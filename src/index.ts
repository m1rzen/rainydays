// ===========================================
// 服务器入口 —— Express + SSE + Persona + 会话管理
// ===========================================

import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
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
  SessionImportError,
  searchSessions,
} from "./session.js";
import { closeDb, insertPin, getPinsBySession, deletePin, deleteMessagesAfterLastUserMessage, getDatabaseSchemaVersion } from "./db.js";
import { setAskUserSseCallback, submitAnswer } from "./tools/ask-user-tool.js";
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
import { updateSessionStatus, onMessage } from "./link.js";
import { disposeAll as disposeWire } from "./wire.js";
import { setNotifyCallback } from "./tools/phase1-tools.js";
import { createMuseExec } from "./tools/phase1-tools.js";
import { createCurateExec } from "./tools/curate-tool.js";
import { createConsolidateExec } from "./tools/knowledge-tools.js";
import { createOracleQueryExec } from "./tools/advanced-tools.js";
import { createSubagentExec, subagentDef } from "./tools/subagent-tools.js";
import { curateDef } from "./tools/curate-tool.js";
import { consolidateDef } from "./tools/knowledge-tools.js";
import { oracleQueryDef } from "./tools/advanced-tools.js";
import { museDef } from "./tools/phase1-tools.js";
import { capabilityBroker, getAllToolNames, registerDynamicTool } from "./tools/index.js";
import { canonicalDigest, type CapabilityContext, type RuntimeAuthority } from "./capability-broker.js";
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
import { createManualExecutionGateway, shutdownExecutionRuntime } from "./execution-runtime.js";
import {
  invalidateNativeProcessConsent,
  registerNativeProcessConsentHandler,
} from "./native-process-consent.js";
import { installInheritedNativeProcessConsentTransport } from "./native-process-consent-transport.js";

export { invalidateNativeProcessConsent, registerNativeProcessConsentHandler };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3111", 10);
const HOST = "127.0.0.1";
const API_TOKEN = process.env.MINI_LUX_API_TOKEN || randomBytes(32).toString("hex");

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
const memory = new ConversationMemory(80);

let personas: PersonaDefinition[] = [];
let currentPersona: PersonaDefinition | null = null;
let agent: Agent | null = null;
let currentAuthority: RuntimeAuthority | null = null;
let currentSessionId: string | null = null;
let httpServer: Server | null = null;
let childNativeProcessConsentCleanup: (() => void) | null = null;
let isShuttingDown = false;
const localApiPrincipal = capabilityBroker.createLocalApiPrincipal();
const manualExecutionConsent = new ManualExecutionConsentLedger();
let manualConsentIncarnationId = randomBytes(32).toString("hex");
const runtimeSubscriptionClosers = new Map<RuntimeAuthority, Set<() => void>>();

function ensureRuntimeAccepting(): void {
  if (isShuttingDown) throw new Error("服务正在关闭，不能创建或重建运行时授权");
}

function invalidatePendingConsent(): void {
  manualExecutionConsent.invalidateAll();
  invalidateNativeProcessConsent();
  manualConsentIncarnationId = randomBytes(32).toString("hex");
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
  if (!agent?.isRunning()) return false;
  res.status(409).json({ error: "当前 runtime 正在执行，不能切换或重建授权" });
  return true;
}

async function runDirectOperation<T>(
  operation: string,
  args: Record<string, unknown>,
  action: (
    authorizedArgs: Readonly<Record<string, unknown>>,
    owner: TerminalOwner,
    authority: RuntimeAuthority,
    context: CapabilityContext
  ) => T | Promise<T>
): Promise<T> {
  ensureRuntimeAccepting();
  const authority = currentAuthority;
  const sessionId = currentSessionId;
  if (!authority || !sessionId) throw new Error("直接操作需要已选择的会话");
  const context = capabilityBroker.issueLocalApiContext({
    authority,
    principal: localApiPrincipal,
    sessionId,
    operation,
    args,
  });
  try {
    const authorizedArgs = capabilityBroker.authorizeDirectOperation(context, operation, args);
    const owner = capabilityBroker.getResourceOwner(context);
    return await action(authorizedArgs, owner, authority, context);
  } finally {
    if (capabilityBroker.isContextActive(context)) capabilityBroker.finishContext(context);
  }
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
    : new Set(["id", "input", "appendNewline"]);
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
  if (typeof value.input !== "string") throw new TypeError("input must be a string");
  if (value.appendNewline !== undefined && typeof value.appendNewline !== "boolean") throw new TypeError("appendNewline must be a boolean");
  return Object.freeze({ id: value.id, input: value.input, appendNewline: value.appendNewline !== false });
}

async function currentManualConsentBinding(
  operation: ManualConsentOperation,
  request: Readonly<Record<string, unknown>>
): Promise<Readonly<{
  sessionId: string;
  runtimeAuthorityId: string;
  authorityEpoch: number;
  incarnationId: string;
}>> {
  ensureRuntimeAccepting();
  const authority = currentAuthority;
  const sessionId = currentSessionId;
  if (!authority || !sessionId) throw new Error("原生确认需要已选择的会话");
  const directOperation = operation === "terminal-start" ? "terminal:start" : "terminal:input";
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
      incarnationId: manualConsentIncarnationId,
    });
  } finally {
    if (capabilityBroker.isContextActive(context)) capabilityBroker.finishContext(context);
  }
}

async function qualifyManualTerminalStart(
  exactRequest: Readonly<Record<string, unknown>>
): Promise<string> {
  return runDirectOperation("terminal:start", exactRequest, (authorized, _owner, _authority, context) =>
    capabilityBroker.withDirectExecutionRoot(
      context,
      "terminal:start",
      String(authorized.cwd),
      "WORKSPACE_ROOT",
      (_canonicalCwd, _executionRootLease, qualificationDigest) => qualificationDigest
    )
  );
}

export async function prepareManualTerminalConsent(
  operation: ManualConsentOperation,
  request: unknown,
  presence: ManualTerminalPresence
): Promise<ManualConsentChallenge> {
  const exactRequest = exactManualTerminalRequest(operation, request);
  const rootQualificationDigest = operation === "terminal-start"
    ? await qualifyManualTerminalStart(exactRequest)
    : null;
  const binding = await currentManualConsentBinding(operation, exactRequest);
  const display = operation === "terminal-start"
    ? {
        operationLabel: "启动持久终端",
        targetLabel: String(exactRequest.cwd).slice(0, 512),
        rootAlias: "WORKSPACE_ROOT",
        preview: `${String(exactRequest.shell)}${exactRequest.name ? ` · ${String(exactRequest.name)}` : ""}`.slice(0, 512),
      }
    : {
        operationLabel: "向持久终端发送输入",
        targetLabel: String(exactRequest.id).slice(0, 512),
        rootAlias: "terminal",
        preview: (String(exactRequest.input) || "(empty input)").slice(0, 512),
      };
  return manualExecutionConsent.prepare({
    operation,
    request: exactRequest,
    display,
    rootQualificationDigest,
    presence: { ...presence, ...binding },
  });
}

export async function decideManualTerminalConsent(
  challengeId: string,
  decision: ManualConsentDecision,
  operation: ManualConsentOperation,
  argumentsDigest: string,
  presence: ManualTerminalPresence
): Promise<unknown> {
  const binding = await currentManualConsentBinding(operation, {});
  let result: unknown;
  await manualExecutionConsent.decide({
    challengeId,
    decision,
    operation,
    argumentsDigest,
    presence: { ...presence, ...binding },
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
        )
      );
      result = { terminal: info };
      return;
    }
    const terminal = await runDirectOperation("terminal:input", exactRequest, async (authorized, owner, _authority, context) => {
      const id = String(authorized.id);
      const execution = createManualExecutionGateway({ context, owner, operation: storedOperation, exactRequest });
      const leaseInfo = terminalFacade.get(owner, id);
      if (!leaseInfo) throw new Error(`终端不存在: ${id}`);
      await terminalFacade.input(owner, id, String(authorized.input), authorized.appendNewline !== false, execution);
      return terminalFacade.get(owner, id);
    });
    result = { success: true, terminal };
  });
  return result;
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

interface PreparedRuntime {
  readonly persona: PersonaDefinition;
  readonly authority: RuntimeAuthority;
  readonly agent: Agent;
}

let runtimeMutationTail: Promise<void> = Promise.resolve();

async function withRuntimeMutation<T>(action: () => Promise<T>): Promise<T> {
  const previous = runtimeMutationTail;
  let release!: () => void;
  runtimeMutationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

async function prepareRuntimeInstance(persona: PersonaDefinition, settings: AppSettings, sessionId: string | null): Promise<PreparedRuntime> {
  const authority = await issueRuntimeAuthority(persona, settings);
  try {
    registerDynamicTools(authority, persona);
    const nextAgent = new Agent(llm, memory, persona, authority);
    if (sessionId) nextAgent.setSession(sessionId);
    return Object.freeze({ persona, authority, agent: nextAgent });
  } catch (error) {
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
    throw error;
  }
}

async function replaceRuntimeAgentLocked(persona: PersonaDefinition, sessionId: string | null): Promise<void> {
  ensureRuntimeAccepting();
  if (agent?.isRunning()) throw new Error("Agent 正在运行，不能重建执行授权");
  invalidatePendingConsent();
  const previousAuthority = currentAuthority;
  const prepared = await prepareRuntimeInstance(persona, getAppSettings(), sessionId);

  closeRuntimeSubscriptions(previousAuthority);
  if (previousAuthority) {
    try {
      await capabilityBroker.retireAuthority(previousAuthority);
    } catch (error) {
      await capabilityBroker.retireAuthority(prepared.authority).catch(() => undefined);
      currentAuthority = null;
      agent = null;
      throw error;
    }
  }
  currentAuthority = prepared.authority;
  agent = prepared.agent;
}

async function replaceRuntimeAgent(persona: PersonaDefinition, sessionId: string | null): Promise<void> {
  return withRuntimeMutation(() => replaceRuntimeAgentLocked(persona, sessionId));
}

async function rebuildRuntimeAgent(): Promise<void> {
  llm = createLlmClient();
  initSupervisor(llm);

  if (!currentPersona) return;
  const rawPersona = personas.find((p) => p.name === currentPersona!.name) || currentPersona;
  currentPersona = applyRuntimeSettings(rawPersona);
  await replaceRuntimeAgent(currentPersona, currentSessionId);
}

async function prepareSettingsRuntime(configSnapshot: Config, personaName: string | null, sessionId: string | null): Promise<PreparedRuntime | null> {
  if (!personaName) return null;
  const rawPersona = personas.find(candidate => candidate.name === personaName);
  if (!rawPersona) throw new Error(`当前 Persona 不存在: ${personaName}`);
  const effectivePersona = applyRuntimeSettings(rawPersona, configSnapshot.settings);
  return prepareRuntimeInstance(effectivePersona, configSnapshot.settings, sessionId);
}

async function recoverPreviousSettingsRuntime(previousConfig: Config, personaName: string | null, sessionId: string | null): Promise<void> {
  await commitConfigSnapshot(previousConfig);
  const recovered = await prepareSettingsRuntime(previousConfig, personaName, sessionId);
  currentPersona = recovered?.persona ?? null;
  currentAuthority = recovered?.authority ?? null;
  agent = recovered?.agent ?? null;
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
  readonly authority: RuntimeAuthority | null;
  readonly personaName: string | null;
  readonly sessionId: string | null;
}

interface SettingsEnrollmentPlan {
  readonly config: Config;
  readonly runtime: PreparedRuntime | null;
  readonly outputLease: PathDirectoryEnrollmentLease | null;
}

async function enrollAppSettings(input: Parameters<typeof prepareAppSettingsUpdate>[0]): Promise<void> {
  return withRuntimeMutation(async () => {
    ensureRuntimeAccepting();
    if (agent?.isRunning()) throw new Error("Agent 正在运行，不能更新根目录授权");
    invalidatePendingConsent();

    await executeSettingsEnrollment<SettingsEnrollmentBase, SettingsEnrollmentPlan>({
      captureBase: () => Object.freeze({
        config: getConfigSnapshot(),
        digest: getConfigRevisionDigest(),
        authority: currentAuthority,
        personaName: currentPersona?.name ?? null,
        sessionId: currentSessionId,
      }),
      prepareCandidate: async base => {
        const candidateConfig = prepareAppSettingsUpdate(input, base.config);
        await validateAppSettingsPaths(candidateConfig.settings, Object.freeze({
          sessionId: base.sessionId,
          runId: randomBytes(16).toString("hex"),
          principal: "local-user-api",
        }));
        const outputLease = await prepareOutputEnrollmentLease(candidateConfig, base.authority, base.sessionId);
        try {
          const runtime = await prepareSettingsRuntime(candidateConfig, base.personaName, base.sessionId);
          return Object.freeze({ config: candidateConfig, runtime, outputLease });
        } catch (error) {
          if (outputLease) await outputLease.rollback();
          throw error;
        }
      },
      isBaseCurrent: base => getConfigRevisionDigest() === base.digest
        && currentAuthority === base.authority
        && (currentPersona?.name ?? null) === base.personaName
        && currentSessionId === base.sessionId,
      retireBase: async base => {
        closeRuntimeSubscriptions(base.authority);
        if (base.authority) await capabilityBroker.retireAuthority(base.authority);
        currentAuthority = null;
        agent = null;
      },
      persistCandidate: plan => commitConfigSnapshot(plan.config),
      publishCandidate: plan => {
        currentPersona = plan.runtime?.persona ?? null;
        currentAuthority = plan.runtime?.authority ?? null;
        agent = plan.runtime?.agent ?? null;
      },
      commitCandidate: plan => { plan.outputLease?.commit(); },
      discardCandidate: async plan => {
        if (plan.runtime) await capabilityBroker.retireAuthority(plan.runtime.authority).catch(() => undefined);
        if (plan.outputLease) await plan.outputLease.rollback();
      },
      recoverBase: base => recoverPreviousSettingsRuntime(base.config, base.personaName, base.sessionId),
      stopFailClosed: () => {
        currentAuthority = null;
        agent = null;
      },
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
app.use(cors({
  origin(origin, callback) {
    // Electron/同源请求通常没有 Origin；浏览器仅允许本机回环来源。
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("不允许的跨域来源"));
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
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
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
  const headerCredential = String(req.header("X-Mini-Lux-Token") || "");
  if (constantTimeCredentialMatch(headerCredential, API_TOKEN)) {
    next();
    return;
  }
  res.status(401).json({ error: "未授权的本地 API 请求" });
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
    current: currentPersona?.name || null,
  });
});

app.post("/api/switch-persona", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  const { name } = req.body;
  const rawPersona = await getPersona(name);
  if (!rawPersona) { res.status(404).json({ error: `Persona 不存在: ${name}` }); return; }
  const persona = applyRuntimeSettings(rawPersona);

  await replaceRuntimeAgent(persona, null);
  currentPersona = persona;
  currentSessionId = null;

  console.log(`✅ Persona: ${persona.displayName} (${persona.name})`);
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
    const result = await runDirectOperation("file:content", args, async (authorized, owner, authority, context) => {
      const content = await fileViewerService.content(authority, directPathAudit(context), owner, String(authorized.root), String(authorized.path));
      try {
        const requestedRange = authorized.range === null ? null : String(authorized.range);
        let start = 0;
        let end = content.size - 1;
        let partial = false;
        if (requestedRange !== null) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(requestedRange.trim());
          if (!match || (!match[1] && !match[2])) return { content, invalidRange: true as const };
          partial = true;
          if (!match[1]) {
            const suffixLength = Number(match[2]);
            start = Math.max(content.size - suffixLength, 0);
          } else {
            start = Number(match[1]);
            end = match[2] ? Number(match[2]) : content.size - 1;
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= content.size) {
            return { content, invalidRange: true as const };
          }
          end = Math.min(end, content.size - 1);
        }
        const data = await content.readRange(start, end);
        return { content, invalidRange: false as const, partial, start, end, data };
      } finally {
        await content.close();
      }
    });

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", result.content.mime);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Last-Modified", result.content.modifiedAt.toUTCString());
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.content.name)}`);
    if (result.invalidRange) {
      res.setHeader("Content-Range", `bytes */${result.content.size}`);
      res.status(416).end();
      return;
    }
    if (result.partial) res.setHeader("Content-Range", `bytes ${result.start}-${result.end}/${result.content.size}`);
    res.setHeader("Content-Length", result.data.length);
    res.status(result.partial ? 206 : 200).end(result.data);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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

app.post("/api/terminals", (_req, res) => {
  res.status(403).json({
    code: "EXEC_NATIVE_CONSENT_REQUIRED",
    error: "Manual terminal start requires native Electron consent",
  });
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

app.post("/api/terminals/:id/input", (_req, res) => {
  res.status(403).json({
    code: "EXEC_NATIVE_CONSENT_REQUIRED",
    error: "Manual terminal input requires native Electron consent",
  });
});

app.post("/api/terminals/:id/clear", async (req, res) => {
  try {
    await runDirectOperation("terminal:clear", { id: req.params.id }, (authorized, owner) => terminalFacade.clear(owner, String(authorized.id)));
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/terminals/:id/kill", async (req, res) => {
  try {
    const terminal = await runDirectOperation("terminal:kill", { id: req.params.id }, async (authorized, owner) => {
      const id = String(authorized.id);
      await terminalFacade.kill(owner, id);
      return terminalFacade.get(owner, id);
    });
    res.json({ success: true, terminal });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/terminals/:id", async (req, res) => {
  try {
    await runDirectOperation("terminal:close", { id: req.params.id }, (authorized, owner) => terminalFacade.close(owner, String(authorized.id)));
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
        if (isShuttingDown || currentAuthority !== authority || currentSessionId !== ownerSessionId) {
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
        if (isShuttingDown || currentAuthority !== authority || currentSessionId !== ownerSessionId) {
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
  res.json({ sessions, current: currentSessionId });
});

/** 创建新会话 */
app.post("/api/sessions", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  if (!currentPersona) { res.status(400).json({ error: "请先选择 persona" }); return; }
  const title = (req.body?.title as string) || "新对话";
  const session = createSession(currentPersona, title);
  await replaceRuntimeAgent(currentPersona, session.id);
  currentSessionId = session.id;

  console.log(`✅ 新会话: ${session.id} (${currentPersona.displayName})`);
  res.json({ session });
});

/** 切换到指定会话 */
app.post("/api/sessions/:id/select", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  const id = req.params.id;
  const session = getSessionInfo(id);
  if (!session) { res.status(404).json({ error: "会话不存在" }); return; }

  const rawSessionPersona = personas.find((p) => p.name === session.persona_name);
  if (!rawSessionPersona) {
    res.status(409).json({ error: `会话绑定的 Persona 不可用: ${session.persona_name}` });
    return;
  }
  const sessionPersona = applyRuntimeSettings(rawSessionPersona);
  await replaceRuntimeAgent(sessionPersona, id);
  touch(id);
  currentPersona = sessionPersona;
  currentSessionId = id;

  console.log(`✅ 切换会话: ${id} (${session.title})`);
  res.json({ session, persona: currentPersona?.name });
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
  if (currentSessionId === id && agent?.isRunning()) {
    res.status(409).json({ error: "Agent 正在运行，不能删除当前会话" });
    return;
  }
  if (currentAuthority) await capabilityBroker.retireSessionResources(currentAuthority, id);
  removeSession(id);
  if (currentSessionId === id) {
    if (currentPersona) await replaceRuntimeAgent(currentPersona, null);
    currentSessionId = null;
  }
  console.log(`🗑️ 删除会话: ${id}`);
  res.json({ success: true });
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

app.post("/api/sessions/:id/rollback", (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  const id = req.params.id;
  const deleted = deleteMessagesAfterLastUserMessage(id);

  // 重新加载 memory
  if (agent && currentSessionId === id) {
    agent.setSession(id);
  }

  res.json({ success: true, deletedMessages: deleted });
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
app.post("/api/sessions/:id/fork", (req, res) => {
  const id = req.params.id;
  const messageId = req.body?.messageId as number | undefined;

  if (!currentPersona) { res.status(400).json({ error: "请先选择 persona" }); return; }

  try {
    const newSession = forkSession(id, messageId || null, currentPersona);
    console.log(`🔱 Fork: ${id} → ${newSession.id}`);
    res.json({ session: newSession });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ===========================================
// Export API（导出会话）
// ===========================================
app.get("/api/sessions/:id/export", (req, res) => {
  const id = req.params.id;
  const data = exportSession(id);
  if (!data) { res.status(404).json({ error: "会话不存在" }); return; }
  const safeName = (data.session.title || "export").replace(/[^\w\u4e00-\u9fa5]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.json"`);
  res.json(data);
});

// ===========================================
// Import API（导入会话）
// ===========================================
app.post("/api/sessions/import", (req, res) => {
  if (!currentPersona) { res.status(400).json({ error: "请先选择 persona" }); return; }
  try {
    const newSession = importSession(req.body, currentPersona);
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
    await upsertProfile(name, {
      model: req.body?.model,
      baseURL: req.body?.baseURL,
      apiKey: req.body?.apiKey,
      providerType: req.body?.providerType,
    });

    if (name === getCurrentProfileName()) await rebuildRuntimeAgent();
    res.json({ success: true, settings: getPublicConfig() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/settings/providers/:name", async (req, res) => {
  if (rejectWhenRuntimeBusy(res)) return;
  try {
    await deleteProfile(req.params.name);
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
  const success = switchProfile(name);
  if (!success) { res.status(404).json({ error: `Profile 不存在: ${name}` }); return; }

  await rebuildRuntimeAgent();
  const profile = getCurrentProfile();
  console.log(`✅ Provider 切换: ${name} (${profile.model})`);
  res.json({ success: true, model: profile.model, configured: Boolean(profile.apiKey) });
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

app.get("/api/diagnostics", (_req, res) => {
  const profile = getCurrentProfile();
  const safeBuildId = artifactSafeBuildId(BUILD_ID);
  res.setHeader("Content-Disposition", `attachment; filename="mini-lux-diagnostics-${safeBuildId}.json"`);
  res.json({
    generatedAt: new Date().toISOString(),
    version: getPublicVersionInfo(),
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || process.env.MINI_LUX_ELECTRON_VERSION || null,
      platform: process.platform,
      arch: process.arch,
    },
    databaseSchemaVersion: getDatabaseSchemaVersion(),
    protocols: structuredClone(PROTOCOL_CAPABILITIES),
    state: {
      configured: Boolean(profile.apiKey),
      activeProfile: getCurrentProfileName(),
      activePersona: currentPersona?.name || null,
      activeSession: Boolean(currentSessionId),
    },
  });
});

app.get("/api/status", (_req, res) => {
  const profile = getCurrentProfile();
  res.json({
    version: getPublicVersionInfo(),
    model: profile.model,
    provider: profile.baseURL,
    profile: getCurrentProfileName(),
    configured: Boolean(profile.apiKey),
    tokens: memory.getTokenEstimate(),
    messageCount: memory.getMessageCount(),
    hasSummary: memory.hasSummary(),
    persona: currentPersona?.name || null,
    sessionId: currentSessionId,
    profiles: listProfiles(),
  });
});

// ===========================================
// Chat API
// ===========================================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") { res.status(400).json({ error: "缺少 message" }); return; }
  if (!getCurrentProfile().apiKey) { res.status(400).json({ error: "当前 Provider 尚未配置 API Key，请先打开 Settings 完成配置" }); return; }
  if (!agent || !currentSessionId) { res.status(400).json({ error: "请先创建或选择一个会话" }); return; }
  if (agent.isRunning()) { res.status(409).json({ error: "当前 runtime 已有进行中的 Agent run" }); return; }

  const chatSessionId = currentSessionId;
  updateSessionStatus(chatSessionId, "running");

  // 注册 ask_user SSE 回调——把问题推送到当前 SSE 流
  setAskUserSseCallback((data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  // 注册 notify 回调——把通知推送到当前 SSE 流
  setNotifyCallback((title, body) => {
    res.write(`data: ${JSON.stringify({ type: "notification", title, body, timestamp: Date.now() })}\n\n`);
  });

  // 注册 link 消息回调——跨 session 消息推送到当前 SSE 流
  const unlinkMsg = onMessage(chatSessionId, (msg) => {
    res.write(`data: ${JSON.stringify({
      type: "link_message",
      from: msg.from,
      content: msg.content,
      timestamp: msg.timestamp,
    })}\n\n`);
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    for await (const step of agent.run(message)) {
      res.write(`data: ${JSON.stringify(step)}\n\n`);
    }
    updateSessionStatus(chatSessionId, "idle");
  } catch (err) {
    updateSessionStatus(chatSessionId, "error");
    res.write(`data: ${JSON.stringify({
      type: "error",
      content: `Agent 运行出错: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: Date.now(),
    })}\n\n`);
  }
  unlinkMsg();
  res.end();
});

// ===========================================
// Ask User API（用户提交回答）
// ===========================================
app.post("/api/ask-user/answer", (req, res) => {
  const { questionId, answer } = req.body;
  if (!questionId || !answer) { res.status(400).json({ error: "缺少 questionId 或 answer" }); return; }
  const success = submitAnswer(questionId, answer);
  res.json({ success });
});

/** 清空当前会话的内存（不删数据库，只是清空内存中的上下文） */
app.post("/api/clear", (_req, res) => {
  memory.clear();
  if (currentPersona) memory.setSystemPrompt(currentPersona.systemPrompt);
  res.json({ success: true });
});

// --- Cron Manager ---
let cronManager: CronManager | null = null;

// 定时任务触发时的回调——推送到前端
const cronCallbacks = new Set<(job: CronJobRow) => void>();

function onCronFire(job: CronJobRow): void {
  console.log(`⏰ 定时任务触发: ${job.message}`);
  for (const cb of cronCallbacks) {
    cb(job);
  }
}

// ===========================================
// Cron SSE —— 定时任务触发推送
// ===========================================
app.get("/api/cron/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const cb = (job: CronJobRow) => {
    res.write(`data: ${JSON.stringify({
      type: "cron_triggered",
      message: job.message,
      jobId: job.id,
      timestamp: Date.now(),
    })}\n\n`);
  };

  cronCallbacks.add(cb);

  req.on("close", () => {
    cronCallbacks.delete(cb);
  });
});

// ===========================================
// 启动
// ===========================================
async function start() {
  childNativeProcessConsentCleanup = await installInheritedNativeProcessConsentTransport();
  await initializeConfig();
  llm = createLlmClient();
  personas = await listPersonas();
  console.log(`✅ 已加载 ${personas.length} 个 persona`);
  for (const p of personas) console.log(`   • ${p.displayName} (${p.name})`);

  cronManager = new CronManager(onCronFire);
  cronManager.loadFromDb();
  initSupervisor(llm);

  const sessions = getAllSessions();
  for (const session of sessions) ensureSessionLinkRegistration(session.id, session.title);

  if (personas.length > 0) {
    const configuredDefault = getAppSettings().defaultPersona;
    const rawDefaultPersona = personas.find((p) => p.name === configuredDefault) || personas[0];
    let selectedPersona = applyRuntimeSettings(rawDefaultPersona);
    let selectedSessionId: string | null = null;

    if (sessions.length > 0) {
      const latestSession = sessions[0];
      const rawSessionPersona = personas.find((p) => p.name === latestSession.persona_name);
      if (rawSessionPersona) {
        selectedPersona = applyRuntimeSettings(rawSessionPersona);
        selectedSessionId = latestSession.id;
      } else {
        console.warn(`⚠️ 无法恢复会话 ${latestSession.id}: Persona ${latestSession.persona_name} 不可用`);
      }
    }

    await replaceRuntimeAgent(selectedPersona, selectedSessionId);
    currentPersona = selectedPersona;
    currentSessionId = selectedSessionId;
    console.log(`✅ 默认 persona: ${currentPersona.displayName}`);
    if (selectedSessionId) console.log(`✅ 自动恢复会话: ${sessions[0].title}`);
  }

  // 工具注册完整性启动自检：所有 persona 声明的工具必须真实可执行。
  validatePersonaToolIntegrity(personas);

  const activeProfile = getCurrentProfile();
  console.log(JSON.stringify({
    event: "mini_lux_version",
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
      console.log(`\n🚀 Mini-Lux ${APP_VERSION} (${BUILD_ID}) 已启动: http://${HOST}:${PORT}/\n`);
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
function registerDynamicTools(authority: RuntimeAuthority, persona: PersonaDefinition): void {
  registerDynamicToolCron(authority);

  // subagent —— 需要 llm + persona
  registerDynamicTool(authority, {
    name: "subagent",
    definition: subagentDef,
    executor: createSubagentExec(llm, persona),
  });

  // curate —— 需要 memory + llm
  registerDynamicTool(authority, {
    name: "curate",
    definition: curateDef,
    executor: createCurateExec(memory, llm),
  });

  // consolidate —— 需要 llm
  registerDynamicTool(authority, {
    name: "consolidate",
    definition: consolidateDef,
    executor: createConsolidateExec(llm),
  });

  // oracle_query —— 需要 llm
  registerDynamicTool(authority, {
    name: "oracle_query",
    definition: oracleQueryDef,
    executor: createOracleQueryExec(llm),
  });

  // muse —— 需要 llm
  registerDynamicTool(authority, {
    name: "muse",
    definition: museDef,
    executor: createMuseExec(llm),
  });

  // playbook_execute —— 需要 llm + persona
  registerDynamicTool(authority, {
    name: "playbook_execute",
    definition: playbookExecuteDef,
    executor: createPlaybookExecuteExec(llm, { systemPrompt: persona.systemPrompt }),
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
  invalidatePendingConsent();
  childNativeProcessConsentCleanup?.();
  childNativeProcessConsentCleanup = null;
  manualExecutionConsent.shutdown();

  // 先停止接受新连接，再进行任何异步清理；普通路由同时由 shutdown 门禁拒绝。
  const server = httpServer;
  httpServer = null;
  const serverClosed = server
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve();

  const retiringAuthority = currentAuthority;
  closeRuntimeSubscriptions(retiringAuthority);
  currentAuthority = null;
  agent = null;
  if (retiringAuthority) await capabilityBroker.retireAuthority(retiringAuthority);

  cronManager?.dispose();
  await disposeWire();
  await terminalFacade.disposeAllForShutdown();
  await shutdownExecutionRuntime();
  await serverClosed;

  // 防御性终检：异步清理期间不允许遗留任何新发布的 authority。
  if (currentAuthority) {
    closeRuntimeSubscriptions(currentAuthority);
    await capabilityBroker.retireAuthority(currentAuthority);
    currentAuthority = null;
  }
  await closeEmbedding();
  await closeDb();
  await getBootstrapPathStore().close();
  if (exitProcess) process.exit(0);
}
process.on("SIGINT", () => { void shutdown(true); });
process.on("SIGTERM", () => { void shutdown(true); });

export const ready = start();
