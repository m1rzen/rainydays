import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityContext, InspectedToolCall } from "./capability-broker.js";
import {
  ExecutionDeniedError,
  ExecutionIsolationService,
  type ExecutionGrantRequest,
  type ExecutionLimits,
  type ExecutionResult,
  type SessionLease,
  type SessionOutput,
} from "./execution-isolation.js";
import {
  bindNativeRootAuthority,
  createProductionNativeExecutionBridge,
  type NativeArtifactIdentity,
  type NativeExecutionProof,
  type NativeServiceDenialRequest,
} from "./execution-native.js";
import { consumeExecutionRootLease, type ExecutionRootLease } from "./path-policy.js";
import { assertResourceOwner, assertResourceOwnerForCleanup, type ResourceOwner } from "./resource-owner.js";
import type { ManualConsentEvidenceBinding, ManualConsentOperation } from "./manual-execution-consent.js";

export interface IsolatedTerminalLease { readonly leaseId: string }

export interface ScopedExecutionGateway {
  readonly executeCommand: (input: Readonly<{ command: string; rootLease: ExecutionRootLease }>) => Promise<ExecutionResult>;
  readonly executeScript: (input: Readonly<{ code: string; rootLease: ExecutionRootLease }>) => Promise<ExecutionResult>;
  readonly startShell: (input: Readonly<{ terminalId: string; shell: "cmd" | "powershell"; rootLease: ExecutionRootLease }>) => Promise<IsolatedTerminalLease>;
  readonly writeShell: (input: Readonly<{ lease: IsolatedTerminalLease; terminalId: string; data: string; appendNewline: boolean }>) => Promise<void>;
}

interface PersistentRecord {
  readonly token: IsolatedTerminalLease;
  readonly nativeLease: SessionLease;
  readonly owner: ResourceOwner;
  readonly context: CapabilityContext;
  readonly terminalId: string;
  readonly entryPoint: "E2" | "E4";
  readonly service: ExecutionIsolationService;
  closed: boolean;
}

const persistentRecords = new WeakMap<IsolatedTerminalLease, PersistentRecord>();

const HASH = /^[a-f0-9]{64}$/u;
const ARCHITECTURE_SHA256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.basename(moduleDirectory).toLowerCase() === "dist"
  ? path.dirname(moduleDirectory)
  : path.dirname(moduleDirectory);
const manifestPath = path.join(projectDirectory, "dist", "native", "sec03-native-manifest.json");
const buildInfoPath = path.join(projectDirectory, "build-info.json");

const PROFILE_LIMITS: Readonly<Record<"E1" | "E2" | "E3" | "E4", ExecutionLimits>> = Object.freeze({
  E1: Object.freeze({
    activeProcesses: 16,
    processMemoryBytes: 512 * 2 ** 20,
    jobMemoryBytes: 2 ** 30,
    cpuRatePercent: 50,
    jobUserTimeMs: 30_000,
    wallTimeMs: 30_000,
    idleTimeMs: null,
    aggregateOutputBytes: 1 * 2 ** 20,
    retainedOutputBytes: 1 * 2 ** 20,
    inputBytes: 128 * 2 ** 10,
  }),
  E2: Object.freeze({
    activeProcesses: 32,
    processMemoryBytes: 512 * 2 ** 20,
    jobMemoryBytes: 2 ** 30,
    cpuRatePercent: 25,
    jobUserTimeMs: 600_000,
    wallTimeMs: 1_800_000,
    idleTimeMs: 300_000,
    aggregateOutputBytes: 10 * 2 ** 20,
    retainedOutputBytes: 2 ** 20,
    inputBytes: 64 * 2 ** 10,
  }),
  E3: Object.freeze({
    activeProcesses: 1,
    processMemoryBytes: 256 * 2 ** 20,
    jobMemoryBytes: 256 * 2 ** 20,
    cpuRatePercent: 20,
    jobUserTimeMs: 10_000,
    wallTimeMs: 10_000,
    idleTimeMs: null,
    aggregateOutputBytes: 1 * 2 ** 20,
    retainedOutputBytes: 1 * 2 ** 20,
    inputBytes: 128 * 2 ** 10,
  }),
  E4: Object.freeze({
    activeProcesses: 64,
    processMemoryBytes: 2 ** 30,
    jobMemoryBytes: 2 * 2 ** 30,
    cpuRatePercent: 50,
    jobUserTimeMs: 3_600_000,
    wallTimeMs: 28_800_000,
    idleTimeMs: 1_800_000,
    aggregateOutputBytes: 64 * 2 ** 20,
    retainedOutputBytes: 2 ** 20,
    inputBytes: 64 * 2 ** 10,
  }),
});

let servicePromise: Promise<ExecutionIsolationService> | null = null;
let serviceForShutdown: ExecutionIsolationService | null = null;

function sha256Json(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .map(key => [key, canonicalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

async function loadNativeIdentity(): Promise<NativeArtifactIdentity> {
  let manifest: unknown;
  let buildInfo: unknown;
  try {
    [manifest, buildInfo] = await Promise.all([
      readFile(manifestPath, "utf8").then(value => JSON.parse(value)),
      readFile(buildInfoPath, "utf8").then(value => JSON.parse(value)),
    ]);
  } catch {
    throw new ExecutionDeniedError("EXEC_NATIVE_IDENTITY_INVALID", "SEC-03 native/build identity is unavailable");
  }
  if (!manifest || typeof manifest !== "object" || !buildInfo || typeof buildInfo !== "object") throw new ExecutionDeniedError("EXEC_NATIVE_IDENTITY_INVALID", "SEC-03 native/build identity is invalid");
  const value = manifest as Record<string, unknown>;
  const build = buildInfo as Record<string, unknown>;
  const outputs = Array.isArray(value.outputs) ? value.outputs as Array<Record<string, unknown>> : [];
  const versions = build.versions && typeof build.versions === "object" ? build.versions as Record<string, unknown> : {};
  const execution = versions.executionIsolation && typeof versions.executionIsolation === "object" ? versions.executionIsolation as Record<string, unknown> : {};
  const artifacts = Array.isArray(execution.artifacts) ? execution.artifacts as Array<Record<string, unknown>> : [];
  const expectedPaths = ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node"];
  const host = outputs[0];
  const launcher = outputs[1];
  const artifactIdentityMatches = outputs.length === expectedPaths.length && artifacts.length === expectedPaths.length
    && outputs.every((entry, index) => entry.path === expectedPaths[index]
      && artifacts[index]?.path === entry.path
      && artifacts[index]?.bytes === entry.bytes
      && artifacts[index]?.sha256 === entry.sha256
      && artifacts[index]?.machine === entry.machine);
  if (value.schemaVersion !== 1 || value.architecture !== "x64" || value.signatureStatus !== "unsigned-local"
    || !HASH.test(String(value.sourceDigest ?? "")) || !HASH.test(String(value.toolchainDigest ?? ""))
    || build.schemaVersion !== 1 || build.product !== "RainyDays" || !HASH.test(String(build.candidateId ?? ""))
    || !HASH.test(String(build.sourceDigest ?? "")) || typeof build.buildId !== "string" || build.buildId.length < 1 || build.buildId.length > 128
    || execution.architectureSha256 !== ARCHITECTURE_SHA256 || execution.protocolVersion !== 1
    || execution.nativeSourceDigest !== value.sourceDigest || execution.toolchainDigest !== value.toolchainDigest
    || execution.signatureStatus !== value.signatureStatus || !artifactIdentityMatches
    || !host || !launcher || host.machine !== "AMD64" || launcher.machine !== "AMD64"
    || !HASH.test(String(host.sha256 ?? "")) || !HASH.test(String(launcher.sha256 ?? ""))
    || !Number.isSafeInteger(host.bytes) || Number(host.bytes) < 1
    || !Number.isSafeInteger(launcher.bytes) || Number(launcher.bytes) < 1) {
    throw new ExecutionDeniedError("EXEC_NATIVE_IDENTITY_INVALID", "SEC-03 native artifact identity is invalid");
  }
  return Object.freeze({
    candidateId: String(build.candidateId),
    buildIdSha256: createHash("sha256").update(String(build.buildId)).digest("hex"),
    sourceSha256: String(build.sourceDigest),
    launcherSha256: String(launcher.sha256),
    launcherBytes: Number(launcher.bytes),
    hostSha256: String(host.sha256),
    hostBytes: Number(host.bytes),
    machine: "x64",
    protocolVersion: 1,
  });
}

const manualConsentStates = new Set([
  "consent-denied", "consent-dismissed", "consent-expired", "consent-argument-mismatch", "consent-replayed",
  "consent-synthetic", "consent-cross-window", "consent-cross-session", "consent-concurrent-reuse",
]);

export function manualConsentEvidenceBinding(
  context: CapabilityContext,
  operation: ManualConsentOperation
): ManualConsentEvidenceBinding {
  if (!context || context.principal !== "local-user-api"
    || (operation !== "terminal-start" && operation !== "terminal-input")) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Manual consent evidence binding is invalid");
  }
  return Object.freeze({
    contextId: context.executionDomainId,
    sessionId: context.sessionId,
    runId: context.runId,
    authorityEpoch: context.authorityEpoch,
    personaDigest: context.persona.digest,
    policyDigest: sha256Json({ architecture: ARCHITECTURE_SHA256, operation }),
  });
}

export async function observeManualConsentDenial(request: NativeServiceDenialRequest): Promise<NativeExecutionProof> {
  if (!request || request.entryPoint !== "E4" || request.profile !== "manual-terminal" || request.operation !== "consent"
    || !manualConsentStates.has(request.decisionState)) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Manual consent evidence request is invalid");
  }
  const bridge = createProductionNativeExecutionBridge(await loadNativeIdentity());
  try {
    await bridge.initialize?.();
    if (!bridge.observeServiceDenial) throw new ExecutionDeniedError("EXEC_NATIVE_FAILED", "Manual consent evidence is unavailable");
    return await bridge.observeServiceDenial(request);
  } finally {
    await bridge.shutdown();
  }
}

async function executionService(): Promise<ExecutionIsolationService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      if (process.platform !== "win32" || process.arch !== "x64") {
        throw new ExecutionDeniedError("EXEC_NATIVE_FAILED", "SEC-03 execution requires Windows x64");
      }
      const bridge = createProductionNativeExecutionBridge(await loadNativeIdentity());
      await bridge.initialize?.();
      const service = new ExecutionIsolationService(bridge);
      serviceForShutdown = service;
      return service;
    })();
  }
  return servicePromise;
}

function trustedWindowsEnvironment(entryPoint: "E1" | "E2" | "E3" | "E4", canonicalRootPath: string, _canonicalCwd: string): Readonly<Record<string, string>> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Trusted Windows runtime paths are unavailable");
  }
  const system32 = path.win32.join(systemRoot, "System32");
  const common: Record<string, string> = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    NUMBER_OF_PROCESSORS: String(Math.max(1, os.cpus().length)),
    PATH: system32,
    TEMP: canonicalRootPath,
    TMP: canonicalRootPath,
    USERPROFILE: canonicalRootPath,
    HOME: canonicalRootPath,
    APPDATA: canonicalRootPath,
    LOCALAPPDATA: canonicalRootPath,
    MINI_LUX_ROOT_0: canonicalRootPath,
  };
  if (entryPoint === "E3") {
    common.NODE_DISABLE_COLORS = "1";
    if (process.versions.electron) common.ELECTRON_RUN_AS_NODE = "1";
  } else common.ComSpec = path.win32.join(system32, "cmd.exe");
  return Object.freeze(common);
}

function consumeNativeRoot(rootLease: ExecutionRootLease, authorityEpoch: number): Readonly<{
  rootId: string;
  access: "read-write";
  identity: Readonly<{ volumeSerial: string; fileId: string; type: "directory"; nativeAuthorityId: string }>;
  canonicalRootPath: string;
  canonicalCwd: string;
  revoke: () => void;
}> {
  return consumeExecutionRootLease(rootLease, { authorityEpoch, access: "read-write" }, snapshot => {
    const authority = Object.freeze({
      rootId: snapshot.rootId,
      access: "read-write" as const,
      canonicalPath: snapshot.canonicalPath,
      identity: Object.freeze({ volumeSerial: snapshot.identity.deviceId, fileId: snapshot.identity.objectId, type: "directory" as const }),
      canonicalCwd: snapshot.canonicalCwd,
      cwdIdentity: Object.freeze({ volumeSerial: snapshot.cwdIdentity.deviceId, fileId: snapshot.cwdIdentity.objectId, type: "directory" as const }),
    });
    const binding = bindNativeRootAuthority(authority);
    return Object.freeze({
      rootId: authority.rootId,
      access: authority.access,
      identity: Object.freeze({ ...authority.identity, nativeAuthorityId: binding.nativeAuthorityId }),
      canonicalRootPath: authority.canonicalPath,
      canonicalCwd: authority.canonicalCwd,
      revoke: binding.revoke,
    });
  });
}

function exactString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", `${label} is invalid`);
  }
  return value;
}

export function createScopedExecutionGateway(input: Readonly<{
  context: CapabilityContext;
  inspected: InspectedToolCall;
  owner: ResourceOwner;
}>): ScopedExecutionGateway {
  const { context, inspected, owner } = input;
  const ownerMetadata = assertResourceOwner(owner);
  const bindingValid = ownerMetadata.sessionId === context.sessionId
    && ownerMetadata.authorityEpoch === context.authorityEpoch
    && ownerMetadata.principal === context.principal
    && context.persona.digest.length === 64
    && inspected.registrationId === context.approvalGrant?.registrationId
    && inspected.argumentsDigest === context.approvalGrant?.argumentsDigest
    && inspected.name === context.approvalGrant?.toolOrOperation;
  let consumed = false;
  const launch = async (entryPoint: "E1" | "E3", payloadText: string, rootLease: ExecutionRootLease): Promise<ExecutionResult> => {
    if (!bindingValid) throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Execution invocation binding is invalid");
    if (consumed) throw new ExecutionDeniedError("EXEC_GRANT_REPLAYED", "Execution invocation was already consumed");
    consumed = true;
    const root = consumeNativeRoot(rootLease, context.authorityEpoch);
    try {
      if (!context.allowedRoots.includes(root.rootId) || !ownerMetadata.rootIds.includes(root.rootId)) {
        throw new ExecutionDeniedError("EXEC_GRANT_ARGUMENT_MISMATCH", "Execution root differs from the approved invocation");
      }
      const payload = Buffer.from(payloadText, "utf8");
    const limits = PROFILE_LIMITS[entryPoint];
    if (payload.length > limits.inputBytes) throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Execution payload exceeds its limit");
    const request: ExecutionGrantRequest = {
      contextId: context.executionDomainId,
      sessionId: context.sessionId,
      runId: context.runId,
      principal: context.principal,
      authorityEpoch: context.authorityEpoch,
      personaDigest: context.persona.digest,
      policyDigest: sha256Json(inspected.policy),
      resourceOwner: owner,
      entryPoint,
      profile: entryPoint === "E1" ? "one-shot-shell" : "script",
      payload,
      roots: [root],
      environment: trustedWindowsEnvironment(entryPoint, root.canonicalRootPath, root.canonicalCwd),
      network: Object.freeze({ mode: "deny" }),
      limits,
      expiresAtMs: Date.now() + 5_000,
    };
      const service = await executionService();
      return await service.launchOneShot(await service.issueExecutionGrantAuthenticated(request), owner, request);
    } finally {
      root.revoke();
    }
  };
  const startPersistent = async (terminalId: string, shell: "cmd" | "powershell", rootLease: ExecutionRootLease): Promise<IsolatedTerminalLease> => {
    if (!bindingValid || inspected.name !== "shell_start") throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Persistent launch binding is invalid");
    if (consumed) throw new ExecutionDeniedError("EXEC_GRANT_REPLAYED", "Execution invocation was already consumed");
    consumed = true;
    let service!: ExecutionIsolationService;
    let nativeLease!: SessionLease;
    const root = consumeNativeRoot(rootLease, context.authorityEpoch);
    try {
      if (!/^term_[a-f0-9]{8}$/u.test(terminalId) || !context.allowedRoots.includes(root.rootId) || !ownerMetadata.rootIds.includes(root.rootId)) {
        throw new ExecutionDeniedError("EXEC_GRANT_ARGUMENT_MISMATCH", "Persistent execution root or terminal differs from the approved invocation");
      }
      const approvedShell = inspected.args.shell === undefined ? "cmd" : inspected.args.shell;
      if (shell !== approvedShell || (shell !== "cmd" && shell !== "powershell")) {
        throw new ExecutionDeniedError("EXEC_GRANT_ARGUMENT_MISMATCH", "Shell differs from the approved invocation");
      }
      const limits = PROFILE_LIMITS.E2;
      const request: ExecutionGrantRequest = {
        contextId: context.executionDomainId,
        sessionId: context.sessionId,
        runId: context.runId,
        principal: context.principal,
        authorityEpoch: context.authorityEpoch,
        personaDigest: context.persona.digest,
        policyDigest: sha256Json(inspected.policy),
        resourceOwner: owner,
        entryPoint: "E2",
        profile: "agent-shell",
        payload: Buffer.from(shell, "utf8"),
        roots: [root],
        environment: trustedWindowsEnvironment("E2", root.canonicalRootPath, root.canonicalCwd),
        network: Object.freeze({ mode: "deny" }),
        limits,
        expiresAtMs: Date.now() + 5_000,
      };
      service = await executionService();
      nativeLease = await service.launchPersistent(await service.issueExecutionGrantAuthenticated(request), owner, request);
    } finally {
      root.revoke();
    }
    const token = Object.freeze({ leaseId: randomUUID() });
    persistentRecords.set(token, { token, nativeLease, owner, context, terminalId, entryPoint: "E2", service, closed: false });
    return token;
  };
  return Object.freeze({
    executeCommand: async ({ command, rootLease }: Readonly<{ command: string; rootLease: ExecutionRootLease }>) => {
      if (inspected.name !== "execute_command" || command !== inspected.args.command) {
        throw new ExecutionDeniedError("EXEC_GRANT_ARGUMENT_MISMATCH", "Command differs from the approved invocation");
      }
      return launch("E1", exactString(command, 128 * 2 ** 10, "Command"), rootLease);
    },
    executeScript: async ({ code, rootLease }: Readonly<{ code: string; rootLease: ExecutionRootLease }>) => {
      if (inspected.name !== "script" || code !== inspected.args.code) {
        throw new ExecutionDeniedError("EXEC_GRANT_ARGUMENT_MISMATCH", "Script differs from the approved invocation");
      }
      return launch("E3", exactString(code, 128 * 2 ** 10, "Script"), rootLease);
    },
    startShell: async ({ terminalId, shell, rootLease }: Readonly<{ terminalId: string; shell: "cmd" | "powershell"; rootLease: ExecutionRootLease }>) =>
      startPersistent(terminalId, shell, rootLease),
    writeShell: async ({ lease, terminalId, data, appendNewline }: Readonly<{ lease: IsolatedTerminalLease; terminalId: string; data: string; appendNewline: boolean }>) => {
      if (!bindingValid || inspected.name !== "shell_input" || consumed) throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Persistent input binding is invalid");
      consumed = true;
      const record = persistentRecords.get(lease);
      if (!record || record.token !== lease || record.closed || record.owner !== owner || record.terminalId !== terminalId
        || record.context.executionDomainId !== context.executionDomainId || record.context.runId !== context.runId
        || record.context.sessionId !== context.sessionId || record.context.authorityEpoch !== context.authorityEpoch
        || record.context.principal !== context.principal
        || inspected.args.terminalId !== terminalId || inspected.args.input !== data
        || (inspected.args.appendNewline === false ? false : true) !== appendNewline) {
        throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Persistent input differs from the approved invocation or session");
      }
      const payload = Buffer.from(exactString(data, 64 * 2 ** 10, "Terminal input"), "utf8");
      const inputRequest = {
        lease: record.nativeLease,
        resourceOwner: owner,
        contextId: context.executionDomainId,
        sessionId: context.sessionId,
        runId: context.runId,
        principal: context.principal,
        authorityEpoch: context.authorityEpoch,
        payload,
        appendNewline,
        expiresAtMs: Date.now() + 5_000,
      };
      const inputGrant = record.service.issueInputGrant(inputRequest);
      await record.service.write(record.nativeLease, inputGrant, owner, inputRequest);
    },
  });
}

export function createManualExecutionGateway(input: Readonly<{
  context: CapabilityContext;
  owner: ResourceOwner;
  operation: "terminal-start" | "terminal-input";
  exactRequest: Readonly<Record<string, unknown>>;
}>): ScopedExecutionGateway {
  const { context, owner, operation, exactRequest } = input;
  const ownerMetadata = assertResourceOwner(owner);
  const bindingValid = context.principal === "local-user-api"
    && ownerMetadata.sessionId === context.sessionId
    && ownerMetadata.authorityEpoch === context.authorityEpoch
    && ownerMetadata.principal === context.principal;
  let consumed = false;
  const denyWrongOperation = (): never => { throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Manual consent cannot authorize this execution operation"); };
  return Object.freeze({
    executeCommand: async () => denyWrongOperation(),
    executeScript: async () => denyWrongOperation(),
    startShell: async ({ terminalId, shell, rootLease }: Readonly<{ terminalId: string; shell: "cmd" | "powershell"; rootLease: ExecutionRootLease }>) => {
      if (!bindingValid || operation !== "terminal-start" || consumed) denyWrongOperation();
      consumed = true;
      let service!: ExecutionIsolationService;
      let nativeLease!: SessionLease;
      const root = consumeNativeRoot(rootLease, context.authorityEpoch);
      try {
        if (root.rootId !== "workspace" || !context.allowedRoots.includes(root.rootId) || !ownerMetadata.rootIds.includes(root.rootId)
        || exactRequest.shell !== shell || !/^term_[a-f0-9]{8}$/u.test(terminalId)) denyWrongOperation();
      const request: ExecutionGrantRequest = {
        contextId: context.executionDomainId,
        sessionId: context.sessionId,
        runId: context.runId,
        principal: context.principal,
        authorityEpoch: context.authorityEpoch,
        personaDigest: context.persona.digest,
        policyDigest: sha256Json({ architecture: ARCHITECTURE_SHA256, operation }),
        resourceOwner: owner,
        entryPoint: "E4",
        profile: "manual-terminal",
        payload: Buffer.from(shell, "utf8"),
        roots: [root],
        environment: trustedWindowsEnvironment("E4", root.canonicalRootPath, root.canonicalCwd),
        network: Object.freeze({ mode: "deny" }),
        limits: PROFILE_LIMITS.E4,
        expiresAtMs: Date.now() + 5_000,
      };
        service = await executionService();
        nativeLease = await service.launchPersistent(await service.issueExecutionGrantAuthenticated(request), owner, request);
      } finally {
        root.revoke();
      }
      const token = Object.freeze({ leaseId: randomUUID() });
      persistentRecords.set(token, { token, nativeLease, owner, context, terminalId, entryPoint: "E4", service, closed: false });
      return token;
    },
    writeShell: async ({ lease, terminalId, data, appendNewline }: Readonly<{ lease: IsolatedTerminalLease; terminalId: string; data: string; appendNewline: boolean }>) => {
      if (!bindingValid || operation !== "terminal-input" || consumed) denyWrongOperation();
      consumed = true;
      const record = persistentRecords.get(lease);
      if (!record || record.token !== lease || record.entryPoint !== "E4" || record.closed || record.owner !== owner
        || record.terminalId !== terminalId || record.context.executionDomainId !== context.executionDomainId
        || record.context.sessionId !== context.sessionId || record.context.authorityEpoch !== context.authorityEpoch || record.context.principal !== context.principal
        || exactRequest.id !== terminalId || exactRequest.input !== data
        || (exactRequest.appendNewline === false ? false : true) !== appendNewline) {
        throw new ExecutionDeniedError("EXEC_BINDING_MISMATCH", "Manual input differs from the approved request or session");
      }
      const payload = Buffer.from(exactString(data, 64 * 2 ** 10, "Terminal input"), "utf8");
      const inputRequest = {
        lease: record.nativeLease,
        resourceOwner: owner,
        contextId: context.executionDomainId,
        sessionId: context.sessionId,
        runId: context.runId,
        principal: context.principal,
        authorityEpoch: context.authorityEpoch,
        payload,
        appendNewline,
        expiresAtMs: Date.now() + 5_000,
      };
      const grant = record.service.issueInputGrant(inputRequest);
      await record.service.write(record.nativeLease, grant, owner, inputRequest);
    },
  });
}

function requirePersistent(lease: IsolatedTerminalLease, owner: ResourceOwner, ownerRetirement = false): PersistentRecord {
  const record = persistentRecords.get(lease);
  if (!record || record.token !== lease || record.owner !== owner) {
    throw new ExecutionDeniedError("EXEC_GRANT_FORGED", "Persistent execution lease is unavailable");
  }
  if (ownerRetirement) assertResourceOwnerForCleanup(owner);
  else assertResourceOwner(owner);
  return record;
}

export function readIsolatedTerminal(lease: IsolatedTerminalLease, owner: ResourceOwner): SessionOutput {
  const record = requirePersistent(lease, owner);
  return record.service.readOutput(record.nativeLease, owner);
}

export async function terminateIsolatedTerminal(lease: IsolatedTerminalLease, owner: ResourceOwner, reason = "requested"): Promise<void> {
  const record = requirePersistent(lease, owner);
  if (record.closed) return;
  record.closed = true;
  await record.service.terminate(record.nativeLease, owner, reason);
}

export async function retireIsolatedTerminal(lease: IsolatedTerminalLease, owner: ResourceOwner, reason: string): Promise<void> {
  const record = requirePersistent(lease, owner, true);
  if (record.closed) return;
  record.closed = true;
  await record.service.terminateForOwnerRetirement(record.nativeLease, owner, reason);
}

export async function shutdownExecutionRuntime(): Promise<void> {
  const service = serviceForShutdown;
  serviceForShutdown = null;
  servicePromise = null;
  if (service) await service.shutdown();
}

export const SEC03_EXECUTION_ARCHITECTURE_SHA256 = ARCHITECTURE_SHA256;
