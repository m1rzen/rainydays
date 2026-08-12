import { randomBytes } from "node:crypto";
import { getManagedPathStore } from "./managed-path-store.js";

export interface CredentialProtector {
  readonly protect: (plaintext: string) => Buffer | Promise<Buffer>;
  readonly unprotect: (ciphertext: Buffer) => string | Promise<string>;
}

type CredentialVault = Readonly<{
  schemaVersion: 1;
  entries: Readonly<Record<string, string>>;
}>;

const referencePattern = /^cred_[a-f0-9]{32}$/u;
let injectedProtector: CredentialProtector | null = null;
let ipcProtector: CredentialProtector | null = null;
const ipcPending = new Map<string, { resolve: (value: Buffer | string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
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
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "rainydays-credential-result") return;
      const response = message as { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
      if (typeof response.requestId !== "string") return;
      const pending = ipcPending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      ipcPending.delete(response.requestId);
      if (response.ok === true && typeof response.value === "string") pending.resolve(response.value);
      else pending.reject(new Error("OS credential protection request failed"));
    });
  }
  const request = (operation: "protect" | "unprotect", value: string): Promise<string> => new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      ipcPending.delete(requestId);
      reject(new Error("OS credential protection request timed out"));
    }, 5_000);
    timer.unref();
    ipcPending.set(requestId, { resolve: result => resolve(String(result)), reject, timer });
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

function parseVault(bytes: Buffer | null): Record<string, string> {
  if (bytes === null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Credential vault is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    || !(parsed as { entries?: unknown }).entries || typeof (parsed as { entries: unknown }).entries !== "object"
    || Array.isArray((parsed as { entries: unknown }).entries)) {
    throw new Error("Credential vault schema is invalid");
  }
  const result: Record<string, string> = {};
  for (const [reference, ciphertext] of Object.entries((parsed as { entries: Record<string, unknown> }).entries)) {
    if (!referencePattern.test(reference) || typeof ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(ciphertext)) {
      throw new Error("Credential vault entry is invalid");
    }
    result[reference] = ciphertext;
  }
  return result;
}

async function loadEntries(): Promise<Record<string, string>> {
  return parseVault(await (await getManagedPathStore()).readCredentialVault());
}

async function persistEntries(entries: Record<string, string>): Promise<void> {
  const vault: CredentialVault = { schemaVersion: 1, entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) };
  await (await getManagedPathStore()).writeCredentialVault(Buffer.from(JSON.stringify(vault, null, 2), "utf8"));
}

export async function readCredential(reference: string): Promise<string> {
  if (!referencePattern.test(reference)) throw new Error("Credential reference is invalid");
  const encoded = (await loadEntries())[reference];
  if (!encoded) throw new Error("Credential reference is unresolved");
  try { return await requireProtector().unprotect(Buffer.from(encoded, "base64")); }
  catch { throw new Error("Credential decryption failed"); }
}

export async function storeCredential(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || !plaintext) throw new Error("Credential plaintext is empty");
  const reference = `cred_${randomBytes(16).toString("hex")}`;
  const entries = await loadEntries();
  let ciphertext: Buffer;
  try { ciphertext = await requireProtector().protect(plaintext); }
  catch { throw new Error("Credential encryption failed"); }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new Error("Credential encryption returned invalid bytes");
  entries[reference] = ciphertext.toString("base64");
  await persistEntries(entries);
  return reference;
}

export async function deleteCredentials(references: readonly string[]): Promise<void> {
  const unique = [...new Set(references.filter(reference => referencePattern.test(reference)))];
  if (unique.length === 0) return;
  const entries = await loadEntries();
  let changed = false;
  for (const reference of unique) changed = delete entries[reference] || changed;
  if (changed) await persistEntries(entries);
}
