import { createHash, randomBytes } from "node:crypto";
import type { RuntimeAuthority } from "./capability-broker.js";

export type NativeProcessConsentDecision = "approve" | "deny" | "dismiss";

export interface NativeProcessConsentChallenge {
  readonly nonce: string;
  readonly runtimeAuthorityId: string;
  readonly authorityEpoch: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly contextId: string;
  readonly registrationId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly argumentsBytesSha256: string;
  readonly argumentsUtf8Bytes: number;
  readonly expiresAt: string;
  readonly profile: string;
  readonly rootAliases: readonly string[];
  readonly cwd: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
}

export type NativeProcessConsentHandler = (
  challenge: NativeProcessConsentChallenge
) => NativeProcessConsentDecision | Promise<NativeProcessConsentDecision>;

interface PendingConsent {
  readonly nonce: string;
  readonly generation: number;
  readonly authority: RuntimeAuthority;
  readonly runtimeAuthorityId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly contextId: string;
  readonly registrationId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly expiresAtMs: number;
  readonly validateCurrent: () => boolean;
  consumed: boolean;
}

const MAX_ARGUMENT_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 768;
const CONSENT_TTL_MS = 15_000;
const pending = new Map<string, PendingConsent>();
let privateHandler: NativeProcessConsentHandler | null = null;
let generation = 1;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function safeLabel(value: string, fallback: string): string {
  const cleaned = value.replaceAll("\0", "").trim();
  return (cleaned || fallback).slice(0, 512);
}

export function registerNativeProcessConsentHandler(handler: NativeProcessConsentHandler): () => void {
  if (typeof handler !== "function") throw new TypeError("Native process consent handler is invalid");
  if (privateHandler) throw new Error("Native process consent handler is already registered");
  privateHandler = handler;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (privateHandler === handler) privateHandler = null;
    invalidateNativeProcessConsent();
  };
}

export function invalidateNativeProcessConsent(): void {
  generation += 1;
  for (const entry of pending.values()) entry.consumed = true;
  pending.clear();
}

export async function requestNativeProcessConsent(input: Readonly<{
  authority: RuntimeAuthority;
  authorityEpoch: number;
  sessionId: string;
  runId: string;
  contextId: string;
  registrationId: string;
  toolName: string;
  argumentsDigest: string;
  args: Readonly<Record<string, unknown>>;
  profile: string;
  rootAliases: readonly string[];
  cwd: string;
  validateCurrent: () => boolean;
}>): Promise<boolean> {
  const handler = privateHandler;
  if (!handler) return false;
  if (!input.authority) return false;
  if (!input.authority.authorityId || !Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1
    || !input.sessionId || !input.runId || !input.contextId || !input.registrationId || !input.toolName
    || !/^[a-f0-9]{64}$/u.test(input.argumentsDigest) || typeof input.validateCurrent !== "function") return false;

  let encoded: Buffer;
  try {
    encoded = Buffer.from(JSON.stringify(canonicalize(input.args)), "utf8");
  } catch {
    return false;
  }
  if (encoded.length < 2 || encoded.length > MAX_ARGUMENT_BYTES) return false;

  const fullPreview = encoded.toString("utf8");
  const previewTruncated = fullPreview.length > MAX_PREVIEW_CHARS;
  const preview = previewTruncated
    ? `${fullPreview.slice(0, MAX_PREVIEW_CHARS)}\n… [truncated; verify SHA-256 and byte length]`
    : fullPreview;
  const nonce = randomBytes(32).toString("hex");
  const currentGeneration = generation;
  const expiresAtMs = Date.now() + CONSENT_TTL_MS;
  const record: PendingConsent = {
    nonce,
    generation: currentGeneration,
    authority: input.authority,
    runtimeAuthorityId: input.authority.authorityId,
    sessionId: input.sessionId,
    runId: input.runId,
    contextId: input.contextId,
    registrationId: input.registrationId,
    toolName: input.toolName,
    argumentsDigest: input.argumentsDigest,
    expiresAtMs,
    validateCurrent: input.validateCurrent,
    consumed: false,
  };
  pending.set(nonce, record);
  const challenge: NativeProcessConsentChallenge = Object.freeze({
    nonce,
    runtimeAuthorityId: record.runtimeAuthorityId,
    authorityEpoch: input.authorityEpoch,
    sessionId: record.sessionId,
    runId: record.runId,
    contextId: record.contextId,
    registrationId: record.registrationId,
    toolName: record.toolName,
    argumentsDigest: record.argumentsDigest,
    argumentsBytesSha256: createHash("sha256").update(encoded).digest("hex"),
    argumentsUtf8Bytes: encoded.length,
    expiresAt: new Date(expiresAtMs).toISOString(),
    profile: safeLabel(input.profile, "unknown"),
    rootAliases: Object.freeze(input.rootAliases.map(alias => safeLabel(alias, "unknown")).slice(0, 32)),
    cwd: safeLabel(input.cwd, "(tool default)"),
    preview,
    previewTruncated,
  });

  let decision: NativeProcessConsentDecision = "deny";
  try {
    decision = await handler(challenge);
  } catch {
    decision = "deny";
  }

  const current = pending.get(nonce);
  if (!current || current !== record || current.consumed) return false;
  current.consumed = true;
  pending.delete(nonce);
  if (decision !== "approve" || generation !== currentGeneration || Date.now() > current.expiresAtMs
    || current.authority !== input.authority || current.runtimeAuthorityId !== input.authority.authorityId
    || current.sessionId !== input.sessionId || current.runId !== input.runId
    || current.contextId !== input.contextId || current.registrationId !== input.registrationId
    || current.toolName !== input.toolName || current.argumentsDigest !== input.argumentsDigest) return false;
  try { return current.validateCurrent() === true; }
  catch { return false; }
}
