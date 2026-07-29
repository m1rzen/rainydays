import path from "node:path";
import { PathDeniedError, type PathAuthority, type PathOperation } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import {
  BUILTIN_PERSONAS_DIR,
  BUILTIN_SKILLS_DIR,
  CONFIG_PATH,
  ORACLE_PATH,
  PLAYBOOKS_DIR,
  USER_DATA_DIR,
  USER_PERSONAS_DIR,
  USER_SKILLS_DIR,
  validateOptionalBootstrapDescendant,
} from "./runtime-paths.js";

export type ManagedStoreRole =
  | "builtin-personas"
  | "user-personas"
  | "builtin-skills"
  | "user-skills"
  | "playbooks"
  | "config";

interface ManagedRoot {
  readonly rootId: string;
  readonly authority: PathAuthority;
}

const READ_BYTES = 4 * 1024 * 1024;
const WRITE_BYTES = 4 * 1024 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const readPermissions: readonly PathOperation[] = Object.freeze(["read-file", "read-directory"]);

const roleConfig: Readonly<Record<ManagedStoreRole, Readonly<{
  rootId: string;
  directory: string;
  writable: boolean;
  replaceable?: boolean;
}>>> = Object.freeze({
  "builtin-personas": Object.freeze({ rootId: "builtin-personas", directory: BUILTIN_PERSONAS_DIR, writable: false }),
  "user-personas": Object.freeze({ rootId: "user-personas", directory: USER_PERSONAS_DIR, writable: true }),
  "builtin-skills": Object.freeze({ rootId: "builtin-skills", directory: BUILTIN_SKILLS_DIR, writable: false }),
  "user-skills": Object.freeze({ rootId: "user-skills", directory: USER_SKILLS_DIR, writable: false }),
  playbooks: Object.freeze({ rootId: "playbooks", directory: PLAYBOOKS_DIR, writable: true }),
  config: Object.freeze({ rootId: "config", directory: path.dirname(CONFIG_PATH), writable: true, replaceable: true }),
});

export function validateManagedIdentifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new PathDeniedError("PATH_INPUT_INVALID", "Managed identifier denied");
  }
  return value;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function probeDirectory(directory: string, rootId: string): Promise<boolean> {
  try {
    const probe = await pathPolicy.createAuthority([{
      rootId,
      role: "managed-probe",
      configuredPath: directory,
      permissions: readPermissions,
    }]);
    pathPolicy.revoke(probe);
    return true;
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_ROOT_UNAVAILABLE") return false;
    throw error;
  }
}

async function ensureManagedDirectory(directory: string, rootId: string): Promise<void> {
  if (await probeDirectory(directory, rootId)) return;
  const userData = path.resolve(USER_DATA_DIR);
  const target = path.resolve(directory);
  if (!inside(userData, target) || target === userData) {
    throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", "Managed root unavailable");
  }
  const relative = path.relative(userData, target);
  const bootstrap = await pathPolicy.createAuthority([{
    rootId: "user-data-bootstrap",
    role: "bootstrap",
    configuredPath: userData,
    permissions: ["create-file", "replace-file"],
  }]);
  try {
    await pathPolicy.createOrReplaceFile(
      bootstrap,
      {
        input: path.join(relative, ".mini-lux-managed-root"),
        operation: "create-file",
        defaultRootId: "user-data-bootstrap",
      },
      Buffer.alloc(0),
      1
    );
  } finally {
    pathPolicy.revoke(bootstrap);
  }
  if (!(await probeDirectory(target, rootId))) throw new PathDeniedError("PATH_ROOT_UNAVAILABLE", "Managed root unavailable");
}

async function prepareRoot(role: ManagedStoreRole): Promise<ManagedRoot> {
  const config = roleConfig[role];
  if (role === "config" && !inside(path.resolve(USER_DATA_DIR), path.resolve(config.directory))) {
    throw new PathDeniedError("PATH_ROOT_DENIED", "Config store must remain under user data");
  }
  await ensureManagedDirectory(config.directory, config.rootId);
  const permissions: PathOperation[] = [...readPermissions];
  if (config.writable) permissions.push("create-file");
  if (config.replaceable) permissions.push("replace-file");
  const authority = await pathPolicy.createAuthority([{
    rootId: config.rootId,
    role,
    configuredPath: config.directory,
    permissions,
  }]);
  return Object.freeze({ rootId: config.rootId, authority });
}

export class ManagedPathStore {
  readonly #rootPromises = new Map<ManagedStoreRole, Promise<ManagedRoot>>();
  #oraclePromise: Promise<ManagedRoot> | null = null;
  readonly #oracleFileName = path.basename(ORACLE_PATH);
  readonly #configFileName = path.basename(CONFIG_PATH);

  async listNames(role: ManagedStoreRole, extension: ".md" | ".json"): Promise<string[]> {
    const root = await this.#root(role);
    const entries = await pathPolicy.listDirectory(root.authority, {
      input: "",
      operation: "read-directory",
      defaultRootId: root.rootId,
    });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(extension)) continue;
      const name = entry.name.slice(0, -extension.length);
      if (identifierPattern.test(name)) names.push(name);
    }
    return names.sort();
  }

  async readNamed(role: ManagedStoreRole, name: string, extension: ".md" | ".json"): Promise<Buffer> {
    const root = await this.#root(role);
    const safeName = validateManagedIdentifier(name);
    const result = await pathPolicy.readFile(root.authority, {
      input: `${safeName}${extension}`,
      operation: "read-file",
      defaultRootId: root.rootId,
    }, READ_BYTES);
    return Buffer.from(result.bytes);
  }

  async createNamed(role: "user-personas" | "playbooks", name: string, extension: ".md" | ".json", bytes: Uint8Array): Promise<void> {
    const root = await this.#root(role);
    const safeName = validateManagedIdentifier(name);
    await pathPolicy.createFile(root.authority, {
      input: `${safeName}${extension}`,
      operation: "create-file",
      defaultRootId: root.rootId,
      requiredExtension: extension,
    }, bytes, WRITE_BYTES);
  }

  async readConfig(): Promise<Buffer | null> {
    const root = await this.#root("config");
    try {
      const result = await pathPolicy.readFile(root.authority, {
        input: this.#configFileName,
        operation: "read-file",
        defaultRootId: root.rootId,
        requiredExtension: ".json",
      }, READ_BYTES);
      return Buffer.from(result.bytes);
    } catch (error) {
      if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
      throw error;
    }
  }

  async writeConfig(bytes: Uint8Array): Promise<void> {
    const root = await this.#root("config");
    await pathPolicy.atomicCreateOrReplaceFile(root.authority, {
      input: this.#configFileName,
      operation: "create-file",
      defaultRootId: root.rootId,
      requiredExtension: ".json",
    }, bytes, WRITE_BYTES);
  }

  async readOracle(): Promise<Buffer | null> {
    const oracle = await this.#oracleRoot();
    try {
      const result = await pathPolicy.readFile(oracle.authority, {
        input: this.#oracleFileName,
        operation: "read-file",
        defaultRootId: oracle.rootId,
      }, READ_BYTES);
      return Buffer.from(result.bytes);
    } catch (error) {
      if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
      throw error;
    }
  }

  async writeOracle(bytes: Uint8Array): Promise<void> {
    const oracle = await this.#oracleRoot();
    await pathPolicy.createOrReplaceFile(oracle.authority, {
      input: this.#oracleFileName,
      operation: "create-file",
      defaultRootId: oracle.rootId,
    }, bytes, WRITE_BYTES);
  }

  #root(role: ManagedStoreRole): Promise<ManagedRoot> {
    const existing = this.#rootPromises.get(role);
    if (existing) return existing;
    const preparing = prepareRoot(role).catch((error) => {
      this.#rootPromises.delete(role);
      throw error;
    });
    this.#rootPromises.set(role, preparing);
    return preparing;
  }

  #oracleRoot(): Promise<ManagedRoot> {
    if (this.#oraclePromise) return this.#oraclePromise;
    const preparing = (async () => {
      await validateOptionalBootstrapDescendant(ORACLE_PATH, USER_DATA_DIR, "oracle");
      const oracleDirectory = path.dirname(ORACLE_PATH);
      await ensureManagedDirectory(oracleDirectory, "oracle-store");
      const authority = await pathPolicy.createAuthority([{
        rootId: "oracle-store",
        role: "oracle",
        configuredPath: oracleDirectory,
        permissions: ["read-file", "create-file", "replace-file"],
      }]);
      return Object.freeze({ rootId: "oracle-store", authority });
    })().catch((error) => {
      this.#oraclePromise = null;
      throw error;
    });
    this.#oraclePromise = preparing;
    return preparing;
  }
}

const managedStore = new ManagedPathStore();

export function getManagedPathStore(): Promise<ManagedPathStore> {
  return Promise.resolve(managedStore);
}
