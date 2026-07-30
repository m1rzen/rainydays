import { createHash, randomUUID } from "node:crypto";
import type { NativeExecutionProof, NativeServiceDenialRequest, NativeServiceDenialState } from "./execution-native.js";

export type ManualConsentOperation = "terminal-start" | "terminal-input";
export type ManualConsentDecision = "approve" | "deny" | "dismiss";

export interface ManualConsentBinding {
  readonly windowId: number;
  readonly webContentsId: number;
  readonly sessionId: string;
  readonly runtimeAuthorityId: string;
  readonly authorityEpoch: number;
  readonly incarnationId: string;
}

export interface ManualConsentPresence extends ManualConsentBinding {
  readonly topFrame: boolean;
  readonly windowVisible: boolean;
  readonly windowFocused: boolean;
}

export interface ManualConsentDisplay {
  readonly operationLabel: string;
  readonly targetLabel: string;
  readonly rootAlias: string;
  readonly preview: string;
}

export interface ManualConsentChallenge {
  readonly challengeId: string;
  readonly operation: ManualConsentOperation;
  readonly argumentsDigest: string;
  readonly expiresAt: string;
  readonly display: ManualConsentDisplay;
}

export interface ManualConsentEvidenceBinding {
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly authorityEpoch: number;
  readonly personaDigest: string;
  readonly policyDigest: string;
}

export type ManualConsentDenialCode =
  | "CONSENT_LEDGER_SHUTDOWN"
  | "CONSENT_REQUEST_INVALID"
  | "CONSENT_PRESENCE_REQUIRED"
  | "CONSENT_CHALLENGE_INVALID"
  | "EXEC_CONSENT_DENIED"
  | "EXEC_CONSENT_DISMISSED"
  | "EXEC_CONSENT_EXPIRED"
  | "EXEC_CONSENT_ARGUMENT_MISMATCH"
  | "EXEC_CONSENT_REPLAYED"
  | "EXEC_CONSENT_SYNTHETIC"
  | "EXEC_CONSENT_CROSS_WINDOW"
  | "EXEC_CONSENT_CROSS_SESSION"
  | "EXEC_CONSENT_CONCURRENT_REUSE";

export class ManualConsentDeniedError extends Error {
  readonly code: ManualConsentDenialCode;
  readonly nativeObservation: NativeExecutionProof | null;
  constructor(code: ManualConsentDenialCode, message: string, nativeObservation: NativeExecutionProof | null = null) {
    super(message);
    this.name = "ManualConsentDeniedError";
    this.code = code;
    this.nativeObservation = nativeObservation;
  }
}

interface PendingConsent {
  readonly challenge: ManualConsentChallenge;
  readonly operation: ManualConsentOperation;
  readonly binding: ManualConsentBinding;
  readonly exactRequest: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
  readonly rootQualificationDigest: string | null;
  readonly evidence: ManualConsentEvidenceBinding | null;
  readonly expiresAtMs: number;
  state: "pending" | "consuming" | "consumed";
}

interface ConsumedConsent {
  readonly outcome: "expired" | "replayed";
  readonly evidence: ManualConsentEvidenceBinding | null;
  readonly payloadDigest: string;
}

interface ManualConsentDecisionInput {
  readonly challengeId: string;
  readonly decision: ManualConsentDecision;
  readonly presence: ManualConsentPresence;
  readonly operation: ManualConsentOperation;
  readonly argumentsDigest: string;
  readonly evidence?: ManualConsentEvidenceBinding | null;
}

type ExecuteStoredConsent = (
  operation: ManualConsentOperation,
  exactRequest: Readonly<Record<string, unknown>>,
  rootQualificationDigest: string | null
) => void | Promise<void>;

const MAX_PENDING = 128;
const CONSENT_TTL_MS = 15_000;
const MAX_PREVIEW_CHARS = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const denialStateByCode = Object.freeze({
  EXEC_CONSENT_DENIED: "consent-denied",
  EXEC_CONSENT_DISMISSED: "consent-dismissed",
  EXEC_CONSENT_EXPIRED: "consent-expired",
  EXEC_CONSENT_ARGUMENT_MISMATCH: "consent-argument-mismatch",
  EXEC_CONSENT_REPLAYED: "consent-replayed",
  EXEC_CONSENT_SYNTHETIC: "consent-synthetic",
  EXEC_CONSENT_CROSS_WINDOW: "consent-cross-window",
  EXEC_CONSENT_CROSS_SESSION: "consent-cross-session",
  EXEC_CONSENT_CONCURRENT_REUSE: "consent-concurrent-reuse",
} as const satisfies Partial<Record<ManualConsentDenialCode, NativeServiceDenialState>>);

function denied(code: ManualConsentDenialCode, message: string): never {
  throw new ManualConsentDeniedError(code, message);
}

function cloneJson(value: unknown, depth = 0): unknown {
  if (depth > 32) denied("CONSENT_REQUEST_INVALID", "Consent request is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(entry => cloneJson(entry, depth + 1)));
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (!key || key.length > 128) denied("CONSENT_REQUEST_INVALID", "Consent request key is invalid");
      result[key] = cloneJson((value as Record<string, unknown>)[key], depth + 1);
    }
    return Object.freeze(result);
  }
  denied("CONSENT_REQUEST_INVALID", "Consent request must be plain JSON data");
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateEvidence(value: ManualConsentEvidenceBinding | null | undefined): ManualConsentEvidenceBinding | null {
  if (value === null || value === undefined) return null;
  if (![value.contextId, value.sessionId, value.runId].every(item => typeof item === "string" && ID.test(item))
    || !Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1
    || !HEX_64.test(value.personaDigest) || !HEX_64.test(value.policyDigest)) {
    denied("CONSENT_REQUEST_INVALID", "Consent evidence binding is invalid");
  }
  return Object.freeze({ ...value });
}

function validateBinding(
  binding: ManualConsentBinding,
  invalidCode: ManualConsentDenialCode = "CONSENT_REQUEST_INVALID"
): ManualConsentBinding {
  if (!binding || !Number.isSafeInteger(binding.windowId) || binding.windowId < 1
    || !Number.isSafeInteger(binding.webContentsId) || binding.webContentsId < 1
    || typeof binding.sessionId !== "string" || !ID.test(binding.sessionId)
    || typeof binding.runtimeAuthorityId !== "string" || !ID.test(binding.runtimeAuthorityId)
    || !Number.isSafeInteger(binding.authorityEpoch) || binding.authorityEpoch < 1
    || typeof binding.incarnationId !== "string" || !ID.test(binding.incarnationId)) {
    denied(invalidCode, "Consent binding is invalid");
  }
  return Object.freeze({
    windowId: binding.windowId,
    webContentsId: binding.webContentsId,
    sessionId: binding.sessionId,
    runtimeAuthorityId: binding.runtimeAuthorityId,
    authorityEpoch: binding.authorityEpoch,
    incarnationId: binding.incarnationId,
  });
}

function requirePresence(
  presence: ManualConsentPresence,
  invalidCode: ManualConsentDenialCode = "CONSENT_PRESENCE_REQUIRED"
): ManualConsentBinding {
  const binding = validateBinding(presence, invalidCode === "CONSENT_PRESENCE_REQUIRED" ? "CONSENT_REQUEST_INVALID" : invalidCode);
  if (presence.topFrame !== true || presence.windowVisible !== true || presence.windowFocused !== true) {
    denied(invalidCode, "Native consent requires the focused visible top-frame window");
  }
  return binding;
}

function copyDisplay(display: ManualConsentDisplay): ManualConsentDisplay {
  if (!display || [display.operationLabel, display.targetLabel, display.rootAlias, display.preview]
    .some(value => typeof value !== "string" || value.length < 1 || value.length > MAX_PREVIEW_CHARS || value.includes("\0"))) {
    denied("CONSENT_REQUEST_INVALID", "Consent display is invalid");
  }
  return Object.freeze({ ...display });
}

export class ManualExecutionConsentLedger {
  readonly #now: () => number;
  readonly #observeDenial: ((request: NativeServiceDenialRequest) => Promise<NativeExecutionProof>) | null;
  readonly #active = new Map<string, PendingConsent>();
  readonly #consumed = new Map<string, ConsumedConsent>();
  #shutdown = false;

  constructor(options: Readonly<{
    now?: () => number;
    observeDenial?: (request: NativeServiceDenialRequest) => Promise<NativeExecutionProof>;
  }> = {}) {
    if (options.observeDenial !== undefined && typeof options.observeDenial !== "function") throw new TypeError("Consent denial observer is invalid");
    this.#now = options.now ?? Date.now;
    this.#observeDenial = options.observeDenial ?? null;
  }

  prepare(input: Readonly<{
    operation: ManualConsentOperation;
    presence: ManualConsentPresence;
    request: Readonly<Record<string, unknown>>;
    display: ManualConsentDisplay;
    rootQualificationDigest?: string | null;
    evidence?: ManualConsentEvidenceBinding | null;
  }>): ManualConsentChallenge {
    if (this.#shutdown) denied("CONSENT_LEDGER_SHUTDOWN", "Consent ledger is shut down");
    this.#pruneExpired();
    if (this.#active.size >= MAX_PENDING) denied("CONSENT_REQUEST_INVALID", "Too many pending consent requests");
    if (!input || (input.operation !== "terminal-start" && input.operation !== "terminal-input")) denied("CONSENT_REQUEST_INVALID", "Consent operation is invalid");
    const binding = requirePresence(input.presence);
    const exactRequest = cloneJson(input.request) as Readonly<Record<string, unknown>>;
    const encoded = Buffer.from(canonical(exactRequest), "utf8");
    if (encoded.length < 2 || encoded.length > 256 * 1024) denied("CONSENT_REQUEST_INVALID", "Consent request size is invalid");
    const argumentsDigest = createHash("sha256").update(encoded).digest("hex");
    const rootQualificationDigest = input.rootQualificationDigest ?? null;
    if (input.operation === "terminal-start" && (typeof rootQualificationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(rootQualificationDigest))) {
      denied("CONSENT_REQUEST_INVALID", "Terminal start requires an exact root qualification");
    }
    if (input.operation !== "terminal-start" && rootQualificationDigest !== null) {
      denied("CONSENT_REQUEST_INVALID", "Terminal input cannot carry a root qualification");
    }
    const expiresAtMs = this.#now() + CONSENT_TTL_MS;
    const challenge = Object.freeze({
      challengeId: randomUUID(),
      operation: input.operation,
      argumentsDigest,
      expiresAt: new Date(expiresAtMs).toISOString(),
      display: copyDisplay(input.display),
    });
    this.#active.set(challenge.challengeId, {
      challenge,
      operation: input.operation,
      binding,
      exactRequest,
      argumentsDigest,
      rootQualificationDigest,
      evidence: validateEvidence(input.evidence),
      expiresAtMs,
      state: "pending",
    });
    return challenge;
  }

  async decide(input: Readonly<ManualConsentDecisionInput>, executeStoredRequest: ExecuteStoredConsent): Promise<void> {
    const active = input && typeof input.challengeId === "string" ? this.#active.get(input.challengeId) : undefined;
    const consumed = input && typeof input.challengeId === "string" ? this.#consumed.get(input.challengeId) : undefined;
    const evidence = active?.evidence ?? consumed?.evidence ?? validateEvidence(input?.evidence);
    const payloadDigest = active?.argumentsDigest ?? consumed?.payloadDigest
      ?? (typeof input?.argumentsDigest === "string" && HEX_64.test(input.argumentsDigest) ? input.argumentsDigest : digest(String(input?.argumentsDigest ?? "invalid")));
    try {
      await this.#decideCore(input, executeStoredRequest);
    } catch (error) {
      if (error instanceof ManualConsentDeniedError) throw await this.#attachObservation(error, input, evidence, payloadDigest);
      throw error;
    }
  }

  async #decideCore(input: Readonly<ManualConsentDecisionInput>, executeStoredRequest: ExecuteStoredConsent): Promise<void> {
    if (this.#shutdown) denied("CONSENT_LEDGER_SHUTDOWN", "Consent ledger is shut down");
    if (!input || typeof input.challengeId !== "string" || typeof executeStoredRequest !== "function") denied("CONSENT_CHALLENGE_INVALID", "Consent decision is invalid");
    const pending = this.#active.get(input.challengeId);
    if (!pending) {
      const consumed = this.#consumed.get(input.challengeId);
      if (consumed?.outcome === "expired") {
        this.#consumed.set(input.challengeId, Object.freeze({ ...consumed, outcome: "replayed" }));
        denied("EXEC_CONSENT_EXPIRED", "Consent challenge expired");
      }
      if (consumed?.outcome === "replayed") denied("EXEC_CONSENT_REPLAYED", "Consent challenge was already consumed");
      this.#consumed.set(input.challengeId, Object.freeze({ outcome: "replayed", evidence: validateEvidence(input.evidence), payloadDigest: typeof input.argumentsDigest === "string" && HEX_64.test(input.argumentsDigest) ? input.argumentsDigest : digest(String(input.argumentsDigest ?? "invalid")) }));
      denied("EXEC_CONSENT_SYNTHETIC", "Consent challenge is unknown");
    }
    if (pending.state === "consuming") denied("EXEC_CONSENT_CONCURRENT_REUSE", "Consent challenge is already being consumed");
    if (pending.state === "consumed") denied("EXEC_CONSENT_REPLAYED", "Consent challenge was already consumed");

    try {
      if (pending.expiresAtMs <= this.#now()) denied("EXEC_CONSENT_EXPIRED", "Consent challenge expired");
      const binding = requirePresence(input.presence, "EXEC_CONSENT_SYNTHETIC");
      if (pending.binding.windowId !== binding.windowId || pending.binding.webContentsId !== binding.webContentsId) {
        denied("EXEC_CONSENT_CROSS_WINDOW", "Consent challenge crossed windows");
      }
      if (pending.binding.sessionId !== binding.sessionId
        || pending.binding.runtimeAuthorityId !== binding.runtimeAuthorityId
        || pending.binding.authorityEpoch !== binding.authorityEpoch
        || pending.binding.incarnationId !== binding.incarnationId) {
        denied("EXEC_CONSENT_CROSS_SESSION", "Consent challenge crossed runtime sessions");
      }
      if (input.operation !== pending.operation || input.argumentsDigest !== pending.argumentsDigest) {
        denied("EXEC_CONSENT_ARGUMENT_MISMATCH", "Consent decision arguments differ from the challenge");
      }
      if (input.decision !== "approve" && input.decision !== "deny" && input.decision !== "dismiss") {
        denied("EXEC_CONSENT_SYNTHETIC", "Consent decision is synthetic");
      }
      if (input.decision === "deny") denied("EXEC_CONSENT_DENIED", "Native execution consent was denied");
      if (input.decision === "dismiss") denied("EXEC_CONSENT_DISMISSED", "Native execution consent was dismissed");
      pending.state = "consuming";
    } catch (error) {
      this.#consume(input.challengeId, pending);
      throw error;
    }

    try {
      await executeStoredRequest(pending.operation, pending.exactRequest, pending.rootQualificationDigest);
    } finally {
      this.#consume(input.challengeId, pending);
    }
  }

  invalidateWebContents(webContentsId: number): void {
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 1) return;
    for (const [id, pending] of this.#active) {
      if (pending.state !== "pending" || pending.binding.webContentsId !== webContentsId) continue;
      this.#consume(id, pending);
    }
  }

  invalidateSession(sessionId: string, authorityEpoch?: number): void {
    for (const [id, pending] of this.#active) {
      if (pending.state !== "pending" || pending.binding.sessionId !== sessionId
        || (authorityEpoch !== undefined && pending.binding.authorityEpoch !== authorityEpoch)) continue;
      this.#consume(id, pending);
    }
  }

  invalidateAuthority(runtimeAuthorityId: string): void {
    if (!runtimeAuthorityId) return;
    for (const [id, pending] of this.#active) {
      if (pending.state !== "pending" || pending.binding.runtimeAuthorityId !== runtimeAuthorityId) continue;
      this.#consume(id, pending);
    }
  }

  invalidateAll(): void {
    for (const [id, pending] of this.#active) {
      if (pending.state === "pending") this.#consume(id, pending);
    }
  }

  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.invalidateAll();
  }

  async #attachObservation(
    error: ManualConsentDeniedError,
    input: Readonly<ManualConsentDecisionInput>,
    evidence: ManualConsentEvidenceBinding | null,
    payloadDigest: string
  ): Promise<ManualConsentDeniedError> {
    const decisionState = denialStateByCode[error.code as keyof typeof denialStateByCode];
    if (!decisionState || !this.#observeDenial || !evidence || !HEX_64.test(payloadDigest)) return error;
    const requestDigest = digest(canonical({
      schema: "mini-lux/sec03/manual-consent-denial/v1",
      challengeDigest: digest(String(input?.challengeId ?? "invalid")),
      decision: String(input?.decision ?? "invalid"),
      operation: String(input?.operation ?? "invalid"),
      argumentsDigest: String(input?.argumentsDigest ?? "invalid"),
      presence: input?.presence ? {
        windowId: input.presence.windowId,
        webContentsId: input.presence.webContentsId,
        sessionId: input.presence.sessionId,
        runtimeAuthorityId: input.presence.runtimeAuthorityId,
        authorityEpoch: input.presence.authorityEpoch,
        incarnationId: input.presence.incarnationId,
        topFrame: input.presence.topFrame,
        windowVisible: input.presence.windowVisible,
        windowFocused: input.presence.windowFocused,
      } : null,
    }));
    try {
      const nativeObservation = await this.#observeDenial(Object.freeze({
        executionId: digest(randomUUID()),
        entryPoint: "E4",
        profile: "manual-terminal",
        contextId: evidence.contextId,
        sessionId: evidence.sessionId,
        runId: evidence.runId,
        authorityEpoch: evidence.authorityEpoch,
        personaDigest: evidence.personaDigest,
        policyDigest: evidence.policyDigest,
        payloadDigest,
        requestDigest,
        operation: "consent",
        decisionState,
      }));
      return new ManualConsentDeniedError(error.code, error.message, nativeObservation);
    } catch {
      return error;
    }
  }

  #consume(id: string, pending: PendingConsent, outcome: "expired" | "replayed" = "replayed"): void {
    pending.state = "consumed";
    this.#active.delete(id);
    this.#consumed.set(id, Object.freeze({ outcome, evidence: pending.evidence, payloadDigest: pending.argumentsDigest }));
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, pending] of this.#active) {
      if (pending.state !== "pending" || pending.expiresAtMs > now) continue;
      this.#consume(id, pending, "expired");
    }
  }
}
