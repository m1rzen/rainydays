import { randomBytes } from "node:crypto";
import { getManagedPathStore } from "./managed-path-store.js";

export interface CredentialProtector {
  readonly protect: (plaintext: string) => Buffer | Promise<Buffer>;
  readonly unprotect: (ciphertext: Buffer) => string | Promise<string>;
}

export interface BackupDataKeyWrapper {
  readonly algorithm: "electron-safe-storage";
  readonly scope: "windows-dpapi-current-user-v1";
  readonly wrapDataKey: (key: Uint8Array) => Promise<Buffer>;
  readonly unwrapDataKey: (wrappedKey: Uint8Array) => Promise<Buffer>;
}

export interface SecurityAuditKeyWrapper {
  readonly algorithm: "electron-safe-storage";
  readonly scope: "windows-dpapi-current-user-v1";
  readonly wrapKey: (key: Uint8Array) => Promise<Buffer>;
  readonly unwrapKey: (wrappedKey: Uint8Array) => Promise<Buffer>;
}

type CredentialVault = Readonly<{
  schemaVersion: 2;
  entries: Readonly<Record<string, string>>;
  pendingDeletes: readonly string[];
}>;

type CredentialVaultState = {
  entries: Record<string, string>;
  pendingDeletes: Set<string>;
};

const referencePattern = /^cred_[a-f0-9]{32}$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_VAULT_ENTRIES = 1_024;
const MAX_VAULT_CIPHERTEXT_BYTES = 64 * 1024;

function decodeCanonicalBase64(value: string, label: string, maximumBytes = Number.MAX_SAFE_INTEGER): Buffer {
  if (!value || !canonicalBase64Pattern.test(value)) throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
}
let injectedProtector: CredentialProtector | null = null;
let ipcProtector: CredentialProtector | null = null;
const ipcPending = new Map<string, {
  operation: "protect" | "unprotect";
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
let ipcListenerInstalled = false;

export function configureCredentialProtector(protector: CredentialProtector): void {
  if (injectedProtector) throw new Error("Credential protector is already configured");
  if (!protector || typeof protector.protect !== "function" || typeof protector.unprotect !== "function") {
    throw new TypeError("Credential protector is invalid");
  }
  injectedProtector = Object.freeze(protector);
}

function childIpcProtector(): CredentialProtector | null {
  if (typeof process.send !== "function" || !process.connected) return null;
  if (!ipcListenerInstalled) {
    ipcListenerInstalled = true;
    process.on("message", message => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const response = message as { type?: unknown; requestId?: unknown; ok?: unknown; value?: unknown };
      if (response.type !== "rainydays-credential-result" || typeof response.requestId !== "string") return;
      const pending = ipcPending.get(response.requestId);
      if (!pending) return;
      const actualKeys = Object.keys(message).sort();
      const expectedKeys = response.ok === true ? ["ok", "requestId", "type", "value"] : ["ok", "requestId", "type"];
      const exact = actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
      clearTimeout(pending.timer);
      ipcPending.delete(response.requestId);
      if (!exact || (response.ok !== true && response.ok !== false) || (response.ok === true && typeof response.value !== "string")) {
        pending.reject(new Error("OS credential protection response is invalid"));
        return;
      }
      if (response.ok === false) {
        pending.reject(new Error("OS credential protection request failed"));
        return;
      }
      if (pending.operation === "protect") {
        try { decodeCanonicalBase64(response.value as string, "Credential protection response", MAX_VAULT_CIPHERTEXT_BYTES).fill(0); }
        catch {
          pending.reject(new Error("OS credential protection response is invalid"));
          return;
        }
      }
      pending.resolve(response.value as string);
    });
    process.on("disconnect", () => {
      for (const pending of ipcPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OS credential protection service disconnected"));
      }
      ipcPending.clear();
      ipcProtector = null;
    });
  }
  const request = (operation: "protect" | "unprotect", value: string): Promise<string> => new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      ipcPending.delete(requestId);
      reject(new Error("OS credential protection request timed out"));
    }, operation === "protect" ? 25_000 : 5_000);
    timer.unref();
    ipcPending.set(requestId, { operation, resolve, reject, timer });
    process.send?.({ type: "rainydays-credential-request", requestId, operation, value }, error => {
      if (!error) return;
      const pending = ipcPending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      ipcPending.delete(requestId);
      reject(new Error("OS credential protection request failed"));
    });
  });
  return ipcProtector ??= Object.freeze({
    protect: async (plaintext: string) => Buffer.from(await request("protect", plaintext), "base64"),
    unprotect: (ciphertext: Buffer) => request("unprotect", ciphertext.toString("base64")),
  });
}

function requireProtector(): CredentialProtector {
  const protector = injectedProtector ?? childIpcProtector();
  if (!protector) throw new Error("OS credential protection is unavailable");
  return protector;
}

export function validateCredentialReference(reference: unknown): string {
  if (typeof reference !== "string" || !referencePattern.test(reference)) throw new Error("Credential reference is invalid");
  return reference;
}

export function listCredentialVaultReferences(bytes: Buffer): readonly string[] {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Credential vault bytes are invalid");
  return Object.freeze(Object.keys(parseVault(bytes).entries).sort());
}

export function validateCredentialVaultCiphertext(bytes: Buffer): void {
  listCredentialVaultReferences(bytes);
}

export async function validateCredentialVaultDecryptable(bytes: Buffer): Promise<void> {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Credential vault bytes are invalid");
  const protector = requireProtector();
  for (const encoded of Object.values(parseVault(bytes).entries)) {
    const ciphertext = decodeCanonicalBase64(encoded, "Credential vault entry", MAX_VAULT_CIPHERTEXT_BYTES);
    try { await protector.unprotect(ciphertext); }
    catch { throw new Error("Credential vault is not decryptable by the current Windows user"); }
    finally { ciphertext.fill(0); }
  }
}

function parseVault(bytes: Buffer | null): CredentialVaultState {
  if (bytes === null) return { entries: {}, pendingDeletes: new Set() };
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Credential vault is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Credential vault schema is invalid");
  const root = parsed as { schemaVersion?: unknown; entries?: unknown; pendingDeletes?: unknown };
  const legacy = root.schemaVersion === 1;
  const expectedKeys = legacy ? ["entries", "schemaVersion"] : ["entries", "pendingDeletes", "schemaVersion"];
  if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(expectedKeys.sort())
    || (!legacy && root.schemaVersion !== 2)
    || !root.entries || typeof root.entries !== "object" || Array.isArray(root.entries)
    || (!legacy && !Array.isArray(root.pendingDeletes))) {
    throw new Error("Credential vault schema is invalid");
  }
  const rawEntries = Object.entries(root.entries as Record<string, unknown>);
  if (rawEntries.length > MAX_VAULT_ENTRIES) throw new Error("Credential vault schema is invalid");
  const entries: Record<string, string> = {};
  for (const [reference, ciphertext] of rawEntries) {
    if (!referencePattern.test(reference) || typeof ciphertext !== "string") throw new Error("Credential vault entry is invalid");
    decodeCanonicalBase64(ciphertext, "Credential vault entry", MAX_VAULT_CIPHERTEXT_BYTES);
    entries[reference] = ciphertext;
  }
  const rawPending = legacy ? [] : root.pendingDeletes as unknown[];
  if (rawPending.length > MAX_VAULT_ENTRIES || rawPending.some(reference => typeof reference !== "string" || !referencePattern.test(reference))) {
    throw new Error("Credential vault cleanup ledger is invalid");
  }
  const pendingDeletes = new Set(rawPending as string[]);
  if (pendingDeletes.size !== rawPending.length || [...pendingDeletes].some(reference => !Object.hasOwn(entries, reference))) {
    throw new Error("Credential vault cleanup ledger is invalid");
  }
  return { entries, pendingDeletes };
}

async function loadVault(): Promise<CredentialVaultState> {
  return parseVault(await (await getManagedPathStore()).readCredentialVault());
}

async function persistVault(state: CredentialVaultState): Promise<void> {
  const vault: CredentialVault = {
    schemaVersion: 2,
    entries: Object.fromEntries(Object.entries(state.entries).sort(([left], [right]) => left.localeCompare(right))),
    pendingDeletes: Object.freeze([...state.pendingDeletes].sort()),
  };
  await (await getManagedPathStore()).writeCredentialVault(Buffer.from(JSON.stringify(vault, null, 2), "utf8"));
}

const SECURITY_AUDIT_KEY_PREFIX = "rainydays-security-audit-key-v1:";

export function createSecurityAuditKeyWrapper(): SecurityAuditKeyWrapper {
  if (process.platform !== "win32") throw new Error("Security audit key protection requires Windows DPAPI");
  const protector = requireProtector();
  return Object.freeze({
    algorithm: "electron-safe-storage" as const,
    scope: "windows-dpapi-current-user-v1" as const,
    wrapKey: async (key: Uint8Array): Promise<Buffer> => {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new TypeError("Security audit key must be 32 bytes");
      const plaintext = `${SECURITY_AUDIT_KEY_PREFIX}${Buffer.from(key).toString("base64")}`;
      const wrapped = await protector.protect(plaintext);
      if (!Buffer.isBuffer(wrapped) || wrapped.length === 0 || wrapped.length > 64 * 1024) throw new Error("Security audit key wrapping failed");
      return Buffer.from(wrapped);
    },
    unwrapKey: async (wrappedKey: Uint8Array): Promise<Buffer> => {
      if (!(wrappedKey instanceof Uint8Array) || wrappedKey.byteLength === 0 || wrappedKey.byteLength > 64 * 1024) {
        throw new TypeError("Wrapped security audit key is invalid");
      }
      let plaintext: string;
      try { plaintext = await protector.unprotect(Buffer.from(wrappedKey)); }
      catch { throw new Error("Security audit key is unavailable"); }
      if (!plaintext.startsWith(SECURITY_AUDIT_KEY_PREFIX)) throw new Error("Security audit key is unavailable");
      const key = decodeCanonicalBase64(plaintext.slice(SECURITY_AUDIT_KEY_PREFIX.length), "Security audit key", 32);
      if (key.length !== 32) {
        key.fill(0);
        throw new Error("Security audit key is unavailable");
      }
      return key;
    },
  });
}

export function createBackupDataKeyWrapper(): BackupDataKeyWrapper {
  if (process.platform !== "win32") throw new Error("Backup key protection requires Windows DPAPI");
  const protector = requireProtector();
  return Object.freeze({
    algorithm: "electron-safe-storage" as const,
    scope: "windows-dpapi-current-user-v1" as const,
    wrapDataKey: async (key: Uint8Array): Promise<Buffer> => {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new TypeError("Backup data key must be 32 bytes");
      const encoded = Buffer.from(key).toString("base64");
      const wrapped = await protector.protect(encoded);
      if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) throw new Error("Backup data key wrapping failed");
      return Buffer.from(wrapped);
    },
    unwrapDataKey: async (wrappedKey: Uint8Array): Promise<Buffer> => {
      if (!(wrappedKey instanceof Uint8Array) || wrappedKey.byteLength === 0) throw new TypeError("Wrapped backup data key is invalid");
      let encoded: string;
      try { encoded = await protector.unprotect(Buffer.from(wrappedKey)); }
      catch { throw new Error("Backup is not decryptable"); }
      const key = decodeCanonicalBase64(encoded, "Backup data key", 32);
      if (key.length !== 32) {
        key.fill(0);
        throw new Error("Backup is not decryptable");
      }
      return key;
    },
  });
}

export async function readCredential(reference: string): Promise<string> {
  if (!referencePattern.test(reference)) throw new Error("Credential reference is invalid");
  const encoded = (await loadVault()).entries[reference];
  if (!encoded) throw new Error("Credential reference is unresolved");
  try { return await requireProtector().unprotect(Buffer.from(encoded, "base64")); }
  catch { throw new Error("Credential decryption failed"); }
}

/** New entries begin pending so a crash before Config publication cannot orphan them. */
export async function storeCredential(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || !plaintext) throw new Error("Credential plaintext is empty");
  const vault = await loadVault();
  if (Object.keys(vault.entries).length >= MAX_VAULT_ENTRIES) throw new Error("Credential vault capacity exceeded");
  const reference = `cred_${randomBytes(16).toString("hex")}`;
  let ciphertext: Buffer;
  try { ciphertext = await requireProtector().protect(plaintext); }
  catch { throw new Error("Credential encryption failed"); }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length > MAX_VAULT_CIPHERTEXT_BYTES) {
    ciphertext?.fill(0);
    throw new Error("Credential encryption returned invalid bytes");
  }
  try {
    vault.entries[reference] = ciphertext.toString("base64");
    vault.pendingDeletes.add(reference);
    await persistVault(vault);
  } finally { ciphertext.fill(0); }
  return reference;
}

/** Stage superseded references before Config publication; cleanup happens only after live-reference reconciliation. */
export async function stageCredentialRetirements(references: readonly string[]): Promise<void> {
  const unique = [...new Set(references.filter(reference => referencePattern.test(reference)))];
  if (unique.length === 0) return;
  const vault = await loadVault();
  let changed = false;
  for (const reference of unique) {
    if (Object.hasOwn(vault.entries, reference) && !vault.pendingDeletes.has(reference)) {
      vault.pendingDeletes.add(reference);
      changed = true;
    }
  }
  if (changed) await persistVault(vault);
}

/** Atomically keep live credentials and delete only staged references no longer reachable from Config. */
export async function reconcileCredentialRetirements(liveReferences: readonly string[]): Promise<void> {
  const live = new Set(liveReferences.map(validateCredentialReference));
  const vault = await loadVault();
  let changed = false;
  for (const reference of [...vault.pendingDeletes]) {
    if (live.has(reference)) {
      vault.pendingDeletes.delete(reference);
      changed = true;
      continue;
    }
    delete vault.entries[reference];
    vault.pendingDeletes.delete(reference);
    changed = true;
  }
  if (changed) await persistVault(vault);
}

export async function deleteCredentials(references: readonly string[]): Promise<void> {
  const unique = [...new Set(references.filter(reference => referencePattern.test(reference)))];
  if (unique.length === 0) return;
  const vault = await loadVault();
  let changed = false;
  for (const reference of unique) {
    changed = delete vault.entries[reference] || vault.pendingDeletes.delete(reference) || changed;
  }
  if (changed) await persistVault(vault);
}
