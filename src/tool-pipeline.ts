import type {
  ToolExecutionOutcome,
  ToolPipelineStage,
  ToolPipelineStageRecord,
  ToolPipelineStageState,
} from "./types.js";

const MAX_IDENTICAL_TOOL_CALLS = 3;
const MAX_DISTINCT_TOOL_CALLS_PER_RUN = 256;
export const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const TOOL_OUTPUT_TRUNCATION_SUFFIX = "\n…[tool output truncated]";

export const TOOL_PIPELINE_STAGES: readonly ToolPipelineStage[] = Object.freeze([
  "schema",
  "capability",
  "loop",
  "approval",
  "policy",
  "execute",
  "output",
  "audit",
]);

export class ToolArgumentsError extends Error {
  readonly code = "TOOL_ARGUMENTS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentsError";
  }
}

export function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== "string") throw new ToolArgumentsError("工具参数必须是 JSON 字符串");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new ToolArgumentsError("工具参数不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolArgumentsError("工具参数必须是 JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class ToolLoopError extends Error {
  readonly code = "TOOL_LOOP_DETECTED";

  constructor(message: string) {
    super(message);
    this.name = "ToolLoopError";
  }
}

export class ToolExecutionError extends Error {
  readonly code = "TOOL_EXECUTION_FAILED";

  constructor(toolName: string, cause: unknown) {
    super(`Tool ${toolName} execution failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ToolExecutionError";
  }
}

export class ToolLoopDetector {
  readonly #counts = new Map<string, number>();

  observe(toolName: string, argumentsDigest: string): void {
    const key = `${toolName}:${argumentsDigest}`;
    const previous = this.#counts.get(key) ?? 0;
    if (previous === 0 && this.#counts.size >= MAX_DISTINCT_TOOL_CALLS_PER_RUN) {
      throw new ToolLoopError("Tool call diversity exceeded the per-run loop budget");
    }
    const count = previous + 1;
    this.#counts.set(key, count);
    if (count > MAX_IDENTICAL_TOOL_CALLS) {
      throw new ToolLoopError(`Repeated identical tool call detected: ${toolName}`);
    }
  }
}

export class ToolStageTrace {
  readonly #records = new Map<ToolPipelineStage, ToolPipelineStageRecord>();
  #lastStageIndex = -1;

  record(stage: ToolPipelineStage, state: ToolPipelineStageState, code: string | null = null): void {
    const stageIndex = TOOL_PIPELINE_STAGES.indexOf(stage);
    if (stageIndex < 0 || this.#records.has(stage) || stageIndex <= this.#lastStageIndex) {
      throw new Error(`Tool pipeline stage order is invalid: ${stage}`);
    }
    this.#lastStageIndex = stageIndex;
    this.#records.set(stage, Object.freeze({ stage, state, code }));
  }

  has(stage: ToolPipelineStage): boolean {
    return this.#records.has(stage);
  }

  snapshot(): readonly ToolPipelineStageRecord[] {
    return Object.freeze(TOOL_PIPELINE_STAGES.map(stage => this.#records.get(stage)
      ?? Object.freeze({ stage, state: "skipped" as const, code: null })));
  }
}

function serializeOutcomeFields(
  status: ToolExecutionOutcome["status"],
  content: string,
  code: string | null,
  outputBytes: number,
  originalOutputBytes: number,
  truncated: boolean,
): string {
  return JSON.stringify({ status, code, content, truncated, outputBytes, originalOutputBytes });
}

const MAX_TOOL_CALL_ID_LENGTH = 256;
export const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const WORST_CASE_TOOL_CALL_ID = "x".repeat(MAX_TOOL_CALL_ID_LENGTH);

export function isValidToolCallId(value: unknown): value is string {
  return typeof value === "string" && TOOL_CALL_ID_PATTERN.test(value);
}

function serializedToolMessageBytes(serializedOutcome: string): number {
  return Buffer.byteLength(JSON.stringify({
    role: "tool",
    content: serializedOutcome,
    tool_call_id: WORST_CASE_TOOL_CALL_ID,
  }), "utf8");
}

function outcomeFitsToolMessage(serializedOutcome: string): boolean {
  return serializedToolMessageBytes(serializedOutcome) <= MAX_TOOL_OUTPUT_BYTES;
}

function safePrefixEnd(value: string, requestedEnd: number): number {
  if (requestedEnd > 0 && requestedEnd < value.length) {
    const previous = value.charCodeAt(requestedEnd - 1);
    const next = value.charCodeAt(requestedEnd);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return requestedEnd - 1;
  }
  return requestedEnd;
}

export function truncateCodePoints(value: string, maximum: number, suffix = ""): string {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("Text limit is invalid");
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count === maximum) return `${value.slice(0, end)}${suffix}`;
    end += character.length;
    count += 1;
  }
  return value;
}

function truncateForEnvelope(
  status: ToolExecutionOutcome["status"],
  content: string,
  code: string | null,
  originalOutputBytes: number,
): string {
  let low = 0;
  let high = content.length;
  let best = TOOL_OUTPUT_TRUNCATION_SUFFIX;
  while (low <= high) {
    const requestedEnd = Math.floor((low + high) / 2);
    const end = safePrefixEnd(content, requestedEnd);
    const candidate = `${content.slice(0, end)}${TOOL_OUTPUT_TRUNCATION_SUFFIX}`;
    const deliveredBytes = Buffer.byteLength(candidate, "utf8");
    if (outcomeFitsToolMessage(serializeOutcomeFields(status, candidate, code, deliveredBytes, originalOutputBytes, true))) {
      best = candidate;
      low = requestedEnd + 1;
    } else {
      high = requestedEnd - 1;
    }
  }
  return best;
}

export function serializeToolOutcome(outcome: ToolExecutionOutcome): string {
  const serialized = serializeOutcomeFields(
    outcome.status,
    outcome.content,
    outcome.code,
    outcome.outputBytes,
    outcome.originalOutputBytes,
    outcome.truncated,
  );
  if (!outcomeFitsToolMessage(serialized)) {
    throw new Error("Serialized tool message exceeds the output limit");
  }
  return serialized;
}

export function createToolOutcome(
  status: ToolExecutionOutcome["status"],
  content: string,
  code: string | null = null,
): ToolExecutionOutcome {
  const originalOutputBytes = Buffer.byteLength(content, "utf8");
  const complete = Object.freeze({ status, content, code, outputBytes: originalOutputBytes, originalOutputBytes, truncated: false });
  if (outcomeFitsToolMessage(serializeOutcomeFields(status, content, code, originalOutputBytes, originalOutputBytes, false))) return complete;

  const deliveredContent = truncateForEnvelope(status, content, code, originalOutputBytes);
  const outcome = Object.freeze({
    status,
    content: deliveredContent,
    code,
    outputBytes: Buffer.byteLength(deliveredContent, "utf8"),
    originalOutputBytes,
    truncated: true,
  });
  serializeToolOutcome(outcome);
  return outcome;
}
