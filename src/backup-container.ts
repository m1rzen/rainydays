import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { BackupDataKeyWrapper } from "./credential-store.js";

export type BackupFileRole =
  | "database-snapshot"
  | "config"
  | "credential-vault-ciphertext"
  | "user-persona"
  | "user-skill"
  | "playbook"
  | "oracle";

export interface BackupSourceFile {
  readonly role: BackupFileRole;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface BackupPayload {
  readonly schemaVersion: 1;
  readonly product: "RainyDays";
  readonly createdAt: string;
  readonly appVersion: string;
  readonly databaseSchemaVersion: number;
  readonly files: readonly Readonly<{
    role: BackupFileRole;
    path: string;
    bytes: number;
    sha256: string;
    content: string;
  }>[];
}

interface BackupEnvelope {
  readonly schemaVersion: 1;
  readonly purpose: "rainydays-backup";
  readonly keyWrap: Readonly<{
    algorithm: "electron-safe-storage";
    scope: "windows-dpapi-current-user-v1";
    wrappedKey: string;
  }>;
  readonly encryption: Readonly<{
    algorithm: "AES-256-GCM";
    nonce: string;
    tag: string;
    ciphertext: string;
  }>;
}

const BACKUP_AAD_PREFIX = "rainydays-backup\0v1\0AES-256-GCM\0windows-dpapi-current-user-v1\0";
const MAX_FILE_COUNT = 256;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_WRAPPED_KEY_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 800 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const roles = new Set<BackupFileRole>([
  "database-snapshot", "config", "credential-vault-ciphertext", "user-persona", "user-skill", "playbook", "oracle",
]);

export class BackupContainerError extends Error {
  readonly code: "BACKUP_FORMAT_INVALID" | "BACKUP_NOT_DECRYPTABLE" | "BACKUP_INTEGRITY_FAILED";

  constructor(code: BackupContainerError["code"], message: string) {
    super(message);
    this.name = "BackupContainerError";
    this.code = code;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", `${label} fields are invalid`);
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function decodeBase64(value: unknown, label: string, expectedBytes?: number, maximumBytes = MAX_ENVELOPE_BYTES): Buffer {
  if (typeof value !== "string" || !value || !canonicalBase64Pattern.test(value)) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", `${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64") !== value
    || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", `${label} is invalid`);
  }
  return decoded;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.every(segment => segment && segment !== "." && segment !== ".." && !segment.includes(":"));
}

const managedNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const singletonPaths: Readonly<Partial<Record<BackupFileRole, string>>> = Object.freeze({
  "database-snapshot": "data/mini-lux.db",
  config: "config.json",
  "credential-vault-ciphertext": "credentials.vault.json",
  oracle: "LUX.oracle",
});

function validRolePath(role: BackupFileRole, relativePath: string): boolean {
  const singleton = singletonPaths[role];
  if (singleton !== undefined) return relativePath === singleton;
  const match = /^(data\/personas|data\/skills|playbooks)\/([^/]+)\.(md|json)$/u.exec(relativePath);
  if (!match || !managedNamePattern.test(match[2])) return false;
  if (role === "user-persona") return match[1] === "data/personas" && match[3] === "md";
  if (role === "user-skill") return match[1] === "data/skills" && match[3] === "md";
  return role === "playbook" && match[1] === "playbooks" && match[3] === "json";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function aad(wrappedKey: Uint8Array): Buffer {
  return Buffer.from(`${BACKUP_AAD_PREFIX}${sha256(wrappedKey)}`, "utf8");
}

function parseEnvelope(bytes: Uint8Array): { envelope: BackupEnvelope; wrappedKey: Buffer; nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup container size is invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup container is not valid JSON"); }
  const root = plainObject(parsed, "Backup container");
  exactKeys(root, ["schemaVersion", "purpose", "keyWrap", "encryption"], "Backup container");
  if (root.schemaVersion !== 1 || root.purpose !== "rainydays-backup") {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup container identity is invalid");
  }
  const keyWrap = plainObject(root.keyWrap, "Backup key wrap");
  exactKeys(keyWrap, ["algorithm", "scope", "wrappedKey"], "Backup key wrap");
  if (keyWrap.algorithm !== "electron-safe-storage" || keyWrap.scope !== "windows-dpapi-current-user-v1") {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup key wrap is unsupported");
  }
  const encryption = plainObject(root.encryption, "Backup encryption");
  exactKeys(encryption, ["algorithm", "nonce", "tag", "ciphertext"], "Backup encryption");
  if (encryption.algorithm !== "AES-256-GCM") {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup encryption is unsupported");
  }
  const wrappedKey = decodeBase64(keyWrap.wrappedKey, "Wrapped backup key", undefined, MAX_WRAPPED_KEY_BYTES);
  const nonce = decodeBase64(encryption.nonce, "Backup nonce", 12);
  const tag = decodeBase64(encryption.tag, "Backup tag", 16);
  const ciphertext = decodeBase64(encryption.ciphertext, "Backup ciphertext");
  return {
    envelope: root as unknown as BackupEnvelope,
    wrappedKey,
    nonce,
    tag,
    ciphertext,
  };
}

function validatePayload(value: unknown): BackupPayload {
  const root = plainObject(value, "Backup payload");
  exactKeys(root, ["schemaVersion", "product", "createdAt", "appVersion", "databaseSchemaVersion", "files"], "Backup payload");
  if (root.schemaVersion !== 1 || root.product !== "RainyDays" || !canonicalIso(root.createdAt)
    || typeof root.appVersion !== "string" || root.appVersion.length === 0 || root.appVersion.length > 128
    || !Number.isSafeInteger(root.databaseSchemaVersion) || Number(root.databaseSchemaVersion) < 1
    || !Array.isArray(root.files) || root.files.length === 0 || root.files.length > MAX_FILE_COUNT) {
    throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup payload is invalid");
  }

  let totalBytes = 0;
  let databaseCount = 0;
  const seenPaths = new Set<string>();
  const seenSingletonRoles = new Set<BackupFileRole>();
  const files = root.files.map((entry, index) => {
    const file = plainObject(entry, `Backup file ${index}`);
    exactKeys(file, ["role", "path", "bytes", "sha256", "content"], `Backup file ${index}`);
    if (!roles.has(file.role as BackupFileRole) || !validRelativePath(file.path)
      || !validRolePath(file.role as BackupFileRole, file.path)
      || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > MAX_FILE_BYTES
      || typeof file.sha256 !== "string" || !hashPattern.test(file.sha256)) {
      throw new BackupContainerError("BACKUP_FORMAT_INVALID", `Backup file ${index} metadata is invalid`);
    }
    if (seenPaths.has(file.path)) throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup file paths are duplicated");
    seenPaths.add(file.path);
    const role = file.role as BackupFileRole;
    if (singletonPaths[role] !== undefined) {
      if (seenSingletonRoles.has(role)) throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup singleton roles are duplicated");
      seenSingletonRoles.add(role);
    }
    const content = file.bytes === 0
      ? (file.content === "" ? Buffer.alloc(0) : (() => { throw new BackupContainerError("BACKUP_FORMAT_INVALID", `Backup file ${index} content is invalid`); })())
      : decodeBase64(file.content, `Backup file ${index} content`, Number(file.bytes), MAX_FILE_BYTES);
    if (sha256(content) !== file.sha256) throw new BackupContainerError("BACKUP_INTEGRITY_FAILED", `Backup file ${index} hash differs`);
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup payload is too large");
    if (file.role === "database-snapshot") databaseCount += 1;
    return Object.freeze({
      role: file.role as BackupFileRole,
      path: file.path,
      bytes: Number(file.bytes),
      sha256: file.sha256,
      content: file.content as string,
    });
  });
  if (databaseCount !== 1) throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup must contain exactly one database snapshot");
  return Object.freeze({
    schemaVersion: 1,
    product: "RainyDays",
    createdAt: root.createdAt,
    appVersion: root.appVersion as string,
    databaseSchemaVersion: Number(root.databaseSchemaVersion),
    files: Object.freeze(files),
  });
}

export async function createBackupContainer(
  input: Readonly<{ appVersion: string; databaseSchemaVersion: number; files: readonly BackupSourceFile[]; createdAt?: string }>,
  wrapper: BackupDataKeyWrapper
): Promise<Buffer> {
  if (!wrapper || wrapper.algorithm !== "electron-safe-storage" || wrapper.scope !== "windows-dpapi-current-user-v1") {
    throw new TypeError("Backup data key wrapper is invalid");
  }
  const files = input.files.map(file => {
    if (!(file.bytes instanceof Uint8Array)) throw new TypeError("Backup file bytes are invalid");
    const bytes = Buffer.from(file.bytes);
    return {
      role: file.role,
      path: file.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      content: bytes.length === 0 ? "" : bytes.toString("base64"),
    };
  });
  const payload = validatePayload({
    schemaVersion: 1,
    product: "RainyDays",
    createdAt: input.createdAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    databaseSchemaVersion: input.databaseSchemaVersion,
    files,
  });
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  let wrappedKey: Buffer | null = null;
  try {
    wrappedKey = await wrapper.wrapDataKey(key);
    if (!Buffer.isBuffer(wrappedKey) || wrappedKey.length === 0 || wrappedKey.length > MAX_WRAPPED_KEY_BYTES) {
      throw new Error("Backup data key wrapping failed");
    }
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(wrappedKey));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const envelope: BackupEnvelope = {
      schemaVersion: 1,
      purpose: "rainydays-backup",
      keyWrap: {
        algorithm: wrapper.algorithm,
        scope: wrapper.scope,
        wrappedKey: wrappedKey.toString("base64"),
      },
      encryption: {
        algorithm: "AES-256-GCM",
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    };
    return Buffer.from(JSON.stringify(envelope), "utf8");
  } finally {
    key.fill(0);
    nonce.fill(0);
    wrappedKey?.fill(0);
  }
}

export async function openBackupContainer(bytes: Uint8Array, wrapper: BackupDataKeyWrapper): Promise<BackupPayload> {
  if (!wrapper || wrapper.algorithm !== "electron-safe-storage" || wrapper.scope !== "windows-dpapi-current-user-v1") {
    throw new TypeError("Backup data key wrapper is invalid");
  }
  const parsed = parseEnvelope(bytes);
  let key: Buffer;
  try { key = await wrapper.unwrapDataKey(parsed.wrappedKey); }
  catch { throw new BackupContainerError("BACKUP_NOT_DECRYPTABLE", "Backup is not decryptable"); }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    key?.fill(0);
    throw new BackupContainerError("BACKUP_NOT_DECRYPTABLE", "Backup is not decryptable");
  }
  try {
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce);
      decipher.setAAD(aad(parsed.wrappedKey));
      decipher.setAuthTag(parsed.tag);
      plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    } catch {
      throw new BackupContainerError("BACKUP_NOT_DECRYPTABLE", "Backup is not decryptable");
    }
    try { return validatePayload(JSON.parse(plaintext.toString("utf8"))); }
    catch (error) {
      if (error instanceof BackupContainerError) throw error;
      throw new BackupContainerError("BACKUP_FORMAT_INVALID", "Backup payload is not valid JSON");
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
    parsed.wrappedKey.fill(0);
    parsed.nonce.fill(0);
    parsed.tag.fill(0);
    parsed.ciphertext.fill(0);
  }
}

export function materializeBackupFiles(payload: BackupPayload): readonly Readonly<{ role: BackupFileRole; path: string; bytes: Buffer }>[] {
  const validated = validatePayload(payload);
  return Object.freeze(validated.files.map(file => Object.freeze({
    role: file.role,
    path: file.path,
    bytes: file.bytes === 0 ? Buffer.alloc(0) : decodeBase64(file.content, "Backup file content", file.bytes, MAX_FILE_BYTES),
  })));
}
