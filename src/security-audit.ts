import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type SecurityAuditPhase = "request" | "authorization" | "execution" | "result";
export type SecurityAuditIngress = "agent-tool" | "direct-api" | "native-consent" | "terminal" | "system";
export type SecurityAuditPrincipal = "agent" | "subagent" | "playbook" | "local-user-api" | "system";
export type SecurityAuditOperationKind = "tool" | "api" | "terminal" | "native" | "system";
export type SecurityAuditExecutor = "tool-dispatcher" | "direct-api" | "terminal" | "native-host" | "none";
export type SecurityAuditResultStatus = "success" | "denied" | "error" | "timeout" | "cancelled" | "interrupted";

export interface SecurityAuditCorrelation {
  readonly sessionId: string | null;
  readonly runId: string;
  readonly requestId: string;
  readonly parentRequestId: string | null;
  readonly toolCallId: string | null;
  readonly contextId: string | null;
  readonly executionId: string | null;
}

export interface RequestAuditPayload {
  readonly ingress: SecurityAuditIngress;
  readonly argumentBytes: number;
  readonly argumentsCommitment: string;
}

export interface AuthorizationAuditPayload {
  readonly decision: "allowed" | "denied";
  readonly policyDigest: string | null;
  readonly personaDigest: string | null;
  readonly approvalKind: "none" | "supervisor" | "user" | "native-process";
}

export interface ExecutionAuditPayload {
  readonly state: "started" | "not_started";
  readonly executor: SecurityAuditExecutor;
  readonly profile: string | null;
  readonly proofDigest: string | null;
}

export interface ResultAuditPayload {
  readonly status: SecurityAuditResultStatus;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly resultCommitment: string | null;
}

export type SecurityAuditPayload = RequestAuditPayload | AuthorizationAuditPayload | ExecutionAuditPayload | ResultAuditPayload;

export interface SecurityAuditEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly phase: SecurityAuditPhase;
  readonly correlation: SecurityAuditCorrelation;
  readonly principal: SecurityAuditPrincipal;
  readonly operationKind: SecurityAuditOperationKind;
  readonly operationName: string;
  readonly outcome: string;
  readonly code: string | null;
  readonly requestCommitment: string;
  readonly safePayload: SecurityAuditPayload;
  readonly previousEventHash: string;
  readonly eventHash: string;
}

export interface SecurityAuditCheckpoint {
  readonly schemaVersion: 1;
  readonly eventCount: number;
  readonly headHash: string;
  readonly checkpointMac: string;
}

export interface AppendSecurityAuditEventInput {
  readonly eventId?: string;
  readonly recordedAt?: string;
  readonly phase: SecurityAuditPhase;
  readonly correlation: SecurityAuditCorrelation;
  readonly principal: SecurityAuditPrincipal;
  readonly operationKind: SecurityAuditOperationKind;
  readonly operationName: string;
  readonly outcome: string;
  readonly code: string | null;
  readonly requestCommitment: string;
  readonly safePayload: SecurityAuditPayload;
}

const AUDIT_EVENT_DOMAIN = "mini-lux/sec06/audit-event/v1\0";
const AUDIT_INTEGRITY_KEY_DOMAIN = "mini-lux/sec06/integrity-key/v1\0";
const AUDIT_COMMITMENT_KEY_DOMAIN = "mini-lux/sec06/commitment-key/v1\0";
const AUDIT_CHECKPOINT_KEY_DOMAIN = "mini-lux/sec06/checkpoint-key/v1\0";
const AUDIT_CHECKPOINT_DOMAIN = "mini-lux/sec06/checkpoint/v1\0";
const GENESIS_HASH = "0".repeat(64);
const digestPattern = /^(?:hmac-sha256:)?[a-f0-9]{64}$/u;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const operationPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_CANONICAL_COMMITMENT_BYTES = 1024 * 1024;
const MAX_SAFE_BYTE_COUNT = 1024 * 1024 * 1024;

function exactObject(value: unknown, keys: readonly string[], field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} fields are invalid`);
  }
}

function assertIdentity(value: unknown, field: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !identityPattern.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertDigest(value: unknown, field: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !digestPattern.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertByteCount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_SAFE_BYTE_COUNT) {
    throw new TypeError(`${field} is invalid`);
  }
}

function canonicalJsonValue(value: unknown, seen: WeakSet<object>, depth: number): string {
  if (depth > 32) throw new TypeError("Canonical audit value is too deep");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical audit number is invalid");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) throw new TypeError("Canonical audit value is invalid");
  if (seen.has(value)) throw new TypeError("Canonical audit value is circular");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(entry => canonicalJsonValue(entry, seen, depth + 1)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical audit object prototype is invalid");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonValue((value as Record<string, unknown>)[key], seen, depth + 1)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalSecurityAuditJson(value: unknown): string {
  return canonicalJsonValue(value, new WeakSet(), 0);
}

function deriveSecurityAuditKey(masterKey: Uint8Array, domain: string): Buffer {
  if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) throw new TypeError("Security audit master key must be 32 bytes");
  return createHmac("sha256", masterKey).update(domain, "utf8").digest();
}

export function createSecurityAuditCommitment(masterKey: Uint8Array, value: unknown): string {
  const key = deriveSecurityAuditKey(masterKey, AUDIT_COMMITMENT_KEY_DOMAIN);
  let canonical: Buffer | null = null;
  try {
    canonical = Buffer.from(canonicalSecurityAuditJson(value), "utf8");
    if (canonical.length > MAX_CANONICAL_COMMITMENT_BYTES) throw new TypeError("Security audit commitment input is too large");
    return `hmac-sha256:${createHmac("sha256", key).update(canonical).digest("hex")}`;
  } finally {
    canonical?.fill(0);
    key.fill(0);
  }
}

export function createSecurityAuditCheckpoint(
  masterKey: Uint8Array,
  summary: Readonly<{ eventCount: number; headHash: string }>
): Readonly<SecurityAuditCheckpoint> {
  exactObject(summary, ["eventCount", "headHash"], "Security audit checkpoint summary");
  if (!Number.isSafeInteger(summary.eventCount) || summary.eventCount < 0) throw new TypeError("Security audit checkpoint eventCount is invalid");
  assertDigest(summary.headHash, "Security audit checkpoint headHash");
  const payload = Object.freeze({ schemaVersion: 1 as const, eventCount: summary.eventCount, headHash: summary.headHash });
  const key = deriveSecurityAuditKey(masterKey, AUDIT_CHECKPOINT_KEY_DOMAIN);
  try {
    const checkpointMac = `hmac-sha256:${createHmac("sha256", key)
      .update(AUDIT_CHECKPOINT_DOMAIN, "utf8")
      .update(canonicalSecurityAuditJson(payload), "utf8")
      .digest("hex")}`;
    return Object.freeze({ ...payload, checkpointMac });
  } finally {
    key.fill(0);
  }
}

export function verifySecurityAuditCheckpoint(
  checkpoint: SecurityAuditCheckpoint,
  summary: Readonly<{ eventCount: number; headHash: string }>,
  masterKey: Uint8Array
): void {
  exactObject(checkpoint, ["schemaVersion", "eventCount", "headHash", "checkpointMac"], "Security audit checkpoint");
  if (checkpoint.schemaVersion !== 1) throw new Error("Security audit checkpoint Schema is invalid");
  assertDigest(checkpoint.checkpointMac, "Security audit checkpoint MAC");
  const expected = createSecurityAuditCheckpoint(masterKey, summary);
  const actualBytes = Buffer.from(checkpoint.checkpointMac.slice("hmac-sha256:".length), "hex");
  const expectedBytes = Buffer.from(expected.checkpointMac.slice("hmac-sha256:".length), "hex");
  try {
    if (checkpoint.eventCount !== summary.eventCount || checkpoint.headHash !== summary.headHash
      || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error("Security audit checkpoint differs from the event chain");
    }
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
}

export function makeRequestAuditPayload(input: RequestAuditPayload): Readonly<RequestAuditPayload> {
  exactObject(input, ["ingress", "argumentBytes", "argumentsCommitment"], "Request audit payload");
  if (!["agent-tool", "direct-api", "native-consent", "terminal", "system"].includes(input.ingress)) throw new TypeError("Request audit ingress is invalid");
  assertByteCount(input.argumentBytes, "Request audit argumentBytes");
  assertDigest(input.argumentsCommitment, "Request audit argumentsCommitment");
  return Object.freeze({ ...input });
}

export function makeAuthorizationAuditPayload(input: AuthorizationAuditPayload): Readonly<AuthorizationAuditPayload> {
  exactObject(input, ["decision", "policyDigest", "personaDigest", "approvalKind"], "Authorization audit payload");
  if (!(["allowed", "denied"] as const).includes(input.decision)) throw new TypeError("Authorization audit decision is invalid");
  assertDigest(input.policyDigest, "Authorization audit policyDigest", true);
  assertDigest(input.personaDigest, "Authorization audit personaDigest", true);
  if (!(["none", "supervisor", "user", "native-process"] as const).includes(input.approvalKind)) throw new TypeError("Authorization audit approvalKind is invalid");
  return Object.freeze({ ...input });
}

export function makeExecutionAuditPayload(input: ExecutionAuditPayload): Readonly<ExecutionAuditPayload> {
  exactObject(input, ["state", "executor", "profile", "proofDigest"], "Execution audit payload");
  if (!(["started", "not_started"] as const).includes(input.state)) throw new TypeError("Execution audit state is invalid");
  if (!(["tool-dispatcher", "direct-api", "terminal", "native-host", "none"] as const).includes(input.executor)) throw new TypeError("Execution audit executor is invalid");
  if (input.state === "not_started" && input.executor !== "none") throw new TypeError("Non-started execution must use the none executor");
  if (input.profile !== null && (typeof input.profile !== "string" || !operationPattern.test(input.profile))) throw new TypeError("Execution audit profile is invalid");
  assertDigest(input.proofDigest, "Execution audit proofDigest", true);
  return Object.freeze({ ...input });
}

export function makeResultAuditPayload(input: ResultAuditPayload): Readonly<ResultAuditPayload> {
  exactObject(input, ["status", "durationMs", "outputBytes", "truncated", "resultCommitment"], "Result audit payload");
  if (!(["success", "denied", "error", "timeout", "cancelled", "interrupted"] as const).includes(input.status)) throw new TypeError("Result audit status is invalid");
  assertByteCount(input.durationMs, "Result audit durationMs");
  assertByteCount(input.outputBytes, "Result audit outputBytes");
  if (typeof input.truncated !== "boolean") throw new TypeError("Result audit truncated is invalid");
  assertDigest(input.resultCommitment, "Result audit resultCommitment", true);
  return Object.freeze({ ...input });
}

function validateCorrelation(value: SecurityAuditCorrelation): Readonly<SecurityAuditCorrelation> {
  exactObject(value, ["sessionId", "runId", "requestId", "parentRequestId", "toolCallId", "contextId", "executionId"], "Security audit correlation");
  assertIdentity(value.sessionId, "Security audit sessionId", true);
  assertIdentity(value.runId, "Security audit runId");
  assertIdentity(value.requestId, "Security audit requestId");
  assertIdentity(value.parentRequestId, "Security audit parentRequestId", true);
  assertIdentity(value.toolCallId, "Security audit toolCallId", true);
  assertIdentity(value.contextId, "Security audit contextId", true);
  assertIdentity(value.executionId, "Security audit executionId", true);
  if (value.parentRequestId === value.requestId) throw new TypeError("Security audit request cannot be its own parent");
  return Object.freeze({ ...value });
}

function validatePayload(phase: SecurityAuditPhase, payload: SecurityAuditPayload): Readonly<SecurityAuditPayload> {
  if (phase === "request") return makeRequestAuditPayload(payload as RequestAuditPayload);
  if (phase === "authorization") return makeAuthorizationAuditPayload(payload as AuthorizationAuditPayload);
  if (phase === "execution") return makeExecutionAuditPayload(payload as ExecutionAuditPayload);
  return makeResultAuditPayload(payload as ResultAuditPayload);
}

function validateTimestamp(value: string): string {
  if (!canonicalTimestampPattern.test(value) || new Date(value).toISOString() !== value) throw new TypeError("Security audit timestamp is invalid");
  return value;
}

function eventPayloadForHash(event: Omit<SecurityAuditEvent, "eventHash">): string {
  return canonicalSecurityAuditJson(event);
}

function computeEventHash(masterKey: Uint8Array, event: Omit<SecurityAuditEvent, "eventHash">): string {
  const integrityKey = deriveSecurityAuditKey(masterKey, AUDIT_INTEGRITY_KEY_DOMAIN);
  try { return `hmac-sha256:${createHmac("sha256", integrityKey).update(AUDIT_EVENT_DOMAIN, "utf8").update(eventPayloadForHash(event), "utf8").digest("hex")}`; }
  finally { integrityKey.fill(0); }
}

function sameBaseCorrelation(left: SecurityAuditCorrelation, right: SecurityAuditCorrelation): boolean {
  return left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.requestId === right.requestId
    && left.parentRequestId === right.parentRequestId
    && left.toolCallId === right.toolCallId
    && left.contextId === right.contextId;
}

function requestEvents(events: readonly SecurityAuditEvent[], requestId: string): SecurityAuditEvent[] {
  return events.filter(event => event.correlation.requestId === requestId);
}

function validateTransition(events: readonly SecurityAuditEvent[], input: AppendSecurityAuditEventInput): void {
  const related = requestEvents(events, input.correlation.requestId);
  const expectedPhase = (["request", "authorization", "execution", "result"] as const)[related.length];
  if (input.phase !== expectedPhase) throw new Error(`Security audit phase order is invalid: expected ${expectedPhase ?? "no further phase"}`);
  if (related.length === 0) {
    if (input.correlation.executionId !== null) throw new Error("Request phase cannot bind an execution identity");
    if (input.correlation.parentRequestId !== null) {
      const parent = events.find(event => event.phase === "request" && event.correlation.requestId === input.correlation.parentRequestId);
      if (!parent || parent.correlation.sessionId !== input.correlation.sessionId || parent.correlation.runId !== input.correlation.runId) {
        throw new Error("Security audit parent request identity is invalid");
      }
    }
    return;
  }
  const request = related[0];
  if (!sameBaseCorrelation(request.correlation, input.correlation)
    || request.principal !== input.principal
    || request.operationKind !== input.operationKind
    || request.operationName !== input.operationName
    || request.requestCommitment !== input.requestCommitment) {
    throw new Error("Security audit request identity changed across phases");
  }
  if (input.phase === "authorization" && input.correlation.executionId !== null) throw new Error("Authorization phase cannot bind an execution identity");
  const authorization = related.find(event => event.phase === "authorization");
  const execution = related.find(event => event.phase === "execution");
  if (input.phase === "execution") {
    const authorizationPayload = authorization?.safePayload as AuthorizationAuditPayload | undefined;
    const executionPayload = input.safePayload as ExecutionAuditPayload;
    if (authorizationPayload?.decision === "denied" && executionPayload.state !== "not_started") throw new Error("Denied authorization cannot start execution");
    if (executionPayload.state === "started" && input.correlation.executionId === null) throw new Error("Started execution requires an execution identity");
    if (executionPayload.state === "not_started" && input.correlation.executionId !== null) throw new Error("Non-started execution cannot bind an execution identity");
  }
  if (input.phase === "result") {
    if (!execution || input.correlation.executionId !== execution.correlation.executionId) throw new Error("Result execution identity differs");
    const authorizationPayload = authorization?.safePayload as AuthorizationAuditPayload | undefined;
    const resultPayload = input.safePayload as ResultAuditPayload;
    if (authorizationPayload?.decision === "denied" && resultPayload.status !== "denied") throw new Error("Denied authorization requires a denied result");
  }
}

export function appendSecurityAuditEvent(
  events: readonly SecurityAuditEvent[],
  input: AppendSecurityAuditEventInput,
  masterKey: Uint8Array
): Readonly<SecurityAuditEvent> {
  if (!Array.isArray(events)) throw new TypeError("Security audit history is invalid");
  verifySecurityAuditChain(events, masterKey);
  exactObject(input, ["eventId", "recordedAt", "phase", "correlation", "principal", "operationKind", "operationName", "outcome", "code", "requestCommitment", "safePayload"].filter(key => Object.hasOwn(input, key)), "Security audit append input");
  if (!(["request", "authorization", "execution", "result"] as const).includes(input.phase)) throw new TypeError("Security audit phase is invalid");
  const correlation = validateCorrelation(input.correlation);
  if (!(["agent", "subagent", "playbook", "local-user-api", "system"] as const).includes(input.principal)) throw new TypeError("Security audit principal is invalid");
  if (!(["tool", "api", "terminal", "native", "system"] as const).includes(input.operationKind)) throw new TypeError("Security audit operation kind is invalid");
  if (!operationPattern.test(input.operationName)) throw new TypeError("Security audit operation name is invalid");
  if (!operationPattern.test(input.outcome)) throw new TypeError("Security audit outcome is invalid");
  if (input.code !== null && (typeof input.code !== "string" || !codePattern.test(input.code))) throw new TypeError("Security audit code is invalid");
  assertDigest(input.requestCommitment, "Security audit requestCommitment");
  const safePayload = validatePayload(input.phase, input.safePayload);
  const normalized = Object.freeze({ ...input, correlation, safePayload });
  validateTransition(events, normalized);
  const eventId = input.eventId ?? randomUUID();
  assertIdentity(eventId, "Security audit eventId");
  const recordedAt = validateTimestamp(input.recordedAt ?? new Date().toISOString());
  const previousEventHash = events.at(-1)?.eventHash ?? GENESIS_HASH;
  const withoutHash: Omit<SecurityAuditEvent, "eventHash"> = {
    schemaVersion: 1,
    eventId,
    sequence: events.length + 1,
    recordedAt,
    phase: input.phase,
    correlation,
    principal: input.principal,
    operationKind: input.operationKind,
    operationName: input.operationName,
    outcome: input.outcome,
    code: input.code,
    requestCommitment: input.requestCommitment,
    safePayload,
    previousEventHash,
  };
  return Object.freeze({ ...withoutHash, eventHash: computeEventHash(masterKey, withoutHash) });
}

export function verifySecurityAuditChain(events: readonly SecurityAuditEvent[], masterKey: Uint8Array): Readonly<{ eventCount: number; headHash: string }> {
  if (!Array.isArray(events)) throw new TypeError("Security audit history is invalid");
  let previousHash = GENESIS_HASH;
  const accepted: SecurityAuditEvent[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    exactObject(event, ["schemaVersion", "eventId", "sequence", "recordedAt", "phase", "correlation", "principal", "operationKind", "operationName", "outcome", "code", "requestCommitment", "safePayload", "previousEventHash", "eventHash"], "Security audit event");
    if (event.schemaVersion !== 1 || event.sequence !== index + 1) throw new Error("Security audit sequence is invalid");
    assertIdentity(event.eventId, "Security audit eventId");
    if (eventIds.has(event.eventId)) throw new Error("Security audit event identity is duplicated");
    eventIds.add(event.eventId);
    validateTimestamp(event.recordedAt);
    if (event.previousEventHash !== previousHash) throw new Error("Security audit previous hash differs");
    assertDigest(event.eventHash, "Security audit eventHash");
    const { eventHash, ...withoutHash } = event;
    if (computeEventHash(masterKey, withoutHash) !== eventHash) throw new Error("Security audit event hash differs");
    const payload = validatePayload(event.phase, event.safePayload);
    validateTransition(accepted, { ...event, safePayload: payload });
    accepted.push(event);
    previousHash = eventHash;
  }
  return Object.freeze({ eventCount: events.length, headHash: previousHash });
}
