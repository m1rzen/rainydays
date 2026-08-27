import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";

const {
  BackupContainerError,
  createBackupContainer,
  materializeBackupFiles,
  openBackupContainer,
} = await import("../../dist/backup-container.js");

function wrapper(mask = 0xa7) {
  return Object.freeze({
    algorithm: "electron-safe-storage",
    scope: "windows-dpapi-current-user-v1",
    wrapDataKey: async key => {
      assert.equal(key.byteLength, 32);
      return Buffer.from([...key].map(byte => byte ^ mask));
    },
    unwrapDataKey: async wrapped => {
      assert.equal(wrapped.byteLength, 32);
      return Buffer.from([...wrapped].map(byte => byte ^ mask));
    },
  });
}

function files() {
  return [
    { role: "database-snapshot", path: "data/mini-lux.db", bytes: Buffer.from("sqlite-snapshot") },
    { role: "config", path: "config.json", bytes: Buffer.from('{"profiles":{}}') },
    { role: "credential-vault-ciphertext", path: "credentials.vault.json", bytes: Buffer.from('{"schemaVersion":1,"entries":{}}') },
  ];
}

function mutateEnvelope(container, change) {
  const value = JSON.parse(container.toString("utf8"));
  change(value);
  return Buffer.from(JSON.stringify(value), "utf8");
}

function replaceBase64Byte(value) {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 0x80;
  return bytes.toString("base64");
}

function backupFile(role, path, content = "x") {
  const bytes = Buffer.from(content, "utf8");
  return {
    role,
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content: bytes.toString("base64"),
  };
}

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    product: "RainyDays",
    createdAt: "2026-08-13T00:00:00.000Z",
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    files: [backupFile("database-snapshot", "data/mini-lux.db", "database")],
    ...overrides,
  };
}

function encryptedContainer(value, mask = 0xa7) {
  const key = Buffer.alloc(32, 0x31);
  const wrappedKey = Buffer.from([...key].map(byte => byte ^ mask));
  const nonce = Buffer.alloc(12, 0x52);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`rainydays-backup\0v1\0AES-256-GCM\0windows-dpapi-current-user-v1\0${createHash("sha256").update(wrappedKey).digest("hex")}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    purpose: "rainydays-backup",
    keyWrap: {
      algorithm: "electron-safe-storage",
      scope: "windows-dpapi-current-user-v1",
      wrappedKey: wrappedKey.toString("base64"),
    },
    encryption: {
      algorithm: "AES-256-GCM",
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  }), "utf8");
}

function formatError(error) {
  return error instanceof BackupContainerError && error.code === "BACKUP_FORMAT_INVALID";
}

test("DATA-01 backup container round-trips one authenticated allowlisted payload", async () => {
  const container = await createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    files: files(),
  }, wrapper());
  const envelopeText = container.toString("utf8");
  assert.equal(envelopeText.includes("sqlite-snapshot"), false);
  assert.equal(envelopeText.includes("credentials.vault.json"), false);

  const payload = await openBackupContainer(container, wrapper());
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.databaseSchemaVersion, 1);
  assert.equal(payload.files.length, 3);
  assert.deepEqual(materializeBackupFiles(payload).map(file => ({
    role: file.role,
    path: file.path,
    content: file.bytes.toString("utf8"),
  })), files().map(file => ({ role: file.role, path: file.path, content: file.bytes.toString("utf8") })));
});

test("DATA-01 backup container fails closed for wrong DPAPI context and authenticated-field tampering", async () => {
  const container = await createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    files: files(),
  }, wrapper());
  await assert.rejects(() => openBackupContainer(container, wrapper(0x31)), error =>
    error instanceof BackupContainerError && error.code === "BACKUP_NOT_DECRYPTABLE");

  for (const tampered of [
    mutateEnvelope(container, value => { value.keyWrap.wrappedKey = replaceBase64Byte(value.keyWrap.wrappedKey); }),
    mutateEnvelope(container, value => { value.encryption.nonce = replaceBase64Byte(value.encryption.nonce); }),
    mutateEnvelope(container, value => { value.encryption.tag = replaceBase64Byte(value.encryption.tag); }),
    mutateEnvelope(container, value => { value.encryption.ciphertext = replaceBase64Byte(value.encryption.ciphertext); }),
  ]) {
    await assert.rejects(() => openBackupContainer(tampered, wrapper()), error =>
      error instanceof BackupContainerError && error.code === "BACKUP_NOT_DECRYPTABLE");
  }
});

test("DATA-01 backup envelope rejects unknown fields, malformed base64 and unsupported algorithms before unwrap", async () => {
  const container = await createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    files: files(),
  }, wrapper());
  let unwrapCalls = 0;
  const observing = Object.freeze({
    ...wrapper(),
    unwrapDataKey: async value => { unwrapCalls += 1; return wrapper().unwrapDataKey(value); },
  });
  const invalid = [
    mutateEnvelope(container, value => { value.extra = true; }),
    mutateEnvelope(container, value => { value.encryption.algorithm = "AES-256-CBC"; }),
    mutateEnvelope(container, value => { value.encryption.nonce = "AAAAA"; }),
    mutateEnvelope(container, value => { value.keyWrap.scope = "portable"; }),
  ];
  for (const value of invalid) {
    await assert.rejects(() => openBackupContainer(value, observing), error =>
      error instanceof BackupContainerError && error.code === "BACKUP_FORMAT_INVALID");
  }
  assert.equal(unwrapCalls, 0);
});

test("DATA-01 backup payload binds each role to its one canonical managed path", async () => {
  for (const invalidFiles of [
    [{ role: "database-snapshot", path: "config.json", bytes: Buffer.from("db") }],
    [
      { role: "database-snapshot", path: "data/mini-lux.db", bytes: Buffer.from("db") },
      { role: "config", path: "data/personas/escape.md", bytes: Buffer.from("{}") },
    ],
    [
      { role: "database-snapshot", path: "data/mini-lux.db", bytes: Buffer.from("db") },
      { role: "oracle", path: "LUX.oracle", bytes: Buffer.from("{}") },
      { role: "oracle", path: "LUX.oracle.copy", bytes: Buffer.from("{}") },
    ],
    [
      { role: "database-snapshot", path: "data/mini-lux.db", bytes: Buffer.from("db") },
      { role: "playbook", path: "playbooks/../escape.json", bytes: Buffer.from("{}") },
    ],
  ]) {
    await assert.rejects(() => createBackupContainer({
      appVersion: "0.1.0",
      databaseSchemaVersion: 1,
      files: invalidFiles,
    }, wrapper()), error => error instanceof BackupContainerError && error.code === "BACKUP_FORMAT_INVALID");
  }
});

test("DATA-01 backup envelope rejects malformed structure and invalid canonical encodings before unwrap", async () => {
  const container = await createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    files: files(),
  }, wrapper());
  let unwrapCalls = 0;
  const observing = Object.freeze({
    ...wrapper(),
    unwrapDataKey: async value => { unwrapCalls += 1; return wrapper().unwrapDataKey(value); },
  });
  const invalid = [
    Buffer.alloc(0),
    Buffer.from("not-json", "utf8"),
    Buffer.from("[]", "utf8"),
    mutateEnvelope(container, value => { value.schemaVersion = 2; }),
    mutateEnvelope(container, value => { value.purpose = "other"; }),
    mutateEnvelope(container, value => { value.keyWrap = []; }),
    mutateEnvelope(container, value => { value.keyWrap.extra = true; }),
    mutateEnvelope(container, value => { value.encryption = null; }),
    mutateEnvelope(container, value => { value.encryption.extra = true; }),
    mutateEnvelope(container, value => { value.keyWrap.wrappedKey = ""; }),
    mutateEnvelope(container, value => { value.keyWrap.wrappedKey = "===="; }),
    mutateEnvelope(container, value => { value.encryption.nonce = Buffer.alloc(11).toString("base64"); }),
    mutateEnvelope(container, value => { value.encryption.tag = Buffer.alloc(15).toString("base64"); }),
    mutateEnvelope(container, value => { value.encryption.ciphertext = ""; }),
  ];
  for (const value of invalid) await assert.rejects(() => openBackupContainer(value, observing), formatError);
  assert.equal(unwrapCalls, 0);
});

test("DATA-01 authenticated payload rejects every unsupported identity and file metadata shape", () => {
  const invalidPayloads = [
    null,
    [],
    { ...payload(), unknown: true },
    payload({ schemaVersion: 2 }),
    payload({ product: "Other" }),
    payload({ createdAt: "2026-08-13" }),
    payload({ appVersion: "" }),
    payload({ appVersion: "x".repeat(129) }),
    payload({ databaseSchemaVersion: 0 }),
    payload({ databaseSchemaVersion: 1.5 }),
    payload({ files: [] }),
    payload({ files: [null] }),
    payload({ files: [{ ...backupFile("database-snapshot", "data/mini-lux.db"), unknown: true }] }),
    payload({ files: [backupFile("unknown", "data/mini-lux.db")] }),
    payload({ files: [backupFile("database-snapshot", "C:/mini-lux.db")] }),
    payload({ files: [backupFile("database-snapshot", "data\\mini-lux.db")] }),
    payload({ files: [backupFile("user-persona", "data/personas/UPPER.md")] }),
    payload({ files: [backupFile("user-persona", "data/personas/valid.json")] }),
    payload({ files: [backupFile("user-skill", "data/skills/valid.json")] }),
    payload({ files: [backupFile("playbook", "playbooks/valid.md")] }),
    payload({ files: [{ ...backupFile("database-snapshot", "data/mini-lux.db"), bytes: -1 }] }),
    payload({ files: [{ ...backupFile("database-snapshot", "data/mini-lux.db"), bytes: 1.5 }] }),
    payload({ files: [{ ...backupFile("database-snapshot", "data/mini-lux.db"), sha256: "x" }] }),
    payload({ files: [
      backupFile("database-snapshot", "data/mini-lux.db"),
      backupFile("database-snapshot", "data/mini-lux.db"),
    ] }),
    payload({ files: [
      backupFile("database-snapshot", "data/mini-lux.db"),
      { ...backupFile("config", "config.json"), path: "data/mini-lux.db" },
    ] }),
    payload({ files: [
      backupFile("database-snapshot", "data/mini-lux.db"),
      backupFile("config", "config.json"),
      backupFile("config", "config.json", "other"),
    ] }),
    payload({ files: [{
      role: "database-snapshot",
      path: "data/mini-lux.db",
      bytes: 0,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      content: "AA==",
    }] }),
    payload({ files: [backupFile("config", "config.json")] }),
  ];
  for (const value of invalidPayloads) assert.throws(() => materializeBackupFiles(value), formatError);
});

test("DATA-01 authenticated plaintext maps parser and integrity failures to stable error classes", async () => {
  await assert.rejects(
    () => openBackupContainer(encryptedContainer("not-json"), wrapper()),
    error => error instanceof BackupContainerError && error.code === "BACKUP_FORMAT_INVALID"
  );
  await assert.rejects(
    () => openBackupContainer(encryptedContainer({ ...payload(), files: [{ ...payload().files[0], sha256: "0".repeat(64) }] }), wrapper()),
    error => error instanceof BackupContainerError && error.code === "BACKUP_INTEGRITY_FAILED"
  );
  await assert.rejects(
    () => openBackupContainer(encryptedContainer(payload()), Object.freeze({ ...wrapper(), unwrapDataKey: async () => Buffer.alloc(31) })),
    error => error instanceof BackupContainerError && error.code === "BACKUP_NOT_DECRYPTABLE"
  );
  await assert.rejects(
    () => openBackupContainer(encryptedContainer(payload()), Object.freeze({ ...wrapper(), unwrapDataKey: async () => { throw new Error("DPAPI context mismatch"); } })),
    error => error instanceof BackupContainerError && error.code === "BACKUP_NOT_DECRYPTABLE"
  );
});

test("DATA-01 container creation rejects invalid wrappers, bytes and wrapped keys", async () => {
  const input = { appVersion: "0.1.0", databaseSchemaVersion: 1, files: files() };
  await assert.rejects(() => createBackupContainer(input, null), /wrapper is invalid/iu);
  await assert.rejects(() => createBackupContainer(input, { ...wrapper(), scope: "portable" }), /wrapper is invalid/iu);
  await assert.rejects(() => createBackupContainer({ ...input, files: [{ role: "database-snapshot", path: "data/mini-lux.db", bytes: "not-bytes" }] }, wrapper()), /bytes are invalid/iu);
  await assert.rejects(() => createBackupContainer(input, { ...wrapper(), wrapDataKey: async () => new Uint8Array([1]) }), /wrapping failed/iu);
  await assert.rejects(() => createBackupContainer(input, { ...wrapper(), wrapDataKey: async () => Buffer.alloc(0) }), /wrapping failed/iu);
  await assert.rejects(() => openBackupContainer(Buffer.from("{}"), null), /wrapper is invalid/iu);
});

test("DATA-01 materialization revalidates file hashes and exact payload schema", async () => {
  const bytes = Buffer.from("database");
  const payload = {
    schemaVersion: 1,
    product: "RainyDays",
    createdAt: "2026-08-13T00:00:00.000Z",
    appVersion: "0.1.0",
    databaseSchemaVersion: 1,
    files: [{
      role: "database-snapshot",
      path: "data/mini-lux.db",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("base64"),
    }],
  };
  assert.equal(materializeBackupFiles(payload)[0].bytes.toString("utf8"), "database");
  assert.throws(() => materializeBackupFiles({ ...payload, unknown: true }), error =>
    error instanceof BackupContainerError && error.code === "BACKUP_FORMAT_INVALID");
  assert.throws(() => materializeBackupFiles({
    ...payload,
    files: [{ ...payload.files[0], sha256: "0".repeat(64) }],
  }), error => error instanceof BackupContainerError && error.code === "BACKUP_INTEGRITY_FAILED");
});
