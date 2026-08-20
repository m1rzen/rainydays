import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getBootstrapPathStore, type BootstrapDatabaseFileLease } from "./bootstrap-path-store.js";
import { acquireManagedRestoreLock, hasPendingManagedRestore, recoverPendingManagedRestore } from "./managed-restore.js";
import { PathDeniedError } from "./path-policy.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export type BootstrapDatabase = any;

export interface DatabaseSnapshotValidation {
  readonly schemaVersion: number;
  readonly quickCheck: "ok";
  readonly integrityCheck: "ok";
  readonly foreignKeyViolations: 0;
}

export interface BootstrapDatabaseConnection {
  readonly database: BootstrapDatabase;
  readonly probedVersion: number;
  readonly close: () => Promise<void>;
}

const SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);

interface SyncIdentity {
  readonly deviceId: string;
  readonly objectId: string;
  readonly type: "file" | "directory";
  readonly linkCount: string;
}

function identity(info: fs.BigIntStats): SyncIdentity {
  return Object.freeze({
    deviceId: String(info.dev),
    objectId: String(info.ino),
    type: info.isFile() ? "file" : "directory",
    linkCount: String(info.nlink),
  });
}

function sameIdentity(left: SyncIdentity, right: SyncIdentity): boolean {
  return left.deviceId === right.deviceId
    && left.objectId === right.objectId
    && left.type === right.type
    && left.linkCount === right.linkCount;
}

function denyDatabase(code: "PATH_REDIRECT_DENIED" | "PATH_IDENTITY_CHANGED" | "PATH_AUTHORITY_STALE"): never {
  throw new PathDeniedError(code, "Database bootstrap identity is no longer valid");
}

function inspectExactPath(candidate: string, expectedType: "file" | "directory"): { canonical: string; identity: SyncIdentity } {
  const lexical = fs.lstatSync(candidate, { bigint: true });
  if (lexical.isSymbolicLink()) denyDatabase("PATH_REDIRECT_DENIED");
  const canonical = fs.realpathSync(candidate);
  const canonicalInfo = fs.statSync(canonical, { bigint: true });
  const lexicalIdentity = identity(lexical);
  const canonicalIdentity = identity(canonicalInfo);
  if (lexicalIdentity.type !== expectedType
    || canonicalIdentity.type !== expectedType
    || !sameIdentity(lexicalIdentity, canonicalIdentity)
    || (expectedType === "file" && lexicalIdentity.linkCount !== "1")) {
    denyDatabase("PATH_IDENTITY_CHANGED");
  }
  return Object.freeze({ canonical, identity: canonicalIdentity });
}

class SqlitePathGuard {
  readonly #databasePath: string;
  readonly #databaseName: string;
  readonly #directoryPath: string;
  readonly #directoryIdentity: SyncIdentity;
  readonly #databaseIdentity: SyncIdentity;
  readonly #sidecarIdentities = new Map<string, SyncIdentity>();
  #closed = false;
  #poisoned = false;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
    this.#databaseName = path.basename(databasePath);
    this.#directoryPath = path.dirname(databasePath);
    const directory = inspectExactPath(this.#directoryPath, "directory");
    const database = inspectExactPath(this.#databasePath, "file");
    if (directory.canonical !== this.#directoryPath || database.canonical !== this.#databasePath) {
      denyDatabase("PATH_IDENTITY_CHANGED");
    }
    this.#directoryIdentity = directory.identity;
    this.#databaseIdentity = database.identity;
    this.assertCurrent();
  }

  assertCurrent(): void {
    if (this.#closed || this.#poisoned) denyDatabase("PATH_AUTHORITY_STALE");
    try {
      const directory = inspectExactPath(this.#directoryPath, "directory");
      const database = inspectExactPath(this.#databasePath, "file");
      if (directory.canonical !== this.#directoryPath
        || database.canonical !== this.#databasePath
        || !sameIdentity(this.#directoryIdentity, directory.identity)
        || !sameIdentity(this.#databaseIdentity, database.identity)) {
        denyDatabase("PATH_IDENTITY_CHANGED");
      }

      const allowedSidecars = new Set(SIDECAR_SUFFIXES.map(suffix => `${this.#databaseName}${suffix}`));
      for (const name of fs.readdirSync(this.#directoryPath)) {
        if (name.startsWith(`${this.#databaseName}-`) && !allowedSidecars.has(name)) {
          denyDatabase("PATH_IDENTITY_CHANGED");
        }
      }
      for (const suffix of SIDECAR_SUFFIXES) {
        const name = `${this.#databaseName}${suffix}`;
        const sidecarPath = path.join(this.#directoryPath, name);
        if (!fs.existsSync(sidecarPath)) {
          this.#sidecarIdentities.delete(name);
          continue;
        }
        const sidecar = inspectExactPath(sidecarPath, "file");
        if (sidecar.canonical !== sidecarPath) denyDatabase("PATH_IDENTITY_CHANGED");
        const previous = this.#sidecarIdentities.get(name);
        if (previous && !sameIdentity(previous, sidecar.identity)) denyDatabase("PATH_IDENTITY_CHANGED");
        if (!previous) this.#sidecarIdentities.set(name, sidecar.identity);
      }
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }

  markClosed(): void {
    this.#closed = true;
  }
}

function guardedCall<T>(guard: SqlitePathGuard, action: () => T): T {
  guard.assertCurrent();
  let result: T;
  try {
    result = action();
  } catch (error) {
    guard.assertCurrent();
    throw error;
  }
  if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
    return Promise.resolve(result).then(value => {
      guard.assertCurrent();
      return value;
    }, error => {
      guard.assertCurrent();
      throw error;
    }) as T;
  }
  guard.assertCurrent();
  return result;
}

function guardDatabaseObject<T extends object>(target: T, guard: SqlitePathGuard, cache: WeakMap<object, object>): T {
  const existing = cache.get(target);
  if (existing) return existing as T;
  const wrapReturned = (returned: unknown): unknown => {
    if (returned && typeof (returned as PromiseLike<unknown>).then === "function") return returned;
    if ((typeof returned === "object" && returned !== null) || typeof returned === "function") {
      return guardDatabaseObject(returned as object, guard, cache);
    }
    return returned;
  };
  const proxy = new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current);
      if (typeof value !== "function") return value;
      if (property === "close") {
        return () => { throw new Error("Database close must release the bootstrap lease"); };
      }
      return (...args: unknown[]) => guardedCall(guard, () => wrapReturned(Reflect.apply(value, current, args)));
    },
    apply(current, thisArg, args) {
      return guardedCall(guard, () => wrapReturned(Reflect.apply(current as (...values: unknown[]) => unknown, thisArg, args)));
    },
  });
  cache.set(target, proxy);
  return proxy;
}

function updateWalChecksum(
  bytes: Buffer,
  littleEndian: boolean,
  seed: Readonly<{ first: number; second: number }>
): Readonly<{ first: number; second: number }> {
  if (bytes.length % 8 !== 0) throw new Error("SQLite WAL checksum input is invalid");
  let first = seed.first >>> 0;
  let second = seed.second >>> 0;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const left = littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const right = littleEndian ? bytes.readUInt32LE(offset + 4) : bytes.readUInt32BE(offset + 4);
    first = (first + left + second) >>> 0;
    second = (second + right + first) >>> 0;
  }
  return Object.freeze({ first, second });
}

function readExact(descriptor: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0) throw new Error("SQLite WAL is truncated");
    offset += count;
  }
}

function validateWalFile(walPath: string): void {
  const info = fs.lstatSync(walPath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SQLite WAL identity or size is invalid");
  }
  if (info.size === 0n) return;
  if (info.size < 32n) throw new Error("SQLite WAL is truncated");
  const descriptor = fs.openSync(walPath, "r");
  try {
    const header = Buffer.alloc(32);
    readExact(descriptor, header, 0);
    const magic = header.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error("SQLite WAL magic is invalid");
    if (header.readUInt32BE(4) !== 3_007_000) throw new Error("SQLite WAL format version is invalid");
    const encodedPageSize = header.readUInt32BE(8);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error("SQLite WAL page size is invalid");
    }
    const frameSize = 24 + pageSize;
    const fileSize = Number(info.size);
    if ((fileSize - header.length) % frameSize !== 0) throw new Error("SQLite WAL frame length is invalid");
    const littleEndian = magic === 0x377f0682;
    let checksum = updateWalChecksum(header.subarray(0, 24), littleEndian, { first: 0, second: 0 });
    if (checksum.first !== header.readUInt32BE(24) || checksum.second !== header.readUInt32BE(28)) {
      throw new Error("SQLite WAL header checksum is invalid");
    }
    const saltFirst = header.readUInt32BE(16);
    const saltSecond = header.readUInt32BE(20);
    const frame = Buffer.alloc(frameSize);
    for (let position = header.length; position < fileSize; position += frameSize) {
      readExact(descriptor, frame, position);
      if (frame.readUInt32BE(0) === 0
        || frame.readUInt32BE(8) !== saltFirst
        || frame.readUInt32BE(12) !== saltSecond) {
        throw new Error("SQLite WAL frame identity is invalid");
      }
      checksum = updateWalChecksum(frame.subarray(0, 8), littleEndian, checksum);
      checksum = updateWalChecksum(frame.subarray(24), littleEndian, checksum);
      if (checksum.first !== frame.readUInt32BE(16) || checksum.second !== frame.readUInt32BE(20)) {
        throw new Error("SQLite WAL frame checksum is invalid");
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readHeader(databasePath: string): Buffer {
  const descriptor = fs.openSync(databasePath, "r");
  try {
    const header = Buffer.alloc(100);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead === 0) return Buffer.alloc(0);
    if (bytesRead < 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
      throw new Error("数据库文件头无效");
    }
    return header;
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeProbeFiles(probeDirectory: string, expectedNames: ReadonlySet<string>): void {
  const entries = fs.readdirSync(probeDirectory);
  for (const name of entries) {
    if (!expectedNames.has(name)) throw new Error("数据库版本探测产生了未授权临时文件");
    const target = path.join(probeDirectory, name);
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("数据库版本探测临时对象类型无效");
  }
  for (const name of entries) fs.unlinkSync(path.join(probeDirectory, name));
}

async function existingVersionWithoutMutation(databasePath: string): Promise<number> {
  const header = readHeader(databasePath);
  if (header.length === 0) return 0;

  const suffixes = SIDECAR_SUFFIXES.filter(suffix => fs.existsSync(`${databasePath}${suffix}`));
  if (suffixes.length === 0) return header.readUInt32BE(60);
  if (suffixes.includes("-wal")) validateWalFile(`${databasePath}-wal`);

  const store = getBootstrapPathStore();
  return store.withTemporaryDirectory("mini-lux-db-probe", async probeDirectory => {
    const databaseName = "mini-lux.db";
    const expectedNames = new Set([databaseName, ...suffixes.map(suffix => `${databaseName}${suffix}`)]);
    const probePath = path.join(probeDirectory, databaseName);
    try {
      fs.copyFileSync(databasePath, probePath, fs.constants.COPYFILE_EXCL);
      for (const suffix of suffixes) {
        fs.copyFileSync(`${databasePath}${suffix}`, `${probePath}${suffix}`, fs.constants.COPYFILE_EXCL);
      }
      const probe = new Database(probePath);
      try {
        return Number(probe.pragma("user_version", { simple: true }));
      } finally {
        probe.close();
      }
    } finally {
      removeProbeFiles(probeDirectory, expectedNames);
    }
  });
}

async function closeFailedLease(lease: BootstrapDatabaseFileLease, database: BootstrapDatabase | null): Promise<void> {
  try { database?.close(); } catch {}
  await lease.close();
}

let managedRestoreRecovery: Promise<void> | null = null;

async function ensureManagedRestoreRecovered(): Promise<void> {
  if (managedRestoreRecovery) return managedRestoreRecovery;
  const recovery = (async () => {
    if (await hasPendingManagedRestore()) {
      const { createBackupDataKeyWrapper } = await import("./credential-store.js");
      await recoverPendingManagedRestore(createBackupDataKeyWrapper(), () => undefined, true);
    } else {
      await recoverPendingManagedRestore(undefined, () => undefined, true);
    }
    if (await hasPendingManagedRestore()) throw new Error("Managed restore recovery did not clear the pending journal");
  })();
  managedRestoreRecovery = recovery;
  try { await recovery; }
  finally { if (managedRestoreRecovery === recovery) managedRestoreRecovery = null; }
}

export async function openBootstrapDatabase(maximumSchemaVersion: number): Promise<BootstrapDatabaseConnection> {
  if (!Number.isSafeInteger(maximumSchemaVersion) || maximumSchemaVersion < 0) {
    throw new TypeError("Maximum database schema version is invalid");
  }
  const releaseRestoreLock = await acquireManagedRestoreLock();
  let lease: BootstrapDatabaseFileLease | null = null;
  let database: BootstrapDatabase | null = null;
  try {
    await ensureManagedRestoreRecovered();
    lease = await getBootstrapPathStore().openDatabaseFileLease();
    const activeLease = lease;
    await activeLease.assertPathCurrent();
    const probedVersion = await existingVersionWithoutMutation(activeLease.canonicalPath);
    if (!Number.isInteger(probedVersion) || probedVersion < 0) throw new Error(`数据库 Schema 版本无效: ${probedVersion}`);
    if (probedVersion > maximumSchemaVersion) {
      throw new Error(`数据库 Schema 版本不兼容: 当前 ${probedVersion}，本应用最多支持 ${maximumSchemaVersion}`);
    }
    const guard = new SqlitePathGuard(activeLease.canonicalPath);
    database = new Database(activeLease.canonicalPath);
    guard.assertCurrent();
    const guarded = guardDatabaseObject(database, guard, new WeakMap());
    guarded.pragma("foreign_keys = ON");
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      let pathFailure: unknown = null;
      let closeFailure: unknown = null;
      try {
        guard.assertCurrent();
        await activeLease.assertPathCurrent();
      } catch (error) {
        pathFailure = error;
      }
      try {
        database.close();
      } catch (error) {
        closeFailure = error;
      }
      guard.markClosed();
      closed = true;
      let leaseFailure: unknown = null;
      try {
        await activeLease.close();
      } catch (error) {
        leaseFailure = error;
      }
      let lockFailure: unknown = null;
      try { await releaseRestoreLock(); }
      catch (error) { lockFailure = error; }
      if (leaseFailure) throw leaseFailure;
      if (lockFailure) throw lockFailure;
      if (pathFailure) throw pathFailure;
      if (closeFailure) throw closeFailure;
    };
    return Object.freeze({ database: guarded, probedVersion, close });
  } catch (error) {
    let cleanupError: unknown = null;
    try { if (lease) await closeFailedLease(lease, database); }
    catch (failure) { cleanupError = failure; }
    try { await releaseRestoreLock(); }
    catch (failure) { cleanupError = cleanupError ?? failure; }
    if (cleanupError) throw new AggregateError([error, cleanupError], "Database bootstrap failed and restore lock cleanup failed");
    throw error;
  }
}

export async function writeConsistentDatabaseSnapshot(database: BootstrapDatabase, destination: string): Promise<void> {
  if (!database || typeof database.backup !== "function") throw new TypeError("Database snapshot source is invalid");
  if (typeof destination !== "string" || !path.isAbsolute(destination)) throw new TypeError("Database snapshot destination is invalid");
  const before = inspectExactPath(destination, "file");
  if (before.canonical !== destination || before.identity.linkCount !== "1" || fs.statSync(destination).size !== 0) {
    denyDatabase("PATH_IDENTITY_CHANGED");
  }
  for (const suffix of SIDECAR_SUFFIXES) if (fs.existsSync(`${destination}${suffix}`)) denyDatabase("PATH_IDENTITY_CHANGED");

  await database.backup(destination);
  const backedUp = inspectExactPath(destination, "file");
  if (!sameIdentity(before.identity, backedUp.identity)) denyDatabase("PATH_IDENTITY_CHANGED");

  const standalone = new Database(destination);
  try {
    const mode = String(standalone.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
    if (mode !== "delete") throw new Error("Database snapshot could not be sealed as a standalone file");
  } finally {
    standalone.close();
  }
  const completed = inspectExactPath(destination, "file");
  if (!sameIdentity(before.identity, completed.identity)) denyDatabase("PATH_IDENTITY_CHANGED");
  for (const suffix of SIDECAR_SUFFIXES) if (fs.existsSync(`${destination}${suffix}`)) denyDatabase("PATH_IDENTITY_CHANGED");
}

function checkRows(database: BootstrapDatabase, pragma: "quick_check" | "integrity_check"): void {
  const rows = database.pragma(pragma) as Array<{ [key: string]: unknown }>;
  if (!Array.isArray(rows) || rows.length !== 1 || Object.values(rows[0]).length !== 1 || Object.values(rows[0])[0] !== "ok") {
    throw new Error(`Database snapshot ${pragma} failed`);
  }
}

export function validateDatabaseSnapshotFile(databasePath: string, maximumSchemaVersion: number): DatabaseSnapshotValidation {
  if (typeof databasePath !== "string" || !path.isAbsolute(databasePath)) throw new TypeError("Database snapshot path is invalid");
  if (!Number.isSafeInteger(maximumSchemaVersion) || maximumSchemaVersion < 1) throw new TypeError("Maximum database schema version is invalid");
  const inspected = inspectExactPath(databasePath, "file");
  if (inspected.canonical !== databasePath || inspected.identity.linkCount !== "1") denyDatabase("PATH_IDENTITY_CHANGED");
  for (const suffix of SIDECAR_SUFFIXES) if (fs.existsSync(`${databasePath}${suffix}`)) denyDatabase("PATH_IDENTITY_CHANGED");
  const candidate = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    checkRows(candidate, "quick_check");
    checkRows(candidate, "integrity_check");
    const foreignKeys = candidate.pragma("foreign_key_check") as unknown[];
    if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) throw new Error("Database snapshot foreign_key_check failed");
    const schemaVersion = Number(candidate.pragma("user_version", { simple: true }));
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > maximumSchemaVersion) {
      throw new Error(`Database snapshot schema version is incompatible: ${schemaVersion}`);
    }
    return Object.freeze({ schemaVersion, quickCheck: "ok", integrityCheck: "ok", foreignKeyViolations: 0 });
  } finally {
    candidate.close();
  }
}

export function createInMemoryBootstrapDatabase(snapshot?: Buffer): BootstrapDatabase {
  if (snapshot !== undefined && (!Buffer.isBuffer(snapshot) || snapshot.length === 0)) throw new TypeError("In-memory database snapshot is invalid");
  return snapshot === undefined ? new Database(":memory:") : new Database(Buffer.from(snapshot));
}
