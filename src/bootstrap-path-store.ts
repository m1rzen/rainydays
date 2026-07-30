import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PathDeniedError,
  type ObjectIdentity,
  type PathAuthority,
  type PathBarrierPoint,
  type PathQualifiedResult,
  type PathReadLease,
  validatePathSyntax,
} from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { APP_ROOT, DATA_DIR, MODELS_DIR, PUBLIC_DIR, USER_DATA_DIR } from "./runtime-paths.js";

const APP_READ_LIMIT = 8 * 1024 * 1024;
const PUBLIC_READ_LIMIT = 4 * 1024 * 1024;
const RUNTIME_FILE_LIMIT = 256 * 1024 * 1024;
const DIGEST_CHUNK_BYTES = 1024 * 1024;
const MODEL_TREE_MAX_ENTRIES = 2_000;

export type BootstrapExecutableKind =
  | "node"
  | "taskkill"
  | "terminal-cmd"
  | "terminal-powershell"
  | "reveal"
  | "git";

function sameIdentity(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return left.deviceId === right.deviceId && left.objectId === right.objectId && left.type === right.type;
}

function relativeDescendant(parent: string, candidate: string, role: string): string {
  const relative = path.relative(parent, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathDeniedError("PATH_ROOT_DENIED", `Bootstrap ${role} path is outside its pinned root`);
  }
  validatePathSyntax(relative);
  return relative;
}

function validateRelativeInput(input: string): string {
  validatePathSyntax(input);
  if (path.isAbsolute(input)) throw new PathDeniedError("PATH_INPUT_INVALID", "Bootstrap relative path required");
  return input;
}

function publicRequestPath(requestPath: string): string {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/")) {
    throw new PathDeniedError("PATH_INPUT_INVALID", "Public request path is invalid");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    throw new PathDeniedError("PATH_INPUT_INVALID", "Public request path is invalid");
  }
  if (decoded.includes("\\")) throw new PathDeniedError("PATH_INPUT_INVALID", "Public request path is invalid");
  const relativeUrl = decoded.replace(/^\/+/, "") || "index.html";
  const relative = relativeUrl.split("/").join(path.sep);
  validateRelativeInput(relative);
  return relative;
}

export interface BootstrapAsset {
  readonly bytes: Buffer;
  readonly extension: string;
}

export interface BootstrapDatabaseFileLease {
  readonly canonicalPath: string;
  readonly assertPathCurrent: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BootstrapRuntimeFileLease {
  readonly canonicalPath: string;
  readonly size: number;
  readonly assertCurrent: (barrierPoint?: PathBarrierPoint) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BootstrapModelTreeLease {
  readonly canonicalPath: string;
  readonly fileCount: number;
  readonly assertCurrent: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface ModelTreeRecord {
  readonly relativePath: string;
  readonly type: "file" | "directory";
  readonly identity: ObjectIdentity;
}

async function digestReadLease(lease: PathReadLease): Promise<string> {
  if (!Number.isSafeInteger(lease.size) || lease.size < 1 || lease.size > RUNTIME_FILE_LIMIT) {
    throw new PathDeniedError("PATH_OPERATION_DENIED", "Bootstrap runtime file size is invalid");
  }
  const digest = createHash("sha256");
  for (let start = 0; start < lease.size; start += DIGEST_CHUNK_BYTES) {
    const end = Math.min(lease.size - 1, start + DIGEST_CHUNK_BYTES - 1);
    digest.update(await lease.readRange(start, end));
  }
  return digest.digest("hex");
}

function windowsSystemRoot(): string {
  const candidate = process.env.SystemRoot ?? process.env.WINDIR;
  if (!candidate) throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", "Windows system root is unavailable");
  validatePathSyntax(candidate);
  if (!path.isAbsolute(candidate)) throw new PathDeniedError("PATH_INPUT_INVALID", "Windows system root must be absolute");
  return candidate;
}

function executableCandidate(kind: BootstrapExecutableKind): string {
  if (kind === "node") return process.execPath;
  if (kind === "git") {
    const configured = process.env.RAINYDAYS_GIT_EXECUTABLE;
    if (configured) return configured;
    if (process.platform !== "win32") return "/usr/bin/git";
    throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", "Git executable requires RAINYDAYS_GIT_EXECUTABLE");
  }
  if (process.platform === "win32") {
    const systemRoot = windowsSystemRoot();
    if (kind === "taskkill") return path.join(systemRoot, "System32", "taskkill.exe");
    if (kind === "terminal-cmd") return path.join(systemRoot, "System32", "cmd.exe");
    if (kind === "terminal-powershell") return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (kind === "reveal") return path.join(systemRoot, "explorer.exe");
  } else {
    if (kind === "terminal-cmd" || kind === "terminal-powershell") return "/bin/bash";
    if (kind === "reveal") return process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  }
  throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", `Bootstrap executable is unavailable: ${kind}`);
}

export class BootstrapPathStore {
  readonly #appAuthorityPromise: Promise<PathAuthority>;
  #userDataAuthorityPromise: Promise<PathAuthority> | null = null;
  #dataAuthorityPromise: Promise<PathAuthority> | null = null;
  #temporaryAuthorityPromise: Promise<PathAuthority> | null = null;
  readonly #externalAuthorityPromises = new Map<string, Promise<PathAuthority>>();
  readonly #databaseLeases = new Set<object>();
  readonly #runtimeFileLeases = new Set<object>();
  readonly #publicRelative = relativeDescendant(APP_ROOT, PUBLIC_DIR, "public");
  readonly #modelsRelative = relativeDescendant(APP_ROOT, MODELS_DIR, "models");
  readonly #dataRelative = relativeDescendant(USER_DATA_DIR, DATA_DIR, "data");

  constructor() {
    this.#appAuthorityPromise = pathPolicy.createAuthority([{
      rootId: "app",
      role: "bootstrap-app",
      configuredPath: APP_ROOT,
      permissions: ["read-file", "read-directory", "initial-cwd"],
    }]);
  }

  async readAppFile(relativePath: string, maxBytes = APP_READ_LIMIT): Promise<Buffer> {
    const authority = await this.#appAuthorityPromise;
    const result = await pathPolicy.readFile(authority, {
      input: validateRelativeInput(relativePath),
      operation: "read-file",
      defaultRootId: "app",
    }, maxBytes);
    return Buffer.from(result.bytes);
  }

  async readPublicAsset(requestPath: string): Promise<BootstrapAsset> {
    const authority = await this.#appAuthorityPromise;
    const publicRelative = publicRequestPath(requestPath);
    const target = path.join(this.#publicRelative, publicRelative);
    const result = await pathPolicy.readFile(authority, {
      input: target,
      operation: "read-file",
      defaultRootId: "app",
    }, PUBLIC_READ_LIMIT);
    return Object.freeze({ bytes: Buffer.from(result.bytes), extension: path.extname(publicRelative).toLowerCase() });
  }

  async withAppCwd<T>(use: (canonicalCwd: string) => T | Promise<T>): Promise<T> {
    const authority = await this.#appAuthorityPromise;
    return pathPolicy.withInitialCwd(authority, {
      input: "",
      operation: "initial-cwd",
      defaultRootId: "app",
    }, use);
  }

  async withAppFile<T>(relativePath: string, use: (canonicalFile: string) => T | Promise<T>): Promise<T> {
    const authority = await this.#appAuthorityPromise;
    const request = { input: validateRelativeInput(relativePath), operation: "read-file" as const, defaultRootId: "app" };
    const before = await pathPolicy.qualifyExisting(authority, request, "file");
    const value = await use(before.canonicalPath);
    const after = await pathPolicy.qualifyExisting(authority, request, "file");
    if (!sameIdentity(before.identity, after.identity) || before.canonicalPath !== after.canonicalPath) {
      throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Bootstrap file identity changed during use");
    }
    return value;
  }

  async openNodeExecutable(): Promise<BootstrapRuntimeFileLease> {
    return this.#openExternalRuntimeFile(executableCandidate("node"), "runtime-node");
  }

  async openProcessTreeKiller(): Promise<BootstrapRuntimeFileLease> {
    return this.#openExternalRuntimeFile(executableCandidate("taskkill"), "runtime-taskkill");
  }

  async openTerminalShell(shell: "cmd" | "powershell"): Promise<BootstrapRuntimeFileLease> {
    const kind = shell === "powershell" ? "terminal-powershell" : "terminal-cmd";
    return this.#openExternalRuntimeFile(executableCandidate(kind), `runtime-${kind}`);
  }

  async openRevealLauncher(): Promise<BootstrapRuntimeFileLease> {
    return this.#openExternalRuntimeFile(executableCandidate("reveal"), "runtime-reveal");
  }

  async openGitExecutable(): Promise<BootstrapRuntimeFileLease> {
    return this.#openExternalRuntimeFile(executableCandidate("git"), "runtime-git");
  }

  async openDocumentParserWorker(): Promise<BootstrapRuntimeFileLease> {
    return this.#openAppRuntimeFile(path.join("dist", "document-parser-worker.js"), "runtime-document-worker");
  }

  async openDaemonServerScript(): Promise<BootstrapRuntimeFileLease> {
    return this.#openAppRuntimeFile(path.join("src", "index.ts"), "runtime-daemon-server");
  }

  async openDaemonTsxLoader(): Promise<BootstrapRuntimeFileLease> {
    return this.#openExternalRuntimeFile(fileURLToPath(import.meta.resolve("tsx")), "runtime-daemon-loader");
  }

  async ensureUserDataDescendantDirectory(candidate: string): Promise<boolean> {
    const relative = path.relative(USER_DATA_DIR, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    await pathPolicy.validateBootstrapCandidate(candidate, {
      role: "user-data-output",
      parent: USER_DATA_DIR,
    });
    const authority = await this.#userDataAuthority();
    const request = { input: relative, operation: "read-directory" as const, defaultRootId: "user-data" };
    try {
      await pathPolicy.qualifyExisting(authority, request, "directory");
      return true;
    } catch (error) {
      if (!(error instanceof PathDeniedError) || error.code !== "PATH_NOT_FOUND") throw error;
    }
    const lease = await pathPolicy.createDirectoryEnrollment(authority, {
      input: relative,
      operation: "create-directory",
      defaultRootId: "user-data",
    });
    lease.commit();
    await pathPolicy.qualifyExisting(authority, request, "directory");
    return true;
  }

  async openModelsTreeLease(): Promise<BootstrapModelTreeLease> {
    const authority = await this.#appAuthorityPromise;
    const files: Array<{ record: ModelTreeRecord; lease: PathReadLease; digest: string }> = [];
    let expected: readonly ModelTreeRecord[];
    try {
      expected = await this.#scanModelTree(authority, async (record, relativePath) => {
        const lease = await pathPolicy.openReadLease(authority, {
          input: relativePath,
          operation: "read-file",
          defaultRootId: "app",
        }, RUNTIME_FILE_LIMIT);
        try {
          files.push({ record, lease, digest: await digestReadLease(lease) });
        } catch (error) {
          await lease.close();
          throw error;
        }
      });
    } catch (error) {
      await Promise.all(files.map(file => file.lease.close()));
      throw error;
    }
    const token = Object.freeze({});
    this.#runtimeFileLeases.add(token);
    let closed = false;
    const assertCurrent = async (): Promise<void> => {
      if (closed || !this.#runtimeFileLeases.has(token)) {
        throw new PathDeniedError("PATH_AUTHORITY_STALE", "Models bootstrap lease is closed");
      }
      const actual = await this.#scanModelTree(authority);
      if (actual.length !== expected.length || actual.some((record, index) => {
        const prior = expected[index];
        return record.relativePath !== prior.relativePath || record.type !== prior.type || !sameIdentity(record.identity, prior.identity);
      })) {
        throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Models bootstrap tree identity changed");
      }
      for (const file of files) {
        await file.lease.assertPathCurrent(undefined, true);
        if (await digestReadLease(file.lease) !== file.digest) {
          throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Models bootstrap file content changed");
        }
      }
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      this.#runtimeFileLeases.delete(token);
      await Promise.all(files.map(file => file.lease.close()));
    };
    try {
      await assertCurrent();
      const root = expected.find(record => record.relativePath === "" && record.type === "directory");
      if (!root) throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Models bootstrap root is missing");
      const qualified = await pathPolicy.qualifyExisting(authority, {
        input: this.#modelsRelative,
        operation: "read-directory",
        defaultRootId: "app",
      }, "directory");
      return Object.freeze({ canonicalPath: qualified.canonicalPath, fileCount: files.length, assertCurrent, close });
    } catch (error) {
      await close();
      throw error;
    }
  }

  async withModelsDirectory<T>(use: (canonicalModelsDirectory: string) => T | Promise<T>): Promise<T> {
    const lease = await this.openModelsTreeLease();
    try {
      const value = await use(lease.canonicalPath);
      await lease.assertCurrent();
      return value;
    } finally {
      await lease.close();
    }
  }

  async openDatabaseFileLease(): Promise<BootstrapDatabaseFileLease> {
    const authority = await this.#dataAuthority();
    const request = { input: "mini-lux.db", operation: "read-file" as const, defaultRootId: "data" };
    try {
      await pathPolicy.qualifyExisting(authority, request, "file");
    } catch (error) {
      if (!(error instanceof PathDeniedError) || error.code !== "PATH_NOT_FOUND") throw error;
      await pathPolicy.createFile(authority, {
        input: "mini-lux.db",
        operation: "create-file",
        defaultRootId: "data",
      }, Buffer.alloc(0), 1);
    }
    const pathLease = await pathPolicy.openReadLease(authority, request, Number.MAX_SAFE_INTEGER);
    const token = Object.freeze({});
    this.#databaseLeases.add(token);
    let closed = false;
    const assertPathCurrent = async (): Promise<void> => {
      if (closed || !this.#databaseLeases.has(token)) throw new PathDeniedError("PATH_AUTHORITY_STALE", "Database bootstrap lease is closed");
      await pathLease.assertPathCurrent();
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      this.#databaseLeases.delete(token);
      await pathLease.close();
    };
    return Object.freeze({ canonicalPath: pathLease.canonicalPath, assertPathCurrent, close });
  }

  async withTemporaryDirectory<T>(prefix: string, use: (canonicalDirectory: string) => T | Promise<T>): Promise<T> {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(prefix)) throw new TypeError("Temporary directory prefix is invalid");
    const authority = await this.#temporaryAuthority();
    const name = `${prefix}-${randomUUID()}`;
    const lease = await pathPolicy.createDirectoryEnrollment(authority, {
      input: name,
      operation: "create-directory",
      defaultRootId: "temporary",
    });
    const request = { input: name, operation: "read-directory" as const, defaultRootId: "temporary" };
    const before = await pathPolicy.qualifyExisting(authority, request, "directory");
    try {
      return await use(before.canonicalPath);
    } finally {
      const after = await pathPolicy.qualifyExisting(authority, request, "directory");
      if (!sameIdentity(before.identity, after.identity) || before.canonicalPath !== after.canonicalPath) {
        throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Temporary directory identity changed during bootstrap use");
      }
      await lease.rollback();
    }
  }

  async close(): Promise<void> {
    if (this.#databaseLeases.size > 0) throw new Error("Database bootstrap lease is still active");
    if (this.#runtimeFileLeases.size > 0) throw new Error("Runtime bootstrap lease is still active");
    const authorities = await Promise.all([
      this.#appAuthorityPromise,
      this.#userDataAuthorityPromise,
      this.#dataAuthorityPromise,
      this.#temporaryAuthorityPromise,
      ...this.#externalAuthorityPromises.values(),
    ].filter((value): value is Promise<PathAuthority> => value !== null));
    for (const authority of authorities.reverse()) if (pathPolicy.isActive(authority)) pathPolicy.revoke(authority);
  }

  async #openAppRuntimeFile(relativePath: string, role: string): Promise<BootstrapRuntimeFileLease> {
    const authority = await this.#appAuthorityPromise;
    return this.#createRuntimeFileLease(authority, {
      input: validateRelativeInput(relativePath),
      operation: "read-file",
      defaultRootId: "app",
    }, role);
  }

  async #openExternalRuntimeFile(candidate: string, role: string): Promise<BootstrapRuntimeFileLease> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(role)) throw new TypeError("Bootstrap runtime role is invalid");
    validatePathSyntax(candidate);
    if (!path.isAbsolute(candidate)) throw new PathDeniedError("PATH_INPUT_INVALID", "Bootstrap executable must be absolute");
    const normalized = path.resolve(candidate);
    const parent = path.dirname(normalized);
    const cacheKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    let authorityPromise = this.#externalAuthorityPromises.get(cacheKey);
    if (!authorityPromise) {
      authorityPromise = pathPolicy.createAuthority([{
        rootId: "runtime-file",
        role,
        configuredPath: parent,
        permissions: ["read-file"],
      }]).catch(error => {
        this.#externalAuthorityPromises.delete(cacheKey);
        throw error;
      });
      this.#externalAuthorityPromises.set(cacheKey, authorityPromise);
    }
    return this.#createRuntimeFileLease(await authorityPromise, {
      input: path.basename(normalized),
      operation: "read-file",
      defaultRootId: "runtime-file",
    }, role);
  }

  async #createRuntimeFileLease(
    authority: PathAuthority,
    request: { readonly input: string; readonly operation: "read-file"; readonly defaultRootId: string },
    role: string
  ): Promise<BootstrapRuntimeFileLease> {
    const pathLease = await pathPolicy.openReadLease(authority, request, RUNTIME_FILE_LIMIT);
    const token = Object.freeze({});
    this.#runtimeFileLeases.add(token);
    let closed = false;
    try {
      const originalDigest = await digestReadLease(pathLease);
      const assertCurrent = async (barrierPoint?: PathBarrierPoint): Promise<void> => {
        if (closed || !this.#runtimeFileLeases.has(token)) {
          throw new PathDeniedError("PATH_AUTHORITY_STALE", `Bootstrap runtime lease is closed: ${role}`);
        }
        await pathLease.assertPathCurrent(barrierPoint, true);
        if (await digestReadLease(pathLease) !== originalDigest) {
          throw new PathDeniedError("PATH_IDENTITY_CHANGED", `Bootstrap runtime content changed: ${role}`);
        }
        await pathLease.assertPathCurrent(undefined, true);
      };
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        this.#runtimeFileLeases.delete(token);
        await pathLease.close();
      };
      return Object.freeze({ canonicalPath: pathLease.canonicalPath, size: pathLease.size, assertCurrent, close });
    } catch (error) {
      this.#runtimeFileLeases.delete(token);
      await pathLease.close();
      throw error;
    }
  }

  #userDataAuthority(): Promise<PathAuthority> {
    if (this.#userDataAuthorityPromise) return this.#userDataAuthorityPromise;
    const preparing = pathPolicy.createAuthority([{
      rootId: "user-data",
      role: "bootstrap-user-data",
      configuredPath: USER_DATA_DIR,
      permissions: ["read-file", "read-directory", "create-file", "replace-file", "create-directory"],
    }]).catch(error => {
      this.#userDataAuthorityPromise = null;
      throw error;
    });
    this.#userDataAuthorityPromise = preparing;
    return preparing;
  }

  #dataAuthority(): Promise<PathAuthority> {
    if (this.#dataAuthorityPromise) return this.#dataAuthorityPromise;
    const preparing = (async () => {
      const userAuthority = await this.#userDataAuthority();
      try {
        await pathPolicy.qualifyExisting(userAuthority, {
          input: this.#dataRelative,
          operation: "read-directory",
          defaultRootId: "user-data",
        }, "directory");
      } catch (error) {
        if (!(error instanceof PathDeniedError) || error.code !== "PATH_NOT_FOUND") throw error;
        const lease = await pathPolicy.createDirectoryEnrollment(userAuthority, {
          input: this.#dataRelative,
          operation: "create-directory",
          defaultRootId: "user-data",
        });
        lease.commit();
      }
      return pathPolicy.createAuthority([{
        rootId: "data",
        role: "bootstrap-data",
        configuredPath: DATA_DIR,
        permissions: ["read-file", "read-directory", "create-file", "replace-file"],
      }]);
    })().catch(error => {
      this.#dataAuthorityPromise = null;
      throw error;
    });
    this.#dataAuthorityPromise = preparing;
    return preparing;
  }

  #temporaryAuthority(): Promise<PathAuthority> {
    if (this.#temporaryAuthorityPromise) return this.#temporaryAuthorityPromise;
    const temporaryRoot = os.tmpdir();
    validatePathSyntax(temporaryRoot);
    if (!path.isAbsolute(temporaryRoot)) {
      throw new PathDeniedError("PATH_INPUT_INVALID", "Temporary bootstrap root must be absolute");
    }
    const preparing = pathPolicy.createAuthority([{
      rootId: "temporary",
      role: "bootstrap-temporary",
      configuredPath: temporaryRoot,
      permissions: ["read-file", "read-directory", "create-file", "replace-file", "create-directory"],
    }]).catch(error => {
      this.#temporaryAuthorityPromise = null;
      throw error;
    });
    this.#temporaryAuthorityPromise = preparing;
    return preparing;
  }

  async #scanModelTree(
    authority: PathAuthority,
    onFile?: (record: ModelTreeRecord, appRelativePath: string) => Promise<void>
  ): Promise<readonly ModelTreeRecord[]> {
    const records: ModelTreeRecord[] = [];
    let entryCount = 0;
    const walk = async (appRelativePath: string, treeRelativePath: string): Promise<void> => {
      const directory = await pathPolicy.listDirectoryDirect(authority, {
        input: appRelativePath,
        operation: "read-directory",
        defaultRootId: "app",
      }, MODEL_TREE_MAX_ENTRIES);
      records.push(Object.freeze({ relativePath: treeRelativePath, type: "directory", identity: directory.identity }));
      const entries = [...directory.entries].sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MODEL_TREE_MAX_ENTRIES) throw new PathDeniedError("PATH_OPERATION_DENIED", "Models bootstrap tree is too large");
        const childAppRelative = path.join(appRelativePath, entry.name);
        const childTreeRelative = treeRelativePath ? path.join(treeRelativePath, entry.name) : entry.name;
        const record = Object.freeze({ relativePath: childTreeRelative, type: entry.type, identity: entry.identity });
        if (entry.type === "directory") await walk(childAppRelative, childTreeRelative);
        else {
          records.push(record);
          if (onFile) await onFile(record, childAppRelative);
        }
      }
    };
    await walk(this.#modelsRelative, "");
    return Object.freeze(records);
  }

  async #withPinnedAppDirectory<T>(relativePath: string, use: (canonicalPath: string) => T | Promise<T>): Promise<T> {
    const authority = await this.#appAuthorityPromise;
    const request = { input: relativePath, operation: "read-directory" as const, defaultRootId: "app" };
    const before = await pathPolicy.qualifyExisting(authority, request, "directory");
    const value = await use(before.canonicalPath);
    const after: PathQualifiedResult = await pathPolicy.qualifyExisting(authority, request, "directory");
    if (!sameIdentity(before.identity, after.identity) || before.canonicalPath !== after.canonicalPath) {
      throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Bootstrap directory identity changed during third-party use");
    }
    return value;
  }
}

const bootstrapPathStore = new BootstrapPathStore();

export function getBootstrapPathStore(): BootstrapPathStore {
  return bootstrapPathStore;
}
