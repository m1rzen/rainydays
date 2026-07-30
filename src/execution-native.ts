import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  ExecutionEntryPoint,
  ExecutionLimits,
  ExecutionNetworkPolicy,
  ExecutionProfile,
  ExecutionRootLeaseSnapshot,
} from "./execution-isolation.js";

export interface NativeRootAuthority {
  readonly rootId: string;
  readonly access: "read" | "read-write";
  readonly canonicalPath: string;
  readonly identity: Readonly<{ volumeSerial: string; fileId: string; type: "directory" }>;
  readonly canonicalCwd: string;
  readonly cwdIdentity: Readonly<{ volumeSerial: string; fileId: string; type: "directory" }>;
}

export interface NativeLaunchRequest {
  readonly executionId: string;
  readonly entryPoint: ExecutionEntryPoint;
  readonly profile: ExecutionProfile;
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly principal: string;
  readonly authorityEpoch: number;
  readonly personaDigest: string;
  readonly policyDigest: string;
  readonly payload: Uint8Array;
  readonly payloadDigest: string;
  readonly roots: readonly ExecutionRootLeaseSnapshot[];
  readonly environment: Readonly<Record<string, string>>;
  readonly network: ExecutionNetworkPolicy;
  readonly limits: ExecutionLimits;
  readonly expiresAtMs: number;
}

export interface NativeOutputFrame {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

export interface NativeInputFrame {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly appendNewline: boolean;
}

export interface NativeExecutionProof {
  readonly proof: Uint8Array;
  readonly mac: string;
  readonly keyId: string;
  readonly channelMarker: string;
}

export type NativeServiceDenialState =
  | "missing" | "forged" | "argument-mismatch" | "expired" | "replayed" | "cross-run" | "cross-session" | "concurrent-reuse"
  | "consent-denied" | "consent-dismissed" | "consent-expired" | "consent-argument-mismatch" | "consent-replayed"
  | "consent-synthetic" | "consent-cross-window" | "consent-cross-session" | "consent-concurrent-reuse"
  | "network-profile-unsupported";

export interface NativeServiceDenialRequest {
  readonly executionId: string;
  readonly entryPoint: "E1" | "E2" | "E3" | "E4";
  readonly profile: "one-shot-shell" | "agent-shell" | "script" | "manual-terminal";
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly authorityEpoch: number;
  readonly personaDigest: string;
  readonly policyDigest: string;
  readonly payloadDigest: string;
  readonly requestDigest: string;
  readonly operation: "launch" | "input" | "consent";
  readonly decisionState: NativeServiceDenialState;
}

export interface NativeExecutionCompletion {
  readonly exitCode: number | null;
  readonly reason: string;
  readonly nativeProof: NativeExecutionProof | null;
}

export interface NativeExecutionHandle {
  readonly executionId: string;
  readonly completed: Promise<NativeExecutionCompletion>;
  readonly write: (frame: NativeInputFrame) => Promise<void>;
  readonly terminate: (reason: string) => Promise<void>;
}

export interface NativeExecutionBridge {
  readonly initialize?: () => Promise<void>;
  readonly launch: (request: NativeLaunchRequest, onFrame: (frame: NativeOutputFrame) => void) => Promise<NativeExecutionHandle>;
  readonly observeServiceDenial?: (request: NativeServiceDenialRequest) => Promise<NativeExecutionProof>;
  readonly shutdown: () => Promise<void>;
}

export interface NativeArtifactIdentity {
  readonly candidateId: string;
  readonly buildIdSha256: string;
  readonly sourceSha256: string;
  readonly launcherSha256: string;
  readonly launcherBytes: number;
  readonly hostSha256: string;
  readonly hostBytes: number;
  readonly machine: "x64";
  readonly protocolVersion: 1;
}

export type NativeBridgeFailureCode =
  | "EXEC_NATIVE_UNSUPPORTED"
  | "EXEC_NATIVE_UNAVAILABLE"
  | "EXEC_NATIVE_IDENTITY_INVALID"
  | "EXEC_NATIVE_PROTOCOL"
  | "EXEC_NATIVE_SHUTDOWN";

export class NativeBridgeError extends Error {
  readonly code: NativeBridgeFailureCode;
  constructor(code: NativeBridgeFailureCode, message: string) {
    super(message);
    this.name = "NativeBridgeError";
    this.code = code;
  }
}

interface AddonCompletion { readonly exitCode: unknown; readonly reason: unknown; readonly nativeProof: unknown }
interface AddonHandle {
  readonly executionId: unknown;
  readonly completed: unknown;
  readonly writeFrame: unknown;
  readonly terminateHost: unknown;
}
interface AddonLease {
  readonly launchHost: unknown;
  readonly observeServiceDenial: unknown;
  readonly close: unknown;
}
interface LauncherAddon {
  readonly protocolVersion: unknown;
  readonly openExclusiveHostLease: unknown;
  readonly openEvidenceVerifier: unknown;
}

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_FRAME_BYTES = 512 * 1024;
const MAX_OUTPUT_FRAME_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const requireForNative = createRequire(import.meta.url);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const compiledDistribution = path.basename(moduleDirectory).toLowerCase() === "dist";
const nativeDirectory = compiledDistribution ? path.join(moduleDirectory, "native") : path.join(moduleDirectory, "..", "dist", "native");
const fixedLauncherPath = path.join(nativeDirectory, "sandbox-launcher.node");
const fixedHostPath = path.join(nativeDirectory, "sandbox-host.exe");
const trustedRootAuthorities = new Map<string, NativeRootAuthority>();

function rootAuthorityKey(root: ExecutionRootLeaseSnapshot): string {
  const id = (root.identity as ExecutionRootLeaseSnapshot["identity"] & { readonly nativeAuthorityId?: unknown }).nativeAuthorityId;
  return typeof id === "string" && HASH.test(id) ? id : "";
}

export function bindNativeRootAuthority(root: NativeRootAuthority): Readonly<{ nativeAuthorityId: string; revoke: () => void }> {
  if (!root || typeof root.canonicalPath !== "string" || root.canonicalPath.length < 3 || root.canonicalPath.includes("\0")
    || !path.win32.isAbsolute(root.canonicalPath) || root.canonicalPath.startsWith("\\\\")
    || typeof root.canonicalCwd !== "string" || !path.win32.isAbsolute(root.canonicalCwd) || root.canonicalCwd.includes("\0")) {
    throw failure("EXEC_NATIVE_PROTOCOL", "Native root authority is invalid");
  }
  const nativeAuthorityId = randomBytes(32).toString("hex");
  trustedRootAuthorities.set(nativeAuthorityId, Object.freeze({ ...root, identity: Object.freeze({ ...root.identity }), cwdIdentity: Object.freeze({ ...root.cwdIdentity }) }));
  return Object.freeze({ nativeAuthorityId, revoke: () => { trustedRootAuthorities.delete(nativeAuthorityId); } });
}

function failure(code: NativeBridgeFailureCode, message: string): NativeBridgeError {
  return new NativeBridgeError(code, message);
}

function validIdentity(identity: NativeArtifactIdentity): boolean {
  return identity && identity.machine === "x64" && identity.protocolVersion === PROTOCOL_VERSION
    && HASH.test(identity.candidateId) && HASH.test(identity.buildIdSha256) && HASH.test(identity.sourceSha256)
    && HASH.test(identity.launcherSha256) && HASH.test(identity.hostSha256)
    && Number.isSafeInteger(identity.launcherBytes) && identity.launcherBytes > 0
    && Number.isSafeInteger(identity.hostBytes) && identity.hostBytes > 0;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertFixedRegularFile(file: string, expectedBytes: number, expectedHash: string): Promise<void> {
  const [stat, resolved, observedHash] = await Promise.all([lstat(file), realpath(file), sha256(file)]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes || path.normalize(resolved) !== path.normalize(file) || observedHash !== expectedHash) {
    throw failure("EXEC_NATIVE_IDENTITY_INVALID", "Native artifact identity mismatch");
  }
}

function encodeFrame(type: "launch" | "input" | "terminate" | "service-denial", body: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type, ...body }), "utf8");
  if (payload.length < 1 || payload.length > MAX_CONTROL_FRAME_BYTES) throw failure("EXEC_NATIVE_PROTOCOL", "Native control frame exceeds its bound");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeOutputFrame(frame: unknown): NativeOutputFrame {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame.length > MAX_OUTPUT_FRAME_BYTES + 4 || frame.readUInt32BE(0) !== frame.length - 4) {
    throw failure("EXEC_NATIVE_PROTOCOL", "Native output frame is malformed");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(frame.subarray(4).toString("utf8")); }
  catch { throw failure("EXEC_NATIVE_PROTOCOL", "Native output frame is not JSON"); }
  if (!parsed || typeof parsed !== "object") throw failure("EXEC_NATIVE_PROTOCOL", "Native output frame body is invalid");
  const value = parsed as Record<string, unknown>;
  if (value.version !== PROTOCOL_VERSION || (value.stream !== "stdout" && value.stream !== "stderr") || typeof value.data !== "string") throw failure("EXEC_NATIVE_PROTOCOL", "Native output frame fields are invalid");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data || bytes.length > MAX_OUTPUT_FRAME_BYTES) throw failure("EXEC_NATIVE_PROTOCOL", "Native output bytes are invalid");
  return Object.freeze({ stream: value.stream, bytes });
}

function decodeNativeProof(value: unknown): NativeExecutionProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("EXEC_NATIVE_PROTOCOL", "Native proof is invalid");
  const proof = value as Record<string, unknown>;
  if (Object.keys(proof).sort().join("\0") !== "channelMarker\0keyId\0mac\0proof" || !Buffer.isBuffer(proof.proof) || proof.proof.byteLength < 1 || proof.proof.byteLength > 64 * 1024 || typeof proof.mac !== "string" || !HASH.test(proof.mac) || typeof proof.keyId !== "string" || !HASH.test(proof.keyId) || typeof proof.channelMarker !== "string" || !HASH.test(proof.channelMarker)) throw failure("EXEC_NATIVE_PROTOCOL", "Native proof is invalid");
  return Object.freeze({ proof: Buffer.from(proof.proof), mac: proof.mac, keyId: proof.keyId, channelMarker: proof.channelMarker });
}

function launchBody(request: NativeLaunchRequest, identity: NativeArtifactIdentity): Record<string, unknown> {
  const roots = request.roots.map((root) => {
    const authority = trustedRootAuthorities.get(rootAuthorityKey(root));
    if (!authority || authority.rootId !== root.rootId || authority.access !== root.access
      || authority.identity.volumeSerial !== root.identity.volumeSerial || authority.identity.fileId !== root.identity.fileId) {
      throw failure("EXEC_NATIVE_PROTOCOL", "Native root authority is unavailable");
    }
    trustedRootAuthorities.delete(rootAuthorityKey(root));
    return Object.freeze({
      rootId: authority.rootId,
      access: authority.access,
      canonicalPath: authority.canonicalPath,
      identity: authority.identity,
      canonicalCwd: authority.canonicalCwd,
      cwdIdentity: authority.cwdIdentity,
    });
  });
  return {
    secret: "0".repeat(64),
    candidateId: identity.candidateId,
    buildIdSha256: identity.buildIdSha256,
    sourceSha256: identity.sourceSha256,
    hostSha256: "0".repeat(64),
    launcherSha256: "0".repeat(64),
    executable: Object.freeze({ handleIndex: -1, kind: request.entryPoint === "E3" ? "current-node" : "fixed-system" }),
    executionId: request.executionId,
    entryPoint: request.entryPoint,
    profile: request.profile,
    contextId: request.contextId,
    sessionId: request.sessionId,
    runId: request.runId,
    principal: request.principal,
    authorityEpoch: request.authorityEpoch,
    personaDigest: request.personaDigest,
    policyDigest: request.policyDigest,
    payload: Buffer.from(request.payload).toString("base64"),
    payloadDigest: request.payloadDigest,
    roots,
    environment: request.environment,
    network: request.network,
    limits: request.limits,
    expiresAtMs: request.expiresAtMs,
  };
}

export function createProductionNativeExecutionBridge(identity: NativeArtifactIdentity): NativeExecutionBridge {
  if (!validIdentity(identity)) throw new TypeError("Native artifact identity is invalid");
  let addonPromise: Promise<LauncherAddon> | null = null;
  let stopped = false;
  const handles = new Set<NativeExecutionHandle>();

  const loadAddon = async (): Promise<LauncherAddon> => {
    if (process.platform !== "win32" || process.arch !== "x64") throw failure("EXEC_NATIVE_UNSUPPORTED", "Native execution is unavailable on this platform");
    if (!addonPromise) addonPromise = (async () => {
      try {
        await Promise.all([
          assertFixedRegularFile(fixedLauncherPath, identity.launcherBytes, identity.launcherSha256),
          assertFixedRegularFile(fixedHostPath, identity.hostBytes, identity.hostSha256),
        ]);
        const loaded = (compiledDistribution
          ? requireForNative("./native/sandbox-launcher.node")
          : requireForNative("../dist/native/sandbox-launcher.node")) as LauncherAddon;
        if (!loaded || loaded.protocolVersion !== PROTOCOL_VERSION || typeof loaded.openExclusiveHostLease !== "function" || typeof loaded.openEvidenceVerifier !== "function") throw failure("EXEC_NATIVE_PROTOCOL", "Native launcher ABI mismatch");
        return loaded;
      } catch (error) {
        if (error instanceof NativeBridgeError) throw error;
        throw failure("EXEC_NATIVE_UNAVAILABLE", "Native launcher is unavailable");
      }
    })();
    return addonPromise;
  };

  return Object.freeze({
    async initialize(): Promise<void> {
      if (stopped) throw failure("EXEC_NATIVE_SHUTDOWN", "Native execution bridge is shut down");
      const addon = await loadAddon();
      const openLease = addon.openExclusiveHostLease as (expectedSha256: string, expectedBytes: number, launcherSha256: string) => AddonLease;
      const lease = openLease(identity.hostSha256, identity.hostBytes, identity.launcherSha256);
      if (!lease || typeof lease.close !== "function") throw failure("EXEC_NATIVE_PROTOCOL", "Exclusive host lease ABI mismatch");
      await (lease.close as () => Promise<void>).call(lease);
    },
    async observeServiceDenial(request: NativeServiceDenialRequest): Promise<NativeExecutionProof> {
      if (stopped) throw failure("EXEC_NATIVE_SHUTDOWN", "Native execution bridge is shut down");
      const addon = await loadAddon();
      const openLease = addon.openExclusiveHostLease as (expectedSha256: string, expectedBytes: number, launcherSha256: string) => AddonLease;
      const lease = openLease(identity.hostSha256, identity.hostBytes, identity.launcherSha256);
      if (!lease || typeof lease.observeServiceDenial !== "function" || typeof lease.close !== "function") throw failure("EXEC_NATIVE_PROTOCOL", "Service denial observer ABI mismatch");
      try {
        const observe = lease.observeServiceDenial as (frame: Buffer) => NativeExecutionProof;
        return decodeNativeProof(await observe.call(lease, encodeFrame("service-denial", {
          candidateId: identity.candidateId,
          buildIdSha256: identity.buildIdSha256,
          sourceSha256: identity.sourceSha256,
          executionId: request.executionId,
          contextId: request.contextId,
          sessionId: request.sessionId,
          runId: request.runId,
          authorityEpoch: request.authorityEpoch,
          entryPoint: request.entryPoint,
          profile: request.profile,
          personaDigest: request.personaDigest,
          policyDigest: request.policyDigest,
          payloadDigest: request.payloadDigest,
          requestDigest: request.requestDigest,
          operation: request.operation,
          decisionState: request.decisionState,
        })));
      } finally {
        await (lease.close as () => Promise<void>).call(lease);
      }
    },
    async launch(request: NativeLaunchRequest, onFrame: (frame: NativeOutputFrame) => void): Promise<NativeExecutionHandle> {
      if (stopped) throw failure("EXEC_NATIVE_SHUTDOWN", "Native execution bridge is shut down");
      const addon = await loadAddon();
      const openLease = addon.openExclusiveHostLease as (expectedSha256: string, expectedBytes: number, launcherSha256: string) => AddonLease;
      const lease = openLease(identity.hostSha256, identity.hostBytes, identity.launcherSha256);
      if (!lease || typeof lease.launchHost !== "function" || typeof lease.close !== "function") throw failure("EXEC_NATIVE_PROTOCOL", "Exclusive host lease ABI mismatch");
      let addonHandle: AddonHandle;
      let protocolFailed = false;
      try {
        const launchHost = lease.launchHost as (frame: Buffer, output: (frame: Buffer) => void) => Promise<AddonHandle>;
        addonHandle = await launchHost.call(lease, encodeFrame("launch", launchBody(request, identity)), (frame) => {
          if (protocolFailed) return;
          try { onFrame(decodeOutputFrame(frame)); }
          catch {
            protocolFailed = true;
            if (addonHandle && typeof addonHandle.terminateHost === "function") void (addonHandle.terminateHost as (frame: Buffer) => Promise<void>).call(addonHandle, encodeFrame("terminate", { secret: "0".repeat(64), reason: "protocol-failure" }));
          }
        });
      } finally {
        await (lease.close as () => Promise<void>).call(lease);
      }
      if (!addonHandle || addonHandle.executionId !== request.executionId || !(addonHandle.completed instanceof Promise) || typeof addonHandle.writeFrame !== "function" || typeof addonHandle.terminateHost !== "function") throw failure("EXEC_NATIVE_PROTOCOL", "Native host ABI mismatch");
      if (protocolFailed) {
        await (addonHandle.terminateHost as (frame: Buffer) => Promise<void>).call(addonHandle, encodeFrame("terminate", { secret: "0".repeat(64), reason: "protocol-failure" })).catch(() => undefined);
        throw failure("EXEC_NATIVE_PROTOCOL", "Native host emitted a malformed frame");
      }

      const completed = (addonHandle.completed as Promise<AddonCompletion>).then(value => {
        if (protocolFailed || !value || (value.exitCode !== null && !Number.isInteger(value.exitCode)) || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 128) throw failure("EXEC_NATIVE_PROTOCOL", "Native completion is invalid");
        let nativeProof: NativeExecutionProof | null = null;
        if (value.nativeProof !== null) nativeProof = decodeNativeProof(value.nativeProof);
        return Object.freeze({ exitCode: value.exitCode as number | null, reason: value.reason, nativeProof });
      });
      const handle: NativeExecutionHandle = Object.freeze({
        executionId: request.executionId,
        completed,
        async write(frame: NativeInputFrame): Promise<void> {
          if (protocolFailed || !Buffer.isBuffer(frame.bytes) || !HASH.test(frame.digest) || createHash("sha256").update(frame.bytes).digest("hex") !== frame.digest || typeof frame.appendNewline !== "boolean") throw failure("EXEC_NATIVE_PROTOCOL", "Native input is invalid");
          const writeFrame = addonHandle.writeFrame as (frame: Buffer) => Promise<void>;
          await writeFrame.call(addonHandle, encodeFrame("input", { secret: "0".repeat(64), data: Buffer.from(frame.bytes).toString("base64"), digest: frame.digest, appendNewline: frame.appendNewline }));
        },
        async terminate(reason: string): Promise<void> {
          const safeReason = typeof reason === "string" && /^[a-z0-9-]{1,64}$/u.test(reason) ? reason : "invalid-reason";
          const terminateHost = addonHandle.terminateHost as (frame: Buffer) => Promise<void>;
          await terminateHost.call(addonHandle, encodeFrame("terminate", { secret: "0".repeat(64), reason: safeReason }));
        },
      });
      handles.add(handle);
      void completed.finally(() => handles.delete(handle)).catch(() => undefined);
      return handle;
    },
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await Promise.allSettled([...handles].map(handle => handle.terminate("bridge-shutdown")));
    },
  });
}
