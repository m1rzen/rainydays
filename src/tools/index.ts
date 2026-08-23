// ===========================================
// 工具注册中心 —— 统一注册所有工具
// 按 persona 的 tools 列表动态加载
// ===========================================

import Ajv, { type ValidateFunction } from "ajv";
import type { RegisteredTool, ToolDefinition, ToolExecutionOutcome, ToolExecutor, ToolInvocationServices } from "../types.js";
import { CapabilityBroker, CapabilityDeniedError, type CapabilityContext, type InspectedToolCall, type RuntimeAuthority } from "../capability-broker.js";
import { DIRECT_OPERATION_POLICIES, RUNTIME_TOOL_POLICIES, STATIC_TOOL_POLICIES } from "../tool-policies.js";
import { getSessionInfo } from "../session.js";
import { PathDeniedError } from "../path-policy.js";
import { pathPolicy } from "../path-runtime.js";
import { createScopedExecutionGateway } from "../execution-runtime.js";
import { createScopedNetworkGateway, NetworkPolicyDeniedError } from "../network-policy.js";
import {
  listDirectoryDef, listDirectoryExec,
  readFileDef, readFileExec,
  searchFilesDef, searchFilesExec,
  writeFileDef, writeFileExec,
  editFileDef, editFileExec,
  grepDef, grepExec,
} from "./filesystem.js";
import {
  createDocxDef, createDocxExec,
  createXlsxDef, createXlsxExec,
} from "./writer.js";
import {
  executeCommandDef, executeCommandExec,
} from "./shell.js";
import {
  shellStartDef, shellStartExec,
  shellInputDef, shellInputExec,
  shellOutputDef, shellOutputExec,
  shellResizeDef, shellResizeExec,
  shellListDef, shellListExec,
  shellKillDef, shellKillExec,
} from "./terminal-tools.js";
import {
  fetchUrlDef, fetchUrlExec,
} from "./web.js";
import {
  rememberDef, rememberExec,
  recallDef, recallExec,
  listMemoriesDef, listMemoriesExec,
} from "./memory-tools.js";
import {
  taskCreateDef, taskCreateExec,
  taskUpdateDef, taskUpdateExec,
  taskListDef, taskListExec,
  taskGetDef, taskGetExec,
  taskDeleteDef, taskDeleteExec,
} from "./task-tools.js";
import {
  scriptDef, scriptExec,
} from "./script.js";
import {
  getCurrentTimeDef, getCurrentTimeExec,
} from "./system.js";
import {
  cronScheduleDef, cronListDef, cronCancelDef, cronListExec,
  createCronScheduleExec, createCronCancelExec,
} from "./cron-tools.js";
import {
  inspectDef, inspectExec,
  graphDef, graphExec,
  consolidateDef,
} from "./knowledge-tools.js";
import { createConsolidateExec } from "./knowledge-tools.js";
import { curateDef } from "./curate-tool.js";
import { webSearchDef, webSearchExec } from "./search-tool.js";
import { downloadDef, downloadExec } from "./download-tool.js";
import { askUserDef, askUserExec } from "./ask-user-tool.js";
import {
  oracleQueryDef,
  oracleSaveDef, oracleSaveExec,
  oracleStatusDef, oracleStatusExec,
  playbookListDef, playbookListExec,
  playbookCreateDef, playbookCreateExec,
  playbookStatusDef, playbookStatusExec,
  linkDiscoverDef, linkDiscoverExec,
  linkPeekDef, linkPeekExec,
  linkPostDef, linkPostExec,
  pollSubscribeDef, pollSubscribeExec,
  pollUnsubscribeDef, pollUnsubscribeExec,
  pollListDef, pollListExec,
  superviseDef, superviseExec,
} from "./advanced-tools.js";
import { createOracleQueryExec } from "./advanced-tools.js";
import {
  memoAddDef, memoAddExec, memoListDef, memoListExec, memoDoneDef, memoDoneExec,
  mascotNotifyDef, mascotNotifyExec, museDef,
  searchToolsDef, searchToolsExec, setNotifyCallback,
} from "./phase1-tools.js";
import { imageHelperDef, imageHelperExec } from "./image-helper.js";
import { readRepoDef, readRepoExec } from "./read-repo.js";
import { savePersonaDef, createSavePersonaExec } from "./save-persona.js";
import type { CronJobRow } from "../db.js";
import type { SecurityAuditJournal } from "../security-audit-journal.js";
import {
  makeAuthorizationAuditPayload,
  makeExecutionAuditPayload,
  makeRequestAuditPayload,
  makeResultAuditPayload,
  type SecurityAuditCorrelation,
  type SecurityAuditPrincipal,
} from "../security-audit.js";
import { randomUUID } from "node:crypto";
import { cancellationError, cancellationFailure, isRunCancellation, isRunSettlementFailure, NEVER_ABORT_SIGNAL, RunSettlementError, throwIfCancelled, timeoutSignal } from "../run-cancellation.js";
import { createToolOutcome, isValidToolCallId, parseToolArguments, ToolArgumentsError, ToolExecutionError, ToolLoopDetector, ToolLoopError } from "../tool-pipeline.js";
export { createToolOutcome, isValidToolCallId, MAX_TOOL_OUTPUT_BYTES, parseToolArguments, serializeToolOutcome, truncateCodePoints, ToolArgumentsError, ToolExecutionError, ToolLoopDetector, ToolLoopError } from "../tool-pipeline.js";

/** 全部已注册的工具（按名索引） */
const rawStaticTools: Omit<RegisteredTool, "policy">[] = [
  { name: "list_directory",  definition: listDirectoryDef,  executor: listDirectoryExec },
  { name: "read_file",       definition: readFileDef,        executor: readFileExec },
  { name: "search_files",    definition: searchFilesDef,     executor: searchFilesExec },
  { name: "write_file",      definition: writeFileDef,       executor: writeFileExec },
  { name: "edit_file",       definition: editFileDef,        executor: editFileExec },
  { name: "grep",            definition: grepDef,             executor: grepExec },
  { name: "create_docx",     definition: createDocxDef,      executor: createDocxExec },
  { name: "create_xlsx",     definition: createXlsxDef,      executor: createXlsxExec },
  { name: "execute_command", definition: executeCommandDef,  executor: executeCommandExec },
  { name: "shell_start",     definition: shellStartDef,       executor: shellStartExec },
  { name: "shell_input",     definition: shellInputDef,       executor: shellInputExec },
  { name: "shell_output",    definition: shellOutputDef,      executor: shellOutputExec },
  { name: "shell_resize",    definition: shellResizeDef,      executor: shellResizeExec },
  { name: "shell_list",      definition: shellListDef,        executor: shellListExec },
  { name: "shell_kill",      definition: shellKillDef,        executor: shellKillExec },
  { name: "fetch_url",       definition: fetchUrlDef,        executor: fetchUrlExec },
  { name: "remember",        definition: rememberDef,        executor: rememberExec },
  { name: "recall",          definition: recallDef,          executor: recallExec },
  { name: "list_memories",   definition: listMemoriesDef,    executor: listMemoriesExec },
  { name: "task_create",     definition: taskCreateDef,      executor: taskCreateExec },
  { name: "task_update",     definition: taskUpdateDef,      executor: taskUpdateExec },
  { name: "task_list",       definition: taskListDef,        executor: taskListExec },
  { name: "task_get",        definition: taskGetDef,         executor: taskGetExec },
  { name: "task_delete",     definition: taskDeleteDef,      executor: taskDeleteExec },
  { name: "script",          definition: scriptDef,           executor: scriptExec },
  { name: "get_current_time", definition: getCurrentTimeDef,  executor: getCurrentTimeExec },
  { name: "cron_list",        definition: cronListDef,         executor: cronListExec },
  { name: "inspect",          definition: inspectDef,          executor: inspectExec },
  { name: "graph",            definition: graphDef,             executor: graphExec },
  { name: "web_search",       definition: webSearchDef,         executor: webSearchExec },
  { name: "download",         definition: downloadDef,          executor: downloadExec },
  { name: "ask_user",         definition: askUserDef,           executor: askUserExec },
  { name: "oracle_save",      definition: oracleSaveDef,        executor: oracleSaveExec },
  { name: "oracle_status",    definition: oracleStatusDef,      executor: oracleStatusExec },
  { name: "playbook_list",    definition: playbookListDef,      executor: playbookListExec },
  { name: "playbook_create",  definition: playbookCreateDef,    executor: playbookCreateExec },
  { name: "playbook_status",  definition: playbookStatusDef,    executor: playbookStatusExec },
  { name: "link_discover",    definition: linkDiscoverDef,      executor: linkDiscoverExec },
  { name: "link_peek",        definition: linkPeekDef,           executor: linkPeekExec },
  { name: "link_post",        definition: linkPostDef,           executor: linkPostExec },
  { name: "poll_subscribe",   definition: pollSubscribeDef,     executor: pollSubscribeExec },
  { name: "poll_unsubscribe", definition: pollUnsubscribeDef,   executor: pollUnsubscribeExec },
  { name: "poll_list",        definition: pollListDef,           executor: pollListExec },
  { name: "supervise",        definition: superviseDef,          executor: superviseExec },
  { name: "memo_add",         definition: memoAddDef,             executor: memoAddExec },
  { name: "memo_list",        definition: memoListDef,            executor: memoListExec },
  { name: "memo_done",        definition: memoDoneDef,            executor: memoDoneExec },
  { name: "mascot_notify",    definition: mascotNotifyDef,        executor: mascotNotifyExec },
  { name: "search_tools",     definition: searchToolsDef,         executor: searchToolsExec },
  { name: "image_helper",     definition: imageHelperDef,         executor: imageHelperExec },
  { name: "read_repo",        definition: readRepoDef,            executor: readRepoExec },
];

const staticNames = rawStaticTools.map((tool) => tool.name).sort();
const staticPolicyNames = Object.keys(STATIC_TOOL_POLICIES).sort();
if (JSON.stringify(staticNames) !== JSON.stringify(staticPolicyNames)) {
  throw new Error("SEC-01 static tool policy manifest does not exactly match the registry");
}

const runtimePolicyNames = Object.keys(RUNTIME_TOOL_POLICIES).sort();
if (new Set([...staticNames, ...runtimePolicyNames]).size !== staticNames.length + runtimePolicyNames.length) {
  throw new Error("SEC-01 static and runtime tool names collide");
}

const allTools: RegisteredTool[] = rawStaticTools.map((tool) => ({
  ...tool,
  policy: STATIC_TOOL_POLICIES[tool.name],
}));

export const capabilityBroker = new CapabilityBroker({
  resolveSessionPersona: (sessionId) => getSessionInfo(sessionId)?.persona_name ?? null,
  pathPolicy,
});
for (const tool of allTools) capabilityBroker.registerStaticTool(tool);
for (const [operation, policy] of Object.entries(DIRECT_OPERATION_POLICIES)) capabilityBroker.registerDirectOperation(operation, policy);

const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, strict: false });
const validators = new WeakMap<ToolDefinition, ValidateFunction>();
const strictDefinitions = new WeakMap<ToolDefinition, ToolDefinition>();

type ToolAuditContext = Readonly<{ journal: SecurityAuditJournal; parentRequestId: string }>;

function nestedResultStatus(result: string): ToolExecutionOutcome["status"] {
  if (result.startsWith("⛔")) return "denied";
  if (/超时|timeout/iu.test(result)) return "timeout";
  if (result.startsWith("工具执行出错:")) return "error";
  return "success";
}

class NestedToolAuditTrail {
  readonly #journal: SecurityAuditJournal;
  readonly #context: CapabilityContext;
  readonly #parentRequestId: string;
  readonly #toolCallId: string;
  readonly #toolName: string;
  readonly #requestId = randomUUID();
  readonly #requestCommitment: string;
  readonly #startedAt = Date.now();
  #executionId: string | null = null;
  #authorized = false;
  #executed = false;
  #finished = false;

  constructor(audit: ToolAuditContext, context: CapabilityContext, toolCallId: string, toolName: string, args: unknown) {
    this.#journal = audit.journal;
    this.#context = context;
    this.#parentRequestId = audit.parentRequestId;
    this.#toolCallId = toolCallId;
    this.#toolName = /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(toolName) ? toolName : "invalid-tool-name";
    this.#requestCommitment = audit.journal.commit({ toolName, args });
  }

  #correlation(): SecurityAuditCorrelation {
    return Object.freeze({
      sessionId: this.#context.sessionId,
      runId: this.#context.runId,
      requestId: this.#requestId,
      parentRequestId: this.#parentRequestId,
      toolCallId: this.#toolCallId,
      contextId: this.#context.contextId,
      executionId: this.#executionId,
    });
  }

  #principal(): SecurityAuditPrincipal {
    return this.#context.principal === "subagent" || this.#context.principal === "playbook" ? this.#context.principal : "agent";
  }

  #common() {
    return {
      correlation: this.#correlation(),
      principal: this.#principal(),
      operationKind: "tool" as const,
      operationName: this.#toolName,
      requestCommitment: this.#requestCommitment,
    };
  }

  get authorized(): boolean { return this.#authorized; }
  get executed(): boolean { return this.#executed; }
  get finished(): boolean { return this.#finished; }

  async request(args: unknown): Promise<void> {
    const encoded = typeof args === "string" ? args : JSON.stringify(args);
    await this.#journal.append({
      ...this.#common(),
      phase: "request",
      outcome: "received",
      code: null,
      safePayload: makeRequestAuditPayload({
        ingress: "agent-tool",
        argumentBytes: Buffer.byteLength(encoded, "utf8"),
        argumentsCommitment: this.#journal.commit(args),
      }),
    });
  }

  async authorize(decision: "allowed" | "denied", policyDigest: string | null, code: string | null): Promise<void> {
    await this.#journal.append({
      ...this.#common(),
      phase: "authorization",
      outcome: decision,
      code,
      safePayload: makeAuthorizationAuditPayload({
        decision,
        policyDigest,
        personaDigest: this.#context.persona.digest,
        approvalKind: "none",
      }),
    });
    this.#authorized = true;
  }

  async execution(started: boolean): Promise<void> {
    this.#executionId = started ? randomUUID() : null;
    await this.#journal.append({
      ...this.#common(),
      phase: "execution",
      outcome: started ? "started" : "not_started",
      code: null,
      safePayload: makeExecutionAuditPayload({
        state: started ? "started" : "not_started",
        executor: started ? "tool-dispatcher" : "none",
        profile: null,
        proofDigest: null,
      }),
    });
    this.#executed = true;
  }

  async result(
    result: string,
    status = nestedResultStatus(result),
    code: string | null = null,
    outputBytes = Buffer.byteLength(result, "utf8"),
    truncated = false,
  ): Promise<void> {
    await this.#journal.append({
      ...this.#common(),
      phase: "result",
      outcome: status,
      code,
      safePayload: makeResultAuditPayload({
        status,
        durationMs: Date.now() - this.#startedAt,
        outputBytes,
        truncated,
        resultCommitment: this.#journal.commit(result),
      }),
    });
    this.#finished = true;
  }

  async deny(outcome: ToolExecutionOutcome, code: string): Promise<void> {
    await this.authorize("denied", null, code);
    await this.execution(false);
    await this.result(outcome.content, "denied", code, outcome.outputBytes, outcome.truncated);
  }
}

/** 所有声明工具名；仅用于 Persona 完整性检查和设置 UI，不构成执行授权。 */
export function getAllToolNames(): string[] {
  return [...staticNames, ...runtimePolicyNames];
}

export function registerDynamicTool(authority: RuntimeAuthority, tool: Omit<RegisteredTool, "policy">): void {
  const policy = RUNTIME_TOOL_POLICIES[tool.name];
  if (!policy) throw new Error(`SEC-01 runtime tool is absent from the frozen policy manifest: ${tool.name}`);
  capabilityBroker.registerRuntimeTool(authority, { ...tool, policy });
}

export function getToolDefinitions(context: CapabilityContext): ToolDefinition[] {
  return capabilityBroker.getToolDefinitions(context).map(strictToolDefinition);
}

function closeObjectSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(closeObjectSchemas));
  if (!value || typeof value !== "object") return value;
  const closed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) closed[key] = closeObjectSchemas(child);
  if (closed.type === "object" && !Object.hasOwn(closed, "additionalProperties")) closed.additionalProperties = false;
  return Object.freeze(closed);
}

function strictToolDefinition(definition: ToolDefinition): ToolDefinition {
  let strict = strictDefinitions.get(definition);
  if (!strict) {
    strict = closeObjectSchemas(definition) as ToolDefinition;
    strictDefinitions.set(definition, strict);
  }
  return strict;
}

function validateArguments(definition: ToolDefinition, args: Record<string, unknown>): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolArgumentsError("工具参数必须是普通 JSON object");
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) throw new ToolArgumentsError("工具参数必须是普通 JSON object");
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.compile(closeObjectSchemas(definition.function.parameters) as object);
    validators.set(definition, validate);
  }
  let valid = false;
  try {
    valid = validate(args) as boolean;
  } catch {
    throw new ToolArgumentsError("工具参数必须是仅包含可复制 JSON 数据的普通 object");
  }
  if (!valid) {
    const details = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
    throw new ToolArgumentsError(`工具参数不符合 Schema: ${details}`);
  }
}

export function inspectToolCall(
  context: CapabilityContext,
  name: string,
  args: Record<string, unknown>
): InspectedToolCall {
  const definition = getToolDefinitions(context).find((entry) => entry.function.name === name);
  if (!definition) return capabilityBroker.inspectToolCall(context, name, args);
  validateArguments(definition, args);
  try {
    return capabilityBroker.inspectToolCall(context, name, args);
  } catch (error) {
    if (error instanceof CapabilityDeniedError) throw error;
    throw new ToolArgumentsError("工具参数必须是普通 JSON object，且仅包含可复制的 JSON 数据");
  }
}

function invocationServices(
  executionContext: CapabilityContext,
  inspected: InspectedToolCall,
  auditContext: ToolAuditContext | null,
  signal: AbortSignal,
  loopDetector: ToolLoopDetector | null,
): {
  readonly services: ToolInvocationServices;
  readonly close: () => void;
} {
  const issuedPath = capabilityBroker.issueToolPathGateway(executionContext, inspected);
  const resourceOwner = capabilityBroker.getResourceOwner(executionContext);
  const detachedLoopDetectors = new WeakMap<CapabilityContext, ToolLoopDetector>();
  const services: ToolInvocationServices = {
    capabilityContext: capabilityBroker.getInvocationSourceContext(executionContext),
    signal,
    path: issuedPath.gateway,
    network: createScopedNetworkGateway({ context: executionContext, inspected, signal }),
    execution: createScopedExecutionGateway({ context: executionContext, inspected, owner: resourceOwner, signal }),
    resourceOwner,
    deriveChild: (request) => capabilityBroker.deriveInvocationChild(executionContext, request),
    finishChild: (context) => capabilityBroker.finishContext(context),
    deriveDetachedChild: (request, runId) => {
      const context = capabilityBroker.deriveDetachedInvocationChild(executionContext, request, runId);
      detachedLoopDetectors.set(context, new ToolLoopDetector());
      return context;
    },
    finishDetachedChild: async (context) => {
      detachedLoopDetectors.delete(context);
      await capabilityBroker.finishDetachedContext(context);
    },
    executeDetachedTool: (context, name, args, toolCallId, childSignal) => {
      const detector = detachedLoopDetectors.get(context);
      if (!detector) throw new Error("Detached child execution context is unavailable");
      return executeTool(context, name, args, auditContext, toolCallId, childSignal, detector);
    },
    createDetachedNetwork: (context, childSignal) => createScopedNetworkGateway({
      context,
      inspected,
      signal: childSignal,
      assertActive: () => detachedLoopDetectors.has(context) && capabilityBroker.isContextActive(context),
    }),
    getUnattendedChildToolNames: () => capabilityBroker.getUnattendedChildToolNames(
      capabilityBroker.getInvocationSourceContext(executionContext),
    ),
    listCurrentToolDefinitions: () => getToolDefinitions(executionContext),
    getToolDefinitions: (context) => getToolDefinitions(context),
    auditContext,
    executeTool: (context, name, args, toolCallId) => executeTool(context, name, args, auditContext, toolCallId, signal, loopDetector),
  };
  return Object.freeze({ services: Object.freeze(services), close: issuedPath.close });
}

type ToolSettlement = Readonly<{ ok: true; value: string }> | Readonly<{ ok: false; error: unknown }>;

async function invokeWithCancellationSettlement(
  context: CapabilityContext,
  inspected: InspectedToolCall,
  invocation: ReturnType<typeof invocationServices>,
  signal: AbortSignal,
): Promise<string> {
  const operation = capabilityBroker.invokeTool(context, inspected, invocation.services);
  const settled: Promise<ToolSettlement> = operation.then(
    value => Object.freeze({ ok: true as const, value }),
    error => Object.freeze({ ok: false as const, error }),
  );
  let notifyAbort!: () => void;
  const aborted = new Promise<Readonly<{ aborted: true }>>(resolve => { notifyAbort = () => resolve(Object.freeze({ aborted: true })); });
  signal.addEventListener("abort", notifyAbort, { once: true });
  if (signal.aborted) notifyAbort();
  try {
    const first = await Promise.race([settled, aborted]);
    if (!("aborted" in first)) {
      if (first.ok) return first.value;
      throw first.error;
    }

    let timer: NodeJS.Timeout | null = null;
    const graceExpired = new Promise<Readonly<{ expired: true }>>(resolve => {
      timer = setTimeout(() => resolve(Object.freeze({ expired: true })), 5_000);
      timer.unref?.();
    });
    const final = await Promise.race([settled, graceExpired]);
    if (timer) clearTimeout(timer);
    if (!("expired" in final)) {
      if (final.ok) return final.value;
      throw final.error;
    }

    invocation.close();
    const failures: unknown[] = [new Error(`Tool ${inspected.name} did not settle within the cancellation grace period`)];
    try { await capabilityBroker.poisonRunContext(context); }
    catch (error) { failures.push(error); }
    throw new RunSettlementError(
      cancellationError(signal, `Tool ${inspected.name} was cancelled`),
      failures,
      `Tool ${inspected.name} cancellation settlement failed`,
    );
  } finally {
    signal.removeEventListener("abort", notifyAbort);
  }
}

export interface PreparedToolExecution {
  readonly execute: () => Promise<ToolExecutionOutcome>;
  readonly close: () => void;
}

export function prepareInspectedToolExecution(
  context: CapabilityContext,
  inspected: InspectedToolCall,
  auditContext: ToolAuditContext | null = null,
  parentSignal: AbortSignal = NEVER_ABORT_SIGNAL,
  loopDetector: ToolLoopDetector | null = null,
): PreparedToolExecution {
  const name = inspected.name;
  const timeoutMs = name === "execute_command" || name === "script" ? 60_000 : 30_000;
  throwIfCancelled(parentSignal);
  const cancellation = timeoutSignal(parentSignal, timeoutMs, `Tool ${name}`);
  let invocation: ReturnType<typeof invocationServices>;
  try {
    invocation = invocationServices(context, inspected, auditContext, cancellation.signal, loopDetector);
  } catch (error) {
    cancellation.dispose();
    throw error;
  }
  let started = false;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    invocation.close();
    cancellation.dispose();
  };
  const execute = async (): Promise<ToolExecutionOutcome> => {
    if (started || closed) throw new ToolExecutionError(name, new Error("Prepared tool execution is unavailable"));
    started = true;
    try {
      throwIfCancelled(cancellation.signal);
      // A successfully settled executor owns its operation's linearization result. Do not
      // rewrite an already-published side effect as cancelled merely because the parent
      // signal raced with its final acknowledgement.
      const result = await invokeWithCancellationSettlement(context, inspected, invocation, cancellation.signal);
      if (typeof result !== "string") throw new ToolExecutionError(name, new TypeError("Tool executor returned a non-string result"));
      return createToolOutcome("success", result);
    } catch (error) {
      if (isRunCancellation(error) || isRunSettlementFailure(error)) throw error;
      if (cancellation.signal.aborted) throw cancellationFailure(cancellation.signal, error, `Tool ${name} was cancelled`);
      if (error instanceof CapabilityDeniedError || error instanceof ToolArgumentsError || error instanceof PathDeniedError || error instanceof NetworkPolicyDeniedError || error instanceof ToolExecutionError || error instanceof ToolLoopError) throw error;
      throw new ToolExecutionError(name, error);
    } finally {
      close();
    }
  };
  return Object.freeze({ execute, close });
}

export async function executeInspectedTool(
  context: CapabilityContext,
  inspected: InspectedToolCall,
  auditContext: ToolAuditContext | null = null,
  parentSignal: AbortSignal = NEVER_ABORT_SIGNAL,
  loopDetector: ToolLoopDetector | null = null,
): Promise<string> {
  return (await prepareInspectedToolExecution(context, inspected, auditContext, parentSignal, loopDetector).execute()).content;
}

/** 唯一工具 dispatcher：context 缺失、伪造、过期或越权时在 executor 前抛出。 */
export async function executeTool(
  context: CapabilityContext,
  name: string,
  args: Record<string, unknown> | string,
  auditContext: ToolAuditContext | null = null,
  toolCallId: string | null = null,
  signal: AbortSignal = NEVER_ABORT_SIGNAL,
  loopDetector: ToolLoopDetector | null = null,
): Promise<string> {
  throwIfCancelled(signal);
  if (!auditContext) {
    const parsedArgs = typeof args === "string" ? parseToolArguments(args) : args;
    const inspected = inspectToolCall(context, name, parsedArgs);
    loopDetector?.observe(inspected.name, inspected.argumentsDigest);
    return executeInspectedTool(context, inspected, null, signal, loopDetector);
  }
  if (!isValidToolCallId(toolCallId)) {
    throw new ToolArgumentsError("嵌套工具调用缺少有效的 tool_call_id");
  }
  const audit = new NestedToolAuditTrail(auditContext, context, toolCallId, name, args);
  let preparedExecution: PreparedToolExecution | null = null;
  await audit.request(args);
  try {
    const parsedArgs = typeof args === "string" ? parseToolArguments(args) : args;
    const inspected = inspectToolCall(context, name, parsedArgs);
    loopDetector?.observe(inspected.name, inspected.argumentsDigest);
    const policyDigest = auditContext.journal.commit(inspected.policy);
    await audit.authorize("allowed", policyDigest, null);
    preparedExecution = prepareInspectedToolExecution(context, inspected, auditContext, signal, loopDetector);
    await audit.execution(true);
    const outcome = await preparedExecution.execute();
    await audit.result(outcome.content, "success", null, outcome.outputBytes, outcome.truncated);
    return outcome.content;
  } catch (error) {
    let failure = error;
    if (signal.aborted && !isRunCancellation(failure) && !isRunSettlementFailure(failure)) {
      failure = cancellationFailure(signal, failure, "Nested tool was cancelled");
    }
    if (isRunCancellation(failure)) {
      const cancelled = failure;
      const cancellationStatus = cancelled.code === "RUN_TIMEOUT" ? "timeout" : "cancelled";
      const outcome = createToolOutcome(cancellationStatus, `工具执行${cancellationStatus === "timeout" ? "超时" : "已取消"}: ${cancelled.message}`, cancelled.code);
      if (!audit.finished) {
        if (!audit.authorized) await audit.authorize("denied", null, cancelled.code);
        if (!audit.executed) await audit.execution(false);
        await audit.result(outcome.content, cancellationStatus, cancelled.code, outcome.outputBytes, outcome.truncated);
      }
      throw cancelled;
    }
    const code = failure instanceof CapabilityDeniedError || failure instanceof PathDeniedError || failure instanceof NetworkPolicyDeniedError || failure instanceof ToolExecutionError || failure instanceof ToolLoopError
      ? failure.code
      : failure instanceof ToolArgumentsError
        ? "SEC06_TOOL_ARGUMENTS_INVALID"
        : failure instanceof RunSettlementError
          ? failure.code
          : "SEC06_TOOL_ERROR";
    const result = failure instanceof CapabilityDeniedError
      ? `⛔ 执行授权拒绝 [${failure.code}]`
      : failure instanceof PathDeniedError
        ? `⛔ 路径授权拒绝 [${failure.code}]`
        : failure instanceof NetworkPolicyDeniedError
          ? `⛔ 网络授权拒绝 [${failure.code}]`
          : failure instanceof ToolArgumentsError || failure instanceof ToolLoopError
          ? `⛔ ${failure.message}`
          : `工具执行出错: ${failure instanceof Error ? failure.message : String(failure)}`;
    const outcome = createToolOutcome(nestedResultStatus(result), result, code);
    if (!audit.finished) {
      if (!audit.authorized) await audit.deny(outcome, code);
      else {
        if (!audit.executed) await audit.execution(false);
        await audit.result(outcome.content, outcome.status, code, outcome.outputBytes, outcome.truncated);
      }
    }
    throw failure;
  } finally {
    preparedExecution?.close();
  }
}
