// ===========================================
// 服务器入口 —— Express + SSE + Persona + 会话管理
// ===========================================

import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import { once } from "events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { LLMClient } from "./llm.js";
import { ConversationMemory } from "./memory.js";
import { Agent } from "./agent.js";
import { createEffectivePersona, listPersonas, reloadPersonas, getPersona, listAvailableSkills, loadSkillContent } from "./persona.js";
import {
  createSession,
  getAllSessions,
  getSessionInfo,
  removeSession,
  renameSession,
  touch,
  loadSessionMessages,
  forkSession,
  exportSession,
  importSession,
  ensureSessionLinkRegistration,
  SessionExportError,
  SessionImportError,
  searchSessions,
} from "./session.js";
import { closeDb, insertPin, getPinsBySession, deletePin, deleteMessagesAfterLastUserMessage, getDatabaseSchemaVersion, createEventStore, createPollStore, markMemoRemindedByCronJob } from "./db.js";
import { getDefaultEventBus, type EventEnvelope, type SessionDeliveryOutcome } from "./event-bus.js";
import { getDefaultPollManager } from "./poll.js";
import { cancelRunInteraction, runOutsideInteractionChannel, runWithInteractionChannel, submitAnswer } from "./tools/ask-user-tool.js";
import { closeEmbedding } from "./embedding.js";
import { migrateMissingEmbeddings } from "./tools/memory-tools.js";
import { getTasksBySession } from "./task.js";
import { CronManager } from "./cron.js";
import {
  initializeConfig,
  getCurrentProfile,
  getCurrentProfileName,
  getAppSettings,
  getPublicConfig,
  getConfigPath,
  getConfigSnapshot,
  getConfigRevisionDigest,
  prepareAppSettingsUpdate,
  validateAppSettingsPaths,
  commitConfigSnapshot,
  switchProfile,
  listProfiles,
  upsertProfile,
  deleteProfile,
  type AppSettings,
  type Config,
} from "./config.js";
import { initSupervisor } from "./supervisor.js";
import { discoverSessions, updateSessionStatus, onMessage } from "./link.js";
import { disposeAll as disposeWire } from "./wire.js";
import { createMuseExec, setMemoCronCallbacks } from "./tools/phase1-tools.js";
import { createCurateExec } from "./tools/curate-tool.js";
import { createConsolidateExec } from "./tools/knowledge-tools.js";
import { createOracleQueryExec } from "./tools/advanced-tools.js";
import {
  createSubagentExecutors,
  subagentDef,
  subagentListDef,
  subagentOutputDef,
  subagentPeekDef,
  subagentPostDef,
  subagentStopDef,
  subagentWaitDef,
} from "./tools/subagent-tools.js";
import { SubagentRegistry } from "./subagent-registry.js";
import { curateDef } from "./tools/curate-tool.js";
import { consolidateDef } from "./tools/knowledge-tools.js";
import { oracleQueryDef } from "./tools/advanced-tools.js";
import { museDef } from "./tools/phase1-tools.js";
import { capabilityBroker, getAllToolNames, registerDynamicTool } from "./tools/index.js";
import { CapabilityDeniedError, type CapabilityContext, type RuntimeAuthority } from "./capability-broker.js";
import { PathDeniedError, type PathAuditIdentity, type PathAuthority, type PathDirectoryEnrollmentLease, type PathOperation, type PathRootInput } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { playbookExecuteDef, createPlaybookExecuteExec, playbookAbortDef, playbookAbortExec } from "./playbook.js";
import { savePersonaDef, createSavePersonaExec } from "./tools/save-persona.js";
import { cronScheduleDef, cronCancelDef, createCronScheduleExec, createCronCancelExec } from "./tools/cron-tools.js";
import type { CronJobRow } from "./db.js";
import type { PersonaDefinition } from "./types.js";
import type { TerminalOwner, TerminalShell } from "./terminal.js";
import { terminalFacade } from "./terminal-facade.js";
import { fileViewerService, type FileRootSnapshotInput } from "./file-viewer.js";
import { DATA_DIR } from "./runtime-paths.js";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { APP_VERSION, BUILD_ID, BUILD_INFO, PROTOCOL_CAPABILITIES, getPublicVersionInfo } from "./version.js";
import { executeSettingsEnrollment } from "./settings-enrollment.js";
import {
  ManualExecutionConsentLedger,
  type ManualConsentChallenge,
  type ManualConsentDecision,
  type ManualConsentOperation,
} from "./manual-execution-consent.js";
import { createManualExecutionGateway, manualConsentEvidenceBinding, observeManualConsentDenial, observeTerminalDirectDenial, shutdownExecutionRuntime } from "./execution-runtime.js";
import {
  invalidateNativeProcessConsent,
  registerNativeProcessConsentHandler,
} from "./native-process-consent.js";
import { installInheritedNativeProcessConsentTransport } from "./native-process-consent-transport.js";
import { openSecurityAuditJournal, type SecurityAuditJournal } from "./security-audit-journal.js";
import {
  SessionRuntimeLifecycleError,
  SessionRuntimeRegistry,
  type SessionRuntimeCancellationReason,
  type SessionRuntimeIdentity,
} from "./session-runtime.js";
import { isRunCancellation, isRunSettlementFailure } from "./run-cancellation.js";
import {
  makeAuthorizationAuditPayload,
  makeExecutionAuditPayload,
  makeRequestAuditPayload,
  makeResultAuditPayload,
  type SecurityAuditCorrelation,
  type SecurityAuditOperationKind,
  type SecurityAuditResultStatus,
} from "./security-audit.js";

export { invalidateNativeProcessConsent, registerNativeProcessConsentHandler };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3111", 10);
const HOST = "127.0.0.1";
const API_TOKEN = process.env.RAINYDAYS_API_TOKEN || randomBytes(32).toString("hex");
const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

function artifactSafeBuildId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, (character) => `~${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`);
}

function createLlmClient(): LLMClient {
  const profile = getCurrentProfile();
  return new LLMClient({
    apiKey: profile.apiKey || "not-configured",
    baseURL: profile.baseURL,
    model: profile.model,
  });
}

let llm: LLMClient;
let personas: PersonaDefinition[] = [];
let securityAuditJournal: SecurityAuditJournal | null = null;
let selectedSessionId: string | null = null;
let draftPersonaName: string | null = null;
let httpServer: Server | null = null;
let childNativeProcessConsentCleanup: (() => void) | null = null;
let isShuttingDown = false;
const localApiPrincipal = capabilityBroker.createLocalApiPrincipal();
const manualExecutionConsent = new ManualExecutionConsentLedger({ observeDenial: observeManualConsentDenial });
const runtimeSubscriptionClosers = new Map<RuntimeAuthority, Set<() => void>>();
const directRequestSession = new AsyncLocalStorage<string | null>();

function exactSessionRuntimeIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Session runtime identity 无效");
  }
  return value;
}

function resolveBodySessionIdentity(value: unknown, requireBody: boolean): string | null {
  const transportIdentity = directRequestSession.getStore() ?? null;
  const bodyIdentity = value === undefined ? null : exactSessionRuntimeIdentity(value);
  if (requireBody && bodyIdentity === null) throw new TypeError("缺少 sessionId");
  if (bodyIdentity && transportIdentity && bodyIdentity !== transportIdentity) {
    throw new TypeError("Session runtime identity 冲突");
  }
  return bodyIdentity ?? transportIdentity;
}

type AppSessionRuntime = Readonly<{
  sessionId: string;
  generation: number;
  persona: PersonaDefinition;
  llm: LLMClient;
  memory: ConversationMemory;
  authority: RuntimeAuthority;
  agent: Agent;
  subagents: SubagentRegistry;
  consentIncarnationId: string;
}>;

let runtimeRegistry: SessionRuntimeRegistry<AppSessionRuntime> | null = null;
const manualConsentRuntimes = new Map<string, AppSessionRuntime>();
type ActiveRun = Readonly<{
  sessionId: string;
  runId: string;
}>;
const activeRunInteractions = new Map<string, ActiveRun>();
type ActiveRunInjection = Readonly<{
  input: string;
  settle: (outcome: SessionDeliveryOutcome) => void;
}>;
const activeRunInjections = new Map<string, ActiveRunInjection[]>();
const MAX_ACTIVE_RUN_INJECTIONS = 100;
let runtimeMutationReservations = 0;

/** 返回的 Promise 在 flow 真正取走 injection 时 ack；取消前未取走则 retry。 */
function enqueueActiveRunInjection(sessionId: string, input: string): Promise<SessionDeliveryOutcome> | null {
  if (!activeRunInteractions.has(sessionId)) return null;
  let queue = activeRunInjections.get(sessionId);
  if (!queue) {
    queue = [];
    activeRunInjections.set(sessionId, queue);
  }
  if (queue.length >= MAX_ACTIVE_RUN_INJECTIONS) return null;
  let settle!: (outcome: SessionDeliveryOutcome) => void;
  const outcome = new Promise<SessionDeliveryOutcome>(resolve => { settle = resolve; });
  queue.push(Object.freeze({ input, settle }));
  return outcome;
}

function takeActiveRunInjection(sessionId: string, signal: AbortSignal): string | null {
  if (signal.aborted) return null;
  const queue = activeRunInjections.get(sessionId);
  if (!queue || queue.length === 0) return null;
  const injection = queue.shift()!;
  if (queue.length === 0) activeRunInjections.delete(sessionId);
  injection.settle({ outcome: "acked" });
  return injection.input;
}

function clearActiveRunInjections(sessionId: string): void {
  const queue = activeRunInjections.get(sessionId);
  activeRunInjections.delete(sessionId);
  for (const injection of queue ?? []) injection.settle({ outcome: "retry", error: "active flow ended before injection was consumed" });
}

function cancelActiveRun(
  registry: SessionRuntimeRegistry<AppSessionRuntime>,
  run: ActiveRun,
  reason: SessionRuntimeCancellationReason
): Promise<void> {
  cancelRunInteraction(run);
  return registry.cancelRun(run.sessionId, run.runId, reason);
}

function ensureRuntimeAccepting(): void {
  if (isShuttingDown) throw new Error("服务正在关闭，不能创建或重建运行时授权");
}

function invalidateAllPendingConsent(): void {
  manualExecutionConsent.invalidateAll();
  manualConsentRuntimes.clear();
  invalidateNativeProcessConsent();
}

function requireRuntimeRegistry(): SessionRuntimeRegistry<AppSessionRuntime> {
  if (!runtimeRegistry) throw new Error("Session runtime registry is unavailable");
  return runtimeRegistry;
}

function selectedRuntime(): AppSessionRuntime | null {
  return selectedSessionId && runtimeRegistry ? runtimeRegistry.get(selectedSessionId) ?? null : null;
}

function invalidateManualConsentForSession(sessionId: string): void {
  manualExecutionConsent.invalidateSession(sessionId);
  for (const [challengeId, runtime] of manualConsentRuntimes) {
    if (runtime.sessionId === sessionId) manualConsentRuntimes.delete(challengeId);
  }
}

function selectSessionIdentity(sessionId: string | null): void {
  if (selectedSessionId && selectedSessionId !== sessionId) invalidateManualConsentForSession(selectedSessionId);
  selectedSessionId = sessionId;
}

function selectedPersona(): PersonaDefinition | null {
  const loaded = selectedRuntime();
  if (loaded) return loaded.persona;
  const name = selectedSessionId ? getSessionInfo(selectedSessionId)?.persona_name : draftPersonaName;
  const raw = name ? personas.find(persona => persona.name === name) : null;
  return raw ? applyRuntimeSettings(raw) : null;
}

function registerRuntimeSubscription(authority: RuntimeAuthority, close: () => void): () => void {
  let active = true;
  const trackedClose = () => {
    if (!active) return;
    active = false;
    const group = runtimeSubscriptionClosers.get(authority);
    group?.delete(trackedClose);
    if (group?.size === 0) runtimeSubscriptionClosers.delete(authority);
    close();
  };
  const group = runtimeSubscriptionClosers.get(authority) ?? new Set<() => void>();
  group.add(trackedClose);
  runtimeSubscriptionClosers.set(authority, group);
  return trackedClose;
}

function closeRuntimeSubscriptions(authority: RuntimeAuthority | null): void {
  if (!authority) return;
  const closers = [...(runtimeSubscriptionClosers.get(authority) ?? [])];
  for (const close of closers) close();
  runtimeSubscriptionClosers.delete(authority);
}

function rejectWhenRuntimeBusy(res: Response): boolean {
  if (isShuttingDown) {
    res.status(503).json({ error: "服务正在关闭" });
    return true;
  }
  if (runtimeMutationReservations === 0 && !runtimeRegistry?.hasRunningSessions()) return false;
  res.status(409).json({ error: "存在正在执行或变更中的 Session runtime，不能重建全局授权" });
  return true;
}

class SecurityAuditDeliveryError extends Error {
  constructor(error: unknown) {
    super(`Security audit delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    this.name = "SecurityAuditDeliveryError";
  }
}

class DirectOperationAuditTrail {
  readonly #journal: SecurityAuditJournal;
  readonly #operation: string;
  readonly #operationKind: SecurityAuditOperationKind;
  readonly #requestId = randomUUID();
  readonly #requestCommitment: string;
  readonly #baseCorrelation: Omit<SecurityAuditCorrelation, "requestId" | "executionId">;
  readonly #personaDigest: string | null;
  #executionId: string | null = null;
  #requested = false;
  #authorized = false;
  #executed = false;
  #finished = false;

  constructor(journal: SecurityAuditJournal, operation: string, args: Record<string, unknown>, context: CapabilityContext | null, sessionId: string | null) {
    this.#journal = journal;
    this.#operation = operation;
    this.#operationKind = operation.startsWith("terminal:") ? "terminal" : "api";
    this.#requestCommitment = journal.commit({ operation, args });
    this.#baseCorrelation = Object.freeze({
      sessionId: context?.sessionId ?? sessionId,
      runId: context?.runId ?? randomUUID(),
      parentRequestId: null,
      toolCallId: null,
      contextId: context?.contextId ?? null,
    });
    this.#personaDigest = context?.persona.digest ?? null;
  }

  #correlation(): SecurityAuditCorrelation {
    return Object.freeze({ ...this.#baseCorrelation, requestId: this.#requestId, executionId: this.#executionId });
  }

  #common() {
    return {
      correlation: this.#correlation(),
      principal: "local-user-api" as const,
      operationKind: this.#operationKind,
      operationName: this.#operation,
      requestCommitment: this.#requestCommitment,
    };
  }

  get requested(): boolean { return this.#requested; }
  get authorized(): boolean { return this.#authorized; }
  get executed(): boolean { return this.#executed; }
  get finished(): boolean { return this.#finished; }

  async request(args: Record<string, unknown>): Promise<void> {
    let encoded: string;
    try { encoded = JSON.stringify(args); }
    catch { encoded = "[unserializable]"; }
    try {
      await this.#journal.append({
        ...this.#common(),
        phase: "request",
        outcome: "received",
        code: null,
        safePayload: makeRequestAuditPayload({
          ingress: this.#operationKind === "terminal" ? "terminal" : "direct-api",
          argumentBytes: Buffer.byteLength(encoded, "utf8"),
          argumentsCommitment: this.#journal.commit(args),
        }),
      });
      this.#requested = true;
    } catch (error) { throw new SecurityAuditDeliveryError(error); }
  }

  async authorize(decision: "allowed" | "denied", code: string | null): Promise<void> {
    try {
      await this.#journal.append({
        ...this.#common(),
        phase: "authorization",
        outcome: decision,
        code,
        safePayload: makeAuthorizationAuditPayload({
          decision,
          policyDigest: null,
          personaDigest: this.#personaDigest,
          approvalKind: "none",
        }),
      });
      this.#authorized = true;
    } catch (error) { throw new SecurityAuditDeliveryError(error); }
  }

  async execution(started: boolean): Promise<void> {
    this.#executionId = started ? randomUUID() : null;
    try {
      await this.#journal.append({
        ...this.#common(),
        phase: "execution",
        outcome: started ? "started" : "not_started",
        code: null,
        safePayload: makeExecutionAuditPayload({
          state: started ? "started" : "not_started",
          executor: started ? (this.#operationKind === "terminal" ? "terminal" : "direct-api") : "none",
          profile: null,
          proofDigest: null,
        }),
      });
      this.#executed = true;
    } catch (error) { throw new SecurityAuditDeliveryError(error); }
  }

  async result(value: unknown, durationMs: number, status: SecurityAuditResultStatus, code: string | null): Promise<void> {
    let encoded: string;
    try { encoded = JSON.stringify(value) ?? ""; }
    catch { encoded = "[unserializable]"; }
    try {
      await this.#journal.append({
        ...this.#common(),
        phase: "result",
        outcome: status,
        code,
        safePayload: makeResultAuditPayload({
          status,
          durationMs,
          outputBytes: Buffer.byteLength(encoded, "utf8"),
          truncated: false,
          resultCommitment: this.#journal.commit(encoded),
        }),
      });
      this.#finished = true;
    } catch (error) { throw new SecurityAuditDeliveryError(error); }
  }

  async deny(value: unknown, durationMs: number, code: string): Promise<void> {
    await this.authorize("denied", code);
    await this.execution(false);
    await this.result(value, durationMs, "denied", code);
  }
}

function directErrorCode(error: unknown): string {
  if (error instanceof CapabilityDeniedError || error instanceof PathDeniedError) return error.code;
  return "SEC06_DIRECT_OPERATION_ERROR";
}

async function runDirectOperation<T>(
  operation: string,
  args: Record<string, unknown>,
  action: (
    authorizedArgs: Readonly<Record<string, unknown>>,
    owner: TerminalOwner,
    authority: RuntimeAuthority,
    context: CapabilityContext
  ) => T | Promise<T>,
  targetRuntime?: AppSessionRuntime
): Promise<T> {
  ensureRuntimeAccepting();
  if (runtimeMutationReservations > 0) throw new Error("Session runtime 正在变更");
  const sessionId = targetRuntime?.sessionId ?? directRequestSession.getStore() ?? null;
  const runtime = targetRuntime ?? (sessionId ? await requireRuntimeRegistry().ensure(sessionId) : null);
  const authority = runtime?.authority ?? null;
  const journal = securityAuditJournal;
  if (!journal) throw new Error("Security audit journal is unavailable");
  const startedAt = Date.now();
  let context: CapabilityContext | null = null;
  let audit: DirectOperationAuditTrail | null = null;
  try {
    if (!authority || !sessionId) throw new Error("直接操作需要已选择的会话");
    context = capabilityBroker.issueLocalApiContext({
      authority,
      principal: localApiPrincipal,
      sessionId,
      operation,
      args,
    });
    audit = new DirectOperationAuditTrail(journal, operation, args, context, sessionId);
    await audit.request(args);
    const authorizedArgs = capabilityBroker.authorizeDirectOperation(context, operation, args);
    await audit.authorize("allowed", null);
    await audit.execution(true);
    const owner = capabilityBroker.getResourceOwner(context);
    const result = await action(authorizedArgs, owner, authority, context);
    await audit.result(result, Date.now() - startedAt, "success", null);
    return result;
  } catch (error) {
    if (error instanceof SecurityAuditDeliveryError) throw error;
    audit ??= new DirectOperationAuditTrail(journal, operation, args, context, sessionId);
    if (!audit.requested) await audit.request(args);
    const code = directErrorCode(error);
    if (!audit.authorized) await audit.deny({ code }, Date.now() - startedAt, code);
    else {
      if (!audit.executed) await audit.execution(false);
      if (!audit.finished) await audit.result({ code }, Date.now() - startedAt, error instanceof CapabilityDeniedError || error instanceof PathDeniedError ? "denied" : "error", code);
    }
    throw error;
  } finally {
    if (context && capabilityBroker.isContextActive(context)) capabilityBroker.finishContext(context);
  }
}

async function observeDirectTerminalHttpDenial(event: "start" | "input" | "clear" | "kill" | "close", requestBody: unknown): Promise<void> {
  const journal = securityAuditJournal;
  if (!journal) throw new Error("Security audit journal is unavailable");
  const operation = `terminal:${event}`;
  const args = { deniedRoute: event, requestBody: requestBody === undefined ? null : requestBody };
  const sessionId = directRequestSession.getStore() ?? null;
  const runtime = sessionId && runtimeRegistry ? runtimeRegistry.get(sessionId) ?? null : null;
  const audit = new DirectOperationAuditTrail(journal, operation, args, null, sessionId);
  const startedAt = Date.now();
  await audit.request(args);
  await audit.deny({ code: "EXEC_DIRECT_MUTATION_DENIED" }, Date.now() - startedAt, "EXEC_DIRECT_MUTATION_DENIED");

  const authority = runtime?.authority ?? null;
  if (!authority || !sessionId || (event !== "start" && event !== "input")) return;
  let context: CapabilityContext | null = null;
  try {
    context = capabilityBroker.issueLocalApiContext({ authority, principal: localApiPrincipal, sessionId, operation: "terminal:list", args: { deniedRoute: event } });
    await observeTerminalDirectDenial(context, event);
  } catch { /* Native observation supplements the persistent deny chain. */ }
  finally { if (context && capabilityBroker.isContextActive(context)) capabilityBroker.finishContext(context); }
}

function directPathAudit(context: CapabilityContext): PathAuditIdentity {
  return Object.freeze({ sessionId: context.sessionId, runId: context.runId, principal: context.principal });
}

type ManualTerminalPresence = Readonly<{
  windowId: number;
  webContentsId: number;
  topFrame: boolean;
  windowVisible: boolean;
  windowFocused: boolean;
}>;

function requireManualRequest(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)) {
    throw new TypeError("manual terminal request must be a plain object");
  }
  return request as Record<string, unknown>;
}

function exactManualTerminalRequest(
  operation: ManualConsentOperation,
  request: unknown
): Readonly<Record<string, unknown>> {
  const value = requireManualRequest(request);
  const allowed = operation === "terminal-start"
    ? new Set(["name", "shell", "cwd"])
    : operation === "terminal-input"
      ? new Set(["id", "input", "appendNewline"])
      : new Set(["id"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError("manual terminal request contains unsupported fields");

  if (operation === "terminal-start") {
    if (value.shell !== "cmd" && value.shell !== "powershell") throw new TypeError("shell must be cmd or powershell");
    if (value.name !== undefined && typeof value.name !== "string") throw new TypeError("name must be a string");
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd.trim())) throw new TypeError("cwd must be a non-empty string");
    return Object.freeze({
      name: typeof value.name === "string" ? value.name : "",
      shell: value.shell,
      cwd: typeof value.cwd === "string" ? value.cwd.trim() : getAppSettings().workspaceRoot,
    });
  }

  if (typeof value.id !== "string" || !value.id) throw new TypeError("id must be a non-empty string");
  if (operation !== "terminal-input") return Object.freeze({ id: value.id });
  if (typeof value.input !== "string") throw new TypeError("input must be a string");
  if (value.appendNewline !== undefined && typeof value.appendNewline !== "boolean") throw new TypeError("appendNewline must be a boolean");
  return Object.freeze({ id: value.id, input: value.input, appendNewline: value.appendNewline !== false });
}

async function currentManualConsentBinding(
  operation: ManualConsentOperation,
  request: Readonly<Record<string, unknown>>,
  runtime: AppSessionRuntime
): Promise<Readonly<{
  sessionId: string;
  runtimeAuthorityId: string;
  authorityEpoch: number;
  incarnationId: string;
  evidence: ReturnType<typeof manualConsentEvidenceBinding>;
}>> {
  ensureRuntimeAccepting();
  const authority = runtime.authority;
  const sessionId = runtime.sessionId;
  if (requireRuntimeRegistry().get(sessionId) !== runtime) throw new Error("原生确认绑定的 Session runtime 已失效");
  const directOperation = `terminal:${operation.slice("terminal-".length)}`;
  const context = capabilityBroker.issueLocalApiContext({
    authority,
    principal: localApiPrincipal,
    sessionId,
    operation: directOperation,
    args: request,
  });
  try {
    return Object.freeze({
      sessionId: context.sessionId,
      runtimeAuthorityId: authority.authorityId,
      authorityEpoch: context.authorityEpoch,
      incarnationId: runtime.consentIncarnationId,
      evidence: manualConsentEvidenceBinding(context, operation),
    });
  } finally {
    if (capabilityBroker.isContextActive(context)) capabilityBroker.finishContext(context);
  }
}

async function qualifyManualTerminalStart(
  exactRequest: Readonly<Record<string, unknown>>,
  runtime: AppSessionRuntime
): Promise<string> {
  return runDirectOperation("terminal:start", exactRequest, (authorized, _owner, _authority, context) =>
    capabilityBroker.withDirectExecutionRoot(
      context,
      "terminal:start",
      String(authorized.cwd),
      "WORKSPACE_ROOT",
      (_canonicalCwd, _executionRootLease, qualificationDigest) => qualificationDigest
    ), runtime
  );
}

export async function prepareManualTerminalConsent(
  operation: ManualConsentOperation,
  request: unknown,
  presence: ManualTerminalPresence
): Promise<ManualConsentChallenge> {
  const runtime = selectedRuntime();
  if (!runtime) throw new Error("原生确认需要已选择的会话");
  const exactRequest = exactManualTerminalRequest(operation, request);
  const rootQualificationDigest = operation === "terminal-start"
    ? await qualifyManualTerminalStart(exactRequest, runtime)
    : null;
  const binding = await currentManualConsentBinding(operation, exactRequest, runtime);
  const { evidence, ...consentBinding } = binding;
  const controlLabels: Readonly<Record<string, string>> = Object.freeze({
    "terminal-input": "向持久终端发送输入",
    "terminal-clear": "清空持久终端输出",
    "terminal-kill": "终止持久终端进程",
    "terminal-close": "关闭持久终端",
  });
  const display = operation === "terminal-start"
    ? {
        operationLabel: "启动持久终端",
        targetLabel: String(exactRequest.cwd).slice(0, 512),
        rootAlias: "WORKSPACE_ROOT",
        preview: `${String(exactRequest.shell)}${exactRequest.name ? ` · ${String(exactRequest.name)}` : ""}`.slice(0, 512),
      }
    : {
        operationLabel: controlLabels[operation],
        targetLabel: String(exactRequest.id).slice(0, 512),
        rootAlias: "terminal",
        preview: operation === "terminal-input" ? (String(exactRequest.input) || "(empty input)").slice(0, 512) : String(exactRequest.id).slice(0, 512),
      };
  const challenge = manualExecutionConsent.prepare({
    operation,
    request: exactRequest,
    display,
    rootQualificationDigest,
    evidence,
    presence: { ...presence, ...consentBinding },
  });
  manualConsentRuntimes.set(challenge.challengeId, runtime);
  return challenge;
}

export async function decideManualTerminalConsent(
  challengeId: string,
  decision: ManualConsentDecision,
  operation: ManualConsentOperation,
  argumentsDigest: string,
  presence: ManualTerminalPresence
): Promise<unknown> {
  const runtime = manualConsentRuntimes.get(challengeId);
  if (!runtime || requireRuntimeRegistry().get(runtime.sessionId) !== runtime) {
    throw new Error("原生确认绑定的 Session runtime 已失效");
  }
  const binding = await currentManualConsentBinding(operation, {}, runtime);
  const { evidence, ...consentBinding } = binding;
  let result: unknown;
  try {
    await manualExecutionConsent.decide({
      challengeId,
      decision,
      operation,
      argumentsDigest,
      evidence,
      presence: { ...presence, ...consentBinding },
    }, async (storedOperation, exactRequest, storedRootQualificationDigest) => {
      if (storedOperation === "terminal-start") {
        const info = await runDirectOperation("terminal:start", exactRequest, (authorized, owner, _authority, context) =>
          capabilityBroker.withDirectExecutionRoot(
            context,
            "terminal:start",
            String(authorized.cwd),
            "WORKSPACE_ROOT",
            (authorizedCwd, executionRootLease, qualificationDigest) => {
              if (!storedRootQualificationDigest
                || !constantTimeCredentialMatch(qualificationDigest, storedRootQualificationDigest)) {
                throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Execution root identity changed before consent decision");
              }
              return terminalFacade.start(owner, {
                name: String(authorized.name || "") || undefined,
                shell: authorized.shell as TerminalShell,
                authorizedCwd,
                executionRootLease,
                execution: createManualExecutionGateway({ context, owner, operation: storedOperation, exactRequest }),
              });
            }
          ), runtime
        );
        result = { terminal: info };
        return;
      }
      const directOperation = `terminal:${storedOperation.slice("terminal-".length)}`;
      const terminal = await runDirectOperation(directOperation, exactRequest, async (authorized, owner, _authority, context) => {
        const id = String(authorized.id);
        if (storedOperation === "terminal-input") {
          const execution = createManualExecutionGateway({ context, owner, operation: storedOperation, exactRequest });
          const leaseInfo = terminalFacade.get(owner, id);
          if (!leaseInfo) throw new Error(`终端不存在: ${id}`);
          await terminalFacade.input(owner, id, String(authorized.input), authorized.appendNewline !== false, execution);
          return terminalFacade.get(owner, id);
        }
        if (storedOperation === "terminal-clear") {
          terminalFacade.clear(owner, id);
          return terminalFacade.get(owner, id);
        }
        if (storedOperation === "terminal-kill") {
          await terminalFacade.kill(owner, id);
          return terminalFacade.get(owner, id);
        }
        await terminalFacade.close(owner, id);
        return null;
      }, runtime);
      result = { success: true, terminal };
    });
    return result;
  } finally {
    manualConsentRuntimes.delete(challengeId);
  }
}

export function invalidateManualTerminalConsent(webContentsId: number): void {
  manualExecutionConsent.invalidateWebContents(webContentsId);
}

/** 将 Settings 中的工作路径注入 persona，不修改 persona 源文件。 */
function applyRuntimeSettings(persona: PersonaDefinition, settings: AppSettings = getAppSettings()): PersonaDefinition {
  const env = {
    ...persona.env,
    WORKSPACE_ROOT: settings.workspaceRoot,
    DEPARTMENT_DATA_ROOT: settings.departmentDataRoot,
    OUTPUT_DIR: settings.outputDir,
    DATA_ROOT: persona.name === "rds-assistant"
      ? settings.departmentDataRoot
      : settings.workspaceRoot,
  };
  return createEffectivePersona({
    ...persona,
    env,
    allowedRoots: [settings.workspaceRoot, settings.departmentDataRoot, settings.outputDir],
  });
}

const runtimeRootPermissions: readonly PathOperation[] = Object.freeze([
  "read-file", "read-directory", "search-tree", "create-file", "replace-file",
  "create-directory", "watch-directory", "initial-cwd", "reveal",
]);

async function prepareRuntimePathAuthority(persona: PersonaDefinition, settings: AppSettings): Promise<{
  pathAuthority: PathAuthority;
  rootEnv: Readonly<Record<string, string | null>>;
  fileRoots: readonly FileRootSnapshotInput[];
}> {
  await validateAppSettingsPaths(settings);
  const bootstrapStore = getBootstrapPathStore();
  await bootstrapStore.ensureUserDataDescendantDirectory(settings.workspaceRoot);
  await bootstrapStore.ensureUserDataDescendantDirectory(settings.outputDir);
  const candidates: Array<{ input: PathRootInput; optional: boolean }> = [
    { input: { rootId: "workspace", role: "workspace", configuredPath: settings.workspaceRoot, permissions: runtimeRootPermissions }, optional: true },
    { input: { rootId: "department", role: "department", configuredPath: settings.departmentDataRoot, permissions: runtimeRootPermissions }, optional: true },
    { input: { rootId: "output", role: "output", configuredPath: settings.outputDir, permissions: runtimeRootPermissions }, optional: false },
  ];
  const available: PathRootInput[] = [];
  for (const candidate of candidates) {
    try {
      const probe = await pathPolicy.createAuthority([candidate.input]);
      pathPolicy.revoke(probe);
      available.push(candidate.input);
    } catch (error) {
      if (candidate.optional && error instanceof PathDeniedError && error.code === "PATH_ROOT_UNAVAILABLE") continue;
      throw error;
    }
  }
  const pathAuthority = await pathPolicy.createAuthority(available);
  const availableIds = new Set(pathAuthority.rootIds);
  const dataRootId = persona.name === "rds-assistant" ? "department" : "workspace";
  return {
    pathAuthority,
    rootEnv: Object.freeze({
      WORKSPACE_ROOT: availableIds.has("workspace") ? "workspace" : null,
      DEPARTMENT_DATA_ROOT: availableIds.has("department") ? "department" : null,
      OUTPUT_DIR: availableIds.has("output") ? "output" : null,
      DATA_ROOT: availableIds.has(dataRootId) ? dataRootId : null,
    }),
    fileRoots: Object.freeze([
      { id: "workspace", name: "工作目录", configuredPath: settings.workspaceRoot, available: availableIds.has("workspace") },
      { id: "department", name: "部门资料", configuredPath: settings.departmentDataRoot, available: availableIds.has("department") },
      { id: "output", name: "输出目录", configuredPath: settings.outputDir, available: availableIds.has("output") },
    ]),
  };
}

async function issueRuntimeAuthority(persona: PersonaDefinition, settings: AppSettings = getAppSettings()): Promise<RuntimeAuthority> {
  const prepared = await prepareRuntimePathAuthority(persona, settings);
  let authority: RuntimeAuthority | null = null;
  try {
    authority = capabilityBroker.createRuntimeAuthority({
      name: persona.name,
      tools: persona.tools,
      env: persona.env,
      systemPrompt: persona.systemPrompt,
      allowedRoots: persona.allowedRoots,
      rootEnv: prepared.rootEnv,
      pathAuthority: prepared.pathAuthority,
      networkPolicy: persona.networkPolicy,
      digest: persona.digest,
    });
    fileViewerService.bindAuthority(authority, prepared.pathAuthority, prepared.fileRoots);
    return authority;
  } catch (error) {
    if (authority) await capabilityBroker.retireAuthority(authority).catch(() => undefined);
    else if (pathPolicy.isActive(prepared.pathAuthority)) pathPolicy.revoke(prepared.pathAuthority);
    throw error;
  }
}

let runtimeMutationTail: Promise<void> = Promise.resolve();

async function withRuntimeMutation<T>(action: () => Promise<T>): Promise<T> {
  runtimeMutationReservations += 1;
  const previous = runtimeMutationTail;
  let release!: () => void;
  runtimeMutationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    runtimeMutationReservations -= 1;
    release();
  }
}

async function prepareRuntimeInstance(
  identity: SessionRuntimeIdentity,
  settings: AppSettings,
  runtimeLlm: LLMClient
): Promise<AppSessionRuntime> {
  const session = getSessionInfo(identity.sessionId);
  if (!session) throw new Error(`Session 不存在: ${identity.sessionId}`);
  const rawPersona = personas.find(candidate => candidate.name === session.persona_name);
  if (!rawPersona) throw new Error(`Session 绑定的 Persona 不可用: ${session.persona_name}`);
  const persona = applyRuntimeSettings(rawPersona, settings);
  const memory = new ConversationMemory(80);
  const authority = await issueRuntimeAuthority(persona, settings);
  const subagents = new SubagentRegistry(identity.sessionId);
  try {
    registerDynamicTools(authority, persona, memory, runtimeLlm, subagents, settings);
    if (!securityAuditJournal) throw new Error("Security audit journal is unavailable");
    const runtimeAgent = new Agent(runtimeLlm, memory, persona, authority, securityAuditJournal);
    runtimeAgent.setSession(identity.sessionId);
    return Object.freeze({
      sessionId: identity.sessionId,
      generation: identity.generation,
      persona,
      llm: runtimeLlm,
      memory,
      authority,
      agent: runtimeAgent,
      subagents,
      consentIncarnationId: randomBytes(32).toString("hex"),
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([
      subagents.shutdown(),
      capabilityBroker.retireAuthority(authority),
    ]);
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (failures.length > 0) throw new AggregateError([error, ...failures], "Session runtime preparation failed and cleanup did not settle");
    throw error;
  }
}

async function retireRuntimeInstance(runtime: AppSessionRuntime): Promise<void> {
  closeRuntimeSubscriptions(runtime.authority);
  manualExecutionConsent.invalidateSession(runtime.sessionId);
  manualExecutionConsent.invalidateAuthority(runtime.authority.authorityId);
  for (const [challengeId, owner] of manualConsentRuntimes) {
    if (owner === runtime) manualConsentRuntimes.delete(challengeId);
  }
  const failures: unknown[] = [];
  try { await runtime.subagents.shutdown(); }
  catch (error) { failures.push(error); }
  try { await capabilityBroker.retireAuthority(runtime.authority); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Session runtime retirement failed");
}

function createRuntimeRegistry(
  settings: AppSettings = getAppSettings(),
  runtimeLlm: LLMClient = llm
): SessionRuntimeRegistry<AppSessionRuntime> {
  return new SessionRuntimeRegistry(
    identity => prepareRuntimeInstance(identity, settings, runtimeLlm),
    runtime => retireRuntimeInstance(runtime),
  );
}

async function prepareRuntimeRegistry(
  sessionIds: readonly string[],
  settings: AppSettings,
  runtimeLlm: LLMClient
): Promise<SessionRuntimeRegistry<AppSessionRuntime>> {
  const candidate = createRuntimeRegistry(settings, runtimeLlm);
  try {
    await Promise.all(sessionIds.map(sessionId => candidate.ensure(sessionId)));
    return candidate;
  } catch (error) {
    await candidate.shutdown().catch(() => undefined);
    throw error;
  }
}

async function mutateGlobalConfigAndRuntimes(
  mutate: () => Promise<void> | void,
  rebuild: boolean
): Promise<void> {
  return withRuntimeMutation(async () => {
    ensureRuntimeAccepting();
    const previousRegistry = requireRuntimeRegistry();
    if (previousRegistry.hasRunningSessions()) throw new Error("存在正在运行的 Session，不能修改全局 Provider 配置");
    const previousConfig = getConfigSnapshot();
    const previousProfileName = getCurrentProfileName();
    const previousLlm = llm;
    const sessionIds = previousRegistry.loadedSessionIds();

    await mutate();
    if (!rebuild) return;

    let candidate: SessionRuntimeRegistry<AppSessionRuntime>;
    let candidateLlm: LLMClient;
    try {
      candidateLlm = createLlmClient();
      candidate = await prepareRuntimeRegistry(sessionIds, getAppSettings(), candidateLlm);
    } catch (error) {
      await commitConfigSnapshot(previousConfig);
      switchProfile(previousProfileName);
      throw error;
    }

    invalidateAllPendingConsent();
    try {
      await previousRegistry.shutdown();
    } catch (retirementError) {
      await candidate.shutdown().catch(() => undefined);
      runtimeRegistry = null;
      try {
        await commitConfigSnapshot(previousConfig);
        switchProfile(previousProfileName);
        runtimeRegistry = await prepareRuntimeRegistry(sessionIds, previousConfig.settings, previousLlm);
        llm = previousLlm;
        initSupervisor(llm);
      } catch (recoveryError) {
        throw new AggregateError([retirementError, recoveryError], "Provider runtime retirement failed and recovery failed");
      }
      throw retirementError;
    }

    runtimeRegistry = candidate;
    llm = candidateLlm;
    initSupervisor(llm);
  });
}

async function prepareOutputEnrollmentLease(
  candidateConfig: Config,
  previousAuthority: RuntimeAuthority | null,
  sessionId: string | null
) {
  const outputRoot: PathRootInput = {
    rootId: "candidate-output",
    role: "output-enrollment-probe",
    configuredPath: candidateConfig.settings.outputDir,
    permissions: runtimeRootPermissions,
  };
  try {
    const probe = await pathPolicy.createAuthority([outputRoot]);
    pathPolicy.revoke(probe);
    return null;
  } catch (error) {
    if (!(error instanceof PathDeniedError) || error.code !== "PATH_ROOT_UNAVAILABLE") throw error;
  }
  if (!previousAuthority) throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", "Missing output root has no enrolled writable parent");
  return fileViewerService.prepareRootEnrollment(previousAuthority, Object.freeze({
    sessionId,
    runId: randomBytes(16).toString("hex"),
    principal: "local-user-api",
  }), candidateConfig.settings.outputDir);
}

interface SettingsEnrollmentBase {
  readonly config: Config;
  readonly digest: string;
  readonly registry: SessionRuntimeRegistry<AppSessionRuntime>;
  readonly sessionIds: readonly string[];
  readonly selectedSessionId: string | null;
  readonly selectedAuthority: RuntimeAuthority | null;
  readonly llm: LLMClient;
}

interface SettingsEnrollmentPlan {
  readonly config: Config;
  readonly registry: SessionRuntimeRegistry<AppSessionRuntime>;
  readonly outputLease: PathDirectoryEnrollmentLease | null;
}

async function enrollAppSettings(input: Parameters<typeof prepareAppSettingsUpdate>[0]): Promise<void> {
  return withRuntimeMutation(async () => {
    ensureRuntimeAccepting();
    const current = requireRuntimeRegistry();
    if (current.hasRunningSessions()) throw new Error("存在正在运行的 Session，不能更新根目录授权");
    invalidateAllPendingConsent();

    await executeSettingsEnrollment<SettingsEnrollmentBase, SettingsEnrollmentPlan>({
      captureBase: () => Object.freeze({
        config: getConfigSnapshot(),
        digest: getConfigRevisionDigest(),
        registry: current,
        sessionIds: current.loadedSessionIds(),
        selectedSessionId,
        selectedAuthority: selectedRuntime()?.authority ?? null,
        llm,
      }),
      prepareCandidate: async base => {
        const candidateConfig = prepareAppSettingsUpdate(input, base.config);
        await validateAppSettingsPaths(candidateConfig.settings, Object.freeze({
          sessionId: base.selectedSessionId,
          runId: randomBytes(16).toString("hex"),
          principal: "local-user-api",
        }));
        const outputLease = await prepareOutputEnrollmentLease(candidateConfig, base.selectedAuthority, base.selectedSessionId);
        try {
          const registry = await prepareRuntimeRegistry(base.sessionIds, candidateConfig.settings, base.llm);
          return Object.freeze({ config: candidateConfig, registry, outputLease });
        } catch (error) {
          if (outputLease) await outputLease.rollback();
          throw error;
        }
      },
      isBaseCurrent: base => getConfigRevisionDigest() === base.digest
        && runtimeRegistry === base.registry
        && selectedSessionId === base.selectedSessionId
        && base.sessionIds.length === base.registry.loadedSessionIds().length
        && base.sessionIds.every(sessionId => base.registry.get(sessionId) !== undefined),
      retireBase: async base => {
        await base.registry.shutdown();
        if (runtimeRegistry === base.registry) runtimeRegistry = null;
      },
      persistCandidate: plan => commitConfigSnapshot(plan.config),
      publishCandidate: plan => { runtimeRegistry = plan.registry; },
      commitCandidate: plan => { plan.outputLease?.commit(); },
      discardCandidate: async plan => {
        await plan.registry.shutdown().catch(() => undefined);
        if (plan.outputLease) await plan.outputLease.rollback();
      },
      recoverBase: async base => {
        await commitConfigSnapshot(base.config);
        const recovered = await prepareRuntimeRegistry(base.sessionIds, base.config.settings, base.llm);
        runtimeRegistry = recovered;
      },
      stopFailClosed: () => { runtimeRegistry = null; },
    });
  });
}

function validatePersonaToolIntegrity(loadedPersonas: PersonaDefinition[]): void {
  const available = new Set(getAllToolNames());
  const problems: string[] = [];

  for (const persona of loadedPersonas) {
    const missing = persona.tools.filter((toolName) => !available.has(toolName));
    if (missing.length > 0) {
      problems.push(`${persona.name}: ${missing.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`工具注册完整性检查失败，以下 persona 声明了未注册工具:\n${problems.join("\n")}`);
  }

  console.log(`✅ 工具注册完整性检查通过: ${available.size} 个工具 / ${loadedPersonas.length} 个 persona`);
}

async function reloadPersonaRegistry(): Promise<void> {
  personas = await reloadPersonas();
  validatePersonaToolIntegrity(personas);
}

// --- Express ---
const app = express();
app.use((_req, res, next) => {
  if (isShuttingDown) {
    res.status(503).json({ error: "服务正在关闭" });
    return;
  }
  next();
});
app.use((req, res, next) => {
  if (req.headers.host !== `${HOST}:${PORT}`) {
    res.status(403).json({ error: "不允许的本地控制面主机" });
    return;
  }
  const origin = req.header("Origin");
  if (origin !== undefined && origin !== LOCAL_ORIGIN) {
    res.status(403).json({ error: "不允许的跨域来源" });
    return;
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(origin === undefined || origin === LOCAL_ORIGIN ? null : new Error("不允许的跨域来源"), origin === undefined || origin === LOCAL_ORIGIN);
  },
}));
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err.message === "不允许的跨域来源") {
    res.status(403).json({ error: err.message });
    return;
  }
  next(err);
});
app.use(express.json({ limit: "10mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  next();
});
function constantTimeCredentialMatch(supplied: string, expected: string): boolean {
  const actualBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const publicMimeTypes: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
});
app.use(async (req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path === "/api" || req.path.startsWith("/api/")) {
    next();
    return;
  }
  try {
    const asset = await getBootstrapPathStore().readPublicAsset(req.path);
    res.setHeader("Content-Type", publicMimeTypes[asset.extension] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(asset.bytes.length));
    if (req.method === "HEAD") res.end();
    else res.end(asset.bytes);
  } catch (error) {
    if (error instanceof PathDeniedError) {
      if (error.code === "PATH_NOT_FOUND") next();
      else res.status(404).end();
      return;
    }
    next(error);
  }
});
app.use("/api", (req, res, next) => {
  const headerCredential = String(req.header("X-RainyDays-Token") || "");
  if (constantTimeCredentialMatch(headerCredential, API_TOKEN)) {
    next();
    return;
  }
  res.status(401).json({ error: "未授权的本地 API 请求" });
});
app.use("/api", (req, res, next) => {
  const rawQuerySessionId = req.query.sessionId;
  if (rawQuerySessionId !== undefined && typeof rawQuerySessionId !== "string") {
    res.status(400).json({ error: "Session runtime query identity 无效" });
    return;
  }
  const querySessionId = rawQuerySessionId as string | undefined;
  const headerSessionId = req.header("X-RainyDays-Session");
  if (headerSessionId !== undefined && querySessionId !== undefined && headerSessionId !== querySessionId) {
    res.status(400).json({ error: "Session runtime identity 冲突" });
    return;
  }
  const rawSessionId = headerSessionId ?? querySessionId;
  if (rawSessionId !== undefined
    && (rawSessionId.length < 1 || rawSessionId.length > 256 || rawSessionId.trim() !== rawSessionId
      || /[\u0000-\u001f\u007f]/u.test(rawSessionId))) {
    res.status(400).json({ error: "Session runtime identity 无效" });
    return;
  }
  directRequestSession.run(rawSessionId ?? null, next);
});

// ===========================================
// Persona API
// ===========================================
app.get("/api/personas", async (_req, res) => {
  if (personas.length === 0) personas = await listPersonas();
  res.json({
    personas: personas.map((p) => ({
      name: p.name, displayName: p.displayName, description: p.description, tools: p.tools,
    })),
    current: selectedPersona()?.name ?? draftPersonaName,
  });
});

app.post("/api/switch-persona", async (req, res) => {
  ensureRuntimeAccepting();
  const { name } = req.body;
  const rawPersona = await getPersona(name);
  if (!rawPersona) { res.status(404).json({ error: `Persona 不存在: ${name}` }); return; }
  const persona = applyRuntimeSettings(rawPersona);
  draftPersonaName = persona.name;
  selectSessionIdentity(null);

  console.log(`✅ Persona draft: ${persona.displayName} (${persona.name})`);
  res.json({
    success: true,
    persona: { name: persona.name, displayName: persona.displayName, description: persona.description, tools: persona.tools },
  });
});

// ===========================================
// File Viewer API
// ===========================================

app.get("/api/files/roots", async (_req, res) => {
  try {
    const roots = await runDirectOperation("file:roots", {}, (_args, _owner, authority) => fileViewerService.roots(authority));
    res.json({ roots });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/files/list", async (req, res) => {
  try {
    const args = {
      root: String(req.query.root || "workspace"),
      path: String(req.query.path || ""),
      offset: Number(req.query.offset || 0),
      limit: Number(req.query.limit || 200),
    };
    if (!Number.isFinite(args.offset) || !Number.isFinite(args.limit)) throw new Error("offset 和 limit 必须是数字");
    const result = await runDirectOperation("file:list", args, (authorized, _owner, authority, context) =>
      fileViewerService.list(authority, directPathAudit(context), String(authorized.root), String(authorized.path), Number(authorized.offset), Number(authorized.limit))
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/files/preview", async (req, res) => {
  try {
    const args = {
      root: String(req.query.root || "workspace"),
      path: String(req.query.path || ""),
      lineOffset: Number(req.query.lineOffset || 1),
      lineLimit: Number(req.query.lineLimit || 500),
    };
    if (!args.path) throw new Error("缺少文件路径");
    if (!Number.isFinite(args.lineOffset) || !Number.isFinite(args.lineLimit)) throw new Error("lineOffset 和 lineLimit 必须是数字");
    const result = await runDirectOperation("file:preview", args, (authorized, owner, authority, context) =>
      fileViewerService.preview(authority, directPathAudit(context), owner, String(authorized.root), String(authorized.path), Number(authorized.lineOffset), Number(authorized.lineLimit))
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/files/resolve", async (req, res) => {
  try {
    const args = { path: String(req.query.path || "") };
    if (!args.path) throw new Error("缺少绝对路径");
    const result = await runDirectOperation("file:resolve", args, (authorized, _owner, authority, context) =>
      fileViewerService.resolveAbsolute(authority, directPathAudit(context), String(authorized.path))
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/files/reveal", async (req, res) => {
  try {
    const args = { root: String(req.body?.root || "workspace"), path: String(req.body?.path || "") };
    if (!args.path) throw new Error("缺少文件路径");
    const result = await runDirectOperation("file:reveal", args, (authorized, _owner, authority, context) =>
      fileViewerService.reveal(authority, directPathAudit(context), String(authorized.root), String(authorized.path))
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/files/content", async (req, res) => {
  try {
    const args = {
      root: String(req.query.root || "workspace"),
      path: String(req.query.path || ""),
      range: typeof req.headers.range === "string" ? req.headers.range : null,
    };
    if (!args.path) throw new Error("缺少文件路径");
    await runDirectOperation("file:content", args, async (authorized, owner, authority, context) => {
      const content = await fileViewerService.content(authority, directPathAudit(context), owner, String(authorized.root), String(authorized.path));
      try {
        const requestedRange = authorized.range === null ? null : String(authorized.range);
        let start = 0;
        let end = content.size - 1;
        let partial = false;
        let invalidRange = false;
        if (requestedRange !== null) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(requestedRange.trim());
          if (!match || (!match[1] && !match[2])) invalidRange = true;
          else {
            partial = true;
            if (!match[1]) {
              const suffixLength = Number(match[2]);
              start = Math.max(content.size - suffixLength, 0);
            } else {
              start = Number(match[1]);
              end = match[2] ? Number(match[2]) : content.size - 1;
            }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= content.size) invalidRange = true;
            else end = Math.min(end, content.size - 1);
          }
        }

        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", content.mime);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Last-Modified", content.modifiedAt.toUTCString());
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(content.name)}`);
        if (invalidRange) {
          res.setHeader("Content-Range", `bytes */${content.size}`);
          res.status(416).end();
          return;
        }
        if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${content.size}`);
        res.setHeader("Content-Length", end - start + 1);
        res.status(partial ? 206 : 200);
        const responseClosed = new AbortController();
        const abortResponse = () => responseClosed.abort(new Error("File content response closed"));
        res.once("close", abortResponse);
        try {
          res.flushHeaders();
          const chunkBytes = 1024 * 1024;
          for (let offset = start; offset <= end; offset += chunkBytes) {
            const chunkEnd = Math.min(offset + chunkBytes - 1, end);
            const data = await content.readRange(offset, chunkEnd);
            if (!res.write(data)) await once(res, "drain", { signal: responseClosed.signal });
          }
          res.end();
        } finally {
          res.off("close", abortResponse);
        }
      } finally {
        await content.close();
      }
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    else res.destroy(err instanceof Error ? err : undefined);
  }
});

// ===========================================
// Persistent Terminal API
// ===========================================

app.get("/api/terminals", async (_req, res) => {
  try {
    const terminals = await runDirectOperation("terminal:list", {}, (_args, owner) => terminalFacade.list(owner));
    res.json({ terminals });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/terminals", async (req, res) => {
  try {
    await observeDirectTerminalHttpDenial("start", req.body);
    res.status(403).json({
      code: "EXEC_DIRECT_MUTATION_DENIED",
      error: "Direct HTTP terminal start is permanently denied",
    });
  } catch (error) {
    res.status(503).json({ code: "SECURITY_AUDIT_UNAVAILABLE", error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/terminals/:id/output", async (req, res) => {
  try {
    const offset = req.query.offset === undefined ? undefined : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 20000 : Number(req.query.limit);
    if (offset !== undefined && !Number.isFinite(offset)) throw new Error("offset 必须是数字");
    if (!Number.isFinite(limit)) throw new Error("limit 必须是数字");
    const result = await runDirectOperation("terminal:output", { id: req.params.id, offset: offset ?? null, limit }, (authorized, owner) =>
      terminalFacade.output(
        owner,
        String(authorized.id),
        authorized.offset === null ? undefined : Number(authorized.offset),
        Number(authorized.limit)
      )
    );
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/terminals/:id/input", async (req, res) => {
  try {
    await observeDirectTerminalHttpDenial("input", { id: req.params.id, body: req.body });
    res.status(403).json({
      code: "EXEC_DIRECT_MUTATION_DENIED",
      error: "Direct HTTP terminal input is permanently denied",
    });
  } catch (error) {
    res.status(503).json({ code: "SECURITY_AUDIT_UNAVAILABLE", error: error instanceof Error ? error.message : String(error) });
  }
});

for (const route of ["clear", "kill", "close"] as const) {
  const path = route === "close" ? "/api/terminals/:id" : `/api/terminals/:id/${route}`;
  app[route === "close" ? "delete" : "post"](path, async (req, res) => {
    try {
      await observeDirectTerminalHttpDenial(route, { id: req.params.id, body: req.body ?? null });
      res.status(403).json({
        code: "EXEC_DIRECT_MUTATION_DENIED",
        error: `Direct HTTP terminal ${route} is permanently denied`,
      });
    } catch (error) {
      res.status(503).json({ code: "SECURITY_AUDIT_UNAVAILABLE", error: error instanceof Error ? error.message : String(error) });
    }
  });
}

app.get("/api/terminals/:id/events", async (req, res) => {
  try {
    await runDirectOperation("terminal:subscribe", { id: req.params.id }, (authorized, owner, authority, context) => {
      const id = String(authorized.id);
      const ownerSessionId = context.sessionId;
      const info = terminalFacade.get(owner, id);
      if (!info) throw new Error(`终端不存在: ${id}`);
      const initial = terminalFacade.output(owner, id, undefined, 50000);
      let ready = false;
      let closed = false;
      const pendingEvents: unknown[] = [];
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => undefined;
      let closeTracked: () => void = () => undefined;

      const closeBase = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      };

      unsubscribe = terminalFacade.subscribe(owner, id, (event) => {
        if (isShuttingDown || runtimeRegistry?.get(ownerSessionId)?.authority !== authority) {
          closeTracked();
          return;
        }
        if (ready) res.write(`data: ${JSON.stringify(event)}\n\n`);
        else pendingEvents.push(event);
      });
      closeTracked = registerRuntimeSubscription(authority, closeBase);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "snapshot", terminalId: id, ...initial })}\n\n`);
      ready = true;
      for (const event of pendingEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);

      heartbeat = setInterval(() => {
        if (isShuttingDown || runtimeRegistry?.get(ownerSessionId)?.authority !== authority) {
          closeTracked();
          return;
        }
        res.write(": heartbeat\n\n");
      }, 15000);
      heartbeat.unref?.();
      req.once("close", closeTracked);
    });
  } catch (err) {
    if (!res.headersSent) res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ===========================================
// Session API
// ===========================================

/** 列出所有会话 */
app.get("/api/sessions", (_req, res) => {
  const sessions = getAllSessions();
  res.json({ sessions, current: selectedSessionId });
});

/** 创建新会话 */
app.post("/api/sessions", async (req, res) => {
  const persona = selectedPersona();
  if (!persona) { res.status(400).json({ error: "请先选择 persona" }); return; }
  const title = (req.body?.title as string) || "新对话";
  try {
    const session = await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const created = createSession(persona, title);
      try {
        await requireRuntimeRegistry().ensure(created.id);
      } catch (error) {
        removeSession(created.id);
        throw error;
      }
      selectSessionIdentity(created.id);
      return created;
    });
    console.log(`✅ 新会话: ${session.id} (${persona.displayName})`);
    res.json({ session });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** 切换到指定会话；只改变 UI selection，不退休其他 Session runtime。 */
app.post("/api/sessions/:id/select", async (req, res) => {
  const id = req.params.id;
  const session = getSessionInfo(id);
  if (!session) { res.status(404).json({ error: "会话不存在" }); return; }
  if (!personas.some(persona => persona.name === session.persona_name)) {
    res.status(409).json({ error: `会话绑定的 Persona 不可用: ${session.persona_name}` });
    return;
  }
  try {
    const runtime = await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const loaded = await requireRuntimeRegistry().ensure(id);
      selectSessionIdentity(id);
      touch(id);
      return loaded;
    });
    console.log(`✅ 切换会话: ${id} (${session.title})`);
    res.json({ session, persona: runtime.persona.name });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** 获取会话的消息历史 */
app.get("/api/sessions/:id/messages", (req, res) => {
  const id = req.params.id;
  const session = getSessionInfo(id);
  if (!session) { res.status(404).json({ error: "会话不存在" }); return; }
  const messages = loadSessionMessages(id);
  res.json({ session, messages });
});

/** 删除会话 */
app.delete("/api/sessions/:id", async (req, res) => {
  const id = req.params.id;
  if (!getSessionInfo(id)) { res.status(404).json({ error: "会话不存在" }); return; }
  try {
    await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const registry = requireRuntimeRegistry();
      if (registry.isRunning(id)) throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Agent 正在运行，不能删除该会话");
      await registry.retire(id);
      removeSession(id);
      if (selectedSessionId === id) selectSessionIdentity(null);
    });
    console.log(`🗑️ 删除会话: ${id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(error instanceof SessionRuntimeLifecycleError && error.code === "SESSION_RUNTIME_BUSY" ? 409 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** 重命名会话 */
app.patch("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  const title = req.body?.title as string;
  if (!title) { res.status(400).json({ error: "缺少 title" }); return; }
  if (!renameSession(id, title)) { res.status(404).json({ error: "会话不存在" }); return; }
  res.json({ success: true });
});

// ===========================================
// Task API
// ===========================================

/** 获取会话的任务列表 */
app.get("/api/sessions/:id/tasks", (req, res) => {
  const id = req.params.id;
  const session = getSessionInfo(id);
  if (!session) { res.status(404).json({ error: "会话不存在" }); return; }
  const tasks = getTasksBySession(id);
  res.json({ tasks });
});

/** 获取已加载 Session runtime 的后台 Subagent 状态；查询不会隐式创建 runtime。 */
app.get("/api/sessions/:id/subagents", (req, res) => {
  const id = req.params.id;
  const session = getSessionInfo(id);
  if (!session) { res.status(404).json({ error: "会话不存在" }); return; }
  res.json({ subagents: runtimeRegistry?.get(id)?.subagents.list() ?? [] });
});

// ===========================================
// Pin API（固定指令）
// ===========================================

/** 列出会话的 Pin */
app.get("/api/sessions/:id/pins", (req, res) => {
  const pins = getPinsBySession(req.params.id);
  res.json({ pins });
});

/** 添加 Pin */
app.post("/api/sessions/:id/pins", (req, res) => {
  const content = req.body?.content as string;
  if (!content) { res.status(400).json({ error: "缺少 content" }); return; }
  const id = insertPin(req.params.id, content);
  res.json({ success: true, id });
});

/** 删除 Pin */
app.delete("/api/sessions/:id/pins/:pinId", (req, res) => {
  deletePin(parseInt(req.params.pinId, 10));
  res.json({ success: true });
});

// ===========================================
// Rollback API（回退到上一个用户消息）
// ===========================================

app.post("/api/sessions/:id/rollback", async (req, res) => {
  const id = req.params.id;
  if (!getSessionInfo(id)) { res.status(404).json({ error: "会话不存在" }); return; }
  try {
    const deleted = await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const registry = requireRuntimeRegistry();
      if (registry.isRunning(id)) throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Agent 正在运行，不能回退该会话");
      const count = deleteMessagesAfterLastUserMessage(id);
      registry.get(id)?.agent.setSession(id);
      return count;
    });
    res.json({ success: true, deletedMessages: deleted });
  } catch (error) {
    res.status(error instanceof SessionRuntimeLifecycleError && error.code === "SESSION_RUNTIME_BUSY" ? 409 : 400)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ===========================================
// Search API（跨会话搜索）
// ===========================================
app.get("/api/search", (req, res) => {
  const q = (req.query.q as string) || "";
  if (!q.trim()) { res.json({ results: [] }); return; }
  const results = searchSessions(q.trim());
  res.json({ query: q, results });
});

// ===========================================
// Fork API（从指定消息处分叉新会话）
// ===========================================
app.post("/api/sessions/:id/fork", async (req, res) => {
  const id = req.params.id;
  const messageId = req.body?.messageId as number | undefined;
  const source = getSessionInfo(id);
  if (!source) { res.status(404).json({ error: "源会话不存在" }); return; }
  const rawPersona = personas.find(persona => persona.name === source.persona_name);
  if (!rawPersona) { res.status(409).json({ error: `源会话绑定的 Persona 不可用: ${source.persona_name}` }); return; }

  try {
    const newSession = await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      if (requireRuntimeRegistry().isRunning(id)) {
        throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Agent 正在运行，不能 Fork 该会话");
      }
      const created = forkSession(id, messageId || null, applyRuntimeSettings(rawPersona));
      try {
        await requireRuntimeRegistry().ensure(created.id);
      } catch (error) {
        removeSession(created.id);
        throw error;
      }
      return created;
    });
    console.log(`🔱 Fork: ${id} → ${newSession.id}`);
    res.json({ session: newSession });
  } catch (err) {
    res.status(err instanceof SessionRuntimeLifecycleError && err.code === "SESSION_RUNTIME_BUSY" ? 409 : 400)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ===========================================
// Export API（导出会话）
// ===========================================
app.get("/api/sessions/:id/export", (req, res) => {
  const id = req.params.id;
  try {
    const data = exportSession(id);
    if (!data) { res.status(404).json({ error: "会话不存在" }); return; }
    const safeName = (data.session.title || "export").replace(/[^\w\u4e00-\u9fa5]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.json"`);
    res.json(data);
  } catch (error) {
    if (error instanceof SessionExportError) {
      res.status(413).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

// ===========================================
// Import API（导入会话）
// ===========================================
app.post("/api/sessions/import", async (req, res) => {
  const persona = selectedPersona();
  if (!persona) { res.status(400).json({ error: "请先选择 persona" }); return; }
  try {
    const newSession = await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const created = importSession(req.body, persona);
      try {
        await requireRuntimeRegistry().ensure(created.id);
      } catch (error) {
        removeSession(created.id);
        throw error;
      }
      return created;
    });
    console.log(`📥 导入会话: ${newSession.id}`);
    res.json({ session: newSession });
  } catch (err) {
    if (err instanceof SessionImportError) {
      res.status(400).json({
        error: err.message,
        code: err.code,
        foundVersion: err.foundVersion ?? null,
        supportedFormatVersion: BUILD_INFO.versions.sessionExport,
      });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), code: "SESSION_IMPORT_FAILED" });
  }
});

// ===========================================
// Settings / Provider API
// ===========================================

/** 查询设置。API Key 永远只返回掩码和 hasApiKey。 */
app.get("/api/settings", (_req, res) => {
  res.json(getPublicConfig());
});

/** 保存通用设置并立即刷新当前 persona 的运行时路径。 */
app.put("/api/settings/general", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  try {
    const defaultPersona = req.body?.defaultPersona as string | undefined;
    if (defaultPersona && !personas.some((p) => p.name === defaultPersona)) {
      res.status(400).json({ error: `默认 Persona 不存在: ${defaultPersona}` });
      return;
    }

    await enrollAppSettings({
      defaultProfile: req.body?.defaultProfile,
      defaultPersona,
      workspaceRoot: req.body?.workspaceRoot,
      departmentDataRoot: req.body?.departmentDataRoot,
      outputDir: req.body?.outputDir,
    });
    res.json({ success: true, settings: getPublicConfig() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 新增或更新 Provider。apiKey 为空时保留已有密钥。 */
app.put("/api/settings/providers/:name", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  try {
    const name = req.params.name;
    const rebuild = name === getCurrentProfileName();
    await mutateGlobalConfigAndRuntimes(() => upsertProfile(name, {
      model: req.body?.model,
      baseURL: req.body?.baseURL,
      apiKey: req.body?.apiKey,
      providerType: req.body?.providerType,
    }), rebuild);
    res.json({ success: true, settings: getPublicConfig() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/settings/providers/:name", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  try {
    await mutateGlobalConfigAndRuntimes(() => deleteProfile(req.params.name), false);
    res.json({ success: true, settings: getPublicConfig() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/providers", (_req, res) => {
  res.json({ profiles: listProfiles() });
});

app.post("/api/providers/switch", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  const { name } = req.body;
  if (!getConfigSnapshot().profiles[name]) { res.status(404).json({ error: `Profile 不存在: ${name}` }); return; }
  try {
    await mutateGlobalConfigAndRuntimes(() => {
      if (!switchProfile(name)) throw new Error(`Profile 不存在: ${name}`);
    }, true);
    const profile = getCurrentProfile();
    console.log(`✅ Provider 切换: ${name} (${profile.model})`);
    res.json({ success: true, model: profile.model, configured: Boolean(profile.apiKey) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ===========================================
// Skill API（运行时技能管理）
// ===========================================
app.get("/api/skills", async (_req, res) => {
  const skills = await listAvailableSkills();
  res.json({ skills });
});

app.get("/api/skills/:name", async (req, res) => {
  const content = await loadSkillContent(req.params.name);
  if (!content) { res.status(404).json({ error: "Skill 不存在" }); return; }
  res.json({ name: req.params.name, content });
});

app.get("/api/version", (_req, res) => {
  res.json(getPublicVersionInfo());
});

app.get("/api/diagnostics", async (_req, res) => {
  try {
    if (!securityAuditJournal) throw new Error("Security audit journal is unavailable");
    const audit = await securityAuditJournal.verify();
    const profile = getCurrentProfile();
    const safeBuildId = artifactSafeBuildId(BUILD_ID);
    res.setHeader("Content-Disposition", `attachment; filename="rainydays-diagnostics-${safeBuildId}.json"`);
    res.json({
    generatedAt: new Date().toISOString(),
    version: getPublicVersionInfo(),
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || process.env.RAINYDAYS_ELECTRON_VERSION || null,
      platform: process.platform,
      arch: process.arch,
    },
    databaseSchemaVersion: getDatabaseSchemaVersion(),
    securityAudit: audit,
    protocols: structuredClone(PROTOCOL_CAPABILITIES),
    state: {
      configured: Boolean(profile.apiKey),
      activeProfile: getCurrentProfileName(),
      activePersona: selectedPersona()?.name ?? null,
      activeSession: Boolean(selectedSessionId),
    },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/status", (_req, res) => {
  const profile = getCurrentProfile();
  const runtime = selectedRuntime();
  const registry = runtimeRegistry;
  res.json({
    version: getPublicVersionInfo(),
    model: profile.model,
    provider: profile.baseURL,
    profile: getCurrentProfileName(),
    configured: Boolean(profile.apiKey),
    tokens: runtime?.memory.getTokenEstimate() ?? 0,
    messageCount: runtime?.memory.getMessageCount() ?? 0,
    hasSummary: runtime?.memory.hasSummary() ?? false,
    persona: runtime?.persona.name ?? selectedPersona()?.name ?? null,
    sessionId: selectedSessionId,
    selectedSessionId,
    runtimes: registry?.loadedSessionIds().map(sessionId => ({
      sessionId,
      running: registry.isRunning(sessionId),
      persona: registry.get(sessionId)?.persona.name ?? null,
      tokens: registry.get(sessionId)?.memory.getTokenEstimate() ?? 0,
      messageCount: registry.get(sessionId)?.memory.getMessageCount() ?? 0,
    })) ?? [],
    profiles: listProfiles(),
  });
});

// ===========================================
// Chat API
// ===========================================
app.post("/api/chat/cancel", async (req, res) => {
  let sessionId: string;
  try {
    sessionId = resolveBodySessionIdentity(req.body?.sessionId, true)!;
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const runId = req.body?.runId;
  if (typeof runId !== "string" || runId.length < 1 || runId.length > 256 || runId.trim() !== runId) {
    res.status(400).json({ error: "Run identity 无效" });
    return;
  }
  const active = activeRunInteractions.get(sessionId);
  if (!active || active.runId !== runId) {
    res.status(409).json({ error: "Run 已结束或 identity 不匹配" });
    return;
  }
  try {
    await cancelActiveRun(requireRuntimeRegistry(), active, "user-stop");
    res.status(200).json({ cancelled: true, settled: true, sessionId, runId });
  } catch (error) {
    res.status(error instanceof SessionRuntimeLifecycleError ? 409 : 503)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") { res.status(400).json({ error: "缺少 message" }); return; }
  let chatSessionId: string;
  try {
    chatSessionId = resolveBodySessionIdentity(req.body?.sessionId, true)!;
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!getSessionInfo(chatSessionId)) { res.status(404).json({ error: "Session 不存在" }); return; }
  if (!getCurrentProfile().apiKey) { res.status(400).json({ error: "当前 Provider 尚未配置 API Key，请先打开 Settings 完成配置" }); return; }
  if (runtimeMutationReservations > 0) { res.status(409).json({ error: "Session runtime 正在变更" }); return; }

  const registry = requireRuntimeRegistry();
  let runtime: AppSessionRuntime;
  try {
    runtime = await registry.ensure(chatSessionId);
    if (runtimeMutationReservations > 0 || runtimeRegistry !== registry) throw new Error("Session runtime 正在变更");
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const runId = randomUUID();
  let claim;
  try {
    claim = registry.claimRun(chatSessionId, runId);
  } catch (error) {
    res.status(error instanceof SessionRuntimeLifecycleError && error.code === "SESSION_RUNTIME_BUSY" ? 409 : 400)
      .json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const identity: ActiveRun = Object.freeze({ sessionId: chatSessionId, runId });
  activeRunInteractions.set(chatSessionId, identity);
  let streamOpen = true;
  let status: "idle" | "error" = "idle";
  const emit = (event: unknown) => {
    if (streamOpen && !res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const closeInteraction = () => {
    streamOpen = false;
    try { void cancelActiveRun(registry, identity, "client-disconnect"); }
    catch { /* The run may already have settled while the response was closing. */ }
  };
  res.once("close", closeInteraction);
  updateSessionStatus(chatSessionId, "running");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  emit({ type: "run_started", sessionId: chatSessionId, runId, timestamp: Date.now() });

  const unlinkMsg = onMessage(chatSessionId, msg => emit({
    type: "link_message",
    sessionId: chatSessionId,
    runId,
    from: msg.from,
    content: msg.content,
    timestamp: msg.timestamp,
  }));

  let cancellationCleanupFailure: unknown = undefined;
  try {
    await runWithInteractionChannel(identity, { emit, signal: claim.signal }, async () => {
      let input: string | null = message;
      while (input !== null) {
        for await (const step of runtime.agent.run(input, runId, claim.signal)) emit(step);
        input = takeActiveRunInjection(chatSessionId, claim.signal);
      }
    });
  } catch (error) {
    const cancelled = isRunCancellation(error);
    if (isRunSettlementFailure(error) || (claim.signal.aborted && !cancelled)) cancellationCleanupFailure = error;
    status = cancelled ? "idle" : "error";
    emit({
      type: cancelled ? "run_cancelled" : "error",
      sessionId: chatSessionId,
      runId,
      content: cancelled
        ? `运行已取消: ${error instanceof Error ? error.message : String(error)}`
        : `Agent 运行出错: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    });
  } finally {
    unlinkMsg();
    res.off("close", closeInteraction);
    if (activeRunInteractions.get(chatSessionId) === identity) activeRunInteractions.delete(chatSessionId);
    clearActiveRunInjections(chatSessionId);
    updateSessionStatus(chatSessionId, status);
    try { registry.releaseRun(claim, cancellationCleanupFailure); }
    catch (error) {
      if (!(error instanceof SessionRuntimeLifecycleError) || error.code !== "SESSION_RUNTIME_CLAIM_STALE") throw error;
    }
    if (streamOpen && !res.writableEnded) res.end();
  }
});

// ===========================================
// Ask User API（用户提交回答）
// ===========================================
app.post("/api/ask-user/answer", (req, res) => {
  const { runId, questionId, answer } = req.body;
  let sessionId: string;
  try {
    sessionId = resolveBodySessionIdentity(req.body?.sessionId, true)!;
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (![runId, questionId, answer].every(value => typeof value === "string" && value.length > 0)) {
    res.status(400).json({ error: "缺少 runId、questionId 或 answer" });
    return;
  }
  const success = submitAnswer(sessionId, runId, questionId, answer);
  res.status(success ? 200 : 409).json({ success });
});

/** 清空指定会话的内存（不删数据库，只清空该 runtime 的内存上下文）。 */
app.post("/api/clear", async (req, res) => {
  let sessionId: string | null;
  try {
    sessionId = resolveBodySessionIdentity(req.body?.sessionId, false);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!sessionId || !getSessionInfo(sessionId)) { res.status(404).json({ error: "Session 不存在或未选择" }); return; }
  try {
    await withRuntimeMutation(async () => {
      ensureRuntimeAccepting();
      const registry = requireRuntimeRegistry();
      if (registry.isRunning(sessionId)) throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Agent 正在运行，不能清空该会话");
      const runtime = await registry.ensure(sessionId);
      runtime.memory.clear();
      runtime.memory.setSystemPrompt(runtime.persona.systemPrompt);
    });
    res.json({ success: true });
  } catch (error) {
    res.status(error instanceof SessionRuntimeLifecycleError && error.code === "SESSION_RUNTIME_BUSY" ? 409 : 400)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ===========================================
// EVT-01 —— EventBus 接入与 Session 唤醒策略
// ack = run 已 claim（claimRun 原子成功）→ at-most-once 注入；
// claim 与 ack 落库之间的崩溃窗口只可能丢唤醒、不会重复注入（冻结合同）。
// 运行中的目标 → retry 退避（真正的运行中注入属 EVT-02）。
// ===========================================
function eventInputMessage(event: EventEnvelope, mode: "wake" | "inject"): string {
  return `[事件${mode === "wake" ? "唤醒" : "注入"} ${event.type} ${event.id}]\n${JSON.stringify(event.payload, null, 2)}`;
}

async function eventSessionDeliveryHandler(event: EventEnvelope): Promise<SessionDeliveryOutcome> {
  const sessionId = event.targetSessionId;
  if (!sessionId) return { outcome: "dead", error: "事件缺少 targetSessionId" };
  if (!getSessionInfo(sessionId)) return { outcome: "dead", error: `目标 Session 不存在: ${sessionId}` };
  if (!getCurrentProfile().apiKey) return { outcome: "retry", error: "当前 Provider 未配置 API Key" };
  if (runtimeMutationReservations > 0 || !runtimeRegistry) return { outcome: "retry", error: "Session runtime 正在变更" };

  const registry = requireRuntimeRegistry();
  let runtime: AppSessionRuntime;
  try {
    runtime = await registry.ensure(sessionId);
    if (runtimeMutationReservations > 0 || runtimeRegistry !== registry) throw new Error("Session runtime 正在变更");
  } catch (error) {
    return { outcome: "retry", error: error instanceof Error ? error.message : String(error) };
  }

  // EVT-02：运行中的目标不再退避；注入当前 active flow 的 follow-up 队列。
  if (registry.isRunning(sessionId)) {
    return enqueueActiveRunInjection(sessionId, eventInputMessage(event, "inject"))
      ?? { outcome: "retry", error: "Session 注入队列不可用或已满" };
  }

  const runId = randomUUID();
  let claim;
  try {
    claim = registry.claimRun(sessionId, runId);
  } catch (error) {
    if (error instanceof SessionRuntimeLifecycleError && error.code === "SESSION_RUNTIME_BUSY") {
      return { outcome: "retry", error: "Session 正在运行" };
    }
    return { outcome: "retry", error: error instanceof Error ? error.message : String(error) };
  }

  // SEC-06：wake 决策走既有审计轨迹（system 触发的本地操作）。
  const journal = securityAuditJournal;
  const audit = journal
    ? new DirectOperationAuditTrail(journal, `event-wake:${event.type}`, { eventId: event.id, targetSessionId: sessionId }, null, sessionId)
    : null;
  if (audit) {
    try {
      await audit.request({ eventId: event.id });
      await audit.authorize("allowed", null);
      await audit.execution(true);
    } catch {
      // 审计写入失败不启动 run（宁可重试唤醒，不可脱离审计启动）。
      try { registry.releaseRun(claim); } catch { /* claim 可能已失效 */ }
      return { outcome: "retry", error: "安全审计写入失败" };
    }
  }

  // ack-on-claim：claim 原子成功即确认投递。run 以 setImmediate 启动，
  // 让 dispatch 循环的 ack 落库（同步 SQLite 写）先于 run 消费。
  setImmediate(() => {
    runOutsideInteractionChannel(() => {
      void (async () => {
        const startedAt = Date.now();
      const identity: ActiveRun = Object.freeze({ sessionId, runId });
      activeRunInteractions.set(sessionId, identity);
      updateSessionStatus(sessionId, "running");
      let status: "idle" | "error" = "idle";
      let settlementFailure: unknown = undefined;
      try {
        await runWithInteractionChannel(identity, { emit: () => undefined, signal: claim.signal }, async () => {
          let input: string | null = eventInputMessage(event, "wake");
          while (input !== null) {
            for await (const step of runtime.agent.run(input, runId, claim.signal)) {
              if (step?.type === "error") status = "error";
            }
            input = takeActiveRunInjection(sessionId, claim.signal);
          }
        });
      } catch (error) {
        const cancelled = isRunCancellation(error);
        if (isRunSettlementFailure(error) || (claim.signal.aborted && !cancelled)) settlementFailure = error;
        status = cancelled ? "idle" : "error";
        if (!cancelled) console.error("⚠️ 事件 Session flow 失败:", error instanceof Error ? error.stack || error.message : String(error));
      } finally {
        if (activeRunInteractions.get(sessionId) === identity) activeRunInteractions.delete(sessionId);
        clearActiveRunInjections(sessionId);
        updateSessionStatus(sessionId, status);
        try {
          registry.releaseRun(claim, settlementFailure);
        } catch (error) {
          if (!(error instanceof SessionRuntimeLifecycleError) || error.code !== "SESSION_RUNTIME_CLAIM_STALE") {
            console.error("⚠️ 事件唤醒 run 结算失败:", error instanceof Error ? error.message : String(error));
          }
        }
        if (audit) {
          try {
            await audit.result({ eventId: event.id, status }, Date.now() - startedAt, status === "idle" ? "success" : "error", null);
          } catch { /* 结果审计失败已由 journal 毒化机制兜底 */ }
        }
        }
      })();
    });
  });
  // 广播批次的 handler 在同一 turn 内串行执行；让出一次 setImmediate，保证刚调度的
  // idle flow 真正开始，避免后续目标的审计/claim 阻塞前序 flow 启动。
  await new Promise<void>(resolve => setImmediate(resolve));
  return { outcome: "acked" };
}

/** 启动 EventBus：先接持久层（早于 cron 恢复，避免启动窗口丢事件），会话恢复后装策略并启动调度。 */
function attachEventStores(): void {
  getDefaultEventBus().attachStore(createEventStore());
  getDefaultPollManager().attachStore(createPollStore());
}

function startEventDispatch(): void {
  const bus = getDefaultEventBus();
  bus.setSessionDelivery(eventSessionDeliveryHandler);
  bus.start();
  getDefaultPollManager().start();
}

// --- Cron Manager ---
let cronManager: CronManager | null = null;

// EVT-02：每个目标一个稳定 v1 envelope；全部持久化后 CronManager 才推进 slot。
// 广播部分成功后重试同 slot，EventBus (source, sourceEventId) dedupe 保证不重复副作用。
async function onCronFire(job: CronJobRow, scheduledAt: string): Promise<boolean> {
  console.log(`⏰ 定时任务触发: ${job.message}`);
  const targetIds = job.broadcast === 1
    ? [...new Set(discoverSessions().map(session => session.id))].sort()
    : [job.target_session_id ?? job.session_id].filter((value): value is string => typeof value === "string" && value.length > 0);
  const observedAt = new Date().toISOString();
  for (const targetSessionId of targetIds) {
    const result = await getDefaultEventBus().publish({
      type: "cron.triggered",
      source: "cron",
      sourceEventId: `job:${job.id}:${scheduledAt}:${createHash("sha256").update(targetSessionId).digest("hex").slice(0, 16)}`,
      targetSessionId,
      // Cron tag 是用户-facing 管理标签（可含中文/空格）；不得直接进入 EventBus machine tags。
      tags: [],
      payload: {
        jobId: job.id,
        message: job.message,
        tag: job.tag,
        scheduledAt,
        observedAt,
        targetSessionId,
        broadcast: job.broadcast === 1,
      },
    });
    if (result.status === "rejected") return false;
  }
  markMemoRemindedByCronJob(job.id, scheduledAt);
  return true;
}

// ===========================================
// Cron SSE —— 定时任务触发推送（legacy 形状，由 EventBus 供给）
// ===========================================
app.get("/api/cron/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const removeListener = getDefaultEventBus().addListener("cron.triggered", event => {
    const payload = event.payload as { jobId?: number; message?: string };
    res.write(`data: ${JSON.stringify({
      type: "cron_triggered",
      message: typeof payload?.message === "string" ? payload.message : "",
      jobId: typeof payload?.jobId === "number" ? payload.jobId : null,
      timestamp: event.createdAt,
    })}\n\n`);
  });

  req.on("close", () => {
    removeListener();
  });
});

// ===========================================
// External event ingress (EVT-03) —— authenticated adapter/webhook/test input
// target 由 Poll subscription 匹配决定，调用方不得指定 Session。
// ===========================================
app.post("/api/events", async (req, res) => {
  if (req.body?.targetSessionId !== undefined || req.body?.target !== undefined) {
    res.status(400).json({ error: "external event 不允许指定 target" });
    return;
  }
  try {
    const result = await getDefaultPollManager().ingest({
      sourceEventId: req.body?.sourceEventId,
      source: req.body?.source,
      tags: req.body?.tags,
      payload: req.body?.payload,
      createdAt: req.body?.createdAt,
    });
    res.status(202).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ===========================================
// 统一事件 SSE (EVT-01) —— 全量 envelope 流（UI 接入面）
// ===========================================
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const removeListener = getDefaultEventBus().addListener("*", event => {
    res.write(`data: ${JSON.stringify({ type: "event", event: {
      id: event.id,
      type: event.type,
      source: event.source,
      targetSessionId: event.targetSessionId,
      tags: event.tags,
      payload: event.payload,
      createdAt: event.createdAt,
    } })}\n\n`);
  });

  req.on("close", () => {
    removeListener();
  });
});

// ===========================================
// 启动
// ===========================================
async function start() {
  childNativeProcessConsentCleanup = await installInheritedNativeProcessConsentTransport();
  await initializeConfig();
  securityAuditJournal = await openSecurityAuditJournal();
  await securityAuditJournal.verify();
  attachEventStores(); // EVT-01/03：先接持久层再恢复 cron/外部事件，避免启动窗口丢事件
  llm = createLlmClient();
  personas = await listPersonas();
  console.log(`✅ 已加载 ${personas.length} 个 persona`);
  for (const p of personas) console.log(`   • ${p.displayName} (${p.name})`);

  cronManager = new CronManager(onCronFire);
  setMemoCronCallbacks({
    schedule: job => cronManager?.scheduleJob(job),
    cancel: id => cronManager?.cancelJob(id),
  });
  cronManager.loadFromDb();
  initSupervisor(llm);

  const sessions = getAllSessions();
  for (const session of sessions) ensureSessionLinkRegistration(session.id, session.title);

  runtimeRegistry = createRuntimeRegistry(getAppSettings(), llm);
  if (personas.length > 0) {
    const configuredDefault = getAppSettings().defaultPersona;
    const rawDefaultPersona = personas.find(persona => persona.name === configuredDefault) || personas[0];
    draftPersonaName = rawDefaultPersona.name;

    for (const session of sessions) {
      if (!personas.some(persona => persona.name === session.persona_name)) {
        console.warn(`⚠️ 无法恢复会话 ${session.id}: Persona ${session.persona_name} 不可用`);
        continue;
      }
      try {
        await runtimeRegistry.ensure(session.id);
      } catch (error) {
        console.warn(`⚠️ 会话运行时恢复失败: ${session.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (sessions.length > 0) {
      const latestSession = sessions[0];
      if (personas.some(persona => persona.name === latestSession.persona_name)) {
        selectSessionIdentity(latestSession.id);
        console.log(`✅ 自动恢复会话: ${latestSession.title}`);
      }
    }

    console.log(`✅ 默认 persona: ${rawDefaultPersona.displayName}`);
  }

  // 工具注册完整性启动自检：所有 persona 声明的工具必须真实可执行。
  validatePersonaToolIntegrity(personas);
  startEventDispatch(); // EVT-01/03：会话恢复完成后再开始 EventBus/Poll 调度

  const activeProfile = getCurrentProfile();
  console.log(JSON.stringify({
    event: "rainydays_version",
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    databaseSchemaVersion: getDatabaseSchemaVersion(),
    sessionExportVersion: BUILD_INFO.versions.sessionExport,
    protocols: PROTOCOL_CAPABILITIES,
  }));
  console.log(`✅ LLM: ${activeProfile.baseURL} / ${activeProfile.model} (profile: ${getCurrentProfileName()}, configured: ${Boolean(activeProfile.apiKey)})`);
  console.log(`✅ 配置: ${getConfigPath()}`);
  console.log(`✅ 数据库: ${path.join(DATA_DIR, "mini-lux.db")}`);

  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(PORT, HOST, () => {
      console.log(`\n🚀 RainyDays ${APP_VERSION} (${BUILD_ID}) 已启动: http://${HOST}:${PORT}/\n`);
      resolve();

      migrateMissingEmbeddings().catch((err) => {
        console.error("⚠️ 记忆向量迁移失败:", err instanceof Error ? err.message : String(err));
      });
    });
    httpServer.once("error", reject);
  });
}

/** 注册 cron 工具的动态 executor */
function registerDynamicToolCron(authority: RuntimeAuthority): void {
  registerDynamicTool(authority, {
    name: "cron_schedule",
    definition: cronScheduleDef,
    executor: createCronScheduleExec((job) => {
      cronManager?.scheduleJob(job);
    }),
  });
  registerDynamicTool(authority, {
    name: "cron_cancel",
    definition: cronCancelDef,
    executor: createCronCancelExec((id) => {
      cronManager?.cancelJob(id);
    }),
  });
}

/**
 * 注册所有需要运行时依赖的动态工具
 * 在启动和切换 persona 时调用（subagent 依赖当前 persona）
 */
function registerDynamicTools(
  authority: RuntimeAuthority,
  persona: PersonaDefinition,
  runtimeMemory: ConversationMemory,
  runtimeLlm: LLMClient,
  subagents: SubagentRegistry,
  settings: AppSettings,
): void {
  registerDynamicToolCron(authority);

  const subagentExecutors = createSubagentExecutors({
    registry: subagents,
    llm: runtimeLlm,
    persona,
    memory: runtimeMemory,
    resolvePersona: name => {
      if (name === persona.name) return persona;
      const candidate = personas.find(entry => entry.name === name);
      return candidate ? applyRuntimeSettings(candidate, settings) : null;
    },
  });
  registerDynamicTool(authority, {
    name: "subagent", definition: subagentDef, executor: subagentExecutors.subagent,
  });
  registerDynamicTool(authority, {
    name: "subagent_list", definition: subagentListDef, executor: subagentExecutors.subagent_list,
  });
  registerDynamicTool(authority, {
    name: "subagent_output", definition: subagentOutputDef, executor: subagentExecutors.subagent_output,
  });
  registerDynamicTool(authority, {
    name: "subagent_peek", definition: subagentPeekDef, executor: subagentExecutors.subagent_peek,
  });
  registerDynamicTool(authority, {
    name: "subagent_post", definition: subagentPostDef, executor: subagentExecutors.subagent_post,
  });
  registerDynamicTool(authority, {
    name: "subagent_stop", definition: subagentStopDef, executor: subagentExecutors.subagent_stop,
  });
  registerDynamicTool(authority, {
    name: "subagent_wait", definition: subagentWaitDef, executor: subagentExecutors.subagent_wait,
  });

  // curate —— 需要 memory + llm
  registerDynamicTool(authority, {
    name: "curate",
    definition: curateDef,
    executor: createCurateExec(runtimeMemory, runtimeLlm),
  });

  // consolidate —— 需要 llm
  registerDynamicTool(authority, {
    name: "consolidate",
    definition: consolidateDef,
    executor: createConsolidateExec(runtimeLlm),
  });

  // oracle_query —— 需要 llm
  registerDynamicTool(authority, {
    name: "oracle_query",
    definition: oracleQueryDef,
    executor: createOracleQueryExec(runtimeLlm),
  });

  // muse —— 需要 llm
  registerDynamicTool(authority, {
    name: "muse",
    definition: museDef,
    executor: createMuseExec({ registry: subagents, llm: runtimeLlm, persona }),
  });

  // playbook_execute —— 需要 llm + persona
  registerDynamicTool(authority, {
    name: "playbook_execute",
    definition: playbookExecuteDef,
    executor: createPlaybookExecuteExec(runtimeLlm, { systemPrompt: persona.systemPrompt }),
  });

  // playbook_abort —— 静态执行器
  registerDynamicTool(authority, {
    name: "playbook_abort",
    definition: playbookAbortDef,
    executor: playbookAbortExec,
  });

  // save_persona —— 需要获取当前 persona 配置
  registerDynamicTool(authority, {
    name: "save_persona",
    definition: savePersonaDef,
    executor: createSavePersonaExec(
      () => ({
        tools: persona.tools,
        env: persona.env,
        networkPolicy: persona.networkPolicy,
        systemPrompt: persona.systemPrompt,
      }),
      async () => {
        await reloadPersonaRegistry();
        console.log("✅ Persona 已热重载");
      }
    ),
  });
}

// 优雅关闭
export async function shutdown(exitProcess = true): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  invalidateAllPendingConsent();
  childNativeProcessConsentCleanup?.();
  childNativeProcessConsentCleanup = null;
  manualExecutionConsent.shutdown();

  // 先停止接受新连接；既有有限 run 收束后，再退休全部 Session runtime。
  const server = httpServer;
  httpServer = null;
  const serverClosed = server
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve();

  const retiringRegistry = runtimeRegistry;
  cronManager?.dispose();
  await getDefaultPollManager().stop(); // EVT-03：先停 source batch 投递，再停下游 EventBus
  await getDefaultEventBus().stop();
  await disposeWire();
  const registryShutdown = retiringRegistry?.shutdown() ?? Promise.resolve();
  await Promise.all([
    serverClosed,
    runtimeMutationTail.catch(() => undefined),
    registryShutdown,
  ]);

  if (runtimeRegistry === retiringRegistry) runtimeRegistry = null;
  activeRunInteractions.clear();
  for (const sessionId of [...activeRunInjections.keys()]) clearActiveRunInjections(sessionId);

  await terminalFacade.disposeAllForShutdown();
  await shutdownExecutionRuntime();
  await closeEmbedding();
  securityAuditJournal?.close();
  securityAuditJournal = null;
  await closeDb();
  await getBootstrapPathStore().close();
  if (exitProcess) process.exit(0);
}
process.on("SIGINT", () => { void shutdown(true); });
process.on("SIGTERM", () => { void shutdown(true); });

export const ready = start();
