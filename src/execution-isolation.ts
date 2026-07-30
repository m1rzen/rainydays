import { createHash, randomUUID } from "node:crypto";
import { assertResourceOwner, registerOwnedResource, type ResourceOwner } from "./resource-owner.js";
import { NativeBridgeError, type NativeExecutionBridge, type NativeExecutionHandle, type NativeExecutionProof, type NativeServiceDenialRequest, type NativeServiceDenialState } from "./execution-native.js";

export type ExecutionEntryPoint = "E1" | "E2" | "E3" | "E4";
export type ExecutionProfile = "one-shot-shell" | "agent-shell" | "script" | "manual-terminal";
export type ExecutionRootAccess = "read" | "read-write";
export type ExecutionNetworkPolicy =
  | Readonly<{ mode: "deny" }>
  | Readonly<{ mode: "brokered"; operationsDigest: string }>;

export interface ExecutionRootLeaseSnapshot {
  readonly rootId: string;
  readonly access: ExecutionRootAccess;
  readonly identity: Readonly<{ volumeSerial: string; fileId: string; type: "directory" }>;
}

export interface ExecutionLimits {
  readonly activeProcesses: number;
  readonly processMemoryBytes: number;
  readonly jobMemoryBytes: number;
  readonly cpuRatePercent: number;
  readonly jobUserTimeMs: number;
  readonly wallTimeMs: number;
  readonly idleTimeMs: number | null;
  readonly aggregateOutputBytes: number;
  readonly retainedOutputBytes: number;
  readonly inputBytes: number;
}

export interface ExecutionAuthoritySnapshot {
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly principal: string;
  readonly authorityEpoch: number;
  readonly personaDigest: string;
  readonly policyDigest: string;
  readonly resourceOwner: ResourceOwner;
}

export interface ExecutionGrantRequest extends ExecutionAuthoritySnapshot {
  readonly entryPoint: ExecutionEntryPoint;
  readonly profile: ExecutionProfile;
  readonly payload: Uint8Array;
  readonly roots: readonly ExecutionRootLeaseSnapshot[];
  readonly environment: Readonly<Record<string, string>>;
  readonly network: ExecutionNetworkPolicy;
  readonly limits: ExecutionLimits;
  readonly expiresAtMs: number;
}

export interface ExecutionGrant { readonly grantId: string }
export interface InputGrant { readonly grantId: string }
export interface SessionLease { readonly leaseId: string; readonly sessionId: string }

export interface ExecutionGrantInvocation extends ExecutionAuthoritySnapshot {
  readonly entryPoint: ExecutionEntryPoint;
  readonly profile: ExecutionProfile;
  readonly payload: Uint8Array;
  readonly roots: readonly ExecutionRootLeaseSnapshot[];
  readonly environment: Readonly<Record<string, string>>;
  readonly network: ExecutionNetworkPolicy;
  readonly limits: ExecutionLimits;
}

export interface InputGrantInvocation {
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly principal: string;
  readonly authorityEpoch: number;
  readonly payload: Uint8Array;
  readonly appendNewline: boolean;
}

export interface ExecutionResult {
  readonly executionId: string;
  readonly exitCode: number | null;
  readonly reason: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface SessionOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly running: boolean;
}

export type ExecutionDenialCode =
  | "EXEC_SERVICE_SHUTDOWN"
  | "EXEC_GRANT_REQUIRED"
  | "EXEC_GRANT_FORGED"
  | "EXEC_GRANT_ARGUMENT_MISMATCH"
  | "EXEC_GRANT_REPLAYED"
  | "EXEC_GRANT_EXPIRED"
  | "EXEC_GRANT_CROSS_RUN"
  | "EXEC_GRANT_CROSS_SESSION"
  | "EXEC_GRANT_CONCURRENT_REUSE"
  | "EXEC_BINDING_MISMATCH"
  | "EXEC_PROFILE_INVALID"
  | "EXEC_REQUEST_INVALID"
  | "EXEC_SESSION_STALE"
  | "EXEC_OUTPUT_LIMIT"
  | "EXEC_NETWORK_PROFILE_UNSUPPORTED"
  | "EXEC_NATIVE_IDENTITY_INVALID"
  | "EXEC_NATIVE_FAILED";

export class ExecutionDeniedError extends Error {
  readonly code: ExecutionDenialCode;
  readonly nativeObservation: NativeExecutionProof | null;
  constructor(code: ExecutionDenialCode, message: string, nativeObservation: NativeExecutionProof | null = null) {
    super(message);
    this.name = "ExecutionDeniedError";
    this.code = code;
    this.nativeObservation = nativeObservation;
  }
}

interface GrantRecord {
  readonly token: ExecutionGrant;
  readonly request: Readonly<Omit<ExecutionGrantRequest, "resourceOwner" | "payload" | "roots" | "environment" | "network" | "limits">>;
  readonly owner: ResourceOwner;
  readonly payload: Buffer;
  readonly payloadDigest: string;
  readonly roots: readonly ExecutionRootLeaseSnapshot[];
  readonly environment: Readonly<Record<string, string>>;
  readonly network: ExecutionNetworkPolicy;
  readonly limits: ExecutionLimits;
  state: "fresh" | "consuming" | "consumed";
}

interface InputRecord {
  readonly token: InputGrant;
  readonly lease: SessionLease;
  readonly owner: ResourceOwner;
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly principal: string;
  readonly authorityEpoch: number;
  readonly payload: Buffer;
  readonly payloadDigest: string;
  readonly appendNewline: boolean;
  readonly expiresAtMs: number;
  state: "fresh" | "consuming" | "consumed";
}

interface OutputRecord {
  stdout: Buffer[];
  stderr: Buffer[];
  retainedBytes: number;
  aggregateBytes: number;
  truncated: boolean;
}

interface SessionRecord {
  readonly token: SessionLease;
  readonly owner: ResourceOwner;
  readonly authority: Pick<GrantRecord["request"], "contextId" | "sessionId" | "runId" | "principal" | "authorityEpoch" | "personaDigest" | "policyDigest">;
  readonly limits: ExecutionLimits;
  readonly entryPoint: "E2" | "E4";
  readonly native: NativeExecutionHandle;
  readonly output: OutputRecord;
  unregister: () => void;
  state: "running" | "terminating" | "closed";
}

const HEX_64 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_KEYS = new Set([
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA",
  "LOCALAPPDATA", "PATH", "NODE_DISABLE_COLORS", "ELECTRON_RUN_AS_NODE",
  "MINI_LUX_SANDBOX_ID", "MINI_LUX_SESSION_ID",
]);

const PROFILE_BY_ENTRY: Readonly<Record<ExecutionEntryPoint, ExecutionProfile>> = Object.freeze({
  E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal",
});

const PROFILE_MAX: Readonly<Record<ExecutionEntryPoint, ExecutionLimits>> = Object.freeze({
  E1: Object.freeze({ activeProcesses: 16, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 50, jobUserTimeMs: 30_000, wallTimeMs: 30_000, idleTimeMs: null, aggregateOutputBytes: 1 * 2 ** 20, retainedOutputBytes: 1 * 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E2: Object.freeze({ activeProcesses: 32, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 25, jobUserTimeMs: 600_000, wallTimeMs: 1_800_000, idleTimeMs: 300_000, aggregateOutputBytes: 10 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10 }),
  E3: Object.freeze({ activeProcesses: 1, processMemoryBytes: 256 * 2 ** 20, jobMemoryBytes: 256 * 2 ** 20, cpuRatePercent: 20, jobUserTimeMs: 10_000, wallTimeMs: 10_000, idleTimeMs: null, aggregateOutputBytes: 1 * 2 ** 20, retainedOutputBytes: 1 * 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E4: Object.freeze({ activeProcesses: 64, processMemoryBytes: 2 ** 30, jobMemoryBytes: 2 * 2 ** 30, cpuRatePercent: 50, jobUserTimeMs: 3_600_000, wallTimeMs: 28_800_000, idleTimeMs: 1_800_000, aggregateOutputBytes: 64 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10 }),
});

function deny(code: ExecutionDenialCode, message: string): never { throw new ExecutionDeniedError(code, message); }
function nativeFailure(error: unknown, message: string): ExecutionDeniedError {
  const code = error instanceof NativeBridgeError ? error.code : error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
  return code === "EXEC_NATIVE_IDENTITY_INVALID"
    ? new ExecutionDeniedError("EXEC_NATIVE_IDENTITY_INVALID", "Native artifact identity is invalid")
    : new ExecutionDeniedError("EXEC_NATIVE_FAILED", message);
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalDigest(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map(key => [key, canonicalize((input as Record<string, unknown>)[key])]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
const stateByCode = {
  EXEC_GRANT_REQUIRED: "missing",
  EXEC_GRANT_FORGED: "forged",
  EXEC_GRANT_ARGUMENT_MISMATCH: "argument-mismatch",
  EXEC_GRANT_EXPIRED: "expired",
  EXEC_GRANT_REPLAYED: "replayed",
  EXEC_GRANT_CROSS_RUN: "cross-run",
  EXEC_GRANT_CROSS_SESSION: "cross-session",
  EXEC_GRANT_CONCURRENT_REUSE: "concurrent-reuse",
  EXEC_NETWORK_PROFILE_UNSUPPORTED: "network-profile-unsupported",
} as const satisfies Partial<Record<ExecutionDenialCode, NativeServiceDenialState>>;
function serviceDenialState(code: ExecutionDenialCode): NativeServiceDenialState | null {
  return stateByCode[code as keyof typeof stateByCode] ?? null;
}
function validId(value: string): boolean { return typeof value === "string" && ID.test(value); }
function freezeRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function sameFlatRecord(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(leftRecord[key], rightRecord[key]));
}

function sameRoots(expected: readonly ExecutionRootLeaseSnapshot[], actual: unknown): boolean {
  if (!Array.isArray(actual) || expected.length !== actual.length) return false;
  const sorted = [...actual].sort((left, right) => String(left?.rootId ?? "").localeCompare(String(right?.rootId ?? "")));
  return expected.every((root, index) => {
    const candidate = sorted[index] as ExecutionRootLeaseSnapshot | undefined;
    return candidate?.rootId === root.rootId && candidate.access === root.access
      && sameFlatRecord(root.identity, candidate.identity);
  });
}

function validateLimits(entry: ExecutionEntryPoint, limits: ExecutionLimits): ExecutionLimits {
  const maximum = PROFILE_MAX[entry];
  const numeric = ["activeProcesses", "processMemoryBytes", "jobMemoryBytes", "cpuRatePercent", "jobUserTimeMs", "wallTimeMs", "aggregateOutputBytes", "retainedOutputBytes", "inputBytes"] as const;
  if (!limits || numeric.some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum[key])) deny("EXEC_REQUEST_INVALID", "Execution limits are invalid");
  if (limits.retainedOutputBytes > limits.aggregateOutputBytes || limits.jobMemoryBytes < limits.processMemoryBytes) deny("EXEC_REQUEST_INVALID", "Execution limit relationships are invalid");
  if (maximum.idleTimeMs === null ? limits.idleTimeMs !== null : !Number.isSafeInteger(limits.idleTimeMs) || limits.idleTimeMs! < 1 || limits.idleTimeMs! > maximum.idleTimeMs) deny("EXEC_REQUEST_INVALID", "Execution idle limit is invalid");
  return Object.freeze({ ...limits });
}

function validateEnvironment(entry: ExecutionEntryPoint, environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!environment || Object.getPrototypeOf(environment) !== Object.prototype) deny("EXEC_REQUEST_INVALID", "Execution environment is invalid");
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toUpperCase();
    const rootAlias = /^MINI_LUX_ROOT_(0|[1-9][0-9]*)$/u.test(key);
    if (!ENV_KEY.test(key) || (!ENV_KEYS.has(key) && !rootAlias) || seen.has(normalized) || typeof value !== "string" || value.includes("\0") || value.length > 32_768) deny("EXEC_REQUEST_INVALID", "Execution environment contains a forbidden entry");
    if (entry === "E3" && key === "ComSpec") deny("EXEC_REQUEST_INVALID", "Script environment cannot contain ComSpec");
    if (entry !== "E3" && (key === "NODE_DISABLE_COLORS" || key === "ELECTRON_RUN_AS_NODE")) deny("EXEC_REQUEST_INVALID", "Shell environment contains Node-only entries");
    seen.add(normalized);
  }
  return freezeRecord(environment);
}

function validateRoots(roots: readonly ExecutionRootLeaseSnapshot[]): readonly ExecutionRootLeaseSnapshot[] {
  if (!Array.isArray(roots)) deny("EXEC_REQUEST_INVALID", "Execution roots are invalid");
  const copied = roots.map(root => {
    if (!root || !ROOT_ID.test(root.rootId) || (root.access !== "read" && root.access !== "read-write") || !root.identity || root.identity.type !== "directory" || !validId(root.identity.volumeSerial) || !validId(root.identity.fileId)) deny("EXEC_REQUEST_INVALID", "Execution root is invalid");
    return Object.freeze({ rootId: root.rootId, access: root.access, identity: Object.freeze({ ...root.identity }) });
  }).sort((left, right) => left.rootId.localeCompare(right.rootId));
  if (new Set(copied.map(root => root.rootId)).size !== copied.length) deny("EXEC_REQUEST_INVALID", "Execution roots contain duplicates");
  return Object.freeze(copied);
}

function validateNetwork(entry: ExecutionEntryPoint, network: ExecutionNetworkPolicy): ExecutionNetworkPolicy {
  if (!network || (network.mode !== "deny" && network.mode !== "brokered")) deny("EXEC_REQUEST_INVALID", "Execution network policy is invalid");
  if ((entry === "E2" || entry === "E4") && network.mode !== "deny") deny("EXEC_NETWORK_PROFILE_UNSUPPORTED", "Persistent profiles do not support direct or brokered network access");
  if (entry === "E3" && network.mode !== "deny" && !HEX_64.test(network.operationsDigest)) deny("EXEC_REQUEST_INVALID", "Broker operations digest is invalid");
  return Object.freeze(network.mode === "deny" ? { mode: "deny" } : { mode: "brokered", operationsDigest: network.operationsDigest });
}

function validateAuthority(input: ExecutionAuthoritySnapshot): void {
  if (![input.contextId, input.sessionId, input.runId, input.principal].every(validId) || !Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1 || !HEX_64.test(input.personaDigest) || !HEX_64.test(input.policyDigest)) deny("EXEC_REQUEST_INVALID", "Execution authority is invalid");
  const owner = assertResourceOwner(input.resourceOwner);
  if (owner.sessionId !== input.sessionId || owner.authorityEpoch !== input.authorityEpoch || owner.principal !== input.principal) deny("EXEC_BINDING_MISMATCH", "Execution owner binding mismatch");
}

function assertOwner(recordOwner: ResourceOwner, supplied: ResourceOwner): void {
  if (recordOwner !== supplied) deny("EXEC_BINDING_MISMATCH", "Execution owner mismatch");
  assertResourceOwner(supplied);
}

function newOutput(): OutputRecord { return { stdout: [], stderr: [], retainedBytes: 0, aggregateBytes: 0, truncated: false }; }

export class ExecutionIsolationService {
  readonly #bridge: NativeExecutionBridge;
  readonly #now: () => number;
  readonly #grants = new WeakMap<ExecutionGrant, GrantRecord>();
  readonly #inputGrants = new WeakMap<InputGrant, InputRecord>();
  readonly #leases = new WeakMap<SessionLease, SessionRecord>();
  readonly #sessions = new Set<SessionRecord>();
  readonly #activeHandles = new Set<NativeExecutionHandle>();
  #shutdown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(bridge: NativeExecutionBridge, options: Readonly<{ now?: () => number }> = {}) {
    if (!bridge || typeof bridge.launch !== "function" || typeof bridge.shutdown !== "function") throw new TypeError("Native execution bridge is invalid");
    this.#bridge = bridge;
    this.#now = options.now ?? Date.now;
  }

  issueExecutionGrant(input: ExecutionGrantRequest): ExecutionGrant {
    if (this.#shutdown) deny("EXEC_SERVICE_SHUTDOWN", "Execution service is shut down");
    validateAuthority(input);
    if (!(input.entryPoint in PROFILE_BY_ENTRY) || PROFILE_BY_ENTRY[input.entryPoint] !== input.profile) deny("EXEC_PROFILE_INVALID", "Execution profile does not match entry point");
    if (!(input.payload instanceof Uint8Array) || input.payload.byteLength < 1) deny("EXEC_REQUEST_INVALID", "Execution payload is invalid");
    if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.#now() || input.expiresAtMs - this.#now() > 15_000) deny("EXEC_GRANT_EXPIRED", "Execution grant expiry is invalid");
    const limits = validateLimits(input.entryPoint, input.limits);
    if (input.payload.byteLength > limits.inputBytes) deny("EXEC_REQUEST_INVALID", "Execution payload exceeds its profile limit");
    const payload = Buffer.from(input.payload);
    const token = Object.freeze({ grantId: randomUUID() });
    const record: GrantRecord = {
      token,
      request: Object.freeze({
        contextId: input.contextId, sessionId: input.sessionId, runId: input.runId,
        principal: input.principal, authorityEpoch: input.authorityEpoch,
        personaDigest: input.personaDigest, policyDigest: input.policyDigest,
        entryPoint: input.entryPoint, profile: input.profile, expiresAtMs: input.expiresAtMs,
      }),
      owner: input.resourceOwner,
      payload,
      payloadDigest: digest(payload),
      roots: validateRoots(input.roots),
      environment: validateEnvironment(input.entryPoint, input.environment),
      network: validateNetwork(input.entryPoint, input.network),
      limits,
      state: "fresh",
    };
    this.#grants.set(token, record);
    return token;
  }

  async issueExecutionGrantAuthenticated(input: ExecutionGrantRequest): Promise<ExecutionGrant> {
    try {
      return this.issueExecutionGrant(input);
    } catch (error) {
      if (error instanceof ExecutionDeniedError && error.code === "EXEC_NETWORK_PROFILE_UNSUPPORTED") {
        throw await this.#observeLaunchDenial(error, input, undefined);
      }
      throw error;
    }
  }

  async launchOneShot(
    grant: ExecutionGrant | null | undefined,
    owner: ResourceOwner,
    invocation: ExecutionGrantInvocation
  ): Promise<ExecutionResult> {
    const output = newOutput();
    let record: GrantRecord | null = null;
    let handle: NativeExecutionHandle | null = null;
    let unregister: () => void = () => undefined;
    try {
      record = this.#beginGrantConsumption(grant);
      this.#validateGrantInvocation(record, owner, invocation, new Set<ExecutionEntryPoint>(["E1", "E3"]));
      handle = await this.#launchNative(record, output);
      this.#activeHandles.add(handle);
      unregister = registerOwnedResource(owner, () => handle!.terminate("owner-retired"));
      const completion = await handle.completed;
      if (output.aggregateBytes > record.limits.aggregateOutputBytes) deny("EXEC_OUTPUT_LIMIT", "Execution output limit exceeded");
      return Object.freeze({
        executionId: handle.executionId,
        exitCode: completion.exitCode,
        reason: completion.reason,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        outputTruncated: output.truncated,
      });
    } catch (error) {
      if (handle) {
        await handle.terminate("launch-failed").catch(() => undefined);
        await handle.completed.catch(() => undefined);
      }
      if (error instanceof ExecutionDeniedError) throw await this.#observeLaunchDenial(error, invocation, grant);
      throw nativeFailure(error, "Native execution failed closed");
    } finally {
      if (record) record.state = "consumed";
      unregister();
      if (handle) this.#activeHandles.delete(handle);
    }
  }

  async launchPersistent(
    grant: ExecutionGrant | null | undefined,
    owner: ResourceOwner,
    invocation: ExecutionGrantInvocation
  ): Promise<SessionLease> {
    const record = this.#beginGrantConsumption(grant);
    const output = newOutput();
    let handle: NativeExecutionHandle | null = null;
    try {
      this.#validateGrantInvocation(record, owner, invocation, new Set<ExecutionEntryPoint>(["E2", "E4"]));
      handle = await this.#launchNative(record, output);
      this.#activeHandles.add(handle);
      const token = Object.freeze({ leaseId: randomUUID(), sessionId: record.request.sessionId });
      const session: SessionRecord = {
        token,
        owner,
        authority: Object.freeze({
          contextId: record.request.contextId, sessionId: record.request.sessionId,
          runId: record.request.runId, principal: record.request.principal,
          authorityEpoch: record.request.authorityEpoch, personaDigest: record.request.personaDigest,
          policyDigest: record.request.policyDigest,
        }),
        limits: record.limits,
        entryPoint: record.request.entryPoint as "E2" | "E4",
        native: handle,
        output,
        unregister: () => undefined,
        state: "running",
      };
      session.unregister = registerOwnedResource(owner, () => this.#terminateSession(session, "owner-retired"));
      this.#leases.set(token, session);
      this.#sessions.add(session);
      void handle.completed.then(
        () => this.#closeSession(session),
        () => this.#closeSession(session)
      );
      return token;
    } catch (error) {
      if (handle) {
        await handle.terminate("launch-failed").catch(() => undefined);
        await handle.completed.catch(() => undefined);
        this.#activeHandles.delete(handle);
      }
      if (error instanceof ExecutionDeniedError) throw error;
      throw nativeFailure(error, "Native persistent execution failed closed");
    } finally {
      record.state = "consumed";
    }
  }

  issueInputGrant(input: Readonly<{
    lease: SessionLease;
    resourceOwner: ResourceOwner;
    contextId: string;
    sessionId: string;
    runId: string;
    principal: string;
    authorityEpoch: number;
    payload: Uint8Array;
    appendNewline: boolean;
    expiresAtMs: number;
  }>): InputGrant {
    if (this.#shutdown) deny("EXEC_SERVICE_SHUTDOWN", "Execution service is shut down");
    const session = this.#requireSession(input.lease, input.resourceOwner);
    if (session.state !== "running") deny("EXEC_SESSION_STALE", "Execution session is stale");
    const authority = session.authority;
    if (![input.contextId, input.runId].every(validId)) deny("EXEC_BINDING_MISMATCH", "Input authority is invalid");
    if (input.sessionId !== authority.sessionId) deny("EXEC_GRANT_CROSS_SESSION", "Input authority crossed sessions");
    if (session.entryPoint === "E2" && input.runId !== authority.runId) deny("EXEC_GRANT_CROSS_RUN", "Input authority crossed runs");
    if (input.contextId !== authority.contextId || input.principal !== authority.principal
      || input.authorityEpoch !== authority.authorityEpoch) {
      deny("EXEC_BINDING_MISMATCH", "Input authority differs from the persistent launch authority");
    }
    if (!(input.payload instanceof Uint8Array) || input.payload.byteLength < 1 || input.payload.byteLength > session.limits.inputBytes || typeof input.appendNewline !== "boolean") deny("EXEC_REQUEST_INVALID", "Input payload is invalid");
    if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.#now() || input.expiresAtMs - this.#now() > 15_000) deny("EXEC_GRANT_EXPIRED", "Input grant expiry is invalid");
    const payload = Buffer.from(input.payload);
    const token = Object.freeze({ grantId: randomUUID() });
    this.#inputGrants.set(token, {
      token, lease: input.lease, owner: input.resourceOwner,
      contextId: input.contextId, sessionId: input.sessionId, runId: input.runId,
      principal: input.principal, authorityEpoch: input.authorityEpoch,
      payload, payloadDigest: digest(payload), appendNewline: input.appendNewline,
      expiresAtMs: input.expiresAtMs, state: "fresh",
    });
    return token;
  }

  async write(
    lease: SessionLease,
    grant: InputGrant | null | undefined,
    owner: ResourceOwner,
    invocation: InputGrantInvocation
  ): Promise<void> {
    let record: InputRecord | null = null;
    try {
      if (this.#shutdown) deny("EXEC_SERVICE_SHUTDOWN", "Execution service is shut down");
      record = this.#beginInputGrantConsumption(grant);
      if (record.expiresAtMs <= this.#now()) deny("EXEC_GRANT_EXPIRED", "Input grant expired");
      if (!invocation || typeof invocation !== "object") deny("EXEC_BINDING_MISMATCH", "Input invocation context is missing");
      if (record.sessionId !== invocation.sessionId) deny("EXEC_GRANT_CROSS_SESSION", "Input grant crossed sessions");
      if (record.runId !== invocation.runId) deny("EXEC_GRANT_CROSS_RUN", "Input grant crossed runs");
      if (!(invocation.payload instanceof Uint8Array) || !record.payload.equals(invocation.payload)
        || record.appendNewline !== invocation.appendNewline) {
        deny("EXEC_GRANT_ARGUMENT_MISMATCH", "Input differs from the approved grant");
      }
      if (record.lease !== lease || record.owner !== owner || record.contextId !== invocation.contextId
        || record.principal !== invocation.principal || record.authorityEpoch !== invocation.authorityEpoch) {
        deny("EXEC_BINDING_MISMATCH", "Input grant binding mismatch");
      }
      const session = this.#requireSession(lease, owner);
      if (record.contextId !== session.authority.contextId
        || (session.entryPoint === "E2" && record.runId !== session.authority.runId)
        || record.sessionId !== session.authority.sessionId || record.principal !== session.authority.principal
        || record.authorityEpoch !== session.authority.authorityEpoch) {
        deny("EXEC_BINDING_MISMATCH", "Input grant binding mismatch");
      }
      try {
        await session.native.write(Object.freeze({ bytes: Buffer.from(record.payload), digest: record.payloadDigest, appendNewline: record.appendNewline }));
      } catch (error) {
        await this.#terminateSession(session, "input-failed").catch(() => undefined);
        throw nativeFailure(error, "Native input failed closed");
      }
    } catch (error) {
      if (error instanceof ExecutionDeniedError) throw await this.#observeInputDenial(error, lease, owner, invocation);
      throw error;
    } finally {
      if (record) record.state = "consumed";
    }
  }

  readOutput(lease: SessionLease, owner: ResourceOwner): SessionOutput {
    const session = this.#requireSession(lease, owner, true);
    return Object.freeze({
      stdout: Buffer.concat(session.output.stdout).toString("utf8"),
      stderr: Buffer.concat(session.output.stderr).toString("utf8"),
      outputTruncated: session.output.truncated,
      running: session.state === "running",
    });
  }

  async terminate(lease: SessionLease, owner: ResourceOwner, reason = "requested"): Promise<void> {
    const session = this.#requireSession(lease, owner, true);
    await this.#terminateSession(session, reason);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdown = true;
    this.#shutdownPromise = (async () => {
      const sessions = [...this.#sessions];
      await Promise.allSettled(sessions.map(session => this.#terminateSession(session, "service-shutdown")));
      const handles = [...this.#activeHandles];
      await Promise.allSettled(handles.map(async handle => {
        await handle.terminate("service-shutdown");
        await handle.completed;
      }));
      await this.#bridge.shutdown();
    })();
    return this.#shutdownPromise;
  }

  #beginGrantConsumption(grant: ExecutionGrant | null | undefined): GrantRecord {
    if (this.#shutdown) deny("EXEC_SERVICE_SHUTDOWN", "Execution service is shut down");
    if (grant === null || grant === undefined) deny("EXEC_GRANT_REQUIRED", "Execution grant is required");
    const record = this.#grants.get(grant);
    if (!record || record.token !== grant) deny("EXEC_GRANT_FORGED", "Execution grant is forged");
    if (record.state === "consuming") deny("EXEC_GRANT_CONCURRENT_REUSE", "Execution grant is already being consumed");
    if (record.state === "consumed") deny("EXEC_GRANT_REPLAYED", "Execution grant was already consumed");
    record.state = "consuming";
    return record;
  }

  #beginInputGrantConsumption(grant: InputGrant | null | undefined): InputRecord {
    if (grant === null || grant === undefined) deny("EXEC_GRANT_REQUIRED", "Input grant is required");
    const record = this.#inputGrants.get(grant);
    if (!record || record.token !== grant) deny("EXEC_GRANT_FORGED", "Input grant is forged");
    if (record.state === "consuming") deny("EXEC_GRANT_CONCURRENT_REUSE", "Input grant is already being consumed");
    if (record.state === "consumed") deny("EXEC_GRANT_REPLAYED", "Input grant was already consumed");
    record.state = "consuming";
    return record;
  }

  #validateGrantInvocation(
    record: GrantRecord,
    owner: ResourceOwner,
    invocation: ExecutionGrantInvocation,
    allowed: ReadonlySet<ExecutionEntryPoint>
  ): void {
    if (record.request.expiresAtMs <= this.#now()) deny("EXEC_GRANT_EXPIRED", "Execution grant expired");
    if (!invocation || typeof invocation !== "object") deny("EXEC_BINDING_MISMATCH", "Execution invocation context is missing");
    if (record.request.sessionId !== invocation.sessionId) deny("EXEC_GRANT_CROSS_SESSION", "Execution grant crossed sessions");
    if (record.request.runId !== invocation.runId) deny("EXEC_GRANT_CROSS_RUN", "Execution grant crossed runs");
    if (!allowed.has(record.request.entryPoint) || record.request.entryPoint !== invocation.entryPoint
      || record.request.profile !== invocation.profile) {
      deny("EXEC_PROFILE_INVALID", "Execution grant has the wrong lifetime profile");
    }
    assertOwner(record.owner, owner);
    if (invocation.resourceOwner !== owner || record.request.contextId !== invocation.contextId
      || record.request.principal !== invocation.principal || record.request.authorityEpoch !== invocation.authorityEpoch
      || record.request.personaDigest !== invocation.personaDigest || record.request.policyDigest !== invocation.policyDigest) {
      deny("EXEC_BINDING_MISMATCH", "Execution grant binding mismatch");
    }
    if (!(invocation.payload instanceof Uint8Array) || !record.payload.equals(invocation.payload)
      || !sameRoots(record.roots, invocation.roots) || !sameFlatRecord(record.environment, invocation.environment)
      || !sameFlatRecord(record.network, invocation.network) || !sameFlatRecord(record.limits, invocation.limits)) {
      deny("EXEC_GRANT_ARGUMENT_MISMATCH", "Execution differs from the approved grant");
    }
  }

  async #observeLaunchDenial(error: ExecutionDeniedError, invocation: ExecutionGrantInvocation, grant: ExecutionGrant | null | undefined): Promise<ExecutionDeniedError> {
    const decisionState = serviceDenialState(error.code);
    const observe = this.#bridge.observeServiceDenial;
    const supportedPair = decisionState === "network-profile-unsupported"
      ? invocation?.entryPoint === "E4" && invocation?.profile === "manual-terminal"
      : (invocation?.entryPoint === "E1" || invocation?.entryPoint === "E3") && PROFILE_BY_ENTRY[invocation.entryPoint] === invocation.profile;
    if (!decisionState || typeof observe !== "function" || !invocation || typeof invocation !== "object"
      || !supportedPair
      || ![invocation.contextId, invocation.sessionId, invocation.runId, invocation.principal].every(validId)
      || !Number.isSafeInteger(invocation.authorityEpoch) || invocation.authorityEpoch < 1
      || !HEX_64.test(invocation.personaDigest) || !HEX_64.test(invocation.policyDigest)
      || !(invocation.payload instanceof Uint8Array) || !Array.isArray(invocation.roots)) return error;
    const profile = invocation.entryPoint === "E1" ? "one-shot-shell" : invocation.entryPoint === "E3" ? "script" : "manual-terminal";
    const authority = grant ? this.#grants.get(grant) : undefined;
    const contextId = authority?.request.contextId ?? invocation.contextId;
    const sessionId = authority?.request.sessionId ?? invocation.sessionId;
    const runId = authority?.request.runId ?? invocation.runId;
    const authorityEpoch = authority?.request.authorityEpoch ?? invocation.authorityEpoch;
    const personaDigest = authority?.request.personaDigest ?? invocation.personaDigest;
    const policyDigest = authority?.request.policyDigest ?? invocation.policyDigest;
    const payloadDigest = digest(invocation.payload);
    const roots = invocation.roots.map(root => ({
      rootId: root?.rootId,
      access: root?.access,
      identity: root?.identity ? { volumeSerial: root.identity.volumeSerial, fileId: root.identity.fileId, type: root.identity.type } : null,
    }));
    const requestDigest = canonicalDigest({
      schema: "mini-lux/sec03/service-denial-request/v1",
      operation: "launch",
      entryPoint: invocation.entryPoint,
      profile: invocation.profile,
      contextId: invocation.contextId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      principal: invocation.principal,
      authorityEpoch: invocation.authorityEpoch,
      personaDigest: invocation.personaDigest,
      policyDigest: invocation.policyDigest,
      payloadDigest,
      roots,
      environment: invocation.environment,
      network: invocation.network,
      limits: invocation.limits,
    });
    try {
      const nativeObservation = await observe.call(this.#bridge, Object.freeze({
        executionId: digest(Buffer.from(randomUUID(), "utf8")),
        entryPoint: invocation.entryPoint,
        profile,
        contextId,
        sessionId,
        runId,
        authorityEpoch,
        personaDigest,
        policyDigest,
        payloadDigest,
        requestDigest,
        operation: "launch",
        decisionState,
      }));
      return new ExecutionDeniedError(error.code, error.message, nativeObservation);
    } catch {
      return error;
    }
  }

  async #observeInputDenial(error: ExecutionDeniedError, lease: SessionLease, owner: ResourceOwner, invocation: InputGrantInvocation): Promise<ExecutionDeniedError> {
    const decisionState = serviceDenialState(error.code);
    const observe = this.#bridge.observeServiceDenial;
    const session = this.#leases.get(lease);
    if (!decisionState || typeof observe !== "function" || !session || session.token !== lease || session.owner !== owner || session.entryPoint !== "E2"
      || !invocation || typeof invocation !== "object" || !(invocation.payload instanceof Uint8Array)
      || ![invocation.contextId, invocation.sessionId, invocation.runId, invocation.principal].every(validId)
      || !Number.isSafeInteger(invocation.authorityEpoch) || invocation.authorityEpoch < 1
      || typeof invocation.appendNewline !== "boolean") return error;
    const payloadDigest = digest(invocation.payload);
    const requestDigest = canonicalDigest({
      schema: "mini-lux/sec03/service-denial-request/v1",
      operation: "input",
      entryPoint: "E2",
      profile: "agent-shell",
      contextId: invocation.contextId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      principal: invocation.principal,
      authorityEpoch: invocation.authorityEpoch,
      personaDigest: session.authority.personaDigest,
      policyDigest: session.authority.policyDigest,
      payloadDigest,
      appendNewline: invocation.appendNewline,
    });
    try {
      const nativeObservation = await observe.call(this.#bridge, Object.freeze({
        executionId: digest(Buffer.from(randomUUID(), "utf8")),
        entryPoint: "E2",
        profile: "agent-shell",
        contextId: session.authority.contextId,
        sessionId: session.authority.sessionId,
        runId: session.authority.runId,
        authorityEpoch: session.authority.authorityEpoch,
        personaDigest: session.authority.personaDigest,
        policyDigest: session.authority.policyDigest,
        payloadDigest,
        requestDigest,
        operation: "input",
        decisionState,
      }));
      return new ExecutionDeniedError(error.code, error.message, nativeObservation);
    } catch {
      return error;
    }
  }

  async #launchNative(record: GrantRecord, output: OutputRecord): Promise<NativeExecutionHandle> {
    let handle: NativeExecutionHandle | null = null;
    const onFrame = (frame: Readonly<{ stream: "stdout" | "stderr"; bytes: Uint8Array }>): void => {
      if (!(frame.bytes instanceof Uint8Array)) return;
      const bytes = Buffer.from(frame.bytes);
      output.aggregateBytes += bytes.length;
      const remaining = Math.max(0, record.limits.retainedOutputBytes - output.retainedBytes);
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        output[frame.stream].push(retained);
        output.retainedBytes += retained.length;
      }
      if (remaining < bytes.length) output.truncated = true;
      if (output.aggregateBytes > record.limits.aggregateOutputBytes) {
        output.truncated = true;
        if (handle) void handle.terminate("output-limit").catch(() => undefined);
      }
    };
    handle = await this.#bridge.launch(Object.freeze({
      executionId: digest(Buffer.from(randomUUID(), "utf8")),
      entryPoint: record.request.entryPoint,
      profile: record.request.profile,
      contextId: record.request.contextId,
      sessionId: record.request.sessionId,
      runId: record.request.runId,
      principal: record.request.principal,
      authorityEpoch: record.request.authorityEpoch,
      personaDigest: record.request.personaDigest,
      policyDigest: record.request.policyDigest,
      payload: Buffer.from(record.payload),
      payloadDigest: record.payloadDigest,
      roots: record.roots,
      environment: record.environment,
      network: record.network,
      limits: record.limits,
      expiresAtMs: record.request.expiresAtMs,
    }), onFrame);
    if (output.aggregateBytes > record.limits.aggregateOutputBytes) await handle.terminate("output-limit");
    return handle;
  }

  #requireSession(lease: SessionLease, owner: ResourceOwner, allowClosed = false): SessionRecord {
    const record = this.#leases.get(lease);
    if (!record || record.token !== lease) deny("EXEC_GRANT_FORGED", "Session lease is forged");
    assertOwner(record.owner, owner);
    if (!allowClosed && record.state !== "running") deny("EXEC_SESSION_STALE", "Execution session is stale");
    return record;
  }

  async #terminateSession(session: SessionRecord, reason: string): Promise<void> {
    if (session.state === "closed") return;
    if (session.state === "running") session.state = "terminating";
    let failure: unknown = null;
    try {
      await session.native.terminate(reason);
    } catch (error) {
      failure = error;
    }
    try {
      await session.native.completed;
    } catch (error) {
      failure ??= error;
    } finally {
      this.#closeSession(session);
    }
    if (failure) throw failure;
  }

  #closeSession(session: SessionRecord): void {
    if (session.state === "closed") return;
    session.state = "closed";
    session.unregister();
    this.#sessions.delete(session);
    this.#activeHandles.delete(session.native);
  }
}
