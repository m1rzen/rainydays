import { createHash, randomUUID } from "node:crypto";

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

export type ManualConsentDenialCode =
  | "CONSENT_LEDGER_SHUTDOWN"
  | "CONSENT_REQUEST_INVALID"
  | "CONSENT_PRESENCE_REQUIRED"
  | "CONSENT_CHALLENGE_INVALID"
  | "CONSENT_CHALLENGE_REPLAYED"
  | "CONSENT_CHALLENGE_EXPIRED"
  | "CONSENT_BINDING_MISMATCH"
  | "CONSENT_DENIED";

export class ManualConsentDeniedError extends Error {
  readonly code: ManualConsentDenialCode;
  constructor(code: ManualConsentDenialCode, message: string) {
    super(message);
    this.name = "ManualConsentDeniedError";
    this.code = code;
  }
}

interface PendingConsent {
  readonly challenge: ManualConsentChallenge;
  readonly operation: ManualConsentOperation;
  readonly binding: ManualConsentBinding;
  readonly exactRequest: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
  readonly rootQualificationDigest: string | null;
  readonly expiresAtMs: number;
  state: "pending" | "consumed";
}

const MAX_PENDING = 128;
const CONSENT_TTL_MS = 15_000;
const MAX_PREVIEW_CHARS = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

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

function validateBinding(binding: ManualConsentBinding): ManualConsentBinding {
  if (!binding || !Number.isSafeInteger(binding.windowId) || binding.windowId < 1
    || !Number.isSafeInteger(binding.webContentsId) || binding.webContentsId < 1
    || typeof binding.sessionId !== "string" || !ID.test(binding.sessionId)
    || typeof binding.runtimeAuthorityId !== "string" || !ID.test(binding.runtimeAuthorityId)
    || !Number.isSafeInteger(binding.authorityEpoch) || binding.authorityEpoch < 1
    || typeof binding.incarnationId !== "string" || !ID.test(binding.incarnationId)) {
    denied("CONSENT_REQUEST_INVALID", "Consent binding is invalid");
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

function requirePresence(presence: ManualConsentPresence): ManualConsentBinding {
  const binding = validateBinding(presence);
  if (presence.topFrame !== true || presence.windowVisible !== true || presence.windowFocused !== true) {
    denied("CONSENT_PRESENCE_REQUIRED", "Native consent requires the focused visible top-frame window");
  }
  return binding;
}

function sameBinding(left: ManualConsentBinding, right: ManualConsentBinding): boolean {
  return left.windowId === right.windowId && left.webContentsId === right.webContentsId
    && left.sessionId === right.sessionId && left.runtimeAuthorityId === right.runtimeAuthorityId
    && left.authorityEpoch === right.authorityEpoch && left.incarnationId === right.incarnationId;
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
  readonly #pending = new Map<string, PendingConsent>();
  readonly #consumed = new Set<string>();
  #shutdown = false;

  constructor(options: Readonly<{ now?: () => number }> = {}) {
    this.#now = options.now ?? Date.now;
  }

  prepare(input: Readonly<{
    operation: ManualConsentOperation;
    presence: ManualConsentPresence;
    request: Readonly<Record<string, unknown>>;
    display: ManualConsentDisplay;
    rootQualificationDigest?: string | null;
  }>): ManualConsentChallenge {
    if (this.#shutdown) denied("CONSENT_LEDGER_SHUTDOWN", "Consent ledger is shut down");
    this.#pruneExpired();
    if (this.#pending.size >= MAX_PENDING) denied("CONSENT_REQUEST_INVALID", "Too many pending consent requests");
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
    this.#pending.set(challenge.challengeId, {
      challenge,
      operation: input.operation,
      binding,
      exactRequest,
      argumentsDigest,
      rootQualificationDigest,
      expiresAtMs,
      state: "pending",
    });
    return challenge;
  }

  async decide(input: Readonly<{
    challengeId: string;
    decision: ManualConsentDecision;
    presence: ManualConsentPresence;
    operation: ManualConsentOperation;
    argumentsDigest: string;
  }>, executeStoredRequest: (
    operation: ManualConsentOperation,
    exactRequest: Readonly<Record<string, unknown>>,
    rootQualificationDigest: string | null
  ) => void | Promise<void>): Promise<void> {
    if (this.#shutdown) denied("CONSENT_LEDGER_SHUTDOWN", "Consent ledger is shut down");
    if (!input || typeof input.challengeId !== "string" || typeof executeStoredRequest !== "function") denied("CONSENT_CHALLENGE_INVALID", "Consent decision is invalid");
    const pending = this.#pending.get(input.challengeId);
    if (!pending) {
      if (this.#consumed.has(input.challengeId)) denied("CONSENT_CHALLENGE_REPLAYED", "Consent challenge was already consumed");
      denied("CONSENT_CHALLENGE_INVALID", "Consent challenge is unknown");
    }
    if (pending.state !== "pending") denied("CONSENT_CHALLENGE_REPLAYED", "Consent challenge was already consumed");
    pending.state = "consumed";
    this.#pending.delete(input.challengeId);
    this.#consumed.add(input.challengeId);

    if (pending.expiresAtMs <= this.#now()) denied("CONSENT_CHALLENGE_EXPIRED", "Consent challenge expired");
    const binding = requirePresence(input.presence);
    if (!sameBinding(pending.binding, binding) || input.operation !== pending.operation || input.argumentsDigest !== pending.argumentsDigest) denied("CONSENT_BINDING_MISMATCH", "Consent decision binding mismatch");
    if (input.decision !== "approve") {
      if (input.decision !== "deny" && input.decision !== "dismiss") denied("CONSENT_CHALLENGE_INVALID", "Consent decision is invalid");
      denied("CONSENT_DENIED", "Native execution consent was denied");
    }
    await executeStoredRequest(pending.operation, pending.exactRequest, pending.rootQualificationDigest);
  }

  invalidateWebContents(webContentsId: number): void {
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 1) return;
    for (const [id, pending] of this.#pending) {
      if (pending.binding.webContentsId !== webContentsId) continue;
      pending.state = "consumed";
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
  }

  invalidateSession(sessionId: string, authorityEpoch?: number): void {
    for (const [id, pending] of this.#pending) {
      if (pending.binding.sessionId !== sessionId || (authorityEpoch !== undefined && pending.binding.authorityEpoch !== authorityEpoch)) continue;
      pending.state = "consumed";
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
  }

  invalidateAuthority(runtimeAuthorityId: string): void {
    if (!runtimeAuthorityId) return;
    for (const [id, pending] of this.#pending) {
      if (pending.binding.runtimeAuthorityId !== runtimeAuthorityId) continue;
      pending.state = "consumed";
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
  }

  invalidateAll(): void {
    for (const [id, pending] of this.#pending) {
      pending.state = "consumed";
      this.#consumed.add(id);
    }
    this.#pending.clear();
  }

  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.invalidateAll();
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAtMs > now) continue;
      pending.state = "consumed";
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
  }
}
