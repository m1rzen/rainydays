import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type PathOperation =
  | "read-file"
  | "read-directory"
  | "search-tree"
  | "create-file"
  | "replace-file"
  | "create-directory"
  | "watch-directory"
  | "initial-cwd"
  | "reveal";

export type PathDenialCode =
  | "PATH_AUTHORITY_REQUIRED"
  | "PATH_AUTHORITY_FORGED"
  | "PATH_AUTHORITY_STALE"
  | "PATH_INPUT_INVALID"
  | "PATH_NAMESPACE_DENIED"
  | "PATH_UNC_DENIED"
  | "PATH_ROOT_DENIED"
  | "PATH_ROOT_UNAVAILABLE"
  | "PATH_ROOT_UNSUPPORTED"
  | "PATH_NOT_FOUND"
  | "PATH_TYPE_MISMATCH"
  | "PATH_REDIRECT_DENIED"
  | "PATH_IDENTITY_CHANGED"
  | "PATH_OPERATION_DENIED"
  | "PATH_ROLLBACK_FAILED"
  | "PATH_AUDIT_FAILED"
  | "PATH_LIFECYCLE_FAILED";

export interface ObjectIdentity {
  readonly deviceId: string;
  readonly objectId: string;
  readonly type: "file" | "directory";
}

export type ExecutionRootAccess = "read" | "read-write";

/** Opaque, one-use authority for a PathPolicy-qualified execution root. */
export interface ExecutionRootLease { readonly __executionRootLease?: never }

/** Trusted runtime view. It is published only while an authentic lease is consumed. */
export interface ExecutionRootAuthoritySnapshot {
  readonly rootId: string;
  readonly access: ExecutionRootAccess;
  readonly authorityEpoch: number;
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly canonicalCwd: string;
  readonly cwdIdentity: ObjectIdentity;
}

export interface MutableSnapshot {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly linkCount: string;
}

export interface PathAuthority {
  readonly authorityId: string;
  readonly epoch: number;
  readonly rootIds: readonly string[];
}

export interface PathAuthorityDescription {
  readonly epoch: number;
  readonly rootIds: readonly string[];
  readonly digest: string;
}

export interface PathRootInput {
  readonly rootId: string;
  readonly role: string;
  readonly configuredPath: string;
  readonly permissions: readonly PathOperation[];
  readonly exclusionOnly?: boolean;
}

export interface PathAuditIdentity {
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly principal: string;
}

export interface PathRequest {
  readonly input: string;
  readonly operation: PathOperation;
  readonly defaultRootId?: string;
  readonly requiredExtension?: string;
  /** Trusted orchestration metadata; never sourced from model arguments. */
  readonly auditIdentity?: PathAuditIdentity;
}

export interface PathAuditEvent {
  readonly event: "path-policy-denied" | "path-policy-rollback-failed";
  readonly operationId: string;
  readonly code: PathDenialCode;
  readonly operation: PathOperation;
  readonly inputFingerprint: string;
  readonly rootId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly principal: string;
  readonly authorityEpoch: number | null;
  readonly timestamp: string;
}

export type PathBarrierPoint =
  | "afterOperationLeaseIssued"
  | "afterLexicalContainment"
  | "afterCanonicalValidation"
  | "afterHandleOpen"
  | "beforeCreateSegment"
  | "beforeFinalCreate"
  | "beforeProcessSpawn"
  | "beforeWatcherCreate"
  | "beforeWatcherPublish";

type NativeWatchFactory = (
  target: string,
  options: { readonly recursive: boolean; readonly encoding: BufferEncoding },
  listener: (eventType: string, filename: string | Buffer | null) => void
) => nodeFs.FSWatcher;

export interface PathPolicyOptions {
  readonly platform?: NodeJS.Platform;
  readonly auditSink?: (event: PathAuditEvent) => void | Promise<void>;
  readonly barrier?: (point: PathBarrierPoint, operationId: string) => void | Promise<void>;
  readonly now?: () => number;
  readonly auditKey?: Uint8Array;
  /** Trusted constructor seam for deterministic native watcher lifecycle tests. */
  readonly watchFactory?: NativeWatchFactory;
}

export interface BootstrapPathCandidateOptions {
  readonly role: string;
  readonly parent?: string;
  readonly allowEqual?: boolean;
  readonly auditIdentity?: PathAuditIdentity;
}

export interface ConfigurationRootCandidate {
  readonly rootId: string;
  readonly configuredPath: unknown;
}

export interface WindowsAuthorityRootCandidate {
  readonly rootId: string;
  readonly rootPath: string;
  readonly identity: ObjectIdentity;
}

export class PathDeniedError extends Error {
  readonly code: PathDenialCode;
  readonly primaryCode: PathDenialCode;
  readonly auditDeliveryFailed: boolean;

  constructor(
    code: PathDenialCode,
    message = "Path operation denied",
    options: { primaryCode?: PathDenialCode; auditDeliveryFailed?: boolean } = {}
  ) {
    super(message);
    this.name = "PathDeniedError";
    this.code = code;
    this.primaryCode = options.primaryCode ?? code;
    this.auditDeliveryFailed = options.auditDeliveryFailed ?? false;
  }
}

function deny(code: PathDenialCode, message?: string): never {
  throw new PathDeniedError(code, message);
}

class PathTargetExistsError extends Error {
  constructor() {
    super("Path target already exists");
    this.name = "PathTargetExistsError";
  }
}

const operations = new Set<PathOperation>([
  "read-file", "read-directory", "search-tree", "create-file", "replace-file",
  "create-directory", "watch-directory", "initial-cwd", "reveal",
]);
const dosDevices = new Set([
  "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
]);

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") deny("PATH_INPUT_INVALID");
}

/** Pure pre-I/O grammar. It intentionally performs no filesystem access. */
export function validatePathSyntax(input: unknown, platform: NodeJS.Platform = process.platform): string {
  assertString(input);
  if (input.length === 0) return input;
  if (/[\u0000-\u001f\u007f]/u.test(input) || /[\uD800-\uDFFF]/u.test(input)) deny("PATH_INPUT_INVALID");
  if (platform !== "win32") {
    const components = input.split(path.posix.sep);
    if (components.some((component) => component === "." || component === "..")) deny("PATH_INPUT_INVALID");
    return input;
  }

  const normalized = input.replaceAll("/", "\\");
  const lower = normalized.toLowerCase();
  if (lower.startsWith("\\\\?\\") || lower.startsWith("\\\\.\\") || lower.startsWith("\\??\\")) {
    deny("PATH_NAMESPACE_DENIED");
  }
  if (normalized.split("\\").some((component) => component.toUpperCase() === "GLOBALROOT")) {
    deny("PATH_NAMESPACE_DENIED");
  }
  if (/^[a-z]:[^\\]/iu.test(normalized)) deny("PATH_INPUT_INVALID");
  if (normalized.startsWith("\\") && !normalized.startsWith("\\\\")) deny("PATH_INPUT_INVALID");

  const driveAbsolute = /^[a-z]:\\/iu.test(normalized);
  const unc = normalized.startsWith("\\\\");
  if (unc) {
    const uncParts = normalized.slice(2).split("\\");
    if (uncParts.at(-1) === "") uncParts.pop();
    if (uncParts.length < 2 || !uncParts[0] || !uncParts[1] || uncParts.some((part) => part.length === 0)) {
      deny("PATH_UNC_DENIED");
    }
  }

  const colonCheck = driveAbsolute ? normalized.slice(2) : normalized;
  if (colonCheck.includes(":")) deny("PATH_INPUT_INVALID");
  const body = unc ? normalized.slice(2) : driveAbsolute ? normalized.slice(3) : normalized;
  const components = body.split("\\").filter((component) => component.length > 0);
  for (const component of components) {
    if (component === "." || component === "..") deny("PATH_INPUT_INVALID");
    if (component.endsWith(".") || component.endsWith(" ")) deny("PATH_INPUT_INVALID");
    const deviceBase = component.split(".", 1)[0].toUpperCase();
    if (dosDevices.has(deviceBase)) deny("PATH_NAMESPACE_DENIED");
  }
  return input;
}

interface CanonicalRootRecord {
  readonly rootId: string;
  readonly role: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly permissions: ReadonlySet<PathOperation>;
  readonly exclusionOnly: boolean;
}

interface AuthorityRecord {
  readonly authority: PathAuthority;
  readonly roots: readonly CanonicalRootRecord[];
  readonly parent: AuthorityRecord | null;
  readonly children: Set<PathAuthority>;
  readonly operationLeases: Set<OperationLeaseRecord>;
  active: boolean;
}

interface OperationLeaseRecord {
  readonly operationId: string;
  readonly authorityId: string;
  readonly authorityEpoch: number;
  readonly sessionId: string | null;
  readonly principal: string;
  readonly operation: PathOperation;
  rootId: string | null;
  rootIdentity: ObjectIdentity | null;
  state: "issued" | "opened" | "closed";
  openedHandles: number;
}

interface ExecutionRootLeaseRecord {
  readonly token: ExecutionRootLease;
  readonly authority: AuthorityRecord;
  readonly rootId: string;
  readonly access: ExecutionRootAccess;
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly canonicalCwd: string;
  readonly cwdIdentity: ObjectIdentity;
  readonly expiresAtMs: number;
  readonly now: () => number;
  consumed: boolean;
}

const executionRootLeases = new WeakMap<ExecutionRootLease, ExecutionRootLeaseRecord>();

export function consumeExecutionRootLease<T>(
  lease: ExecutionRootLease,
  expected: Readonly<{ authorityEpoch: number; rootId?: string; access?: ExecutionRootAccess }>,
  use: (snapshot: ExecutionRootAuthoritySnapshot) => T
): T {
  if (typeof use !== "function") throw new TypeError("execution root consumer is invalid");
  const record = lease && executionRootLeases.get(lease);
  if (!record || record.token !== lease) deny("PATH_AUTHORITY_FORGED");
  if (record.consumed) deny("PATH_OPERATION_DENIED");
  record.consumed = true;
  if (!record.authority.active || record.authority.authority.epoch !== expected.authorityEpoch
    || record.now() > record.expiresAtMs) deny("PATH_AUTHORITY_STALE");
  if ((expected.rootId !== undefined && expected.rootId !== record.rootId)
    || (expected.access !== undefined && expected.access !== record.access)) deny("PATH_OPERATION_DENIED");
  return use(Object.freeze({
    rootId: record.rootId,
    access: record.access,
    authorityEpoch: record.authority.authority.epoch,
    canonicalPath: record.canonicalPath,
    identity: record.identity,
    canonicalCwd: record.canonicalCwd,
    cwdIdentity: record.cwdIdentity,
  }));
}

interface StatLike {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
  readonly mtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  readonly mtimeMs: number | bigint;
  readonly ctimeMs: number | bigint;
  readonly nlink: bigint | number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink?(): boolean;
}

function identityFromStat(info: StatLike): ObjectIdentity {
  const value = info;
  const type = value.isFile() ? "file" : value.isDirectory() ? "directory" : null;
  if (!type) deny("PATH_TYPE_MISMATCH");
  const deviceId = String(value.dev);
  const objectId = String(value.ino);
  if (deviceId === "0" || objectId === "0") deny("PATH_ROOT_UNSUPPORTED");
  return Object.freeze({ deviceId, objectId, type });
}

function sameIdentity(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return left.deviceId === right.deviceId && left.objectId === right.objectId && left.type === right.type;
}

function sameSnapshot(left: MutableSnapshot, right: MutableSnapshot): boolean {
  return left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.linkCount === right.linkCount;
}

function millisecondsToNanoseconds(value: number | bigint): bigint {
  return typeof value === "bigint" ? value * 1_000_000n : BigInt(Math.trunc(value * 1_000_000));
}

function mutableSnapshot(info: StatLike): MutableSnapshot {
  const value = info;
  return Object.freeze({
    size: String(value.size),
    mtimeNs: String(value.mtimeNs ?? millisecondsToNanoseconds(value.mtimeMs)),
    ctimeNs: String(value.ctimeNs ?? millisecondsToNanoseconds(value.ctimeMs)),
    linkCount: String(value.nlink),
  });
}

function containsWindows(root: string, target: string): boolean {
  const relative = path.win32.relative(root.toLowerCase(), target.toLowerCase());
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative));
}

function normalizeWindows(value: string): string {
  return path.win32.normalize(value.replaceAll("/", "\\"));
}

/** Pure Windows root selection used by the runtime and no-I/O UNC contract tests. */
export function selectMostSpecificWindowsRoot(
  candidates: readonly { readonly rootId: string; readonly rootPath: string }[],
  target: unknown
): string | null {
  const safeTarget = validatePathSyntax(target, "win32");
  if (!path.win32.isAbsolute(normalizeWindows(safeTarget))) return null;
  const matches = candidates.map((candidate) => {
    if (!candidate || typeof candidate.rootId !== "string") deny("PATH_INPUT_INVALID");
    validatePathSyntax(candidate.rootPath, "win32");
    const rootPath = normalizeWindows(candidate.rootPath);
    if (!path.win32.isAbsolute(rootPath)) deny("PATH_INPUT_INVALID");
    return { rootId: candidate.rootId, rootPath };
  }).filter((candidate) => containsWindows(candidate.rootPath, normalizeWindows(safeTarget)));
  matches.sort((left, right) => right.rootPath.length - left.rootPath.length || left.rootId.localeCompare(right.rootId));
  return matches[0]?.rootId ?? null;
}

function safeMessage(code: PathDenialCode): string {
  return `Path operation denied (${code})`;
}

interface OperationState {
  readonly operationId: string;
  rootId: string | null;
  lease: OperationLeaseRecord | null;
}

interface SelectedTarget {
  readonly root: CanonicalRootRecord;
  readonly lexicalTarget: string;
}

export interface PathReadResult {
  readonly bytes: Buffer;
  readonly rootId: string;
  readonly identity: ObjectIdentity;
  readonly snapshot: MutableSnapshot;
}

export interface PathDirectReadResult extends PathReadResult {
  readonly canonicalPath: string;
}

export interface PathQualifiedResult {
  readonly rootId: string;
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly snapshot: MutableSnapshot;
}

export interface PathReadLease extends PathQualifiedResult {
  readonly size: number;
  readonly readRange: (start: number, end: number) => Promise<Buffer>;
  readonly assertPathCurrent: (barrierPoint?: PathBarrierPoint, requireSnapshot?: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface PathDirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory";
}

export interface PathDirectDirectoryEntry extends PathDirectoryEntry {
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly snapshot: MutableSnapshot;
}

export interface PathDirectDirectoryResult extends PathQualifiedResult {
  readonly entries: readonly PathDirectDirectoryEntry[];
}

export interface PathCreateResult {
  readonly rootId: string;
  readonly identity: ObjectIdentity;
  readonly bytesWritten: number;
  readonly createdDirectories: number;
}

/** Opaque write preflight. Its target and parent identities remain private to PathPolicy. */
export interface PathWritePreflight {
  readonly rootId: string;
}

interface PathWritePreflightRecord {
  readonly authority: AuthorityRecord;
  readonly request: PathRequest;
  readonly expiresAtMs: number;
  readonly expected:
    | Readonly<{ kind: "existing"; identity: ObjectIdentity; snapshot: MutableSnapshot }>
    | Readonly<{ kind: "missing"; parentPath: string; parentIdentity: ObjectIdentity }>;
  consumed: boolean;
}

export interface PathDirectoryEnrollmentLease {
  readonly rootId: string;
  readonly createdDirectories: number;
  readonly commit: () => void;
  readonly rollback: () => Promise<void>;
}

export interface PathWatchEvent {
  readonly type: "file_added" | "file_changed" | "file_removed";
  readonly path: string;
  readonly timestamp: number;
}

export interface PathWatchLease {
  readonly rootId: string;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
  readonly isOpen: () => boolean;
}

export interface PathTransformResult<T> {
  readonly bytes: Uint8Array | null;
  readonly value: T;
}

export interface PathReplaceResult<T> {
  readonly rootId: string;
  readonly identity: ObjectIdentity;
  readonly bytesWritten: number;
  readonly value: T;
}

interface CreatedObject {
  readonly target: string;
  readonly identity: ObjectIdentity | null;
}

export class PathPolicy {
  readonly #platform: NodeJS.Platform;
  readonly #auditSink: (event: PathAuditEvent) => void | Promise<void>;
  readonly #barrier: (point: PathBarrierPoint, operationId: string) => void | Promise<void>;
  readonly #now: () => number;
  readonly #auditKey: Buffer;
  readonly #watchFactory: NativeWatchFactory;
  readonly #authorities = new WeakMap<PathAuthority, AuthorityRecord>();
  readonly #writePreflights = new WeakMap<PathWritePreflight, PathWritePreflightRecord>();

  constructor(options: PathPolicyOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#auditSink = options.auditSink ?? (() => undefined);
    this.#barrier = options.barrier ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#auditKey = Buffer.from(options.auditKey ?? randomBytes(32));
    this.#watchFactory = options.watchFactory ?? ((target, watchOptions, listener) =>
      nodeFs.watch(target, watchOptions, listener));
    if (this.#auditKey.length < 32) throw new TypeError("PathPolicy audit key must be at least 256 bits");
  }

  async validateBootstrapCandidate(input: unknown, options: BootstrapPathCandidateOptions): Promise<string> {
    if (!options || typeof options.role !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(options.role)) {
      throw new TypeError("Bootstrap path role is invalid");
    }
    const operationId = randomUUID();
    const rawInput = typeof input === "string" ? input : "";
    try {
      validatePathSyntax(input, this.#platform);
      if (!this.#isAbsolute(input as string)) deny("PATH_INPUT_INVALID");
      const resolved = this.#normalizeAbsolute(input as string);
      validatePathSyntax(resolved, this.#platform);
      if (options.parent !== undefined) {
        validatePathSyntax(options.parent, this.#platform);
        if (!this.#isAbsolute(options.parent)) deny("PATH_INPUT_INVALID");
        const parent = this.#normalizeAbsolute(options.parent);
        if (!this.#contains(parent, resolved) || (!options.allowEqual && this.#samePath(parent, resolved))) {
          deny("PATH_ROOT_DENIED");
        }
      }
      return resolved;
    } catch (error) {
      const failure = error instanceof PathDeniedError
        ? error
        : new PathDeniedError("PATH_OPERATION_DENIED", safeMessage("PATH_OPERATION_DENIED"));
      await this.#deliverFailureAudit(failure, {
        operationId,
        rawInput,
        operation: "read-directory",
        rootId: options.role,
        auditIdentity: options.auditIdentity,
        authorityEpoch: null,
      });
      throw failure;
    }
  }

  async validateConfigurationRoots(
    candidates: readonly ConfigurationRootCandidate[],
    auditIdentity?: PathAuditIdentity
  ): Promise<readonly Readonly<{ rootId: string; configuredPath: string }>[]> {
    const operationId = randomUUID();
    let rawInput = "";
    let rootId: string | null = null;
    try {
      if (!Array.isArray(candidates) || candidates.length === 0) deny("PATH_ROOT_DENIED");
      const normalized: Array<Readonly<{ rootId: string; configuredPath: string }>> = [];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate.rootId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(candidate.rootId)) {
          deny("PATH_INPUT_INVALID");
        }
        const candidateRootId = candidate.rootId as string;
        rootId = candidateRootId;
        rawInput = typeof candidate.configuredPath === "string" ? candidate.configuredPath : "";
        validatePathSyntax(candidate.configuredPath, this.#platform);
        if (!this.#isAbsolute(candidate.configuredPath as string)) deny("PATH_INPUT_INVALID");
        const configuredPath = this.#normalizeAbsolute(candidate.configuredPath as string);
        validatePathSyntax(configuredPath, this.#platform);
        if (normalized.some(existing => this.#samePath(existing.configuredPath, configuredPath))) deny("PATH_ROOT_DENIED");
        normalized.push(Object.freeze({ rootId: candidateRootId, configuredPath }));
      }
      return Object.freeze(normalized);
    } catch (error) {
      const failure = error instanceof PathDeniedError
        ? error
        : new PathDeniedError("PATH_OPERATION_DENIED", safeMessage("PATH_OPERATION_DENIED"));
      await this.#deliverFailureAudit(failure, {
        operationId,
        rawInput,
        operation: "read-directory",
        rootId,
        auditIdentity,
        authorityEpoch: null,
      });
      throw failure;
    }
  }

  async evaluateWindowsRootAuthority(
    candidates: readonly WindowsAuthorityRootCandidate[],
    target: unknown,
    observedRootIdentity: ObjectIdentity,
    auditIdentity?: PathAuditIdentity
  ): Promise<Readonly<{ rootId: string }>> {
    const operationId = randomUUID();
    const rawInput = typeof target === "string" ? target : "";
    let selectedRootId: string | null = null;
    try {
      if (!Array.isArray(candidates) || candidates.length === 0) deny("PATH_ROOT_DENIED");
      selectedRootId = selectMostSpecificWindowsRoot(candidates, target);
      if (!selectedRootId) deny("PATH_ROOT_DENIED");
      const selected = candidates.find(candidate => candidate.rootId === selectedRootId);
      if (!selected || !sameIdentity(selected.identity, observedRootIdentity)) deny("PATH_IDENTITY_CHANGED");
      return Object.freeze({ rootId: selectedRootId });
    } catch (error) {
      const failure = error instanceof PathDeniedError
        ? error
        : new PathDeniedError("PATH_OPERATION_DENIED", safeMessage("PATH_OPERATION_DENIED"));
      await this.#deliverFailureAudit(failure, {
        operationId,
        rawInput,
        operation: "read-file",
        rootId: selectedRootId,
        auditIdentity,
        authorityEpoch: null,
      });
      throw failure;
    }
  }

  async createAuthority(inputs: readonly PathRootInput[], epoch = 1): Promise<PathAuthority> {
    const operationId = randomUUID();
    let auditRawInput = "";
    let auditRootId: string | null = null;
    try {
    if (!Array.isArray(inputs)) throw new TypeError("PathAuthority roots must be an array");
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new TypeError("PathAuthority epoch is invalid");
    const rootIds = new Set<string>();
    const roots: CanonicalRootRecord[] = [];
    for (const input of inputs) {
      auditRawInput = typeof input?.configuredPath === "string" ? input.configuredPath : "";
      auditRootId = typeof input?.rootId === "string" ? input.rootId : null;
      if (!input || typeof input.rootId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.rootId)) {
        throw new TypeError("Path root ID is invalid");
      }
      if (rootIds.has(input.rootId)) throw new TypeError("Path root IDs must be unique");
      rootIds.add(input.rootId);
      validatePathSyntax(input.configuredPath, this.#platform);
      if (!this.#isAbsolute(input.configuredPath)) throw new PathDeniedError("PATH_INPUT_INVALID", safeMessage("PATH_INPUT_INVALID"));
      const permissions = new Set<PathOperation>();
      for (const operation of input.permissions) {
        if (!operations.has(operation)) throw new TypeError("Path root permission is invalid");
        permissions.add(operation);
      }
      const lexicalPath = this.#normalizeAbsolute(input.configuredPath);
      let canonicalPath: string;
      let first: ObjectIdentity;
      let second: ObjectIdentity;
      try {
        await this.#walkConfiguredRootNoRedirect(lexicalPath);
        canonicalPath = this.#normalizeAbsolute(await fs.realpath(lexicalPath));
        first = await this.#probeDirectoryIdentity(canonicalPath);
        second = await this.#probeDirectoryIdentity(canonicalPath);
      } catch (error) {
        if (error instanceof PathDeniedError) throw error;
        throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", safeMessage("PATH_ROOT_UNAVAILABLE"));
      }
      if (!sameIdentity(first, second)) {
        throw new PathDeniedError("PATH_ROOT_UNSUPPORTED", safeMessage("PATH_ROOT_UNSUPPORTED"));
      }
      roots.push(Object.freeze({
        rootId: input.rootId,
        role: String(input.role),
        lexicalPath,
        canonicalPath,
        identity: first,
        permissions: permissions,
        exclusionOnly: input.exclusionOnly === true,
      }));
    }

    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (sameIdentity(roots[left].identity, roots[right].identity)) {
          throw new PathDeniedError("PATH_ROOT_UNSUPPORTED", safeMessage("PATH_ROOT_UNSUPPORTED"));
        }
        if (this.#samePath(roots[left].lexicalPath, roots[right].lexicalPath)) {
          throw new PathDeniedError("PATH_ROOT_UNSUPPORTED", safeMessage("PATH_ROOT_UNSUPPORTED"));
        }
      }
    }
    roots.sort((left, right) => right.lexicalPath.length - left.lexicalPath.length || left.rootId.localeCompare(right.rootId));
    const authority = Object.freeze({
      authorityId: randomUUID(),
      epoch,
      rootIds: Object.freeze(roots.filter((root) => !root.exclusionOnly).map((root) => root.rootId)),
    });
    this.#authorities.set(authority, {
      authority,
      roots: Object.freeze(roots),
      parent: null,
      children: new Set(),
      operationLeases: new Set(),
      active: true,
    });
    return authority;
    } catch (error) {
      if (!(error instanceof PathDeniedError)) throw error;
      await this.#deliverFailureAudit(error, {
        operationId,
        rawInput: auditRawInput,
        operation: "read-directory",
        rootId: auditRootId,
        authorityEpoch: null,
      });
      throw error;
    }
  }

  describeAuthority(authority: PathAuthority): PathAuthorityDescription {
    const record = this.#authorities.get(authority);
    if (!record || record.authority !== authority) deny("PATH_AUTHORITY_FORGED");
    if (!record.active) deny("PATH_AUTHORITY_STALE");
    const roots = record.roots.map((root) => ({
      rootId: root.rootId,
      role: root.role,
      identity: root.identity,
      permissions: [...root.permissions].sort(),
      exclusionOnly: root.exclusionOnly,
    })).sort((left, right) => left.rootId.localeCompare(right.rootId));
    const digest = createHash("sha256").update(JSON.stringify(roots)).digest("hex");
    return Object.freeze({
      epoch: authority.epoch,
      rootIds: Object.freeze([...authority.rootIds]),
      digest,
    });
  }

  deriveAuthority(parent: PathAuthority, requestedRootIds: readonly string[]): PathAuthority {
    const record = this.#authorities.get(parent);
    if (!record || record.authority !== parent) deny("PATH_AUTHORITY_FORGED");
    if (!record.active) deny("PATH_AUTHORITY_STALE");
    if (!Array.isArray(requestedRootIds) || requestedRootIds.some((rootId) => typeof rootId !== "string" || !rootId)) {
      throw new TypeError("Derived PathAuthority root IDs are invalid");
    }
    if (new Set(requestedRootIds).size !== requestedRootIds.length) throw new TypeError("Derived PathAuthority root IDs contain duplicates");
    const allowed = new Set(parent.rootIds);
    if (requestedRootIds.some((rootId) => !allowed.has(rootId))) deny("PATH_ROOT_DENIED");
    const selected = new Set(requestedRootIds);
    const roots = record.roots.filter((root) => root.exclusionOnly || selected.has(root.rootId));
    const authority = Object.freeze({
      authorityId: randomUUID(),
      epoch: parent.epoch,
      rootIds: Object.freeze([...requestedRootIds]),
    });
    const childRecord: AuthorityRecord = {
      authority,
      roots: Object.freeze(roots),
      parent: record,
      children: new Set(),
      operationLeases: new Set(),
      active: true,
    };
    this.#authorities.set(authority, childRecord);
    record.children.add(authority);
    return authority;
  }

  revoke(authority: PathAuthority): void {
    const record = this.#authorities.get(authority);
    if (!record) deny("PATH_AUTHORITY_FORGED");
    this.#revokeRecord(record);
  }

  isActive(authority: PathAuthority): boolean {
    return this.#authorities.get(authority)?.active === true;
  }

  async readFile(authority: PathAuthority, request: PathRequest, maxBytes: number): Promise<PathReadResult> {
    return this.#readExistingFile(authority, request, maxBytes, "read-file", false) as Promise<PathReadResult>;
  }

  async readFileDirect(authority: PathAuthority, request: PathRequest, maxBytes: number): Promise<PathDirectReadResult> {
    return this.#readExistingFile(authority, request, maxBytes, "read-file", true) as Promise<PathDirectReadResult>;
  }

  async searchFile(authority: PathAuthority, request: PathRequest, maxBytes: number): Promise<PathReadResult> {
    return this.#readExistingFile(authority, request, maxBytes, "search-tree", false) as Promise<PathReadResult>;
  }

  async #readExistingFile(
    authority: PathAuthority,
    request: PathRequest,
    maxBytes: number,
    requiredOperation: "read-file" | "search-tree",
    includeCanonicalPath: boolean
  ): Promise<PathReadResult | PathDirectReadResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== requiredOperation) deny("PATH_OPERATION_DENIED");
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, request.operation);
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const before = await this.#statIdentity(canonicalTarget, "file");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      this.#assertActive(record);
      const handle = await fs.open(canonicalTarget, "r").catch(() => deny("PATH_NOT_FOUND"));
      this.#markOperationHandleOpened(state);
      try {
        const openedInfo = await handle.stat({ bigint: true });
        const opened = identityFromStat(openedInfo);
        if (!sameIdentity(before.identity, opened)) deny("PATH_IDENTITY_CHANGED");
        await this.#barrier("afterHandleOpen", state.operationId);
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > maxBytes) deny("PATH_OPERATION_DENIED");
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const result = {
          bytes: Buffer.concat(chunks, total),
          rootId: selected.root.rootId,
          identity: opened,
          snapshot: mutableSnapshot(openedInfo),
        };
        return Object.freeze(includeCanonicalPath ? { ...result, canonicalPath: canonicalTarget } : result);
      } finally {
        await handle.close().catch(() => undefined);
      }
    });
  }

  async qualifyExisting(
    authority: PathAuthority,
    request: PathRequest,
    expectedType?: "file" | "directory"
  ): Promise<PathQualifiedResult> {
    return this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, request.operation);
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const before = await this.#statIdentity(canonicalTarget, expectedType);
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const lexical = await this.#lstatIdentity(selected.lexicalTarget, expectedType);
      if (!sameIdentity(before.identity, lexical)) deny("PATH_IDENTITY_CHANGED");
      const finalCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      if (!this.#samePath(canonicalTarget, finalCanonical)) deny("PATH_IDENTITY_CHANGED");
      return Object.freeze({
        rootId: selected.root.rootId,
        canonicalPath: canonicalTarget,
        identity: before.identity,
        snapshot: before.snapshot,
      });
    });
  }

  async openReadLease(authority: PathAuthority, request: PathRequest, maxBytes: number): Promise<PathReadLease> {
    if (request.operation !== "read-file") throw new TypeError("openReadLease requires read-file permission");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
    const opened = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "read-file");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const before = await this.#statIdentity(canonicalTarget, "file");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const handle = await fs.open(canonicalTarget, "r").catch(() => deny("PATH_NOT_FOUND"));
      this.#markOperationHandleOpened(state);
      try {
        const handleInfo = await handle.stat({ bigint: true });
        const handleIdentity = identityFromStat(handleInfo);
        if (!sameIdentity(before.identity, handleIdentity)) deny("PATH_IDENTITY_CHANGED");
        const size = Number(handleInfo.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) deny("PATH_OPERATION_DENIED");
        await this.#barrier("afterHandleOpen", state.operationId);
        this.#assertActive(record);
        return Object.freeze({
          handle,
          selectedRoot: selected.root,
          lexicalTarget: selected.lexicalTarget,
          rootId: selected.root.rootId,
          canonicalPath: canonicalTarget,
          identity: handleIdentity,
          snapshot: mutableSnapshot(handleInfo),
          size,
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });

    let active = true;
    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      active = false;
      closePromise = opened.handle.close().catch(() => undefined);
      return closePromise;
    };
    const readRange = (start: number, end: number): Promise<Buffer> => this.#run(authority, request, async (record, state) => {
      state.rootId = opened.rootId;
      if (!active) deny("PATH_AUTHORITY_STALE");
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= opened.size || end >= opened.size) {
        deny("PATH_OPERATION_DENIED");
      }
      this.#assertActive(record);
      await this.#verifyRoot(record, opened.selectedRoot, state);
      const handleInfo = await opened.handle.stat({ bigint: true }).catch(() => deny("PATH_IDENTITY_CHANGED"));
      if (!sameIdentity(opened.identity, identityFromStat(handleInfo))) deny("PATH_IDENTITY_CHANGED");
      const length = end - start + 1;
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await opened.handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) deny("PATH_IDENTITY_CHANGED");
        offset += bytesRead;
      }
      return buffer;
    });
    const assertPathCurrent = (barrierPoint?: PathBarrierPoint, requireSnapshot = false): Promise<void> => this.#run(authority, request, async (record, state) => {
      state.rootId = opened.rootId;
      if (barrierPoint !== undefined) await this.#barrier(barrierPoint, state.operationId);
      if (!active) deny("PATH_AUTHORITY_STALE");
      this.#assertActive(record);
      await this.#verifyRoot(record, opened.selectedRoot, state);
      await this.#walkNoRedirect(opened.selectedRoot, opened.lexicalTarget);
      const lexical = await this.#lstatIdentity(opened.lexicalTarget, "file");
      if (!sameIdentity(opened.identity, lexical)) deny("PATH_IDENTITY_CHANGED");
      const canonical = this.#normalizeAbsolute(await this.#realpathOrDeny(opened.lexicalTarget));
      if (!this.#samePath(opened.canonicalPath, canonical)) deny("PATH_IDENTITY_CHANGED");
      const handleInfo = await opened.handle.stat({ bigint: true }).catch(() => deny("PATH_IDENTITY_CHANGED"));
      if (!sameIdentity(opened.identity, identityFromStat(handleInfo))) deny("PATH_IDENTITY_CHANGED");
      if (requireSnapshot && !sameSnapshot(opened.snapshot, mutableSnapshot(handleInfo))) deny("PATH_IDENTITY_CHANGED");
    });
    return Object.freeze({
      rootId: opened.rootId,
      canonicalPath: opened.canonicalPath,
      identity: opened.identity,
      snapshot: opened.snapshot,
      size: opened.size,
      readRange,
      assertPathCurrent,
      close,
    });
  }

  async withReveal<T>(
    authority: PathAuthority,
    request: PathRequest,
    use: (canonicalPath: string, type: "file" | "directory") => T | Promise<T>
  ): Promise<T> {
    if (request.operation !== "reveal") throw new TypeError("withReveal requires reveal permission");
    if (typeof use !== "function") throw new TypeError("reveal callback is invalid");
    const outcome = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "reveal");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const before = await this.#statIdentity(canonicalTarget);
      await this.#barrier("afterCanonicalValidation", state.operationId);
      await this.#barrier("beforeProcessSpawn", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const lexical = await this.#lstatIdentity(selected.lexicalTarget, before.identity.type);
      if (!sameIdentity(before.identity, lexical)) deny("PATH_IDENTITY_CHANGED");
      const finalCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      if (!this.#samePath(canonicalTarget, finalCanonical)) deny("PATH_IDENTITY_CHANGED");
      try {
        return Object.freeze({ kind: "value" as const, value: use(canonicalTarget, before.identity.type) });
      } catch (error) {
        return Object.freeze({ kind: "error" as const, error });
      }
    });
    if (outcome.kind === "error") throw outcome.error;
    return await outcome.value;
  }

  async listDirectory(authority: PathAuthority, request: PathRequest, maxEntries = 10_000): Promise<readonly PathDirectoryEntry[]> {
    const result = await this.#listExistingDirectory(authority, request, maxEntries, "read-directory");
    return Object.freeze(result.entries.map((entry) => Object.freeze({ name: entry.name, type: entry.type })));
  }

  async listDirectoryDirect(authority: PathAuthority, request: PathRequest, maxEntries = 10_000): Promise<PathDirectDirectoryResult> {
    if (request.operation !== "read-directory") throw new TypeError("listDirectoryDirect requires read-directory permission");
    return this.#listExistingDirectory(authority, request, maxEntries, "read-directory");
  }

  async searchDirectory(authority: PathAuthority, request: PathRequest, maxEntries = 10_000): Promise<readonly PathDirectoryEntry[]> {
    const result = await this.#listExistingDirectory(authority, request, maxEntries, "search-tree");
    return Object.freeze(result.entries.map((entry) => Object.freeze({ name: entry.name, type: entry.type })));
  }

  async #listExistingDirectory(
    authority: PathAuthority,
    request: PathRequest,
    maxEntries: number,
    requiredOperation: "read-directory" | "search-tree"
  ): Promise<PathDirectDirectoryResult> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive safe integer");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== requiredOperation) deny("PATH_OPERATION_DENIED");
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, request.operation);
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const directoryIdentity = await this.#statIdentity(canonicalTarget, "directory");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      const rechecked = await this.#statIdentity(canonicalTarget, "directory");
      if (!sameIdentity(directoryIdentity.identity, rechecked.identity)) deny("PATH_IDENTITY_CHANGED");
      this.#assertActive(record);
      const directory = await fs.opendir(canonicalTarget).catch(() => deny("PATH_NOT_FOUND"));
      const entries: PathDirectDirectoryEntry[] = [];
      try {
        for await (const entry of directory) {
          validatePathSyntax(entry.name, this.#platform);
          if (entries.length >= maxEntries) deny("PATH_OPERATION_DENIED");
          if (!entry.isFile() && !entry.isDirectory()) deny("PATH_REDIRECT_DENIED");
          const child = this.#join(canonicalTarget, entry.name);
          const childRoot = this.#mostSpecificRoot(record.roots, child, "canonicalPath");
          if (!childRoot || childRoot.exclusionOnly || !childRoot.permissions.has(requiredOperation)) continue;
          this.#assertActive(record);
          const childInfo = await fs.lstat(child, { bigint: true }).catch(() => deny("PATH_IDENTITY_CHANGED"));
          if (childInfo.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
          const childIdentity = identityFromStat(childInfo);
          const entryType = entry.isDirectory() ? "directory" : "file";
          if (childIdentity.type !== entryType) deny("PATH_IDENTITY_CHANGED");
          entries.push(Object.freeze({
            name: entry.name,
            type: entryType,
            canonicalPath: child,
            identity: childIdentity,
            snapshot: mutableSnapshot(childInfo),
          }));
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      return Object.freeze({
        rootId: selected.root.rootId,
        canonicalPath: canonicalTarget,
        identity: directoryIdentity.identity,
        snapshot: directoryIdentity.snapshot,
        entries: Object.freeze(entries),
      });
    });
  }

  async preflightWrite(authority: PathAuthority, request: PathRequest, ttlMs = 60_000): Promise<PathWritePreflight> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) throw new TypeError("write preflight lifetime is invalid");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== "create-file") deny("PATH_OPERATION_DENIED");
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      if (this.#samePath(selected.root.lexicalPath, selected.lexicalTarget)) deny("PATH_OPERATION_DENIED");
      await this.#verifyRoot(record, selected.root, state);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);

      let expected: PathWritePreflightRecord["expected"] | null = null;
      try {
        const targetInfo = await fs.lstat(selected.lexicalTarget, { bigint: true });
        if (targetInfo.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
        if (!targetInfo.isFile()) deny("PATH_TYPE_MISMATCH");
        const replaceRequest = { ...request, operation: "replace-file" as const };
        const replaceSelected = this.#selectTarget(record, replaceRequest);
        if (replaceSelected.root.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
        await this.#walkNoRedirect(replaceSelected.root, replaceSelected.lexicalTarget);
        const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(replaceSelected.lexicalTarget));
        const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "replace-file");
        if (canonicalRoot.rootId !== replaceSelected.root.rootId) deny("PATH_ROOT_DENIED");
        const checked = await this.#statIdentity(canonicalTarget, "file");
        expected = Object.freeze({ kind: "existing", identity: checked.identity, snapshot: checked.snapshot });
      } catch (error) {
        if (error instanceof PathDeniedError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
        let nearestParent = this.#dirname(selected.lexicalTarget);
        while (this.#contains(selected.root.lexicalPath, nearestParent)) {
          try {
            const info = await fs.lstat(nearestParent, { bigint: true });
            if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
            const identity = identityFromStat(info);
            if (identity.type !== "directory") deny("PATH_TYPE_MISMATCH");
            await this.#walkNoRedirect(selected.root, nearestParent);
            const canonicalParent = this.#normalizeAbsolute(await this.#realpathOrDeny(nearestParent));
            const canonicalRoot = this.#selectCanonicalRoot(record, canonicalParent, "create-file");
            if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
            const checked = await this.#statIdentity(canonicalParent, "directory");
            if (!sameIdentity(identity, checked.identity)) deny("PATH_IDENTITY_CHANGED");
            expected = Object.freeze({ kind: "missing", parentPath: nearestParent, parentIdentity: checked.identity });
            break;
          } catch (parentError) {
            if (parentError instanceof PathDeniedError) throw parentError;
            if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
          }
          const next = this.#dirname(nearestParent);
          if (this.#samePath(next, nearestParent)) break;
          nearestParent = next;
        }
        if (!expected) deny("PATH_ROOT_DENIED");
      }

      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      const view = Object.freeze({ rootId: selected.root.rootId });
      this.#writePreflights.set(view, {
        authority: record,
        request: Object.freeze({ ...request, auditIdentity: request.auditIdentity ? Object.freeze({ ...request.auditIdentity }) : undefined }),
        expiresAtMs: this.#now() + ttlMs,
        expected,
        consumed: false,
      });
      return view;
    });
  }

  async commitPreflightWrite(
    authority: PathAuthority,
    preflight: PathWritePreflight,
    bytes: Uint8Array,
    maxBytes = 64 * 1024 * 1024
  ): Promise<PathCreateResult | PathReplaceResult<null>> {
    const record = this.#writePreflights.get(preflight);
    const authorityRecord = this.#authorities.get(authority);
    if (!record || !authorityRecord || record.authority !== authorityRecord) deny("PATH_AUTHORITY_FORGED");
    if (record.consumed) deny("PATH_OPERATION_DENIED");
    record.consumed = true;
    if (this.#now() > record.expiresAtMs) {
      return this.#run(authority, record.request, async () => deny("PATH_OPERATION_DENIED"));
    }
    if (record.expected.kind === "existing") {
      const replaceRequest = { ...record.request, operation: "replace-file" as const };
      return this.#replaceFileInternal(
        authority,
        replaceRequest,
        () => Object.freeze({ bytes, value: null }),
        maxBytes,
        record.expected
      );
    }
    return this.#createFileInternal(authority, record.request, bytes, maxBytes, record.expected);
  }

  async withExecutionRoot<T>(
    authority: PathAuthority,
    request: PathRequest,
    access: ExecutionRootAccess,
    use: (canonicalCwd: string, lease: ExecutionRootLease, qualificationDigest: string) => T | Promise<T>
  ): Promise<T> {
    if (request.operation !== "initial-cwd") throw new TypeError("execution root requires initial-cwd permission");
    if (access !== "read" && access !== "read-write") throw new TypeError("execution root access is invalid");
    if (typeof use !== "function") throw new TypeError("execution root callback is invalid");
    if (this.#platform !== "win32") deny("PATH_ROOT_UNSUPPORTED");
    const outcome = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "initial-cwd");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const directoryIdentity = await this.#statIdentity(canonicalTarget, "directory");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      await this.#barrier("beforeProcessSpawn", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const lexicalIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
      if (!sameIdentity(directoryIdentity.identity, lexicalIdentity)) deny("PATH_IDENTITY_CHANGED");
      const finalCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      if (!this.#samePath(canonicalTarget, finalCanonical)) deny("PATH_IDENTITY_CHANGED");
      const finalRoot = this.#selectCanonicalRoot(record, finalCanonical, "initial-cwd");
      if (finalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const token: ExecutionRootLease = Object.freeze({});
      executionRootLeases.set(token, {
        token,
        authority: record,
        rootId: finalRoot.rootId,
        access,
        canonicalPath: finalRoot.canonicalPath,
        identity: finalRoot.identity,
        canonicalCwd: finalCanonical,
        cwdIdentity: directoryIdentity.identity,
        expiresAtMs: this.#now() + 15_000,
        now: this.#now,
        consumed: false,
      });
      const qualificationDigest = createHmac("sha256", this.#auditKey).update(JSON.stringify({
        authorityEpoch: record.authority.epoch,
        rootId: finalRoot.rootId,
        access,
        canonicalPath: finalRoot.canonicalPath,
        identity: finalRoot.identity,
        canonicalCwd: finalCanonical,
        cwdIdentity: directoryIdentity.identity,
      })).digest("hex");
      try {
        return Object.freeze({ kind: "value" as const, value: use(finalCanonical, token, qualificationDigest) });
      } catch (error) {
        return Object.freeze({ kind: "error" as const, error });
      }
    });
    if (outcome.kind === "error") throw outcome.error;
    return await outcome.value;
  }

  async withInitialCwd<T>(
    authority: PathAuthority,
    request: PathRequest,
    use: (canonicalCwd: string) => T | Promise<T>
  ): Promise<T> {
    if (request.operation !== "initial-cwd") throw new TypeError("withInitialCwd requires initial-cwd permission");
    if (typeof use !== "function") throw new TypeError("initial CWD callback is invalid");
    const outcome = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "initial-cwd");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const directoryIdentity = await this.#statIdentity(canonicalTarget, "directory");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      await this.#barrier("beforeProcessSpawn", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const lexicalIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
      if (!sameIdentity(directoryIdentity.identity, lexicalIdentity)) deny("PATH_IDENTITY_CHANGED");
      const finalCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      if (!this.#samePath(canonicalTarget, finalCanonical)) deny("PATH_IDENTITY_CHANGED");
      const finalRoot = this.#selectCanonicalRoot(record, finalCanonical, "initial-cwd");
      if (finalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      try {
        return Object.freeze({ kind: "value" as const, value: use(canonicalTarget) });
      } catch (error) {
        return Object.freeze({ kind: "error" as const, error });
      }
    });
    if (outcome.kind === "error") throw outcome.error;
    return await outcome.value;
  }

  async watchDirectory(
    authority: PathAuthority,
    request: PathRequest,
    publish: (event: PathWatchEvent) => void | Promise<void>
  ): Promise<PathWatchLease> {
    if (request.operation !== "watch-directory") throw new TypeError("watchDirectory requires watch-directory permission");
    if (typeof publish !== "function") throw new TypeError("watch publish callback is invalid");
    let active = true;
    let nativeWatcher: nodeFs.FSWatcher | null = null;
    let nativeClosed = false;
    let closePromise: Promise<void> | null = null;
    let closedSettled = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const settleClosed = (): void => {
      if (closedSettled) return;
      closedSettled = true;
      resolveClosed();
    };
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      active = false;
      closePromise = (async () => {
        if (!nativeWatcher || nativeClosed) {
          settleClosed();
          return;
        }
        nativeWatcher.close();
        await closed;
      })();
      return closePromise;
    };
    const terminateLease = close;

    const prepared = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "watch-directory");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const directoryIdentity = await this.#statIdentity(canonicalTarget, "directory");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const finalIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
      if (!sameIdentity(directoryIdentity.identity, finalIdentity)) deny("PATH_IDENTITY_CHANGED");
      const finalCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      if (!this.#samePath(canonicalTarget, finalCanonical)) deny("PATH_IDENTITY_CHANGED");

      const authorizeEvent = async (eventType: string, filename: string | Buffer | null): Promise<void> => {
        if (!active) return;
        try {
          if (!this.isActive(authority)) {
            await this.#run(authority, { ...request, input: "", operation: "watch-directory" }, async () => deny("PATH_AUTHORITY_STALE"));
            return;
          }
          if (typeof filename !== "string" || filename.length === 0) {
            await this.#run(authority, { ...request, input: "", operation: "watch-directory" }, async () => deny("PATH_INPUT_INVALID"));
            return;
          }
          const eventFilename = filename;
          const event = await this.#run(authority, {
            ...request,
            input: eventFilename,
            operation: "watch-directory",
          }, async (eventRecord, eventState) => {
            if (this.#isAbsolute(eventFilename)) deny("PATH_INPUT_INVALID");
            const eventTarget = this.#resolve(canonicalTarget, eventFilename);
            if (!this.#contains(canonicalTarget, eventTarget) || this.#samePath(canonicalTarget, eventTarget)) deny("PATH_ROOT_DENIED");
            eventState.rootId = selected.root.rootId;
            this.#assertActive(eventRecord);
            await this.#verifyRoot(eventRecord, selected.root, eventState);
            await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
            const currentWatchIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
            if (!sameIdentity(directoryIdentity.identity, currentWatchIdentity)) deny("PATH_IDENTITY_CHANGED");
            const currentWatchCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
            if (!this.#samePath(canonicalTarget, currentWatchCanonical)) deny("PATH_IDENTITY_CHANGED");

            let type: PathWatchEvent["type"] = "file_changed";
            try {
              const entryInfo = await fs.lstat(eventTarget, { bigint: true });
              if (entryInfo.isSymbolicLink() || (!entryInfo.isFile() && !entryInfo.isDirectory())) deny("PATH_REDIRECT_DENIED");
              await this.#walkNoRedirect(selected.root, eventTarget);
              const canonicalEvent = this.#normalizeAbsolute(await this.#realpathOrDeny(eventTarget));
              const eventRoot = this.#selectCanonicalRoot(eventRecord, canonicalEvent, "watch-directory");
              if (eventRoot.rootId !== selected.root.rootId || !this.#contains(canonicalTarget, canonicalEvent)) deny("PATH_ROOT_DENIED");
              await this.#statIdentity(canonicalEvent, entryInfo.isDirectory() ? "directory" : "file");
              const birthtimeMs = Number(entryInfo.birthtimeMs ?? 0);
              if (eventType === "rename" && Number.isFinite(birthtimeMs) && birthtimeMs > this.#now() - 5_000) type = "file_added";
            } catch (error) {
              if (error instanceof PathDeniedError) throw error;
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
              type = "file_removed";
              let parent = this.#dirname(eventTarget);
              while (this.#contains(canonicalTarget, parent)) {
                try {
                  const parentInfo = await fs.lstat(parent, { bigint: true });
                  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) deny("PATH_REDIRECT_DENIED");
                  await this.#walkNoRedirect(selected.root, parent);
                  const canonicalParent = this.#normalizeAbsolute(await this.#realpathOrDeny(parent));
                  const parentRoot = this.#selectCanonicalRoot(eventRecord, canonicalParent, "watch-directory");
                  if (parentRoot.rootId !== selected.root.rootId || !this.#contains(canonicalTarget, canonicalParent)) deny("PATH_ROOT_DENIED");
                  break;
                } catch (parentError) {
                  if (parentError instanceof PathDeniedError) throw parentError;
                  if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
                }
                if (this.#samePath(parent, canonicalTarget)) deny("PATH_IDENTITY_CHANGED");
                const next = this.#dirname(parent);
                if (this.#samePath(next, parent)) deny("PATH_ROOT_DENIED");
                parent = next;
              }
              if (!this.#contains(canonicalTarget, parent)) deny("PATH_ROOT_DENIED");
            }

            await this.#barrier("beforeWatcherPublish", eventState.operationId);
            this.#assertActive(eventRecord);
            await this.#verifyRoot(eventRecord, selected.root, eventState);
            const publishWatchIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
            if (!sameIdentity(directoryIdentity.identity, publishWatchIdentity)) deny("PATH_IDENTITY_CHANGED");
            return Object.freeze({ type, path: eventTarget, timestamp: this.#now() });
          });
          if (active && this.isActive(authority)) await publish(event);
          else await terminateLease();
        } catch {
          // A denied or stale event permanently closes this lease after its single audit attempt.
          await terminateLease().catch(() => undefined);
        }
      };

      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const createIdentity = await this.#lstatIdentity(selected.lexicalTarget, "directory");
      if (!sameIdentity(directoryIdentity.identity, createIdentity)) deny("PATH_IDENTITY_CHANGED");
      await this.#barrier("beforeWatcherCreate", state.operationId);
      this.#assertActive(record);
      let eventQueue = Promise.resolve();
      const watcher = this.#watchFactory(canonicalTarget, { recursive: true, encoding: "utf8" }, (eventType, filename) => {
        eventQueue = eventQueue.then(() => authorizeEvent(eventType, filename));
      });
      nativeWatcher = watcher;
      watcher.on("error", () => { void close().catch(() => undefined); });
      watcher.once("close", () => {
        nativeClosed = true;
        active = false;
        settleClosed();
      });
      await Promise.resolve();
      if (!active || nativeClosed) {
        await close().catch(() => deny("PATH_LIFECYCLE_FAILED"));
        deny("PATH_LIFECYCLE_FAILED");
      }
      return Object.freeze({ rootId: selected.root.rootId });
    });

    if (!active || nativeClosed) {
      await close().catch(() => undefined);
      return this.#run(authority, request, async () => deny("PATH_LIFECYCLE_FAILED"));
    }
    return Object.freeze({ rootId: prepared.rootId, close, closed, isOpen: () => active && !nativeClosed });
  }

  async createDirectoryEnrollment(
    authority: PathAuthority,
    request: PathRequest
  ): Promise<PathDirectoryEnrollmentLease> {
    if (request.operation !== "create-directory") throw new TypeError("directory enrollment requires create-directory permission");
    const prepared = await this.#run(authority, request, async (record, state) => {
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      if (this.#samePath(selected.root.lexicalPath, selected.lexicalTarget)) deny("PATH_OPERATION_DENIED");
      await this.#verifyRoot(record, selected.root, state);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);

      try {
        const existing = await fs.lstat(selected.lexicalTarget, { bigint: true });
        if (existing.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
        const identity = identityFromStat(existing);
        if (identity.type !== "directory") deny("PATH_TYPE_MISMATCH");
        await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
        const canonical = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
        const canonicalRoot = this.#selectCanonicalRoot(record, canonical, "create-directory");
        if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
        return Object.freeze({ rootId: selected.root.rootId, created: Object.freeze([] as CreatedObject[]) });
      } catch (error) {
        if (error instanceof PathDeniedError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
      }

      const missing: string[] = [];
      let nearestParent = selected.lexicalTarget;
      let nearestIdentity: ObjectIdentity | null = null;
      while (this.#contains(selected.root.lexicalPath, nearestParent)) {
        try {
          const info = await fs.lstat(nearestParent, { bigint: true });
          if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
          nearestIdentity = identityFromStat(info);
          if (nearestIdentity.type !== "directory") deny("PATH_TYPE_MISMATCH");
          break;
        } catch (error) {
          if (error instanceof PathDeniedError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
          missing.unshift(this.#basename(nearestParent));
          const next = this.#dirname(nearestParent);
          if (this.#samePath(next, nearestParent)) break;
          nearestParent = next;
        }
      }
      if (!nearestIdentity || !this.#contains(selected.root.lexicalPath, nearestParent) || missing.length === 0) deny("PATH_ROOT_DENIED");
      await this.#walkNoRedirect(selected.root, nearestParent);
      const canonicalParent = this.#normalizeAbsolute(await this.#realpathOrDeny(nearestParent));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalParent, "create-directory");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const checkedParent = await this.#statIdentity(canonicalParent, "directory");
      if (!sameIdentity(nearestIdentity, checkedParent.identity)) deny("PATH_IDENTITY_CHANGED");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);

      const created: CreatedObject[] = [];
      let current = nearestParent;
      let expectedCurrent = checkedParent.identity;
      try {
        for (const component of missing) {
          await this.#barrier("beforeCreateSegment", state.operationId);
          this.#assertActive(record);
          await this.#verifyRoot(record, selected.root, state);
          await this.#walkNoRedirect(selected.root, current);
          const currentNow = await this.#lstatIdentity(current, "directory");
          if (!sameIdentity(currentNow, expectedCurrent)) deny("PATH_IDENTITY_CHANGED");
          current = this.#join(current, component);
          await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") deny("PATH_IDENTITY_CHANGED");
            deny("PATH_OPERATION_DENIED");
          });
          created.push({ target: current, identity: null });
          const createdIdentity = await this.#lstatIdentity(current, "directory");
          created[created.length - 1] = { target: current, identity: createdIdentity };
          expectedCurrent = createdIdentity;
          const canonicalCreated = this.#normalizeAbsolute(await this.#realpathOrDeny(current));
          const createdRoot = this.#selectCanonicalRoot(record, canonicalCreated, "create-directory");
          if (createdRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
        }
        await this.#barrier("beforeFinalCreate", state.operationId);
        this.#assertActive(record);
        await this.#verifyRoot(record, selected.root, state);
        for (const item of created) {
          if (!item.identity) deny("PATH_IDENTITY_CHANGED");
          await this.#walkNoRedirect(selected.root, item.target);
          const currentIdentity = await this.#lstatIdentity(item.target, "directory");
          if (!sameIdentity(item.identity, currentIdentity)) deny("PATH_IDENTITY_CHANGED");
          const canonicalItem = this.#normalizeAbsolute(await this.#realpathOrDeny(item.target));
          const itemRoot = this.#selectCanonicalRoot(record, canonicalItem, "create-directory");
          if (itemRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
        }
        return Object.freeze({ rootId: selected.root.rootId, created: Object.freeze([...created]) });
      } catch (error) {
        if (created.length > 0) await this.#rollbackCreated(created);
        throw error;
      }
    });

    let active = true;
    const commit = (): void => {
      if (!active) deny("PATH_AUTHORITY_STALE");
      active = false;
    };
    const rollback = async (): Promise<void> => {
      if (!active) deny("PATH_AUTHORITY_STALE");
      active = false;
      if (prepared.created.length > 0) await this.#rollbackCreated(prepared.created);
    };
    return Object.freeze({
      rootId: prepared.rootId,
      createdDirectories: prepared.created.length,
      commit,
      rollback,
    });
  }

  async createFile(
    authority: PathAuthority,
    request: PathRequest,
    bytes: Uint8Array,
    maxBytes = 64 * 1024 * 1024
  ): Promise<PathCreateResult> {
    try {
      return await this.#createFileInternal(authority, request, bytes, maxBytes);
    } catch (error) {
      if (!(error instanceof PathTargetExistsError)) throw error;
      return this.#run(authority, request, () => Promise.resolve(deny("PATH_OPERATION_DENIED")));
    }
  }

  async createOrReplaceFile(
    authority: PathAuthority,
    request: PathRequest,
    bytes: Uint8Array,
    maxBytes = 64 * 1024 * 1024
  ): Promise<PathCreateResult | PathReplaceResult<null>> {
    try {
      return await this.#createFileInternal(authority, request, bytes, maxBytes);
    } catch (error) {
      if (!(error instanceof PathTargetExistsError)) throw error;
      return this.replaceFile(
        authority,
        { ...request, operation: "replace-file" },
        () => ({ bytes, value: null }),
        maxBytes
      );
    }
  }

  async atomicCreateOrReplaceFile(
    authority: PathAuthority,
    request: PathRequest,
    bytes: Uint8Array,
    maxBytes = 4 * 1024 * 1024
  ): Promise<PathCreateResult> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("atomic write bytes are invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength > maxBytes) throw new TypeError("atomic write size is invalid");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== "create-file") deny("PATH_OPERATION_DENIED");
      const copiedBytes = Buffer.from(bytes);
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      if (!selected.root.permissions.has("replace-file")) deny("PATH_OPERATION_DENIED");
      if (this.#samePath(selected.root.lexicalPath, selected.lexicalTarget)) deny("PATH_OPERATION_DENIED");
      await this.#verifyRoot(record, selected.root, state);
      const parent = this.#dirname(selected.lexicalTarget);
      await this.#walkNoRedirect(selected.root, parent);
      const canonicalParent = this.#normalizeAbsolute(await this.#realpathOrDeny(parent));
      const parentRoot = this.#selectCanonicalRoot(record, canonicalParent, "create-file");
      if (parentRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const parentIdentity = await this.#statIdentity(canonicalParent, "directory");

      let expectedTarget: ObjectIdentity | null = null;
      try {
        const targetInfo = await fs.lstat(selected.lexicalTarget, { bigint: true });
        if (targetInfo.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
        expectedTarget = identityFromStat(targetInfo);
        if (expectedTarget.type !== "file") deny("PATH_TYPE_MISMATCH");
        const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
        const replaceRoot = this.#selectCanonicalRoot(record, canonicalTarget, "replace-file");
        if (replaceRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      } catch (error) {
        if (error instanceof PathDeniedError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
      }

      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, parent);
      const parentNow = await this.#statIdentity(canonicalParent, "directory");
      if (!sameIdentity(parentIdentity.identity, parentNow.identity)) deny("PATH_IDENTITY_CHANGED");

      const temporary = this.#join(parent, `.mini-lux-${randomUUID()}.tmp`);
      const temporarySelected = this.#selectTarget(record, { ...request, input: temporary, requiredExtension: undefined });
      if (temporarySelected.root.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const handle = await fs.open(temporary, "wx").catch(() => deny("PATH_OPERATION_DENIED"));
      this.#markOperationHandleOpened(state);
      let temporaryIdentity: ObjectIdentity | null = null;
      try {
        const opened = await handle.stat({ bigint: true });
        temporaryIdentity = identityFromStat(opened);
        if (temporaryIdentity.type !== "file") deny("PATH_TYPE_MISMATCH");
        await handle.writeFile(copiedBytes);
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }

      try {
        await this.#barrier("beforeFinalCreate", state.operationId);
        this.#assertActive(record);
        await this.#verifyRoot(record, selected.root, state);
        await this.#walkNoRedirect(selected.root, parent);
        const finalParent = await this.#statIdentity(canonicalParent, "directory");
        if (!sameIdentity(parentIdentity.identity, finalParent.identity)) deny("PATH_IDENTITY_CHANGED");
        try {
          const targetNowInfo = await fs.lstat(selected.lexicalTarget, { bigint: true });
          const targetNow = identityFromStat(targetNowInfo);
          if (!expectedTarget || targetNowInfo.isSymbolicLink() || !sameIdentity(expectedTarget, targetNow)) deny("PATH_IDENTITY_CHANGED");
        } catch (error) {
          if (error instanceof PathDeniedError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || expectedTarget) deny("PATH_IDENTITY_CHANGED");
        }
        await fs.rename(temporary, selected.lexicalTarget).catch(() => deny("PATH_OPERATION_DENIED"));
        const published = await this.#lstatIdentity(selected.lexicalTarget, "file");
        if (!temporaryIdentity || !sameIdentity(temporaryIdentity, published)) deny("PATH_IDENTITY_CHANGED");
        return Object.freeze({
          rootId: selected.root.rootId,
          identity: published,
          bytesWritten: copiedBytes.length,
          createdDirectories: 0,
        });
      } catch (error) {
        if (temporaryIdentity) await this.#rollbackCreated([{ target: temporary, identity: temporaryIdentity }]);
        throw error;
      }
    });
  }

  async #createFileInternal(
    authority: PathAuthority,
    request: PathRequest,
    bytes: Uint8Array,
    maxBytes: number,
    expectedMissingParent?: Readonly<{ parentPath: string; parentIdentity: ObjectIdentity }>
  ): Promise<PathCreateResult> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("createFile bytes are invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== "create-file") deny("PATH_OPERATION_DENIED");
      if (bytes.byteLength > maxBytes) deny("PATH_OPERATION_DENIED");
      const copiedBytes = Buffer.from(bytes);
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      if (this.#samePath(selected.root.lexicalPath, selected.lexicalTarget)) deny("PATH_OPERATION_DENIED");
      await this.#verifyRoot(record, selected.root, state);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      if (expectedMissingParent) {
        try {
          await fs.lstat(selected.lexicalTarget, { bigint: true });
          deny("PATH_IDENTITY_CHANGED");
        } catch (error) {
          if (error instanceof PathDeniedError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
        }
      }

      const targetParent = this.#dirname(selected.lexicalTarget);
      const missing: string[] = [];
      let nearestParent = targetParent;
      let nearestIdentity: ObjectIdentity | null = null;
      while (this.#contains(selected.root.lexicalPath, nearestParent)) {
        try {
          const info = await fs.lstat(nearestParent, { bigint: true });
          if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
          nearestIdentity = identityFromStat(info);
          if (nearestIdentity.type !== "directory") deny("PATH_TYPE_MISMATCH");
          break;
        } catch (error) {
          if (error instanceof PathDeniedError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_OPERATION_DENIED");
          missing.unshift(this.#basename(nearestParent));
          const next = this.#dirname(nearestParent);
          if (this.#samePath(next, nearestParent)) break;
          nearestParent = next;
        }
      }
      if (!nearestIdentity || !this.#contains(selected.root.lexicalPath, nearestParent)) deny("PATH_ROOT_DENIED");
      if (expectedMissingParent
        && (!this.#samePath(expectedMissingParent.parentPath, nearestParent)
          || !sameIdentity(expectedMissingParent.parentIdentity, nearestIdentity))) {
        deny("PATH_IDENTITY_CHANGED");
      }
      await this.#walkNoRedirect(selected.root, nearestParent);
      const canonicalParent = this.#normalizeAbsolute(await this.#realpathOrDeny(nearestParent));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalParent, request.operation);
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const checkedParent = await this.#statIdentity(canonicalParent, "directory");
      if (!sameIdentity(nearestIdentity, checkedParent.identity)) deny("PATH_IDENTITY_CHANGED");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);

      const created: CreatedObject[] = [];
      let currentParent = nearestParent;
      let expectedCurrentParent = checkedParent.identity;
      try {
        for (const component of missing) {
          await this.#barrier("beforeCreateSegment", state.operationId);
          this.#assertActive(record);
          await this.#verifyRoot(record, selected.root, state);
          await this.#walkNoRedirect(selected.root, currentParent);
          const currentParentNow = await this.#lstatIdentity(currentParent, "directory");
          if (!sameIdentity(currentParentNow, expectedCurrentParent)) deny("PATH_IDENTITY_CHANGED");
          currentParent = this.#join(currentParent, component);
          this.#assertActive(record);
          await fs.mkdir(currentParent).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") deny("PATH_IDENTITY_CHANGED");
            deny("PATH_OPERATION_DENIED");
          });
          created.push({ target: currentParent, identity: null });
          const createdDirectory = await this.#lstatIdentity(currentParent, "directory");
          created[created.length - 1] = { target: currentParent, identity: createdDirectory };
          expectedCurrentParent = createdDirectory;
          const createdCanonical = this.#normalizeAbsolute(await this.#realpathOrDeny(currentParent));
          const createdRoot = this.#selectCanonicalRoot(record, createdCanonical, request.operation);
          if (createdRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
        }

        await this.#barrier("beforeFinalCreate", state.operationId);
        this.#assertActive(record);
        await this.#verifyRoot(record, selected.root, state);
        await this.#walkNoRedirect(selected.root, currentParent);
        const parentNow = await this.#lstatIdentity(currentParent, "directory");
        const expectedParent = created.at(-1)?.identity ?? nearestIdentity;
        if (!expectedParent || !sameIdentity(parentNow, expectedParent)) deny("PATH_IDENTITY_CHANGED");
        this.#assertActive(record);

        const handle = await fs.open(selected.lexicalTarget, "wx").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") {
            if (expectedMissingParent) deny("PATH_IDENTITY_CHANGED");
            throw new PathTargetExistsError();
          }
          deny("PATH_OPERATION_DENIED");
        });
        this.#markOperationHandleOpened(state);
        let fileIdentity: ObjectIdentity;
        created.push({ target: selected.lexicalTarget, identity: null });
        try {
          const opened = await handle.stat({ bigint: true });
          fileIdentity = identityFromStat(opened);
          if (fileIdentity.type !== "file") deny("PATH_TYPE_MISMATCH");
          created[created.length - 1] = { target: selected.lexicalTarget, identity: fileIdentity };
          const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
          const finalRoot = this.#selectCanonicalRoot(record, canonicalTarget, request.operation);
          if (finalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
          await this.#barrier("afterHandleOpen", state.operationId);
          this.#assertActive(record);
          await this.#verifyRoot(record, selected.root, state);
          await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
          const pathIdentity = await this.#lstatIdentity(selected.lexicalTarget, "file");
          if (!sameIdentity(pathIdentity, fileIdentity)) deny("PATH_IDENTITY_CHANGED");
          this.#assertActive(record);
          await handle.writeFile(copiedBytes);
          await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
        return Object.freeze({
          rootId: selected.root.rootId,
          identity: fileIdentity,
          bytesWritten: copiedBytes.length,
          createdDirectories: missing.length,
        });
      } catch (error) {
        if (created.length > 0) await this.#rollbackCreated(created);
        throw error;
      }
    });
  }

  async replaceFile<T>(
    authority: PathAuthority,
    request: PathRequest,
    transform: (bytes: Buffer) => PathTransformResult<T> | Promise<PathTransformResult<T>>,
    maxBytes = 64 * 1024 * 1024
  ): Promise<PathReplaceResult<T>> {
    return this.#replaceFileInternal(authority, request, transform, maxBytes);
  }

  async #replaceFileInternal<T>(
    authority: PathAuthority,
    request: PathRequest,
    transform: (bytes: Buffer) => PathTransformResult<T> | Promise<PathTransformResult<T>>,
    maxBytes: number,
    expectedExisting?: Readonly<{ identity: ObjectIdentity; snapshot: MutableSnapshot }>
  ): Promise<PathReplaceResult<T>> {
    if (typeof transform !== "function") throw new TypeError("replaceFile transform is invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
    return this.#run(authority, request, async (record, state) => {
      if (request.operation !== "replace-file") deny("PATH_OPERATION_DENIED");
      const selected = this.#selectTarget(record, request);
      state.rootId = selected.root.rootId;
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      await this.#barrier("afterLexicalContainment", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      const canonicalTarget = this.#normalizeAbsolute(await this.#realpathOrDeny(selected.lexicalTarget));
      const canonicalRoot = this.#selectCanonicalRoot(record, canonicalTarget, "replace-file");
      if (canonicalRoot.rootId !== selected.root.rootId) deny("PATH_ROOT_DENIED");
      const before = await this.#statIdentity(canonicalTarget, "file");
      if (expectedExisting
        && (!sameIdentity(expectedExisting.identity, before.identity)
          || !sameSnapshot(expectedExisting.snapshot, before.snapshot))) {
        deny("PATH_IDENTITY_CHANGED");
      }
      if (before.snapshot.linkCount !== "1") deny("PATH_REDIRECT_DENIED");
      await this.#barrier("afterCanonicalValidation", state.operationId);
      this.#assertActive(record);
      await this.#verifyRoot(record, selected.root, state);
      await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
      const pathIdentity = await this.#lstatIdentity(selected.lexicalTarget, "file");
      if (!sameIdentity(pathIdentity, before.identity)) deny("PATH_IDENTITY_CHANGED");
      this.#assertActive(record);
      const handle = await fs.open(canonicalTarget, "r+").catch(() => deny("PATH_NOT_FOUND"));
      this.#markOperationHandleOpened(state);
      try {
        const openedInfo = await handle.stat({ bigint: true });
        const opened = identityFromStat(openedInfo);
        const openedSnapshot = mutableSnapshot(openedInfo);
        if (!sameIdentity(before.identity, opened) || !sameSnapshot(before.snapshot, openedSnapshot)) deny("PATH_IDENTITY_CHANGED");
        if (String(openedInfo.nlink) !== "1") deny("PATH_REDIRECT_DENIED");
        await this.#barrier("afterHandleOpen", state.operationId);
        this.#assertActive(record);
        await this.#verifyRoot(record, selected.root, state);
        await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
        const rechecked = await this.#lstatIdentity(selected.lexicalTarget, "file");
        if (!sameIdentity(rechecked, opened)) deny("PATH_IDENTITY_CHANGED");

        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > maxBytes) deny("PATH_OPERATION_DENIED");
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const transformed = await transform(Buffer.concat(chunks, total));
        if (!transformed || !(transformed.bytes === null || transformed.bytes instanceof Uint8Array)) {
          throw new TypeError("replaceFile transform result is invalid");
        }
        const afterTransformInfo = await handle.stat({ bigint: true });
        if (!sameIdentity(identityFromStat(afterTransformInfo), opened)
          || String(afterTransformInfo.nlink) !== "1"
          || !sameSnapshot(mutableSnapshot(afterTransformInfo), openedSnapshot)) {
          deny("PATH_IDENTITY_CHANGED");
        }
        if (transformed.bytes === null) {
          return Object.freeze({ rootId: selected.root.rootId, identity: opened, bytesWritten: 0, value: transformed.value });
        }
        if (transformed.bytes.byteLength > maxBytes) deny("PATH_OPERATION_DENIED");
        const output = Buffer.from(transformed.bytes);
        this.#assertActive(record);
        await this.#verifyRoot(record, selected.root, state);
        await this.#walkNoRedirect(selected.root, selected.lexicalTarget);
        const beforeWrite = await this.#lstatIdentity(selected.lexicalTarget, "file");
        if (!sameIdentity(beforeWrite, opened)) deny("PATH_IDENTITY_CHANGED");
        const handleBeforeWrite = await handle.stat({ bigint: true });
        if (!sameIdentity(identityFromStat(handleBeforeWrite), opened)
          || String(handleBeforeWrite.nlink) !== "1"
          || !sameSnapshot(mutableSnapshot(handleBeforeWrite), openedSnapshot)) {
          deny("PATH_IDENTITY_CHANGED");
        }
        await handle.truncate(0);
        let written = 0;
        while (written < output.length) {
          const result = await handle.write(output, written, output.length - written, written);
          if (result.bytesWritten < 1) deny("PATH_OPERATION_DENIED");
          written += result.bytesWritten;
        }
        await handle.sync();
        return Object.freeze({ rootId: selected.root.rootId, identity: opened, bytesWritten: output.length, value: transformed.value });
      } finally {
        await handle.close().catch(() => undefined);
      }
    });
  }

  async #deliverFailureAudit(
    failure: PathDeniedError,
    details: Readonly<{
      operationId: string;
      rawInput: string;
      operation: PathOperation;
      rootId: string | null;
      auditIdentity?: PathAuditIdentity;
      authorityEpoch: number | null;
    }>
  ): Promise<void> {
    const event: PathAuditEvent = Object.freeze({
      event: failure.primaryCode === "PATH_ROLLBACK_FAILED" ? "path-policy-rollback-failed" : "path-policy-denied",
      operationId: details.operationId,
      code: failure.primaryCode,
      operation: details.operation,
      inputFingerprint: createHmac("sha256", this.#auditKey).update(details.rawInput).digest("hex"),
      rootId: details.rootId,
      sessionId: details.auditIdentity?.sessionId ?? null,
      runId: details.auditIdentity?.runId ?? null,
      principal: details.auditIdentity?.principal ?? "internal",
      authorityEpoch: details.authorityEpoch,
      timestamp: new Date(this.#now()).toISOString(),
    });
    try {
      await this.#auditSink(event);
    } catch {
      if (failure.primaryCode === "PATH_ROLLBACK_FAILED" || failure.primaryCode === "PATH_LIFECYCLE_FAILED") {
        throw new PathDeniedError(failure.primaryCode, safeMessage(failure.primaryCode), {
          primaryCode: failure.primaryCode,
          auditDeliveryFailed: true,
        });
      }
      throw new PathDeniedError("PATH_AUDIT_FAILED", safeMessage("PATH_AUDIT_FAILED"), {
        primaryCode: failure.primaryCode,
        auditDeliveryFailed: true,
      });
    }
  }

  async #run<T>(
    authority: PathAuthority,
    request: PathRequest,
    operation: (record: AuthorityRecord, state: OperationState) => Promise<T>
  ): Promise<T> {
    const state: OperationState = { operationId: randomUUID(), rootId: null, lease: null };
    const rawInput = typeof request?.input === "string" ? request.input : "";
    let record: AuthorityRecord | undefined;
    let operationLease: OperationLeaseRecord | null = null;
    try {
      record = this.#authorities.get(authority);
      if (!record) deny(authority ? "PATH_AUTHORITY_FORGED" : "PATH_AUTHORITY_REQUIRED");
      if (!record.active) deny("PATH_AUTHORITY_STALE");
      if (!request || !operations.has(request.operation)) deny("PATH_OPERATION_DENIED");
      validatePathSyntax(request.input, this.#platform);
      if (request.requiredExtension !== undefined) {
        if (!/^\.[a-z0-9]{1,16}$/u.test(request.requiredExtension)) throw new TypeError("requiredExtension is invalid");
        const extension = (this.#platform === "win32" ? path.win32.extname(request.input) : path.extname(request.input)).toLowerCase();
        if (extension !== request.requiredExtension) deny("PATH_INPUT_INVALID");
      }
      operationLease = {
        operationId: state.operationId,
        authorityId: record.authority.authorityId,
        authorityEpoch: record.authority.epoch,
        sessionId: request.auditIdentity?.sessionId ?? null,
        principal: request.auditIdentity?.principal ?? "system",
        operation: request.operation,
        rootId: null,
        rootIdentity: null,
        state: "issued",
        openedHandles: 0,
      };
      record.operationLeases.add(operationLease);
      state.lease = operationLease;
      return await operation(record, state);
    } catch (error) {
      if (error instanceof PathTargetExistsError) throw error;
      const failure = error instanceof PathDeniedError
        ? error
        : new PathDeniedError("PATH_OPERATION_DENIED", safeMessage("PATH_OPERATION_DENIED"));
      await this.#deliverFailureAudit(failure, {
        operationId: state.operationId,
        rawInput,
        operation: request?.operation ?? "read-file",
        rootId: state.rootId,
        auditIdentity: request?.auditIdentity,
        authorityEpoch: record?.authority.epoch ?? null,
      });
      throw failure;
    } finally {
      if (operationLease) {
        operationLease.state = "closed";
        record?.operationLeases.delete(operationLease);
      }
    }
  }

  #selectTarget(record: AuthorityRecord, request: PathRequest): SelectedTarget {
    let target: string;
    if (this.#isAbsolute(request.input)) {
      target = this.#normalizeAbsolute(request.input);
    } else {
      if (!request.defaultRootId) deny("PATH_ROOT_DENIED");
      const defaultRoot = record.roots.find((root) => root.rootId === request.defaultRootId);
      if (!defaultRoot || defaultRoot.exclusionOnly) deny("PATH_ROOT_DENIED");
      target = this.#resolve(defaultRoot.lexicalPath, request.input);
    }
    const lexicalRoot = this.#mostSpecificRoot(record.roots, target, "lexicalPath");
    const canonicalRoot = this.#mostSpecificRoot(record.roots, target, "canonicalPath");
    let root = lexicalRoot ?? canonicalRoot;
    if (lexicalRoot && canonicalRoot && lexicalRoot.rootId !== canonicalRoot.rootId) {
      if (this.#contains(lexicalRoot.lexicalPath, canonicalRoot.canonicalPath)) root = canonicalRoot;
      else if (this.#contains(canonicalRoot.canonicalPath, lexicalRoot.lexicalPath)) root = lexicalRoot;
      else deny("PATH_ROOT_DENIED");
    }
    if (!root || root.exclusionOnly || !root.permissions.has(request.operation)) deny("PATH_ROOT_DENIED");
    return { root, lexicalTarget: target };
  }

  #selectCanonicalRoot(record: AuthorityRecord, target: string, operation: PathOperation): CanonicalRootRecord {
    const root = this.#mostSpecificRoot(record.roots, target, "canonicalPath");
    if (!root || root.exclusionOnly || !root.permissions.has(operation)) deny("PATH_ROOT_DENIED");
    return root;
  }

  #mostSpecificRoot(
    roots: readonly CanonicalRootRecord[],
    target: string,
    key: "lexicalPath" | "canonicalPath"
  ): CanonicalRootRecord | null {
    if (this.#platform === "win32") {
      const rootId = selectMostSpecificWindowsRoot(
        roots.map((root) => ({ rootId: root.rootId, rootPath: root[key] })),
        target
      );
      return rootId ? roots.find((root) => root.rootId === rootId) ?? null : null;
    }
    const matches = roots.filter((root) => this.#contains(root[key], target));
    matches.sort((left, right) => right[key].length - left[key].length || left.rootId.localeCompare(right.rootId));
    return matches[0] ?? null;
  }

  #revokeRecord(record: AuthorityRecord): void {
    if (!record.active) return;
    record.active = false;
    for (const child of [...record.children]) {
      const childRecord = this.#authorities.get(child);
      if (childRecord) this.#revokeRecord(childRecord);
    }
    record.children.clear();
    record.parent?.children.delete(record.authority);
  }

  #assertActive(record: AuthorityRecord): void {
    if (!record.active || (record.parent && !record.parent.active)) deny("PATH_AUTHORITY_STALE");
  }

  #markOperationHandleOpened(state: OperationState): void {
    const lease = state.lease;
    if (!lease || lease.state !== "issued" || !lease.rootId || !lease.rootIdentity) deny("PATH_OPERATION_DENIED");
    lease.state = "opened";
    lease.openedHandles += 1;
  }

  async #probeDirectoryIdentity(target: string): Promise<ObjectIdentity> {
    const handle = await fs.open(target, "r").catch(() => deny("PATH_ROOT_UNSUPPORTED"));
    try {
      const identity = identityFromStat(await handle.stat({ bigint: true }));
      if (identity.type !== "directory") deny("PATH_ROOT_UNSUPPORTED");
      return identity;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #walkConfiguredRootNoRedirect(lexicalRoot: string): Promise<void> {
    const pathApi = this.#platform === "win32" ? path.win32 : path;
    const parsedRoot = pathApi.parse(lexicalRoot).root;
    if (!parsedRoot) deny("PATH_INPUT_INVALID");
    const relative = pathApi.relative(parsedRoot, lexicalRoot);
    const components = relative.split(pathApi.sep).filter(Boolean);
    let current = parsedRoot;
    let deviceId: string | null = null;
    for (const component of ["", ...components]) {
      if (component) current = pathApi.join(current, component);
      const info = await fs.lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT"
          || (component === "" && this.#platform === "win32" && ["UNKNOWN", "ENODEV", "ENXIO"].includes(error.code ?? ""))) {
          deny("PATH_ROOT_UNAVAILABLE");
        }
        deny("PATH_ROOT_UNSUPPORTED");
      });
      if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
      const identity = identityFromStat(info);
      if (identity.type !== "directory") deny("PATH_ROOT_UNSUPPORTED");
      if (deviceId !== null && identity.deviceId !== deviceId) deny("PATH_ROOT_UNSUPPORTED");
      deviceId = identity.deviceId;
    }
  }

  async #verifyRoot(record: AuthorityRecord, root: CanonicalRootRecord, state: OperationState): Promise<void> {
    const lease = state.lease;
    if (!lease) deny("PATH_OPERATION_DENIED");
    if (lease.rootId === null) {
      lease.rootId = root.rootId;
      lease.rootIdentity = root.identity;
      await this.#barrier("afterOperationLeaseIssued", state.operationId);
      this.#assertActive(record);
    } else if (lease.rootId !== root.rootId || !lease.rootIdentity || !sameIdentity(lease.rootIdentity, root.identity)) {
      deny("PATH_IDENTITY_CHANGED");
    }
    try {
      const current = await this.#statIdentity(root.canonicalPath, "directory");
      if (!sameIdentity(root.identity, current.identity)) deny("PATH_IDENTITY_CHANGED");
    } catch (error) {
      if (error instanceof PathDeniedError) {
        let ancestor = record;
        while (ancestor.parent) ancestor = ancestor.parent;
        this.#revokeRecord(ancestor);
      }
      throw error;
    }
  }

  async #walkNoRedirect(root: CanonicalRootRecord, lexicalTarget: string): Promise<void> {
    const trustedRoot = [root.lexicalPath, root.canonicalPath]
      .filter((candidate, index, values) => values.findIndex((value) => this.#samePath(value, candidate)) === index)
      .filter((candidate) => this.#contains(candidate, lexicalTarget))
      .sort((left, right) => right.length - left.length)[0];
    if (!trustedRoot) deny("PATH_ROOT_DENIED");
    const relative = this.#relative(trustedRoot, lexicalTarget);
    if (relative === "") return;
    const components = relative.split(this.#separator()).filter(Boolean);
    if (this.#isAbsolute(relative) || components.some((component) => component === "." || component === "..")) {
      deny("PATH_ROOT_DENIED");
    }
    let current = trustedRoot;
    for (const component of components) {
      current = this.#join(current, component);
      const info = await fs.lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") deny("PATH_NOT_FOUND");
        deny("PATH_OPERATION_DENIED");
      });
      if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
      if (String(info.dev) !== root.identity.deviceId) deny("PATH_REDIRECT_DENIED");
    }
  }

  async #statIdentity(target: string, expected?: "file" | "directory"): Promise<{ identity: ObjectIdentity; snapshot: MutableSnapshot }> {
    const info = await fs.stat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") deny("PATH_NOT_FOUND");
      deny("PATH_OPERATION_DENIED");
    });
    const identity = identityFromStat(info);
    if (expected && identity.type !== expected) deny("PATH_TYPE_MISMATCH");
    return { identity, snapshot: mutableSnapshot(info) };
  }

  async #lstatIdentity(target: string, expected?: "file" | "directory"): Promise<ObjectIdentity> {
    const info = await fs.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") deny("PATH_NOT_FOUND");
      deny("PATH_OPERATION_DENIED");
    });
    if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED");
    const identity = identityFromStat(info);
    if (expected && identity.type !== expected) deny("PATH_TYPE_MISMATCH");
    return identity;
  }

  async #rollbackCreated(created: readonly CreatedObject[]): Promise<void> {
    for (const entry of [...created].reverse()) {
      let current: ObjectIdentity;
      try {
        const info = await fs.lstat(entry.target, { bigint: true });
        if (info.isSymbolicLink()) deny("PATH_ROLLBACK_FAILED");
        current = identityFromStat(info);
      } catch (error) {
        if (error instanceof PathDeniedError && error.code === "PATH_ROLLBACK_FAILED") throw error;
        deny("PATH_ROLLBACK_FAILED");
      }
      if (!entry.identity || !sameIdentity(current, entry.identity)) deny("PATH_ROLLBACK_FAILED");
      try {
        if (entry.identity.type === "directory") await fs.rmdir(entry.target);
        else await fs.unlink(entry.target);
      } catch {
        deny("PATH_ROLLBACK_FAILED");
      }
      try {
        await fs.lstat(entry.target);
        deny("PATH_ROLLBACK_FAILED");
      } catch (error) {
        if (error instanceof PathDeniedError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") deny("PATH_ROLLBACK_FAILED");
      }
    }
  }

  async #realpathOrDeny(target: string): Promise<string> {
    return fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") deny("PATH_NOT_FOUND");
      deny("PATH_OPERATION_DENIED");
    });
  }

  #dirname(value: string): string {
    return this.#platform === "win32" ? path.win32.dirname(value) : path.dirname(value);
  }

  #basename(value: string): string {
    return this.#platform === "win32" ? path.win32.basename(value) : path.basename(value);
  }

  #contains(root: string, target: string): boolean {
    if (this.#platform === "win32") return containsWindows(root, target);
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  #samePath(left: string, right: string): boolean {
    return this.#platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  #normalizeAbsolute(value: string): string {
    return this.#platform === "win32" ? normalizeWindows(value) : path.normalize(value);
  }

  #isAbsolute(value: string): boolean {
    return this.#platform === "win32" ? path.win32.isAbsolute(value.replaceAll("/", "\\")) : path.isAbsolute(value);
  }

  #resolve(root: string, value: string): string {
    return this.#platform === "win32" ? path.win32.resolve(root, value.replaceAll("/", "\\")) : path.resolve(root, value);
  }

  #relative(root: string, target: string): string {
    return this.#platform === "win32" ? path.win32.relative(root, target) : path.relative(root, target);
  }

  #join(root: string, child: string): string {
    return this.#platform === "win32" ? path.win32.join(root, child) : path.join(root, child);
  }

  #separator(): string {
    return this.#platform === "win32" ? path.win32.sep : path.sep;
  }
}
