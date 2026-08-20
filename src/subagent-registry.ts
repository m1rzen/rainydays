import { randomBytes } from "node:crypto";
import type { CapabilityContext, NetworkPolicy } from "./capability-broker.js";
import type { LLMClient } from "./llm.js";
import { cancellationError, isRunCancellation, RunCancellationError, throwIfCancelled } from "./run-cancellation.js";
import { runSubAgent, type SubagentRunEvent } from "./subagent.js";
import type { Message, PersonaDefinition, ToolInvocationServices } from "./types.js";

const MAX_ACTIVE_SUBAGENTS = 8;
const MAX_RECORDS = 64;
const MAX_EVENTS = 256;
const MAX_SIDEBAND_MESSAGES = 32;
const MAX_SIDEBAND_BYTES = 8 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_CANVAS_BYTES = 512 * 1024;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_PROMPT_LENGTH = 128 * 1024;
const FORBIDDEN_CHILD_TOOLS = new Set([
  "subagent", "subagent_wait", "subagent_output", "subagent_peek", "subagent_post", "subagent_stop", "subagent_list",
  "playbook_execute",
]);

export type SubagentStatus = "running" | "completed" | "failed" | "aborted";
export type SubagentPeekScope = "status" | "brief" | "last" | "recent" | "full";

export class SubagentRegistryError extends Error {
  readonly code: "SUBAGENT_INVALID" | "SUBAGENT_NOT_FOUND" | "SUBAGENT_LIMIT" | "SUBAGENT_NOT_RUNNING" | "SUBAGENT_REGISTRY_CLOSED" | "SUBAGENT_SETTLEMENT_FAILED";

  constructor(code: SubagentRegistryError["code"], message: string) {
    super(message);
    this.name = "SubagentRegistryError";
    this.code = code;
  }
}

export interface SubagentSnapshot {
  readonly taskId: string;
  readonly description: string;
  readonly persona: string;
  readonly status: SubagentStatus;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly eventCount: number;
  readonly pendingSideband: number;
}

export interface SubagentPeekResult extends SubagentSnapshot {
  readonly scope: SubagentPeekScope;
  readonly page: number;
  readonly events: readonly SubagentRunEvent[];
}

export interface SpawnSubagentRequest {
  readonly description: string;
  readonly prompt: string;
  readonly persona: PersonaDefinition;
  readonly llm: LLMClient;
  readonly parentContext: CapabilityContext;
  readonly parentInvocation: ToolInvocationServices;
  readonly inheritCanvas?: boolean;
  readonly canvasSnapshot?: readonly Message[];
}

interface SubagentRecord {
  readonly taskId: string;
  readonly description: string;
  readonly persona: PersonaDefinition;
  readonly llm: LLMClient;
  readonly context: CapabilityContext;
  readonly invocation: ToolInvocationServices;
  readonly controller: AbortController;
  readonly prompt: string;
  readonly inheritCanvas: boolean;
  readonly canvasSnapshot: readonly Message[];
  readonly events: SubagentRunEvent[];
  readonly sideband: string[];
  readonly createdAt: string;
  acceptingSideband: boolean;
  status: SubagentStatus;
  finishedAt: string | null;
  result: string | null;
  error: string | null;
  cleanupError: unknown;
  completion: Promise<void>;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new SubagentRegistryError("SUBAGENT_INVALID", `${field} is invalid`);
  }
  return value;
}

function boundedUtf8(value: string, maximum: number, suffix = "\n…[subagent output truncated]"): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next + suffixBytes > maximum) break;
    bytes += next;
    end += character.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return normalized || "subagent";
}

function loopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
}

function intersectNetwork(parent: NetworkPolicy, child: NetworkPolicy): NetworkPolicy {
  if (parent.mode === "deny" || child.mode === "deny") return Object.freeze({ mode: "deny" });
  if (parent.mode === "unrestricted") return child;
  if (child.mode === "unrestricted") return parent;
  if (parent.mode === "loopback" && child.mode === "loopback") return Object.freeze({ mode: "loopback" });
  if (parent.mode === "allowlist" && child.mode === "allowlist") {
    const parentOrigins = new Set(parent.origins);
    return Object.freeze({ mode: "allowlist", origins: Object.freeze(child.origins.filter(origin => parentOrigins.has(origin))) });
  }
  const allowlist = parent.mode === "allowlist" ? parent : child.mode === "allowlist" ? child : null;
  if (allowlist) {
    return Object.freeze({ mode: "allowlist", origins: Object.freeze(allowlist.origins.filter(loopbackOrigin)) });
  }
  return Object.freeze({ mode: "deny" });
}

function copiedMessages(messages: readonly Message[]): readonly Message[] {
  const copies: Message[] = messages.map(message => ({
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })),
    } : {}),
  }));
  if (Buffer.byteLength(JSON.stringify(copies), "utf8") > MAX_CANVAS_BYTES) {
    throw new SubagentRegistryError("SUBAGENT_LIMIT", "Inherited canvas exceeds the byte limit");
  }
  return Object.freeze(copies);
}

function snapshot(record: SubagentRecord): SubagentSnapshot {
  return Object.freeze({
    taskId: record.taskId,
    description: record.description,
    persona: record.persona.name,
    status: record.status,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    result: record.result,
    error: record.error,
    eventCount: record.events.length,
    pendingSideband: record.sideband.length,
  });
}

function isTerminal(status: SubagentStatus): boolean {
  return status !== "running";
}

export class SubagentRegistry {
  readonly #sessionId: string;
  readonly #settlementTimeoutMs: number;
  readonly #records = new Map<string, SubagentRecord>();
  #closed = false;
  #shutdown: Promise<void> | null = null;

  constructor(sessionId: string, options: Readonly<{ settlementTimeoutMs?: number }> = {}) {
    this.#sessionId = boundedString(sessionId, "sessionId", 256);
    const timeoutMs = options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new SubagentRegistryError("SUBAGENT_INVALID", "Subagent settlement timeout is invalid");
    }
    this.#settlementTimeoutMs = timeoutMs;
  }

  get closed(): boolean { return this.#closed; }

  async spawn(request: SpawnSubagentRequest): Promise<SubagentSnapshot> {
    if (this.#closed) throw new SubagentRegistryError("SUBAGENT_REGISTRY_CLOSED", "Subagent registry is closed");
    if (request.parentContext !== request.parentInvocation.capabilityContext
      || request.parentContext.sessionId !== this.#sessionId) {
      throw new SubagentRegistryError("SUBAGENT_INVALID", "Subagent parent capability differs from the registry Session");
    }
    const description = boundedString(request.description, "description", MAX_DESCRIPTION_LENGTH);
    const prompt = boundedString(request.prompt, "prompt", MAX_PROMPT_LENGTH);
    const canvasSnapshot = copiedMessages(request.canvasSnapshot ?? []);
    if (this.#activeCount() >= MAX_ACTIVE_SUBAGENTS) {
      throw new SubagentRegistryError("SUBAGENT_LIMIT", `At most ${MAX_ACTIVE_SUBAGENTS} subagents may run concurrently`);
    }
    this.#prune();
    let taskId: string;
    do { taskId = `${slug(description)}-${randomBytes(16).toString("hex")}`; }
    while (this.#records.has(taskId));
    const runId = `subagent:${taskId}`;
    const parentTools = new Set(request.parentInvocation.getUnattendedChildToolNames());
    const tools = request.persona.tools.filter(name => parentTools.has(name) && !FORBIDDEN_CHILD_TOOLS.has(name));
    const context = request.parentInvocation.deriveDetachedChild({
      principal: "subagent",
      tools,
      allowedRoots: request.parentContext.allowedRoots,
      networkPolicy: intersectNetwork(request.parentContext.networkPolicy, request.persona.networkPolicy),
    }, runId);
    const controller = new AbortController();
    let network: ToolInvocationServices["network"];
    try {
      network = request.parentInvocation.createDetachedNetwork(context, controller.signal);
    } catch (error) {
      try { await request.parentInvocation.finishDetachedChild(context); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Subagent construction and cleanup failed"); }
      throw error;
    }
    const invocation: ToolInvocationServices = Object.freeze({
      ...request.parentInvocation,
      capabilityContext: context,
      signal: controller.signal,
      network,
      deriveChild: () => { throw new SubagentRegistryError("SUBAGENT_INVALID", "Nested child derivation is unavailable"); },
      finishChild: () => { throw new SubagentRegistryError("SUBAGENT_INVALID", "Nested child lifecycle is unavailable"); },
      deriveDetachedChild: () => { throw new SubagentRegistryError("SUBAGENT_INVALID", "Nested subagents are unavailable"); },
      finishDetachedChild: (requestedContext: CapabilityContext) => {
        if (requestedContext !== context) return Promise.reject(new SubagentRegistryError("SUBAGENT_INVALID", "Detached child context differs"));
        return request.parentInvocation.finishDetachedChild(context);
      },
      executeDetachedTool: request.parentInvocation.executeDetachedTool,
      createDetachedNetwork: request.parentInvocation.createDetachedNetwork,
      getUnattendedChildToolNames: () => Object.freeze([...context.allowedTools]),
      listCurrentToolDefinitions: () => request.parentInvocation.getToolDefinitions(context),
      getToolDefinitions: request.parentInvocation.getToolDefinitions,
      executeTool: (
        requestedContext: CapabilityContext,
        name: string,
        args: Record<string, unknown> | string,
        toolCallId: string,
      ) => {
        if (requestedContext !== context) throw new SubagentRegistryError("SUBAGENT_INVALID", "Detached tool context differs");
        return request.parentInvocation.executeDetachedTool(context, name, args, toolCallId, controller.signal);
      },
    });
    const record: SubagentRecord = {
      taskId,
      description,
      persona: request.persona,
      llm: request.llm,
      context,
      invocation,
      controller,
      prompt,
      inheritCanvas: request.inheritCanvas === true,
      canvasSnapshot,
      events: [],
      sideband: [],
      createdAt: new Date().toISOString(),
      acceptingSideband: true,
      status: "running",
      finishedAt: null,
      result: null,
      error: null,
      cleanupError: null,
      completion: Promise.resolve(),
    };
    this.#records.set(taskId, record);
    record.completion = Promise.resolve().then(() => this.#run(record));
    void record.completion.catch(() => undefined);
    return snapshot(record);
  }

  list(): readonly SubagentSnapshot[] {
    return Object.freeze([...this.#records.values()].map(snapshot));
  }

  get(taskId: string): SubagentSnapshot {
    return snapshot(this.#record(taskId));
  }

  async output(taskId: string, options: Readonly<{ block?: boolean; timeoutMs?: number; signal?: AbortSignal }> = {}): Promise<SubagentSnapshot> {
    const record = this.#record(taskId);
    if (options.block && record.status === "running") {
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        throw new SubagentRegistryError("SUBAGENT_INVALID", "Subagent output timeout is invalid");
      }
      await this.#await(record, options.signal, timeoutMs);
    }
    return snapshot(record);
  }

  async wait(taskId: string, signal?: AbortSignal): Promise<SubagentSnapshot> {
    const record = this.#record(taskId);
    if (record.status === "running") await this.#await(record, signal);
    return snapshot(record);
  }

  peek(taskId: string, scope: SubagentPeekScope = "last", page = 0): SubagentPeekResult {
    const record = this.#record(taskId);
    if (!["status", "brief", "last", "recent", "full"].includes(scope)) {
      throw new SubagentRegistryError("SUBAGENT_INVALID", "Subagent peek scope is invalid");
    }
    if (!Number.isSafeInteger(page) || page < 0 || page > 1_000) {
      throw new SubagentRegistryError("SUBAGENT_INVALID", "Subagent peek page is invalid");
    }
    const pageSize = { status: 0, brief: 4, last: 16, recent: 64, full: MAX_EVENTS }[scope];
    const end = Math.max(0, record.events.length - page * pageSize);
    const start = Math.max(0, end - pageSize);
    const events = pageSize === 0 ? [] : record.events.slice(start, end).map(event => Object.freeze({ ...event }));
    return Object.freeze({ ...snapshot(record), scope, page, events: Object.freeze(events) });
  }

  post(taskId: string, rawMessage: string): SubagentSnapshot {
    const record = this.#record(taskId);
    if (record.status !== "running" || !record.acceptingSideband) throw new SubagentRegistryError("SUBAGENT_NOT_RUNNING", `Subagent ${taskId} is not running`);
    const message = boundedString(rawMessage, "message", MAX_SIDEBAND_BYTES);
    if (Buffer.byteLength(message, "utf8") > MAX_SIDEBAND_BYTES || record.sideband.length >= MAX_SIDEBAND_MESSAGES) {
      throw new SubagentRegistryError("SUBAGENT_LIMIT", "Subagent sideband limit exceeded");
    }
    record.sideband.push(message);
    return snapshot(record);
  }

  async stop(taskId: string): Promise<SubagentSnapshot> {
    const record = this.#record(taskId);
    if (record.status === "running" && !record.controller.signal.aborted) {
      record.controller.abort(new RunCancellationError("RUN_CANCELLED", `Subagent ${taskId} was stopped`));
    }
    await this.#settle(record, `Subagent ${taskId} did not settle after stop`);
    if (record.cleanupError) throw record.cleanupError;
    return snapshot(record);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    this.#shutdown = this.#performShutdown();
    return this.#shutdown;
  }

  async #run(record: SubagentRecord): Promise<void> {
    let terminalStatus: SubagentStatus = "completed";
    try {
      const result = await runSubAgent({
        llm: record.llm,
        persona: record.persona,
        prompt: record.prompt,
        capabilityContext: record.context,
        invocation: record.invocation,
        inheritCanvas: record.inheritCanvas,
        initialMessages: record.canvasSnapshot,
        takeSideband: () => record.sideband.splice(0),
        onEvent: event => this.#event(record, event),
      });
      record.result = boundedUtf8(result, MAX_RESULT_BYTES);
    } catch (error) {
      const aborted = record.controller.signal.aborted || isRunCancellation(error);
      terminalStatus = aborted ? "aborted" : "failed";
      record.error = boundedUtf8(error instanceof Error ? error.message : String(error), MAX_EVENT_BYTES, "…");
    } finally {
      record.acceptingSideband = false;
      try {
        await record.invocation.finishDetachedChild(record.context);
      } catch (error) {
        record.cleanupError = error;
        terminalStatus = "failed";
        record.error = boundedUtf8(`Subagent cleanup failed: ${error instanceof Error ? error.message : String(error)}`, MAX_EVENT_BYTES, "…");
      }
      record.sideband.length = 0;
      record.status = terminalStatus;
      record.finishedAt = new Date().toISOString();
    }
  }

  #event(record: SubagentRecord, event: SubagentRunEvent): void {
    const bounded = Object.freeze({ ...event, content: boundedUtf8(event.content, MAX_EVENT_BYTES, "…") });
    record.events.push(bounded);
    if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
  }

  async #await(record: SubagentRecord, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (signal) throwIfCancelled(signal);
    if (record.status !== "running") return true;
    let timeout: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const candidates: Promise<"complete" | "timeout">[] = [record.completion.then(() => "complete")];
    if (timeoutMs !== undefined) {
      candidates.push(new Promise(resolve => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        timeout.unref?.();
      }));
    }
    if (signal) {
      candidates.push(new Promise((_, reject) => {
        onAbort = () => reject(cancellationError(signal, "Subagent wait was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }));
    }
    try {
      return (await Promise.race(candidates)) === "complete";
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #settle(record: SubagentRecord, message: string): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SubagentRegistryError("SUBAGENT_SETTLEMENT_FAILED", message)), this.#settlementTimeoutMs);
      timer.unref?.();
    });
    try { await Promise.race([record.completion, deadline]); }
    finally { if (timer) clearTimeout(timer); }
  }

  #record(rawTaskId: string): SubagentRecord {
    const taskId = boundedString(rawTaskId, "task_id", 80);
    const record = this.#records.get(taskId);
    if (!record) throw new SubagentRegistryError("SUBAGENT_NOT_FOUND", `Subagent ${taskId} does not exist in this Session`);
    return record;
  }

  #activeCount(): number {
    let count = 0;
    for (const record of this.#records.values()) if (record.status === "running") count += 1;
    return count;
  }

  #prune(): void {
    while (this.#records.size >= MAX_RECORDS) {
      const terminal = [...this.#records.values()].find(record => isTerminal(record.status));
      if (!terminal) throw new SubagentRegistryError("SUBAGENT_LIMIT", "Subagent record limit exceeded");
      this.#records.delete(terminal.taskId);
    }
  }

  async #performShutdown(): Promise<void> {
    const records = [...this.#records.values()];
    for (const record of records) {
      if (record.status === "running" && !record.controller.signal.aborted) {
        record.controller.abort(new RunCancellationError("RUN_CANCELLED", "Subagent stopped because its Session runtime is retiring"));
      }
    }
    const settlements = await Promise.allSettled(records.map(record => this.#settle(
      record,
      `Subagent ${record.taskId} did not settle during Session retirement`,
    )));
    const failures = [
      ...settlements.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason),
      ...records.map(record => record.cleanupError).filter(error => error !== null),
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Subagent cleanup failed during Session retirement");
  }
}
