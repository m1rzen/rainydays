import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { BackupDataKeyWrapper } from "./credential-store.js";
import { PathDeniedError, type PathAuthority, type PathReadLease } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { USER_DATA_DIR } from "./runtime-paths.js";

export interface ManagedRestoreSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type ManagedRestoreBarrier = (point: string, context: Readonly<{ transactionId: string; path?: string }>) => void | Promise<void>;

interface FileState {
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256: string;
}

interface JournalEntry {
  readonly path: string;
  readonly old: FileState;
  readonly new: FileState;
}

type RestoreJournalPhase = "prepared" | "rolled_back" | "committed";

interface RestoreJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly phase: RestoreJournalPhase;
  readonly scope: "windows-dpapi-current-user-v1";
  readonly wrappedKey: string;
  readonly entries: readonly JournalEntry[];
  readonly mac: string;
}

const RESTORE_DIRECTORY = ".rainydays-restore";
const ACTIVE_JOURNAL = "active.json";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 260;
const EMPTY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAC_DOMAIN = "rainydays-managed-restore-journal\0v1\0";
const SINGLETON_PATHS = Object.freeze(["data/mini-lux.db", "config.json", "credentials.vault.json", "LUX.oracle"]);
const LOCK_WAIT_MS = 30_000;

function restoreLockEndpoint(): string | number {
  const identity = createHash("sha256").update(process.platform === "win32" ? path.resolve(USER_DATA_DIR).toLowerCase() : path.resolve(USER_DATA_DIR), "utf8").digest();
  if (process.platform === "win32") return `\\\\.\\pipe\\rainydays-managed-restore-${identity.subarray(0, 16).toString("hex")}`;
  return 20_000 + (identity.readUInt32BE(0) % 30_000);
}

export async function acquireManagedRestoreLock(): Promise<() => Promise<void>> {
  const endpoint = restoreLockEndpoint();
  const started = Date.now();
  while (true) {
    const server = net.createServer();
    const acquired = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
        else reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      if (typeof endpoint === "string") server.listen(endpoint);
      else server.listen(endpoint, "127.0.0.1");
    });
    if (acquired) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      };
    }
    if (Date.now() - started >= LOCK_WAIT_MS) throw new Error("Managed restore lock acquisition timed out");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} fields are invalid`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function validManagedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  if ((SINGLETON_PATHS as readonly string[]).includes(value)) return true;
  const match = /^(data\/personas|data\/skills|playbooks)\/([^/]+)\.(md|json)$/u.exec(value);
  if (!match || !NAME_PATTERN.test(match[2])) return false;
  if (match[1] === "data/personas" || match[1] === "data/skills") return match[3] === "md";
  return match[1] === "playbooks" && match[3] === "json";
}

function targetPath(relativePath: string): string {
  if (!validManagedPath(relativePath)) throw new Error("Managed restore path is invalid");
  const target = path.resolve(USER_DATA_DIR, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(USER_DATA_DIR), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Managed restore path escapes user data");
  return target;
}

async function createRestoreAuthority(): Promise<PathAuthority> {
  return pathPolicy.createAuthority([{
    rootId: "managed-restore",
    role: "managed-restore",
    configuredPath: USER_DATA_DIR,
    permissions: ["read-file", "read-directory", "create-file", "replace-file", "create-directory"],
  }]);
}

function restoreAuthorityInput(candidate: string): string {
  const relative = path.relative(path.resolve(USER_DATA_DIR), path.resolve(candidate));
  if (relative === "") return path.resolve(USER_DATA_DIR);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Managed restore authority path escapes user data");
  return relative;
}

function canonicalJournalPayload(journal: Omit<RestoreJournal, "mac">): string {
  return JSON.stringify({
    schemaVersion: journal.schemaVersion,
    transactionId: journal.transactionId,
    phase: journal.phase,
    scope: journal.scope,
    wrappedKey: journal.wrappedKey,
    entries: journal.entries.map(entry => ({ path: entry.path, old: entry.old, new: entry.new })),
  });
}

function journalMac(key: Uint8Array, journal: Omit<RestoreJournal, "mac">): string {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("Managed restore journal key is invalid");
  return `hmac-sha256:${createHmac("sha256", key).update(MAC_DOMAIN, "utf8").update(canonicalJournalPayload(journal), "utf8").digest("hex")}`;
}

function makeState(bytes: Uint8Array | null): FileState {
  return bytes === null
    ? Object.freeze({ present: false, bytes: 0, sha256: EMPTY_HASH })
    : Object.freeze({ present: true, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function parseState(value: unknown, label: string): FileState {
  const state = plainObject(value, label);
  exactKeys(state, ["present", "bytes", "sha256"], label);
  if (typeof state.present !== "boolean" || !Number.isSafeInteger(state.bytes) || Number(state.bytes) < 0 || Number(state.bytes) > MAX_FILE_BYTES
    || typeof state.sha256 !== "string" || !HASH_PATTERN.test(state.sha256)
    || (!state.present && (state.bytes !== 0 || state.sha256 !== EMPTY_HASH))) throw new Error(`${label} is invalid`);
  return Object.freeze({ present: state.present, bytes: Number(state.bytes), sha256: state.sha256 });
}

function parseJournal(bytes: Buffer): RestoreJournal {
  if (bytes.length === 0 || bytes.length > MAX_JOURNAL_BYTES) throw new Error("Managed restore journal size is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Managed restore journal is not valid JSON"); }
  const root = plainObject(parsed, "Managed restore journal");
  exactKeys(root, ["schemaVersion", "transactionId", "phase", "scope", "wrappedKey", "entries", "mac"], "Managed restore journal");
  if (root.schemaVersion !== 1 || typeof root.transactionId !== "string" || !UUID_PATTERN.test(root.transactionId)
    || (root.phase !== "prepared" && root.phase !== "rolled_back" && root.phase !== "committed") || root.scope !== "windows-dpapi-current-user-v1"
    || typeof root.wrappedKey !== "string" || !BASE64_PATTERN.test(root.wrappedKey)
    || typeof root.mac !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/u.test(root.mac)
    || !Array.isArray(root.entries) || root.entries.length === 0 || root.entries.length > MAX_FILES) {
    throw new Error("Managed restore journal is invalid");
  }
  const seen = new Set<string>();
  const entries = root.entries.map((value, index) => {
    const entry = plainObject(value, `Managed restore journal entry ${index}`);
    exactKeys(entry, ["path", "old", "new"], `Managed restore journal entry ${index}`);
    if (!validManagedPath(entry.path) || seen.has(entry.path)) throw new Error("Managed restore journal paths are invalid");
    seen.add(entry.path);
    return Object.freeze({ path: entry.path, old: parseState(entry.old, "Managed restore old state"), new: parseState(entry.new, "Managed restore new state") });
  });
  if (![...seen].includes("data/mini-lux.db")) throw new Error("Managed restore journal database is missing");
  return Object.freeze({
    schemaVersion: 1,
    transactionId: root.transactionId,
    phase: root.phase,
    scope: "windows-dpapi-current-user-v1",
    wrappedKey: root.wrappedKey,
    entries: Object.freeze(entries),
    mac: root.mac,
  });
}

async function qualifiedFileExists(candidate: string, authority: PathAuthority): Promise<boolean> {
  try {
    const qualified = await pathPolicy.qualifyExisting(authority, {
      input: restoreAuthorityInput(candidate),
      operation: "read-file",
      defaultRootId: "managed-restore",
    }, "file");
    if (qualified.snapshot.linkCount !== "1") throw new Error("Managed restore target identity is invalid");
    return true;
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return false;
    throw error;
  }
}

async function readKnownFile(candidate: string, authority: PathAuthority, maxBytes = MAX_FILE_BYTES): Promise<Buffer | null> {
  let lease;
  try {
    lease = await pathPolicy.openReadLease(authority, {
      input: restoreAuthorityInput(candidate),
      operation: "read-file",
      defaultRootId: "managed-restore",
    }, maxBytes);
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
    throw error;
  }
  try {
    if (lease.snapshot.linkCount !== "1") throw new Error("Managed restore target identity is invalid");
    const bytes = lease.size === 0 ? Buffer.alloc(0) : await lease.readRange(0, lease.size - 1);
    try {
      await lease.assertPathCurrent(undefined, true);
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  } finally {
    await lease.close();
  }
}

async function syncDirectory(candidate: string, expectedDevice: bigint, authority: PathAuthority): Promise<void> {
  const qualified = await pathPolicy.qualifyExisting(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "read-directory",
    defaultRootId: "managed-restore",
  }, "directory");
  if (BigInt(qualified.identity.deviceId) !== expectedDevice) throw new Error("Managed restore directory volume is invalid");
  const handle = await fs.open(qualified.canonicalPath, "r+");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || String(opened.dev) !== qualified.identity.deviceId || String(opened.ino) !== qualified.identity.objectId) {
      throw new Error("Managed restore directory identity changed while opening");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await pathPolicy.qualifyExisting(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "read-directory",
    defaultRootId: "managed-restore",
  }, "directory");
  if (after.identity.deviceId !== qualified.identity.deviceId || after.identity.objectId !== qualified.identity.objectId) {
    throw new Error("Managed restore directory identity changed while syncing");
  }
}

async function ensureDirectory(candidate: string, expectedDevice: bigint, authority: PathAuthority): Promise<void> {
  if (path.resolve(candidate) !== path.resolve(USER_DATA_DIR)) {
    const enrollment = await pathPolicy.createDirectoryEnrollment(authority, {
      input: restoreAuthorityInput(candidate),
      operation: "create-directory",
      defaultRootId: "managed-restore",
    });
    enrollment.commit();
  }
  await syncDirectory(candidate, expectedDevice, authority);
  const parent = path.dirname(candidate);
  if (parent !== candidate && path.resolve(candidate) !== path.resolve(USER_DATA_DIR)) {
    await syncDirectory(parent, expectedDevice, authority);
  }
}

async function atomicWrite(candidate: string, bytes: Uint8Array, expectedDevice: bigint, authority: PathAuthority): Promise<void> {
  await ensureDirectory(path.dirname(candidate), expectedDevice, authority);
  await pathPolicy.atomicCreateOrReplaceFile(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "create-file",
    defaultRootId: "managed-restore",
  }, bytes, MAX_FILE_BYTES);
  await syncDirectory(path.dirname(candidate), expectedDevice, authority);
  const published = await readKnownFile(candidate, authority);
  try {
    if (!published || sha256(published) !== sha256(bytes)) throw new Error("Managed restore published file differs");
  } finally {
    published?.fill(0);
  }
}

async function restoreLocations(authority: PathAuthority, transactionId?: string): Promise<Readonly<{
  userDataDevice: bigint;
  root: string;
  journal: string;
  transactions: string;
  transaction?: string;
}>> {
  const userData = await pathPolicy.qualifyExisting(authority, {
    input: path.resolve(USER_DATA_DIR), operation: "read-directory", defaultRootId: "managed-restore",
  }, "directory");
  const userDataDevice = BigInt(userData.identity.deviceId);
  const root = path.join(USER_DATA_DIR, RESTORE_DIRECTORY);
  await ensureDirectory(root, userDataDevice, authority);
  const transactions = path.join(root, "transactions");
  await ensureDirectory(transactions, userDataDevice, authority);
  const transaction = transactionId ? path.join(transactions, transactionId) : undefined;
  return Object.freeze({ userDataDevice, root, journal: path.join(root, ACTIVE_JOURNAL), transactions, ...(transaction ? { transaction } : {}) });
}

async function readJournalBounded(candidate: string, expectedDevice: bigint, authority: PathAuthority): Promise<Buffer | null> {
  const bytes = await readKnownFile(candidate, authority, MAX_JOURNAL_BYTES);
  if (!bytes) return null;
  if (bytes.length < 1) {
    bytes.fill(0);
    throw new Error("Managed restore journal size is invalid");
  }
  const qualified = await pathPolicy.qualifyExisting(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "read-file",
    defaultRootId: "managed-restore",
  }, "file");
  if (BigInt(qualified.identity.deviceId) !== expectedDevice) {
    bytes.fill(0);
    throw new Error("Managed restore journal volume is invalid");
  }
  return bytes;
}

function stagePath(transaction: string, side: "old" | "new", index: number): string {
  return path.join(transaction, side, `${String(index).padStart(4, "0")}.bin`);
}

interface PreparedStageLeaseSet {
  readonly old: readonly (PathReadLease | null)[];
  readonly new: readonly (PathReadLease | null)[];
  readonly read: (side: "old" | "new", index: number, expected: FileState) => Promise<Buffer | null>;
  readonly close: () => Promise<void>;
}

async function readPinnedStageLease(lease: PathReadLease | null, expected: FileState): Promise<Buffer | null> {
  if (!expected.present) return null;
  if (!lease || lease.snapshot.linkCount !== "1" || lease.size !== expected.bytes) throw new Error("Managed restore staged file differs from journal");
  const bytes = lease.size === 0 ? Buffer.alloc(0) : await lease.readRange(0, lease.size - 1);
  if (sha256(bytes) !== expected.sha256) {
    bytes.fill(0);
    throw new Error("Managed restore staged file differs from journal");
  }
  return bytes;
}

async function currentManagedPaths(expectedDevice: bigint, authority: PathAuthority): Promise<Set<string>> {
  const result = new Set<string>(SINGLETON_PATHS);
  const directories = Object.freeze([
    Object.freeze({ relative: "data/personas", extension: ".md" }),
    Object.freeze({ relative: "data/skills", extension: ".md" }),
    Object.freeze({ relative: "playbooks", extension: ".json" }),
  ]);
  for (const directory of directories) {
    let listed;
    try {
      listed = await pathPolicy.listDirectoryDirect(authority, {
        input: directory.relative,
        operation: "read-directory",
        defaultRootId: "managed-restore",
      }, MAX_FILES);
    } catch (error) {
      if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") continue;
      throw error;
    }
    if (BigInt(listed.identity.deviceId) !== expectedDevice) throw new Error("Managed restore inventory directory is invalid");
    for (const entry of listed.entries) {
      if (entry.type !== "file" || !entry.name.endsWith(directory.extension)) continue;
      const stem = entry.name.slice(0, -directory.extension.length);
      if (!NAME_PATTERN.test(stem)) continue;
      result.add(`${directory.relative}/${entry.name}`);
    }
  }
  return result;
}

async function writeJournal(journalPath: string, journal: Omit<RestoreJournal, "mac">, key: Uint8Array, expectedDevice: bigint, authority: PathAuthority): Promise<RestoreJournal> {
  const complete = Object.freeze({ ...journal, mac: journalMac(key, journal) });
  const bytes = Buffer.from(JSON.stringify(complete), "utf8");
  if (journal.phase === "prepared") {
    await pathPolicy.createFile(authority, {
      input: restoreAuthorityInput(journalPath),
      operation: "create-file",
      defaultRootId: "managed-restore",
    }, bytes, MAX_JOURNAL_BYTES);
    await syncDirectory(path.dirname(journalPath), expectedDevice, authority);
  } else {
    const currentBytes = await readJournalBounded(journalPath, expectedDevice, authority);
    if (!currentBytes) throw new Error("Managed restore PREPARED journal is missing before commit");
    try {
      const current = parseJournal(currentBytes);
      const expectedMac = journalMac(key, {
        schemaVersion: current.schemaVersion,
        transactionId: current.transactionId,
        phase: current.phase,
        scope: current.scope,
        wrappedKey: current.wrappedKey,
        entries: current.entries,
      });
      const transitionedCurrent = {
        schemaVersion: current.schemaVersion,
        transactionId: current.transactionId,
        phase: journal.phase,
        scope: current.scope,
        wrappedKey: current.wrappedKey,
        entries: current.entries,
      } satisfies Omit<RestoreJournal, "mac">;
      if (current.phase !== "prepared" || (journal.phase !== "rolled_back" && journal.phase !== "committed")
        || current.mac !== expectedMac || canonicalJournalPayload(transitionedCurrent) !== canonicalJournalPayload(journal)) {
        throw new Error("Managed restore journal ownership changed before phase transition");
      }
    } finally {
      currentBytes.fill(0);
    }
    await atomicWrite(journalPath, bytes, expectedDevice, authority);
  }
  const published = await readJournalBounded(journalPath, expectedDevice, authority);
  try {
    if (!published || sha256(published) !== sha256(bytes)) throw new Error("Managed restore journal publication differs");
  } finally {
    bytes.fill(0);
    published?.fill(0);
  }
  return complete;
}

async function authenticateJournal(journal: RestoreJournal, wrapper: BackupDataKeyWrapper): Promise<Buffer> {
  const wrapped = Buffer.from(journal.wrappedKey, "base64");
  if (wrapped.length === 0 || wrapped.length > 64 * 1024 || wrapped.toString("base64") !== journal.wrappedKey) throw new Error("Managed restore wrapped key is invalid");
  const key = await wrapper.unwrapDataKey(wrapped);
  wrapped.fill(0);
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    key?.fill(0);
    throw new Error("Managed restore journal key is unavailable");
  }
  const expected = journalMac(key, journal);
  const actualBytes = Buffer.from(journal.mac.slice("hmac-sha256:".length), "hex");
  const expectedBytes = Buffer.from(expected.slice("hmac-sha256:".length), "hex");
  try {
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("Managed restore journal authentication failed");
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
  return key;
}

async function verifyState(relativePath: string, expected: FileState, authority: PathAuthority): Promise<void> {
  const bytes = await readKnownFile(targetPath(relativePath), authority);
  try {
    if (!expected.present) {
      if (bytes !== null) throw new Error("Managed restore exact-set deletion failed");
      return;
    }
    if (!bytes || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error("Managed restore live state differs");
  } finally {
    bytes?.fill(0);
  }
}

async function verifyExactSet(entries: readonly JournalEntry[], side: "old" | "new", expectedDevice: bigint, authority: PathAuthority): Promise<void> {
  const actual = [...await currentManagedPaths(expectedDevice, authority)].sort();
  const wanted = entries
    .filter(entry => (SINGLETON_PATHS as readonly string[]).includes(entry.path) || entry[side].present)
    .map(entry => entry.path)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error("Managed restore exact-set inventory differs");
  for (const entry of entries) await verifyState(entry.path, entry[side], authority);
}

async function applyState(
  entry: JournalEntry,
  index: number,
  side: "old" | "new",
  expectedDevice: bigint,
  barrier: ManagedRestoreBarrier,
  transactionId: string,
  prefix: "live" | "recovery",
  authority: PathAuthority,
  stageLeases: PreparedStageLeaseSet
): Promise<void> {
  const expected = entry[side];
  await barrier(`${prefix}:before-${expected.present ? "write" : "delete"}`, Object.freeze({ transactionId, path: entry.path }));
  if (expected.present) {
    const bytes = await stageLeases.read(side, index, expected);
    try { await atomicWrite(targetPath(entry.path), bytes as Buffer, expectedDevice, authority); }
    finally { bytes?.fill(0); }
  } else {
    const target = targetPath(entry.path);
    if (await qualifiedFileExists(target, authority)) {
      await pathPolicy.removeFile(authority, {
        input: restoreAuthorityInput(target),
        operation: "replace-file",
        defaultRootId: "managed-restore",
      });
      await syncDirectory(path.dirname(target), expectedDevice, authority);
    }
  }
  await verifyState(entry.path, expected, authority);
  await barrier(`${prefix}:after-${expected.present ? "write" : "delete"}`, Object.freeze({ transactionId, path: entry.path }));
}

async function removeKnownFileIfPresent(candidate: string, authority: PathAuthority, expectedDevice: bigint): Promise<boolean> {
  if (!await qualifiedFileExists(candidate, authority)) return false;
  await pathPolicy.removeFile(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "replace-file",
    defaultRootId: "managed-restore",
  });
  await syncDirectory(path.dirname(candidate), expectedDevice, authority);
  return true;
}

async function removeKnownDirectory(candidate: string, authority: PathAuthority, expectedDevice: bigint): Promise<void> {
  await pathPolicy.removeDirectory(authority, {
    input: restoreAuthorityInput(candidate),
    operation: "create-directory",
    defaultRootId: "managed-restore",
  });
  await syncDirectory(path.dirname(candidate), expectedDevice, authority);
}

async function listManagedDirectory(candidate: string, authority: PathAuthority, maxEntries = MAX_FILES): Promise<readonly Readonly<{ name: string; type: "file" | "directory" }>[] | null> {
  try {
    const listed = await pathPolicy.listDirectoryDirect(authority, {
      input: restoreAuthorityInput(candidate),
      operation: "read-directory",
      defaultRootId: "managed-restore",
    }, maxEntries);
    return listed.entries.map(entry => Object.freeze({ name: entry.name, type: entry.type }));
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
    throw error;
  }
}

async function removeTransactionArtifacts(
  transaction: string,
  journalPath: string,
  authority: PathAuthority,
  expectedDevice: bigint,
  barrier: ManagedRestoreBarrier,
  transactionId: string
): Promise<void> {
  for (const side of ["old", "new"] as const) {
    const directory = path.join(transaction, side);
    const entries = await listManagedDirectory(directory, authority);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.type !== "file" || !/^\d{4}\.bin$/u.test(entry.name)) throw new Error("Managed restore stage file name is invalid");
      if (await removeKnownFileIfPresent(path.join(directory, entry.name), authority, expectedDevice)) {
        await barrier(`cleanup:${side}-file-removed`, Object.freeze({ transactionId, path: `${side}/${entry.name}` }));
      }
    }
    await removeKnownDirectory(directory, authority, expectedDevice);
    await barrier(`cleanup:${side}-directory-removed`, Object.freeze({ transactionId }));
  }
  const transactionEntries = await listManagedDirectory(transaction, authority);
  if (transactionEntries) {
    if (transactionEntries.length !== 0) throw new Error("Managed restore transaction contains unknown artifacts");
    await removeKnownDirectory(transaction, authority, expectedDevice);
    await barrier("cleanup:transaction-directory-removed", Object.freeze({ transactionId }));
  }
  await barrier("cleanup:before-journal-remove", Object.freeze({ transactionId }));
  if (await removeKnownFileIfPresent(journalPath, authority, expectedDevice)) {
    await barrier("cleanup:journal-removed", Object.freeze({ transactionId }));
  }
}

async function assertNoOrphanTransactions(locations: Awaited<ReturnType<typeof restoreLocations>>, authority: PathAuthority): Promise<void> {
  const entries = await listManagedDirectory(locations.transactions, authority);
  for (const entry of entries ?? []) {
    if (entry.type !== "directory" || !UUID_PATTERN.test(entry.name)) throw new Error("Managed restore orphan transaction name is invalid");
    throw new Error("Managed restore transaction exists without an authenticated journal");
  }
}

async function assertPreparedStageInventory(
  transaction: string,
  entries: readonly JournalEntry[],
  authority: PathAuthority
): Promise<void> {
  for (const side of ["old", "new"] as const) {
    const listed = await listManagedDirectory(path.join(transaction, side), authority, MAX_FILES);
    if (!listed) throw new Error("Managed restore prepared stage directory is missing");
    const actual = listed.map(entry => {
      if (entry.type !== "file" || !/^\d{4}\.bin$/u.test(entry.name)) throw new Error("Managed restore prepared stage artifact is invalid");
      return entry.name;
    }).sort();
    const expected = entries
      .map((entry, index) => entry[side].present ? `${String(index).padStart(4, "0")}.bin` : null)
      .filter((name): name is string => name !== null)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Managed restore prepared stage exact set differs from journal");
  }
}

async function openPreparedStageLeases(
  transaction: string,
  entries: readonly JournalEntry[],
  authority: PathAuthority
): Promise<PreparedStageLeaseSet> {
  const old: (PathReadLease | null)[] = entries.map(() => null);
  const next: (PathReadLease | null)[] = entries.map(() => null);
  const allLeases = (): PathReadLease[] => [...old, ...next].filter((lease): lease is PathReadLease => lease !== null);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(allLeases().map(lease => lease.close()));
  };
  try {
    await assertPreparedStageInventory(transaction, entries, authority);
    for (const side of ["old", "new"] as const) {
      const destination = side === "old" ? old : next;
      for (let index = 0; index < entries.length; index += 1) {
        const expected = entries[index][side];
        if (!expected.present) continue;
        destination[index] = await pathPolicy.openReadLease(authority, {
          input: restoreAuthorityInput(stagePath(transaction, side, index)),
          operation: "read-file",
          defaultRootId: "managed-restore",
        }, MAX_FILE_BYTES);
      }
    }
    await assertPreparedStageInventory(transaction, entries, authority);
    for (const side of ["old", "new"] as const) {
      const source = side === "old" ? old : next;
      for (let index = 0; index < entries.length; index += 1) {
        const lease = source[index];
        if (!lease) continue;
        await lease.assertPathCurrent(undefined, true);
        const bytes = await readPinnedStageLease(lease, entries[index][side]);
        bytes?.fill(0);
      }
    }
    const read = (side: "old" | "new", index: number, expected: FileState): Promise<Buffer | null> => {
      if (closed || !Number.isSafeInteger(index) || index < 0 || index >= entries.length) throw new Error("Managed restore prepared stage lease is unavailable");
      return readPinnedStageLease((side === "old" ? old : next)[index], expected);
    };
    return Object.freeze({ old: Object.freeze(old), new: Object.freeze(next), read, close });
  } catch (error) {
    await close();
    throw error;
  }
}

async function completePreparedRollback(
  journal: RestoreJournal,
  journalPath: string,
  expectedDevice: bigint,
  key: Uint8Array,
  barrier: ManagedRestoreBarrier,
  authority: PathAuthority,
  stageLeases: PreparedStageLeaseSet
): Promise<void> {
  for (let index = 0; index < journal.entries.length; index += 1) {
    await applyState(journal.entries[index], index, "old", expectedDevice, barrier, journal.transactionId, "recovery", authority, stageLeases);
  }
  await verifyExactSet(journal.entries, "old", expectedDevice, authority);
  await barrier("recovery:prepared-set-complete", Object.freeze({ transactionId: journal.transactionId }));
  await writeJournal(journalPath, Object.freeze({
    schemaVersion: journal.schemaVersion,
    transactionId: journal.transactionId,
    phase: "rolled_back" as const,
    scope: journal.scope,
    wrappedKey: journal.wrappedKey,
    entries: journal.entries,
  }), key, expectedDevice, authority);
  await barrier("recovery:rolled-back-published", Object.freeze({ transactionId: journal.transactionId }));
}

async function hasPendingManagedRestoreWithAuthority(authority: PathAuthority): Promise<boolean> {
  const locations = await restoreLocations(authority);
  const journal = await readJournalBounded(locations.journal, locations.userDataDevice, authority);
  journal?.fill(0);
  return journal !== null;
}

export async function hasPendingManagedRestore(): Promise<boolean> {
  const authority = await createRestoreAuthority();
  try { return await hasPendingManagedRestoreWithAuthority(authority); }
  finally { if (pathPolicy.isActive(authority)) pathPolicy.revoke(authority); }
}

async function recoverPendingManagedRestoreLocked(
  wrapper?: BackupDataKeyWrapper,
  barrier: ManagedRestoreBarrier = () => undefined
): Promise<Readonly<{ recovered: boolean; phase: RestoreJournalPhase | null }>> {
  const authority = await createRestoreAuthority();
  try {
    const locations = await restoreLocations(authority);
    const journalBytes = await readJournalBounded(locations.journal, locations.userDataDevice, authority);
    if (!journalBytes) {
      await assertNoOrphanTransactions(locations, authority);
      return Object.freeze({ recovered: false, phase: null });
    }
    const journal = parseJournal(journalBytes);
    if (!wrapper) throw new Error("Managed restore credential protection is unavailable");
    const key = await authenticateJournal(journal, wrapper);
    const transaction = path.join(locations.transactions, journal.transactionId);
    let stageLeases: PreparedStageLeaseSet | null = null;
    try {
      try {
        const transactionInfo = await pathPolicy.qualifyExisting(authority, {
          input: restoreAuthorityInput(transaction), operation: "read-directory", defaultRootId: "managed-restore",
        }, "directory");
        if (BigInt(transactionInfo.identity.deviceId) !== locations.userDataDevice) throw new Error("Managed restore transaction identity is invalid");
      } catch (error) {
        if (journal.phase === "prepared" || !(error instanceof PathDeniedError) || error.code !== "PATH_NOT_FOUND") throw error;
      }
      const recoveredPhase = journal.phase;
      if (journal.phase === "prepared") {
        stageLeases = await openPreparedStageLeases(transaction, journal.entries, authority);
        await completePreparedRollback(journal, locations.journal, locations.userDataDevice, key, barrier, authority, stageLeases);
        await stageLeases.close();
        stageLeases = null;
      } else if (journal.phase === "rolled_back") {
        await verifyExactSet(journal.entries, "old", locations.userDataDevice, authority);
        await barrier("recovery:rolled_back-set-complete", Object.freeze({ transactionId: journal.transactionId }));
      } else {
        await verifyExactSet(journal.entries, "new", locations.userDataDevice, authority);
        await barrier("recovery:committed-set-complete", Object.freeze({ transactionId: journal.transactionId }));
      }
      await removeTransactionArtifacts(transaction, locations.journal, authority, locations.userDataDevice, barrier, journal.transactionId);
      return Object.freeze({ recovered: true, phase: recoveredPhase });
    } finally {
      await stageLeases?.close();
      key.fill(0);
      journalBytes.fill(0);
    }
  } finally {
    if (pathPolicy.isActive(authority)) pathPolicy.revoke(authority);
  }
}

export async function recoverPendingManagedRestore(
  wrapper?: BackupDataKeyWrapper,
  barrier: ManagedRestoreBarrier = () => undefined,
  lockHeld = false
): Promise<Readonly<{ recovered: boolean; phase: RestoreJournalPhase | null }>> {
  const release = lockHeld ? null : await acquireManagedRestoreLock();
  try { return await recoverPendingManagedRestoreLocked(wrapper, barrier); }
  finally { await release?.(); }
}

export async function performManagedRestore(
  sources: readonly ManagedRestoreSourceFile[],
  wrapper: BackupDataKeyWrapper,
  barrier: ManagedRestoreBarrier = () => undefined
): Promise<Readonly<{ transactionId: string; fileCount: number; cleanupPending: boolean }>> {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_FILES) throw new TypeError("Managed restore sources are invalid");
  if (!wrapper || wrapper.algorithm !== "electron-safe-storage" || wrapper.scope !== "windows-dpapi-current-user-v1"
    || typeof wrapper.wrapDataKey !== "function" || typeof wrapper.unwrapDataKey !== "function") throw new TypeError("Managed restore key wrapper is invalid");
  const sourceMap = new Map<string, Buffer>();
  for (const source of sources) {
    if (!source || !validManagedPath(source.path) || !(source.bytes instanceof Uint8Array) || source.bytes.byteLength > MAX_FILE_BYTES || sourceMap.has(source.path)) {
      throw new TypeError("Managed restore source is invalid");
    }
    sourceMap.set(source.path, Buffer.from(source.bytes));
  }
  if (!sourceMap.has("data/mini-lux.db")) throw new Error("Managed restore database source is missing");

  const release = await acquireManagedRestoreLock();
  let transactionId: string;
  let locations: Awaited<ReturnType<typeof restoreLocations>>;
  let transaction: string;
  let key: Buffer;
  let authority: PathAuthority;
  try {
    authority = await createRestoreAuthority();
    const pending = await hasPendingManagedRestoreWithAuthority(authority);
    if (pending) throw new Error("Managed restore transaction is already pending");
    transactionId = randomUUID();
    locations = await restoreLocations(authority, transactionId);
    transaction = locations.transaction as string;
    key = randomBytes(32);
  } catch (error) {
    for (const bytes of sourceMap.values()) bytes.fill(0);
    await release();
    throw error;
  }
  let wrappedKey: Buffer | null = null;
  let preparedJournal: RestoreJournal | null = null;
  let stageLeases: PreparedStageLeaseSet | null = null;
  let prepared = false;
  let committed = false;
  try {
    await ensureDirectory(transaction, locations.userDataDevice, authority);
    await ensureDirectory(path.join(transaction, "old"), locations.userDataDevice, authority);
    await ensureDirectory(path.join(transaction, "new"), locations.userDataDevice, authority);

    const allPaths = await currentManagedPaths(locations.userDataDevice, authority);
    for (const sourcePath of sourceMap.keys()) allPaths.add(sourcePath);
    const orderedPaths = [...allPaths].sort();
    const entries: JournalEntry[] = [];
    for (let index = 0; index < orderedPaths.length; index += 1) {
      const relativePath = orderedPaths[index];
      const oldBytes = await readKnownFile(targetPath(relativePath), authority);
      const newBytes = sourceMap.get(relativePath) ?? null;
      try {
        if (oldBytes) await pathPolicy.createFile(authority, {
          input: restoreAuthorityInput(stagePath(transaction, "old", index)), operation: "create-file", defaultRootId: "managed-restore",
        }, oldBytes, MAX_FILE_BYTES);
        if (newBytes) await pathPolicy.createFile(authority, {
          input: restoreAuthorityInput(stagePath(transaction, "new", index)), operation: "create-file", defaultRootId: "managed-restore",
        }, newBytes, MAX_FILE_BYTES);
        if (oldBytes) await syncDirectory(path.join(transaction, "old"), locations.userDataDevice, authority);
        if (newBytes) await syncDirectory(path.join(transaction, "new"), locations.userDataDevice, authority);
        entries.push(Object.freeze({ path: relativePath, old: makeState(oldBytes), new: makeState(newBytes) }));
      } finally {
        oldBytes?.fill(0);
      }
      await barrier("stage:file-synced", Object.freeze({ transactionId, path: relativePath }));
    }
    await barrier("stage:set-complete", Object.freeze({ transactionId }));

    wrappedKey = await wrapper.wrapDataKey(key);
    if (!Buffer.isBuffer(wrappedKey) || wrappedKey.length === 0 || wrappedKey.length > 64 * 1024) throw new Error("Managed restore journal key wrapping failed");
    const preparedPayload = Object.freeze({
      schemaVersion: 1 as const,
      transactionId,
      phase: "prepared" as const,
      scope: "windows-dpapi-current-user-v1" as const,
      wrappedKey: wrappedKey.toString("base64"),
      entries: Object.freeze(entries),
    });
    preparedJournal = await writeJournal(locations.journal, preparedPayload, key, locations.userDataDevice, authority);
    prepared = true;
    await barrier("journal:prepared-published", Object.freeze({ transactionId }));
    stageLeases = await openPreparedStageLeases(transaction, entries, authority);

    for (let index = 0; index < entries.length; index += 1) {
      await applyState(entries[index], index, "new", locations.userDataDevice, barrier, transactionId, "live", authority, stageLeases);
    }
    await verifyExactSet(entries, "new", locations.userDataDevice, authority);
    await barrier("live:set-complete", Object.freeze({ transactionId }));

    await writeJournal(locations.journal, Object.freeze({ ...preparedPayload, phase: "committed" as const }), key, locations.userDataDevice, authority);
    committed = true;
    await stageLeases.close();
    stageLeases = null;
    await barrier("journal:committed-published", Object.freeze({ transactionId }));
    let cleanupPending = false;
    try { await removeTransactionArtifacts(transaction, locations.journal, authority, locations.userDataDevice, barrier, transactionId); }
    catch { cleanupPending = true; }
    return Object.freeze({ transactionId, fileCount: preparedJournal.entries.length, cleanupPending });
  } catch (error) {
    if (prepared) {
      try {
        if (!committed && stageLeases && preparedJournal) {
          await completePreparedRollback(preparedJournal, locations.journal, locations.userDataDevice, key, barrier, authority, stageLeases);
          await stageLeases.close();
          stageLeases = null;
          await removeTransactionArtifacts(transaction, locations.journal, authority, locations.userDataDevice, barrier, transactionId).catch(() => undefined);
        } else {
          await stageLeases?.close();
          stageLeases = null;
          await recoverPendingManagedRestore(wrapper, barrier, true);
        }
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Managed restore failed and rollback is incomplete");
      }
    } else {
      await removeTransactionArtifacts(
        transaction,
        path.join(locations.root, `.unpublished-${transactionId}.absent`),
        authority,
        locations.userDataDevice,
        () => undefined,
        transactionId
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await stageLeases?.close();
    for (const bytes of sourceMap.values()) bytes.fill(0);
    key.fill(0);
    if (Buffer.isBuffer(wrappedKey)) wrappedKey.fill(0);
    if (pathPolicy.isActive(authority)) pathPolicy.revoke(authority);
    await release();
  }
}
