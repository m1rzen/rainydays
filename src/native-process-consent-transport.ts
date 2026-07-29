import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, fstatSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  registerNativeProcessConsentHandler,
  type NativeProcessConsentChallenge,
  type NativeProcessConsentDecision,
} from "./native-process-consent.js";

export const NATIVE_CONSENT_REQUEST_FD = 3;
export const NATIVE_CONSENT_RESPONSE_FD = 4;
export const NATIVE_CONSENT_MAX_FRAME_BYTES = 256 * 1024;
export const NATIVE_CONSENT_TIMEOUT_MS = 15_000;
const PROTOCOL = "mini-lux-native-consent-v1";
const HEX_256 = /^[a-f0-9]{64}$/u;
const MAX_SAFE_SEQUENCE = 0x7fff_ffff;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type DecisionHandler = (challenge: NativeProcessConsentChallenge) => NativeProcessConsentDecision | Promise<NativeProcessConsentDecision>;

type AuthenticatedEnvelope = Readonly<{
  seq: number;
  nonce: string;
  body: Readonly<Record<string, JsonValue>>;
  mac: string;
}>;

export interface NativeProcessConsentParentTransport {
  readonly ready: Promise<void>;
  isReady(): boolean;
  close(): void;
}

export interface NativeProcessConsentChildTransport {
  readonly ready: Promise<void>;
  isReady(): boolean;
  requestDecision(challenge: NativeProcessConsentChallenge): Promise<NativeProcessConsentDecision>;
  close(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) throw new TypeError("Native consent frame is not canonical JSON");
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

export function canonicalNativeConsentJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestNativeProcessConsentChallenge(challenge: NativeProcessConsentChallenge): string {
  return createHash("sha256").update(canonicalNativeConsentJson(challenge), "utf8").digest("hex");
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(canonicalNativeConsentJson(value), "utf8");
  if (payload.length === 0 || payload.length > NATIVE_CONSENT_MAX_FRAME_BYTES) {
    throw new Error("Native consent frame exceeds the fixed bound");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseCanonicalFrame(payload: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    throw new Error("Native consent frame is malformed");
  }
  if (canonicalNativeConsentJson(parsed) !== payload.toString("utf8")) {
    throw new Error("Native consent frame is not canonical");
  }
  return parsed;
}

class BoundedFrameReader {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private chain = Promise.resolve();
  private readonly stream: Readable;
  private readonly onFrame: (frame: unknown) => void | Promise<void>;
  private readonly onFailure: () => void;

  constructor(
    stream: Readable,
    onFrame: (frame: unknown) => void | Promise<void>,
    onFailure: () => void,
  ) {
    this.stream = stream;
    this.onFrame = onFrame;
    this.onFailure = onFailure;
    stream.on("data", (chunk: Buffer | string) => this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once("end", () => this.fail());
    stream.once("close", () => this.fail());
    stream.once("error", () => this.fail());
  }

  close(): void {
    this.closed = true;
    this.buffer = Buffer.alloc(0);
  }

  private accept(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    if (this.buffer.length + chunk.length > NATIVE_CONSENT_MAX_FRAME_BYTES + 4) {
      this.fail();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > NATIVE_CONSENT_MAX_FRAME_BYTES) {
        this.fail();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = parseCanonicalFrame(payload);
      } catch {
        this.fail();
        return;
      }
      this.chain = this.chain.then(() => this.closed ? undefined : this.onFrame(parsed)).catch(() => this.fail());
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.onFailure();
  }
}

function writeFrame(stream: Writable, value: unknown): Promise<void> {
  let frame: Buffer;
  try {
    frame = encodeFrame(value);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) {
      reject(new Error("Native consent pipe is closed"));
      return;
    }
    stream.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function macInput(seq: number, nonce: string, body: Readonly<Record<string, JsonValue>>): string {
  return canonicalNativeConsentJson({ body, nonce, seq });
}

function createEnvelope(secret: Buffer, seq: number, body: Readonly<Record<string, JsonValue>>): AuthenticatedEnvelope {
  const nonce = randomBytes(32).toString("hex");
  const mac = createHmac("sha256", secret).update(macInput(seq, nonce, body), "utf8").digest("hex");
  return Object.freeze({ seq, nonce, body, mac });
}

function requireEnvelope(value: unknown, secret: Buffer, expectedSequence: number): AuthenticatedEnvelope {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "body,mac,nonce,seq"
    || value.seq !== expectedSequence || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0
    || typeof value.nonce !== "string" || !HEX_256.test(value.nonce)
    || typeof value.mac !== "string" || !HEX_256.test(value.mac)
    || !isPlainObject(value.body)) {
    throw new Error("Native consent authenticated frame is invalid");
  }
  const expected = createHmac("sha256", secret)
    .update(macInput(value.seq as number, value.nonce, canonicalize(value.body) as Readonly<Record<string, JsonValue>>), "utf8")
    .digest();
  const supplied = Buffer.from(value.mac, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Native consent frame authentication failed");
  }
  return value as unknown as AuthenticatedEnvelope;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function requireChallenge(value: unknown): NativeProcessConsentChallenge {
  const keys = [
    "nonce", "runtimeAuthorityId", "authorityEpoch", "sessionId", "runId", "contextId", "registrationId",
    "toolName", "argumentsDigest", "argumentsBytesSha256", "argumentsUtf8Bytes", "expiresAt", "profile",
    "rootAliases", "cwd", "preview", "previewTruncated",
  ] as const;
  if (!isPlainObject(value) || !exactKeys(value, keys)
    || typeof value.nonce !== "string" || !HEX_256.test(value.nonce)
    || typeof value.runtimeAuthorityId !== "string" || !value.runtimeAuthorityId
    || !Number.isSafeInteger(value.authorityEpoch) || (value.authorityEpoch as number) < 1
    || typeof value.sessionId !== "string" || !value.sessionId
    || typeof value.runId !== "string" || !value.runId
    || typeof value.contextId !== "string" || !value.contextId
    || typeof value.registrationId !== "string" || !value.registrationId
    || typeof value.toolName !== "string" || !value.toolName
    || typeof value.argumentsDigest !== "string" || !HEX_256.test(value.argumentsDigest)
    || typeof value.argumentsBytesSha256 !== "string" || !HEX_256.test(value.argumentsBytesSha256)
    || !Number.isSafeInteger(value.argumentsUtf8Bytes) || (value.argumentsUtf8Bytes as number) < 2
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || typeof value.profile !== "string" || value.profile.length > 512
    || !Array.isArray(value.rootAliases) || value.rootAliases.length > 32
    || value.rootAliases.some(alias => typeof alias !== "string" || alias.length > 512)
    || typeof value.cwd !== "string" || value.cwd.length > 512
    || typeof value.preview !== "string" || value.preview.length > 2048
    || typeof value.previewTruncated !== "boolean") {
    throw new Error("Native consent challenge is invalid");
  }
  return Object.freeze({ ...value, rootAliases: Object.freeze([...value.rootAliases]) }) as unknown as NativeProcessConsentChallenge;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Native consent transport timed out"));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return NATIVE_CONSENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > NATIVE_CONSENT_TIMEOUT_MS) {
    throw new TypeError("Native consent timeout is invalid");
  }
  return value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function destroyStream(stream: Readable | Writable): void {
  if (!stream.destroyed) stream.destroy();
}

export function createNativeProcessConsentParentTransport(input: Readonly<{
  request: Writable;
  response: Readable;
  decide: DecisionHandler;
  timeoutMs?: number;
}>): NativeProcessConsentParentTransport {
  if (!input.request || !input.response || typeof input.decide !== "function") {
    throw new TypeError("Native consent parent transport is invalid");
  }
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const secret = randomBytes(32);
  const handshakeChallenge = randomBytes(32).toString("hex");
  const readyState = deferred<void>();
  let readySettled = false;
  let active = true;
  let ready = false;
  let inboundSequence = 0;
  let outboundSequence = 1;
  let decisionPending = false;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let reader: BoundedFrameReader;

  const fail = () => {
    if (!active) return;
    active = false;
    ready = false;
    decisionPending = false;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    reader?.close();
    destroyStream(input.request);
    destroyStream(input.response);
    if (!readySettled) {
      readySettled = true;
      readyState.reject(new Error("Native consent transport unavailable"));
    }
    secret.fill(0);
  };

  reader = new BoundedFrameReader(input.response, async frame => {
    const envelope = requireEnvelope(frame, secret, inboundSequence);
    if (inboundSequence === 0) {
      if (!exactKeys(envelope.body as Record<string, unknown>, ["challenge", "kind", "protocol"])
        || envelope.body.kind !== "ready" || envelope.body.protocol !== PROTOCOL
        || envelope.body.challenge !== handshakeChallenge) {
        throw new Error("Native consent handshake response is invalid");
      }
      inboundSequence = 1;
      ready = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (!readySettled) {
        readySettled = true;
        readyState.resolve();
      }
      return;
    }

    if (!ready || decisionPending || !exactKeys(envelope.body as Record<string, unknown>, ["challenge", "challengeDigest", "kind", "requestId"])
      || envelope.body.kind !== "prepare" || typeof envelope.body.requestId !== "string" || !HEX_256.test(envelope.body.requestId)
      || typeof envelope.body.challengeDigest !== "string" || !HEX_256.test(envelope.body.challengeDigest)) {
      throw new Error("Native consent prepare frame is invalid");
    }
    const challenge = requireChallenge(envelope.body.challenge);
    const challengeDigest = digestNativeProcessConsentChallenge(challenge);
    if (challengeDigest !== envelope.body.challengeDigest) throw new Error("Native consent challenge digest mismatch");

    inboundSequence += 1;
    if (inboundSequence > MAX_SAFE_SEQUENCE) throw new Error("Native consent sequence exhausted");
    decisionPending = true;
    let decision: NativeProcessConsentDecision;
    try {
      decision = await withTimeout(Promise.resolve(input.decide(challenge)), timeoutMs, fail);
    } catch {
      fail();
      return;
    }
    if (!active || !ready) return;
    if (decision !== "approve" && decision !== "deny" && decision !== "dismiss") decision = "deny";
    const body = canonicalize({
      challengeDigest,
      decision,
      kind: "decision",
      requestId: envelope.body.requestId,
    }) as Readonly<Record<string, JsonValue>>;
    const sequence = outboundSequence++;
    if (sequence > MAX_SAFE_SEQUENCE) throw new Error("Native consent sequence exhausted");
    await writeFrame(input.request, createEnvelope(secret, sequence, body));
    decisionPending = false;
  }, fail);

  handshakeTimer = setTimeout(fail, timeoutMs);
  handshakeTimer.unref?.();
  void writeFrame(input.request, {
    challenge: handshakeChallenge,
    kind: "hello",
    protocol: PROTOCOL,
    secret: secret.toString("hex"),
  }).catch(fail);

  return Object.freeze({
    ready: readyState.promise,
    isReady: () => active && ready,
    close: fail,
  });
}

export function createNativeProcessConsentChildTransport(input: Readonly<{
  request: Readable;
  response: Writable;
  timeoutMs?: number;
}>): NativeProcessConsentChildTransport {
  if (!input.request || !input.response) throw new TypeError("Native consent child transport is invalid");
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const readyState = deferred<void>();
  let readySettled = false;
  let active = true;
  let ready = false;
  let secret: Buffer | null = null;
  let inboundSequence = 0;
  let outboundSequence = 0;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let reader: BoundedFrameReader;
  let pending: {
    readonly requestId: string;
    readonly challengeDigest: string;
    readonly resolve: (decision: NativeProcessConsentDecision) => void;
    readonly timer: NodeJS.Timeout;
  } | null = null;

  const fail = () => {
    if (!active) return;
    active = false;
    ready = false;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    reader?.close();
    destroyStream(input.request);
    destroyStream(input.response);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve("deny");
      pending = null;
    }
    if (!readySettled) {
      readySettled = true;
      readyState.reject(new Error("Native consent transport unavailable"));
    }
    secret?.fill(0);
    secret = null;
  };

  reader = new BoundedFrameReader(input.request, async frame => {
    if (!secret) {
      if (!isPlainObject(frame) || !exactKeys(frame, ["challenge", "kind", "protocol", "secret"])
        || frame.kind !== "hello" || frame.protocol !== PROTOCOL
        || typeof frame.secret !== "string" || !HEX_256.test(frame.secret)
        || typeof frame.challenge !== "string" || !HEX_256.test(frame.challenge)) {
        throw new Error("Native consent handshake is invalid");
      }
      secret = Buffer.from(frame.secret, "hex");
      const body = canonicalize({ challenge: frame.challenge, kind: "ready", protocol: PROTOCOL }) as Readonly<Record<string, JsonValue>>;
      await writeFrame(input.response, createEnvelope(secret, outboundSequence++, body));
      ready = true;
      inboundSequence = 1;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (!readySettled) {
        readySettled = true;
        readyState.resolve();
      }
      return;
    }

    const envelope = requireEnvelope(frame, secret, inboundSequence);
    if (!ready || !pending || !exactKeys(envelope.body as Record<string, unknown>, ["challengeDigest", "decision", "kind", "requestId"])
      || envelope.body.kind !== "decision" || envelope.body.requestId !== pending.requestId
      || envelope.body.challengeDigest !== pending.challengeDigest
      || (envelope.body.decision !== "approve" && envelope.body.decision !== "deny" && envelope.body.decision !== "dismiss")) {
      throw new Error("Native consent decision frame is invalid");
    }
    inboundSequence += 1;
    if (inboundSequence > MAX_SAFE_SEQUENCE) throw new Error("Native consent sequence exhausted");
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve(envelope.body.decision);
  }, fail);

  handshakeTimer = setTimeout(fail, timeoutMs);
  handshakeTimer.unref?.();

  const requestDecision = async (challenge: NativeProcessConsentChallenge): Promise<NativeProcessConsentDecision> => {
    if (!active || !ready || !secret || pending) return "deny";
    let exactChallenge: NativeProcessConsentChallenge;
    try {
      exactChallenge = requireChallenge(challenge);
    } catch {
      return "deny";
    }
    const requestId = randomBytes(32).toString("hex");
    const challengeDigest = digestNativeProcessConsentChallenge(exactChallenge);
    return new Promise<NativeProcessConsentDecision>((resolve) => {
      const timer = setTimeout(() => {
        fail();
        resolve("deny");
      }, timeoutMs);
      timer.unref?.();
      pending = { requestId, challengeDigest, resolve, timer };
      const body = canonicalize({ challenge: exactChallenge, challengeDigest, kind: "prepare", requestId }) as Readonly<Record<string, JsonValue>>;
      const sequence = outboundSequence++;
      if (sequence > MAX_SAFE_SEQUENCE) {
        fail();
        return;
      }
      void writeFrame(input.response, createEnvelope(secret!, sequence, body)).catch(fail);
    });
  };

  return Object.freeze({
    ready: readyState.promise,
    isReady: () => active && ready,
    requestDecision,
    close: fail,
  });
}

function inheritedPipeAvailable(fd: number): boolean {
  try {
    const stats = fstatSync(fd);
    return !stats.isFile() && !stats.isDirectory() && (stats.mode & 0xf000) === 0x1000;
  } catch {
    return false;
  }
}

export async function installInheritedNativeProcessConsentTransport(): Promise<(() => void) | null> {
  if ((process as NodeJS.Process & { type?: string }).type === "browser") return null;
  if (!inheritedPipeAvailable(NATIVE_CONSENT_REQUEST_FD) || !inheritedPipeAvailable(NATIVE_CONSENT_RESPONSE_FD)) return null;
  const request = createReadStream("", { fd: NATIVE_CONSENT_REQUEST_FD, autoClose: true });
  const response = createWriteStream("", { fd: NATIVE_CONSENT_RESPONSE_FD, autoClose: true });
  const transport = createNativeProcessConsentChildTransport({ request, response });
  try {
    await transport.ready;
  } catch {
    transport.close();
    return null;
  }
  let unregister: (() => void) | null = null;
  try {
    unregister = registerNativeProcessConsentHandler(challenge => transport.requestDecision(challenge));
  } catch {
    transport.close();
    return null;
  }
  return () => {
    unregister?.();
    unregister = null;
    transport.close();
  };
}
