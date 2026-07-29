import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getBootstrapPathStore, type BootstrapDatabaseFileLease } from "./bootstrap-path-store.js";
import { PathDeniedError } from "./path-policy.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export type BootstrapDatabase = any;

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
        if (!fs.existsSync(sidecarPath)) continue;
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

export async function openBootstrapDatabase(maximumSchemaVersion: number): Promise<BootstrapDatabaseConnection> {
  if (!Number.isSafeInteger(maximumSchemaVersion) || maximumSchemaVersion < 0) {
    throw new TypeError("Maximum database schema version is invalid");
  }
  const lease = await getBootstrapPathStore().openDatabaseFileLease();
  let database: BootstrapDatabase | null = null;
  try {
    await lease.assertPathCurrent();
    const probedVersion = await existingVersionWithoutMutation(lease.canonicalPath);
    if (!Number.isInteger(probedVersion) || probedVersion < 0) throw new Error(`数据库 Schema 版本无效: ${probedVersion}`);
    if (probedVersion > maximumSchemaVersion) {
      throw new Error(`数据库 Schema 版本不兼容: 当前 ${probedVersion}，本应用最多支持 ${maximumSchemaVersion}`);
    }
    const guard = new SqlitePathGuard(lease.canonicalPath);
    database = new Database(lease.canonicalPath);
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
        await lease.assertPathCurrent();
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
        await lease.close();
      } catch (error) {
        leaseFailure = error;
      }
      if (leaseFailure) throw leaseFailure;
      if (pathFailure) throw pathFailure;
      if (closeFailure) throw closeFailure;
    };
    return Object.freeze({ database: guarded, probedVersion, close });
  } catch (error) {
    await closeFailedLease(lease, database);
    throw error;
  }
}

export function createInMemoryBootstrapDatabase(): BootstrapDatabase {
  return new Database(":memory:");
}
