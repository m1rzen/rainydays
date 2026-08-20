import { createBackupContainer, materializeBackupFiles, openBackupContainer, type BackupSourceFile } from "./backup-container.js";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { validatePersistedConfigBytes } from "./config.js";
import { createBackupDataKeyWrapper, createSecurityAuditKeyWrapper, listCredentialVaultReferences, validateCredentialVaultDecryptable } from "./credential-store.js";
import { createConsistentDatabaseSnapshot, validateDatabaseRestoreCandidate, validateDatabaseRestoreSecurityAudit } from "./db.js";
import { getManagedPathStore } from "./managed-path-store.js";
import { validateOracleSnapshot } from "./oracle.js";
import { validatePersonaSource } from "./persona.js";
import { validatePlaybookSource } from "./playbook.js";
import { APP_VERSION } from "./version.js";

export interface ManagedRestorePlan {
  readonly sourceAppVersion: string;
  readonly databaseSchemaVersion: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly publish: () => Promise<Readonly<{ transactionId: string; fileCount: number; cleanupPending: boolean }>>;
  readonly discard: () => Promise<void>;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function collectNamed(
  role: "user-personas" | "user-skills" | "playbooks",
  extension: ".md" | ".json",
  backupRole: "user-persona" | "user-skill" | "playbook",
  prefix: string
): Promise<BackupSourceFile[]> {
  const store = await getManagedPathStore();
  const files: BackupSourceFile[] = [];
  for (const name of await store.listNames(role, extension)) {
    files.push(Object.freeze({
      role: backupRole,
      path: `${prefix}/${name}${extension}`,
      bytes: await store.readNamed(role, name, extension),
    }));
  }
  return files;
}

export async function createManagedBackup(): Promise<Buffer> {
  const store = await getManagedPathStore();
  const snapshot = await createConsistentDatabaseSnapshot();
  const files: BackupSourceFile[] = [{
    role: "database-snapshot",
    path: "data/mini-lux.db",
    bytes: snapshot.bytes,
  }];
  const [config, vault, oracle, personas, skills, playbooks] = await Promise.all([
    store.readConfig(),
    store.readCredentialVault(),
    store.readOracle(),
    collectNamed("user-personas", ".md", "user-persona", "data/personas"),
    collectNamed("user-skills", ".md", "user-skill", "data/skills"),
    collectNamed("playbooks", ".json", "playbook", "playbooks"),
  ]);
  if (config) files.push({ role: "config", path: "config.json", bytes: config });
  if (vault) files.push({ role: "credential-vault-ciphertext", path: "credentials.vault.json", bytes: vault });
  if (oracle) files.push({ role: "oracle", path: "LUX.oracle", bytes: oracle });
  files.push(...personas, ...skills, ...playbooks);
  try {
    await validateManagedFiles(files.map(file => Object.freeze({ role: file.role, path: file.path, bytes: file.bytes as Buffer })));
    return await createBackupContainer({
      appVersion: APP_VERSION,
      databaseSchemaVersion: snapshot.validation.schemaVersion,
      files,
    }, createBackupDataKeyWrapper());
  } finally {
    for (const file of files) if (Buffer.isBuffer(file.bytes)) file.bytes.fill(0);
  }
}

async function validateManagedFiles(files: readonly Readonly<{ role: string; path: string; bytes: Buffer }>[]): Promise<void> {
  const byPath = new Map(files.map(file => [file.path, file]));
  const skillSources = new Map<string, string>();
  for (const file of files) {
    if (file.role === "user-skill") {
      const name = file.path.slice("data/skills/".length, -".md".length);
      skillSources.set(name, file.bytes.toString("utf8").trim());
    }
  }
  for (const file of files) {
    if (file.role === "playbook") {
      const name = file.path.slice("playbooks/".length, -".json".length);
      validatePlaybookSource(name, file.bytes);
    } else if (file.role === "oracle") {
      validateOracleSnapshot(parseJson(file.bytes, "Oracle backup"));
    } else if (file.role === "user-persona") {
      const name = file.path.slice("data/personas/".length, -".md".length);
      await validatePersonaSource(name, file.bytes, async skillName => skillSources.get(skillName) ?? null);
    }
  }
  const config = byPath.get("config.json");
  const vault = byPath.get("credentials.vault.json");
  const references = config ? validatePersistedConfigBytes(config.bytes) : Object.freeze([] as string[]);
  const available = new Set(vault ? listCredentialVaultReferences(vault.bytes) : []);
  if (references.some(reference => !available.has(reference))) {
    throw new Error("Backup config references credentials that are absent from the encrypted vault");
  }
  if (vault) await validateCredentialVaultDecryptable(vault.bytes);
}

export async function prepareManagedRestore(container: Uint8Array): Promise<ManagedRestorePlan> {
  const payload = await openBackupContainer(container, createBackupDataKeyWrapper());
  if (payload.appVersion !== APP_VERSION) {
    throw new Error(`Backup app version is incompatible: ${payload.appVersion}`);
  }
  const files = materializeBackupFiles(payload);
  try {
    await validateManagedFiles(files);
    const database = files.find(file => file.role === "database-snapshot");
    if (!database) throw new Error("Backup database snapshot is missing");
    const auditWrapper = createSecurityAuditKeyWrapper();
    await validateDatabaseRestoreSecurityAudit(database.bytes, auditWrapper.unwrapKey);
    const validationLease = await getBootstrapPathStore().stageValidatedDatabaseRestore(
      database.bytes,
      candidate => { validateDatabaseRestoreCandidate(candidate, payload.databaseSchemaVersion); }
    );
    await validationLease.discard();
  } catch (error) {
    for (const file of files) file.bytes.fill(0);
    throw error;
  }
  const wrapper = createBackupDataKeyWrapper();
  let active = true;
  const clear = (): void => {
    active = false;
    for (const file of files) file.bytes.fill(0);
  };
  return Object.freeze({
    sourceAppVersion: payload.appVersion,
    databaseSchemaVersion: payload.databaseSchemaVersion,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    publish: async () => {
      if (!active) throw new Error("Managed restore plan is closed");
      const result = await getBootstrapPathStore().publishManagedRestore(files.map(file => Object.freeze({ path: file.path, bytes: file.bytes })), wrapper);
      clear();
      return result;
    },
    discard: async () => {
      if (!active) throw new Error("Managed restore plan is closed");
      clear();
    },
  });
}
