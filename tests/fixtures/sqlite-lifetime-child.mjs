import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [scenario, fixture, outside] = process.argv.slice(2);
assert(["normal", "sidecar-link", "main-replacement", "main-hardlink", "crud", "snapshot", "restore", "restore-sidecar", "restore-config-mismatch", "restore-dpapi-preflight", "restore-rich-managed", "restore-primitives", "security-audit", "wal-corruption"].includes(scenario));
assert(path.isAbsolute(fixture));
assert(path.isAbsolute(outside));

process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");

await fs.mkdir(path.join(fixture, "data"), { recursive: true });
await fs.mkdir(outside, { recursive: true });

const { openBootstrapDatabase } = await import("../../dist/bootstrap-database.js");
const { getBootstrapPathStore } = await import("../../dist/bootstrap-path-store.js");
const { PathDeniedError } = await import("../../dist/path-policy.js");
const mainPath = path.join(fixture, "data", "mini-lux.db");

if (scenario === "normal") {
  const connection = await openBootstrapDatabase(1);
  connection.database.exec("CREATE TABLE lifetime_probe(value TEXT)");
  const insert = connection.database.transaction(value => {
    connection.database.prepare("INSERT INTO lifetime_probe(value) VALUES (?)").run(value);
  });
  insert("kept");
  assert.equal(connection.database.prepare("SELECT value FROM lifetime_probe").get().value, "kept");
  await assert.rejects(() => getBootstrapPathStore().close(), /lease is still active/);
  await connection.close();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, transactionGuarded: true, activeLeaseBlockedRetirement: true, cleanClose: true }));
} else if (scenario === "sidecar-link") {
  await fs.writeFile(mainPath, Buffer.alloc(0));
  const sentinel = path.join(outside, "sentinel.wal");
  const original = Buffer.from("OUTSIDE-WAL-SENTINEL");
  await fs.writeFile(sentinel, original);
  await fs.symlink(sentinel, `${mainPath}-wal`, "file");
  let code = null;
  await assert.rejects(() => openBootstrapDatabase(1), error => {
    code = error instanceof PathDeniedError ? error.code : null;
    return code === "PATH_REDIRECT_DENIED";
  });
  assert.deepEqual(await fs.readFile(sentinel), original);
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, code, externalUnchanged: true }));
} else if (scenario === "main-replacement") {
  const connection = await openBootstrapDatabase(1);
  connection.database.exec("CREATE TABLE replacement_probe(value TEXT)");
  connection.database.prepare("INSERT INTO replacement_probe(value) VALUES (?)").run("old-object");
  const oldPath = path.join(fixture, "data", "old-mini-lux.db");
  let replacementCode = null;
  try {
    await fs.rename(mainPath, oldPath);
  } catch (error) {
    replacementCode = error?.code ?? null;
  }
  assert(["EBUSY", "EACCES", "EPERM"].includes(replacementCode));
  assert.equal(connection.database.prepare("SELECT value FROM replacement_probe").get().value, "old-object");
  await connection.close();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, replacementCode, replacementAttemptDenied: true, originalReadable: true, cleanClose: true }));
} else if (scenario === "main-hardlink") {
  const connection = await openBootstrapDatabase(1);
  connection.database.exec("CREATE TABLE hardlink_probe(value TEXT)");
  connection.database.prepare("INSERT INTO hardlink_probe(value) VALUES (?)").run("original-object");
  const aliasPath = path.join(outside, "outside-alias.db");
  await fs.link(mainPath, aliasPath);
  assert.equal(Number((await fs.stat(mainPath)).nlink), 2);
  let code = null;
  assert.throws(() => connection.database.prepare("SELECT value FROM hardlink_probe"), error => {
    code = error instanceof PathDeniedError ? error.code : null;
    return code === "PATH_IDENTITY_CHANGED";
  });
  let closeCode = null;
  await assert.rejects(() => connection.close(), error => {
    closeCode = error instanceof PathDeniedError ? error.code : null;
    return closeCode === "PATH_AUTHORITY_STALE";
  });
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, code, closeCode, linkCount: 2, operationDenied: true, poisonedHandleDrained: true, bootstrapRetired: true }));
} else if (scenario === "restore" || scenario === "restore-sidecar") {
  const credentialStore = await import("../../dist/credential-store.js");
  credentialStore.configureCredentialProtector(Object.freeze({
    protect: plaintext => Buffer.from(`wrapped:${plaintext}`, "utf8"),
    unprotect: ciphertext => {
      const text = Buffer.from(ciphertext).toString("utf8");
      assert.match(text, /^wrapped:/u);
      return text.slice("wrapped:".length);
    },
  }));
  const db = await import("../../dist/db.js");
  const now = new Date().toISOString();
  db.insertSession({ id: "before-backup", persona_name: "developer", title: "Before", created_at: now, updated_at: now });
  const { createManagedBackup, prepareManagedRestore } = await import("../../dist/data-backup.js");
  const backup = await createManagedBackup();
  db.insertSession({ id: "after-backup", persona_name: "developer", title: "After", created_at: now, updated_at: now });
  const plan = await prepareManagedRestore(backup);
  await assert.rejects(() => plan.publish(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await db.closeDb();
  if (scenario === "restore-sidecar") {
    const sidecar = `${mainPath}-wal`;
    const sentinel = Buffer.from("restore-sidecar-sentinel");
    await fs.writeFile(sidecar, sentinel);
    await assert.rejects(() => plan.publish(), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
    assert.deepEqual(await fs.readFile(sidecar), sentinel);
    await plan.discard();
    await fs.unlink(sidecar);
    await getBootstrapPathStore().close();
    console.log(JSON.stringify({ scenario, liveSidecarDenied: true, liveSidecarUnchanged: true, discardAfterDenial: true }));
  } else {
    const result = await plan.publish();
    assert.equal(result.fileCount >= 4, true);
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    await assert.rejects(() => plan.publish(), /closed/u);
    const restored = new Database(mainPath, { readonly: true, fileMustExist: true });
    let before;
    let after;
    try {
      before = restored.prepare("SELECT title FROM sessions WHERE id = ?").get("before-backup")?.title;
      after = restored.prepare("SELECT title FROM sessions WHERE id = ?").get("after-backup")?.title;
    } finally {
      restored.close();
    }
    assert.equal(before, "Before");
    assert.equal(after, undefined);
    await getBootstrapPathStore().close();
    console.log(JSON.stringify({ scenario, activeDatabaseDenied: true, publishAfterCloseSucceeded: true, postBackupMutationAbsent: true, oneShot: true }));
  }
} else if (scenario === "restore-rich-managed") {
  const credentialStore = await import("../../dist/credential-store.js");
  credentialStore.configureCredentialProtector(Object.freeze({
    protect: plaintext => Buffer.from(`wrapped:${plaintext}`, "utf8"),
    unprotect: ciphertext => Buffer.from(ciphertext).toString("utf8").slice("wrapped:".length),
  }));
  const skillDirectory = path.join(fixture, "data", "skills");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, "backup-skill.md"), "Skill body");
  const config = await import("../../dist/config.js");
  await config.initializeConfig();
  await config.upsertProfile("backup", {
    model: "backup-model",
    baseURL: "https://provider.example/v1",
    apiKey: "backup-secret",
    providerType: "openai-compatible",
  });
  const managed = await import("../../dist/managed-path-store.js");
  const store = await managed.getManagedPathStore();
  await store.createNamed("user-personas", "backup-persona", ".md", Buffer.from([
    "---",
    "name: backup-persona",
    "skills: [backup-skill]",
    "tools: []",
    "network_policy: deny",
    "---",
    "Persona body",
  ].join("\n"), "utf8"));
  await store.createNamed("playbooks", "backup-playbook", ".json", Buffer.from(JSON.stringify({
    name: "backup-playbook",
    description: "Backup playbook",
    steps: [{ message: "Run", description: "One" }],
  }), "utf8"));
  await store.writeOracle(Buffer.from(JSON.stringify({
    createdAt: "2026-08-13T00:00:00.000Z",
    projectPath: ".",
    summary: "summary",
    tree: "tree",
    headers: { "README.md": ["header"] },
  }), "utf8"));
  const { createManagedBackup, prepareManagedRestore } = await import("../../dist/data-backup.js");
  const backup = await createManagedBackup();
  const opened = await (await import("../../dist/backup-container.js")).openBackupContainer(
    backup,
    credentialStore.createBackupDataKeyWrapper()
  );
  assert.deepEqual(new Set(opened.files.map(file => file.role)), new Set([
    "database-snapshot",
    "config",
    "credential-vault-ciphertext",
    "oracle",
    "user-persona",
    "user-skill",
    "playbook",
  ]));
  const backupContainer = await import("../../dist/backup-container.js");
  const expectedFiles = backupContainer.materializeBackupFiles(opened);
  const discardPlan = await prepareManagedRestore(backup);
  assert.equal(discardPlan.sourceAppVersion, "0.1.0");
  assert.equal(discardPlan.fileCount, 7);
  assert.equal(discardPlan.totalBytes > 0, true);
  await discardPlan.discard();
  await assert.rejects(() => discardPlan.discard(), /closed/u);
  const plan = await prepareManagedRestore(backup);

  const db = await import("../../dist/db.js");
  const snapshot = await db.createConsistentDatabaseSnapshot();
  const incompatible = await backupContainer.createBackupContainer({
    appVersion: "9.9.9",
    databaseSchemaVersion: 8,
    files: [{ role: "database-snapshot", path: "data/mini-lux.db", bytes: snapshot.bytes }],
  }, credentialStore.createBackupDataKeyWrapper());
  await assert.rejects(() => prepareManagedRestore(incompatible), /app version is incompatible/iu);

  await config.upsertProfile("backup", {
    model: "live-model-a",
    baseURL: "https://provider.example/v1",
    apiKey: "live-secret-a",
    providerType: "openai-compatible",
  });
  await store.writeOracle(Buffer.from(JSON.stringify({
    createdAt: "2026-08-13T00:00:00.000Z",
    projectPath: ".",
    summary: "live-generation-a",
    tree: "tree",
    headers: { "README.md": ["header"] },
  }), "utf8"));
  await fs.writeFile(path.join(skillDirectory, "backup-skill.md"), "Live skill A");
  await fs.writeFile(path.join(skillDirectory, "live-only.md"), "Live-only skill A");
  await fs.writeFile(path.join(fixture, "data", "personas", "backup-persona.md"), "Live persona A");
  await fs.writeFile(path.join(fixture, "data", "personas", "live-only.md"), "Live-only persona A");
  await fs.writeFile(path.join(fixture, "playbooks", "backup-playbook.json"), JSON.stringify({ generation: "a" }));
  await fs.writeFile(path.join(fixture, "playbooks", "live-only.json"), JSON.stringify({ generation: "a-only" }));

  await db.closeDb();
  const published = await plan.publish();
  assert.equal(published.cleanupPending, false);
  await assert.rejects(() => plan.publish(), /closed/u);
  for (const expected of expectedFiles) {
    assert.deepEqual(await fs.readFile(path.join(fixture, ...expected.path.split("/"))), expected.bytes, expected.path);
    expected.bytes.fill(0);
  }
  for (const liveOnly of [
    path.join(skillDirectory, "live-only.md"),
    path.join(fixture, "data", "personas", "live-only.md"),
    path.join(fixture, "playbooks", "live-only.json"),
  ]) assert.equal(await fs.access(liveOnly).then(() => true, () => false), false, liveOnly);
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, allManagedRoles: true, discardOneShot: true, incompatibleVersionDenied: true, exactSetPublished: true, cleanClose: true }));
} else if (scenario === "restore-primitives") {
  const db = await import("../../dist/db.js");
  const snapshot = await db.createConsistentDatabaseSnapshot();
  const bootstrapDatabase = await import("../../dist/bootstrap-database.js");
  assert.throws(() => bootstrapDatabase.createInMemoryBootstrapDatabase(Buffer.alloc(0)), /snapshot is invalid/iu);
  assert.throws(() => bootstrapDatabase.validateDatabaseSnapshotFile("relative.db", 1), /path is invalid/iu);
  assert.throws(() => bootstrapDatabase.validateDatabaseSnapshotFile(mainPath, 0), /schema version is invalid/iu);
  assert.throws(() => db.validateDatabaseRestoreCandidate(mainPath, 5), /schema version is incompatible/iu);
  await assert.rejects(() => bootstrapDatabase.writeConsistentDatabaseSnapshot(null, mainPath), /source is invalid/iu);
  await assert.rejects(() => bootstrapDatabase.writeConsistentDatabaseSnapshot({}, "relative.db"), /source is invalid/iu);
  await assert.rejects(() => bootstrapDatabase.writeConsistentDatabaseSnapshot(db.db, "relative.db"), /destination is invalid/iu);
  await assert.rejects(() => bootstrapDatabase.openBootstrapDatabase(-1), /maximum database schema version is invalid/iu);
  assert.throws(() => db.db.close(), /must release the bootstrap lease/iu);
  await db.closeDb();

  const store = getBootstrapPathStore();
  await assert.rejects(() => store.withDatabaseSnapshotFile(null), /callback is invalid/iu);
  await assert.rejects(() => store.stageValidatedDatabaseRestore(Buffer.alloc(0), () => {}), /bytes are invalid/iu);
  await assert.rejects(() => store.stageValidatedDatabaseRestore(snapshot.bytes, null), /validator is invalid/iu);
  await assert.rejects(
    () => store.stageValidatedDatabaseRestore(snapshot.bytes, () => { throw new Error("candidate rejected"); }),
    /candidate rejected/u
  );
  const lease = await store.stageValidatedDatabaseRestore(
    snapshot.bytes,
    candidate => db.validateDatabaseRestoreCandidate(candidate, 10)
  );
  assert.equal(lease.isActive(), true);
  assert.deepEqual(await lease.readBytes(), snapshot.bytes);
  await assert.rejects(() => store.close(), /restore lease is still active/iu);
  await lease.discard();
  assert.equal(lease.isActive(), false);
  await assert.rejects(() => lease.readBytes(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await assert.rejects(() => lease.discard(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await assert.rejects(() => lease.publish(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");

  const publishLease = await store.stageValidatedDatabaseRestore(
    snapshot.bytes,
    candidate => db.validateDatabaseRestoreCandidate(candidate, 10)
  );
  const activeConnection = await openBootstrapDatabase(10);
  await assert.rejects(() => publishLease.publish(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await activeConnection.close();

  const sidecar = `${mainPath}-wal`;
  const sidecarSentinel = Buffer.from("staged-restore-sidecar");
  await fs.writeFile(sidecar, sidecarSentinel);
  await assert.rejects(() => publishLease.publish(), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
  assert.deepEqual(await fs.readFile(sidecar), sidecarSentinel);
  await fs.unlink(sidecar);

  const aliasPath = path.join(outside, "staged-restore-alias.db");
  await fs.link(mainPath, aliasPath);
  await assert.rejects(() => publishLease.publish(), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
  await fs.unlink(aliasPath);

  await publishLease.publish();
  assert.equal(publishLease.isActive(), false);
  await assert.rejects(() => publishLease.publish(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");

  await assert.rejects(() => store.withTemporaryDirectory("../invalid", () => undefined), /prefix is invalid/iu);
  const rawDatabaseLease = await store.openDatabaseFileLease();
  await rawDatabaseLease.close();
  await assert.rejects(() => rawDatabaseLease.assertPathCurrent(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await rawDatabaseLease.close();

  const runtimeLease = await store.openNodeExecutable();
  await assert.rejects(() => store.close(), /runtime bootstrap lease is still active/iu);
  await runtimeLease.close();
  await assert.rejects(() => runtimeLease.assertCurrent(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  await runtimeLease.close();
  await store.close();
  console.log(JSON.stringify({
    scenario,
    invalidArgumentsDenied: true,
    rejectedCandidateCleaned: true,
    activeLeaseBlockedRetirement: true,
    oneShotLease: true,
    activeDatabaseDenied: true,
    sidecarDeniedUnchanged: true,
    multiLinkDenied: true,
    publishAfterDenialsSucceeded: true,
    invalidTemporaryPrefixDenied: true,
    closedDatabaseLeaseDenied: true,
    activeRuntimeLeaseBlockedRetirement: true,
    closedRuntimeLeaseDenied: true,
  }));
} else if (scenario === "restore-dpapi-preflight") {
  const credentialStore = await import("../../dist/credential-store.js");
  credentialStore.configureCredentialProtector(Object.freeze({
    protect: plaintext => Buffer.from(`wrapped:${plaintext}`, "utf8"),
    unprotect: ciphertext => {
      const value = Buffer.from(ciphertext).toString("utf8");
      if (!value.startsWith("wrapped:")) throw new Error("foreign DPAPI user");
      return value.slice("wrapped:".length);
    },
  }));
  const db = await import("../../dist/db.js");
  const backupContainer = await import("../../dist/backup-container.js");
  const { prepareManagedRestore } = await import("../../dist/data-backup.js");
  const snapshot = await db.createConsistentDatabaseSnapshot();
  const reference = `cred_${"b".repeat(32)}`;
  const config = Buffer.from(JSON.stringify({
    defaultProfile: "default",
    profiles: { default: { model: "model", credentialRef: reference, baseURL: "https://provider.example", providerType: "openai-compatible" } },
    settings: { defaultPersona: "developer", workspaceRoot: fixture, departmentDataRoot: fixture, outputDir: fixture },
  }), "utf8");
  const foreignVault = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    entries: { [reference]: Buffer.from("foreign-user-ciphertext", "utf8").toString("base64") },
  }), "utf8");
  const vaultContainer = await backupContainer.createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 8,
    files: [
      { role: "database-snapshot", path: "data/mini-lux.db", bytes: snapshot.bytes },
      { role: "config", path: "config.json", bytes: config },
      { role: "credential-vault-ciphertext", path: "credentials.vault.json", bytes: foreignVault },
    ],
  }, credentialStore.createBackupDataKeyWrapper());
  await assert.rejects(() => prepareManagedRestore(vaultContainer), /not decryptable by the current Windows user/u);

  const journal = await (await import("../../dist/security-audit-journal.js")).openSecurityAuditJournal();
  journal.close();
  const auditSnapshot = await db.createConsistentDatabaseSnapshot();
  const { createInMemoryBootstrapDatabase } = await import("../../dist/bootstrap-database.js");
  await assert.rejects(
    () => db.validateDatabaseRestoreSecurityAudit(Buffer.alloc(0), async () => Buffer.alloc(32)),
    /audit snapshot is invalid/iu
  );
  await assert.rejects(
    () => db.validateDatabaseRestoreSecurityAudit(auditSnapshot.bytes, null),
    /key unwrapper is invalid/iu
  );
  for (const invalidKey of [Buffer.alloc(31), new Uint8Array(32)]) {
    await assert.rejects(
      () => db.validateDatabaseRestoreSecurityAudit(auditSnapshot.bytes, async () => invalidKey),
      /audit key is unavailable/iu
    );
  }
  const mutateAuditSnapshot = (triggerName, statement) => {
    const candidate = createInMemoryBootstrapDatabase(auditSnapshot.bytes);
    try {
      const trigger = candidate.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName).sql;
      candidate.exec(`DROP TRIGGER ${triggerName}`);
      candidate.exec(statement);
      candidate.exec(trigger);
      return candidate.serialize();
    } finally {
      candidate.close();
    }
  };
  const incompleteAuditSnapshots = [
    mutateAuditSnapshot("security_audit_state_no_delete", "DELETE FROM security_audit_state"),
    mutateAuditSnapshot("security_audit_head_no_delete", "DELETE FROM security_audit_head"),
  ];
  for (const incomplete of incompleteAuditSnapshots) {
    await assert.rejects(
      () => db.validateDatabaseRestoreSecurityAudit(incomplete, async () => Buffer.alloc(32)),
      /audit state is incomplete/iu
    );
    incomplete.fill(0);
  }
  const invalidAuditState = mutateAuditSnapshot("security_audit_state_no_update", "UPDATE security_audit_state SET created_at='not-a-date' WHERE singleton=1");
  await assert.rejects(
    () => db.validateDatabaseRestoreSecurityAudit(invalidAuditState, async () => Buffer.alloc(32)),
    /audit state is invalid/iu
  );
  invalidAuditState.fill(0);

  const foreignAudit = createInMemoryBootstrapDatabase(auditSnapshot.bytes);
  let foreignAuditBytes;
  try {
    const trigger = foreignAudit.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='security_audit_state_no_update'").get().sql;
    foreignAudit.exec("DROP TRIGGER security_audit_state_no_update");
    foreignAudit.prepare("UPDATE security_audit_state SET wrapped_key=? WHERE singleton=1").run(Buffer.from("foreign-user-audit-key", "utf8"));
    foreignAudit.exec(trigger);
    foreignAuditBytes = foreignAudit.serialize();
  } finally {
    foreignAudit.close();
  }
  const auditContainer = await backupContainer.createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 8,
    files: [{ role: "database-snapshot", path: "data/mini-lux.db", bytes: foreignAuditBytes }],
  }, credentialStore.createBackupDataKeyWrapper());
  await assert.rejects(() => prepareManagedRestore(auditContainer), /audit key is unavailable/u);
  assert.equal(await (await import("../../dist/managed-restore.js")).hasPendingManagedRestore(), false);
  await db.closeDb();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, foreignVaultDenied: true, foreignAuditKeyDenied: true, auditPreflightMatrix: 7, noPreparedTransaction: true, cleanClose: true }));
} else if (scenario === "restore-config-mismatch") {
  const credentialStore = await import("../../dist/credential-store.js");
  credentialStore.configureCredentialProtector(Object.freeze({
    protect: plaintext => Buffer.from(`wrapped:${plaintext}`, "utf8"),
    unprotect: ciphertext => Buffer.from(ciphertext).toString("utf8").slice("wrapped:".length),
  }));
  const db = await import("../../dist/db.js");
  const snapshot = await db.createConsistentDatabaseSnapshot();
  const missingReference = `cred_${"a".repeat(32)}`;
  const config = Buffer.from(JSON.stringify({
    defaultProfile: "default",
    profiles: { default: { model: "model", credentialRef: missingReference, baseURL: "https://provider.example", providerType: "openai-compatible" } },
    settings: { defaultPersona: "developer", workspaceRoot: fixture, departmentDataRoot: fixture, outputDir: fixture },
  }), "utf8");
  const vault = Buffer.from(JSON.stringify({ schemaVersion: 1, entries: {} }), "utf8");
  const { createBackupContainer } = await import("../../dist/backup-container.js");
  const { createBackupDataKeyWrapper } = credentialStore;
  const container = await createBackupContainer({
    appVersion: "0.1.0",
    databaseSchemaVersion: 8,
    files: [
      { role: "database-snapshot", path: "data/mini-lux.db", bytes: snapshot.bytes },
      { role: "config", path: "config.json", bytes: config },
      { role: "credential-vault-ciphertext", path: "credentials.vault.json", bytes: vault },
    ],
  }, createBackupDataKeyWrapper());
  const { prepareManagedRestore } = await import("../../dist/data-backup.js");
  await assert.rejects(() => prepareManagedRestore(container), /absent from the encrypted vault/u);
  await db.closeDb();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, mismatchDenied: true, stagingLeaseNotIssued: true, cleanClose: true }));
} else if (scenario === "security-audit") {
  const credentialStore = await import("../../dist/credential-store.js");
  credentialStore.configureCredentialProtector(Object.freeze({
    protect: plaintext => Buffer.from(`protected:${plaintext}`, "utf8"),
    unprotect: ciphertext => {
      const plaintext = Buffer.from(ciphertext).toString("utf8");
      assert.match(plaintext, /^protected:rainydays-security-audit-key-v1:/u);
      return plaintext.slice("protected:".length);
    },
  }));
  const db = await import("../../dist/db.js");
  const audit = await import("../../dist/security-audit.js");
  const { openSecurityAuditJournal } = await import("../../dist/security-audit-journal.js");
  const explicitWrapper = overrides => Object.freeze({
    algorithm: "electron-safe-storage",
    scope: "windows-dpapi-current-user-v1",
    wrapKey: async key => Buffer.from(`protected:${Buffer.from(key).toString("base64")}`, "utf8"),
    unwrapKey: async wrapped => Buffer.from(Buffer.from(wrapped).toString("utf8").slice("protected:".length), "base64"),
    ...overrides,
  });
  await assert.rejects(() => openSecurityAuditJournal(null), /wrapper is invalid/u);
  await assert.rejects(() => openSecurityAuditJournal(explicitWrapper({ wrapKey: async () => Buffer.alloc(0) })), /wrapping failed/u);
  let journal = await openSecurityAuditJournal();
  const headDeleteTriggerSql = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='security_audit_head_no_delete'").get().sql;
  db.db.exec("BEGIN");
  try {
    db.db.exec("DROP TRIGGER security_audit_head_no_delete");
    db.db.exec("DELETE FROM security_audit_head");
    await assert.rejects(() => openSecurityAuditJournal(), /checkpoint is missing/u);
  } finally {
    db.db.exec("ROLLBACK");
  }
  assert.equal((await journal.verify()).eventCount, 0);
  const requestId = "request-persisted-1";
  const baseCorrelation = {
    sessionId: "session-persisted-1",
    runId: "run-persisted-1",
    requestId,
    parentRequestId: null,
    toolCallId: "tool-call-persisted-1",
    contextId: "context-persisted-1",
    executionId: null,
  };
  const requestCommitment = journal.commit({ command: "echo persistent-super-secret", token: "persistent-token" });
  const common = {
    principal: "agent",
    operationKind: "tool",
    operationName: "execute_command",
    code: null,
    requestCommitment,
  };
  await journal.append({
    ...common,
    eventId: "event-persisted-request",
    recordedAt: "2026-08-13T00:00:00.000Z",
    phase: "request",
    correlation: baseCorrelation,
    outcome: "received",
    safePayload: audit.makeRequestAuditPayload({
      ingress: "agent-tool",
      argumentBytes: 57,
      argumentsCommitment: journal.commit({ command: "echo persistent-super-secret" }),
    }),
  });
  await journal.append({
    ...common,
    eventId: "event-persisted-authorization",
    recordedAt: "2026-08-13T00:00:01.000Z",
    phase: "authorization",
    correlation: baseCorrelation,
    outcome: "allowed",
    safePayload: audit.makeAuthorizationAuditPayload({
      decision: "allowed",
      policyDigest: "a".repeat(64),
      personaDigest: "b".repeat(64),
      approvalKind: "user",
    }),
  });
  const executionCorrelation = { ...baseCorrelation, executionId: "execution-persisted-1" };
  await journal.append({
    ...common,
    eventId: "event-persisted-execution",
    recordedAt: "2026-08-13T00:00:02.000Z",
    phase: "execution",
    correlation: executionCorrelation,
    outcome: "started",
    safePayload: audit.makeExecutionAuditPayload({ state: "started", executor: "native-host", profile: "e1", proofDigest: "c".repeat(64) }),
  });
  await journal.append({
    ...common,
    eventId: "event-persisted-result",
    recordedAt: "2026-08-13T00:00:03.000Z",
    phase: "result",
    correlation: executionCorrelation,
    outcome: "success",
    safePayload: audit.makeResultAuditPayload({
      status: "success",
      durationMs: 12,
      outputBytes: 4,
      truncated: false,
      resultCommitment: journal.commit({ stdout: "persistent-sensitive-output" }),
    }),
  });
  assert.deepEqual(await journal.verify(), {
    schemaVersion: 1,
    integrity: "verified",
    eventCount: 4,
    headHash: db.listSecurityAuditEvents().at(-1).eventHash,
  });
  const serializedRows = JSON.stringify(db.listSecurityAuditEvents());
  for (const secret of ["persistent-super-secret", "persistent-token", "persistent-sensitive-output"]) assert.equal(serializedRows.includes(secret), false);

  for (const [principal, suffix] of [["subagent", "nested-subagent"], ["playbook", "nested-playbook"]]) {
    const nestedCorrelation = {
      ...baseCorrelation,
      requestId: `request-${suffix}`,
      parentRequestId: requestId,
      toolCallId: `tool-call-${suffix}`,
    };
    const nestedCommitment = journal.commit({ principal, secret: `${suffix}-secret` });
    const nestedCommon = {
      principal,
      operationKind: "tool",
      operationName: "supervise",
      code: null,
      requestCommitment: nestedCommitment,
    };
    await journal.append({
      ...nestedCommon,
      eventId: `event-${suffix}-request`,
      phase: "request",
      correlation: nestedCorrelation,
      outcome: "received",
      safePayload: audit.makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 18, argumentsCommitment: nestedCommitment }),
    });
    await journal.append({
      ...nestedCommon,
      eventId: `event-${suffix}-authorization`,
      phase: "authorization",
      correlation: nestedCorrelation,
      outcome: "allowed",
      safePayload: audit.makeAuthorizationAuditPayload({ decision: "allowed", policyDigest: "f".repeat(64), personaDigest: "1".repeat(64), approvalKind: "none" }),
    });
    const nestedExecutionCorrelation = { ...nestedCorrelation, executionId: `execution-${suffix}` };
    await journal.append({
      ...nestedCommon,
      eventId: `event-${suffix}-execution`,
      phase: "execution",
      correlation: nestedExecutionCorrelation,
      outcome: "started",
      safePayload: audit.makeExecutionAuditPayload({ state: "started", executor: "tool-dispatcher", profile: null, proofDigest: null }),
    });
    await journal.append({
      ...nestedCommon,
      eventId: `event-${suffix}-result`,
      phase: "result",
      correlation: nestedExecutionCorrelation,
      outcome: "success",
      safePayload: audit.makeResultAuditPayload({ status: "success", durationMs: 1, outputBytes: 2, truncated: false, resultCommitment: journal.commit("ok") }),
    });
  }
  const nestedRows = db.listSecurityAuditEvents().slice(4, 12);
  assert.deepEqual([...new Set(nestedRows.map(event => event.principal))], ["subagent", "playbook"]);
  assert(nestedRows.every(event => event.correlation.parentRequestId === requestId));
  assert.equal(JSON.stringify(nestedRows).includes("nested-subagent-secret"), false);
  assert.equal(JSON.stringify(nestedRows).includes("nested-playbook-secret"), false);

  const requestOnlyCorrelation = { ...baseCorrelation, requestId: "request-recovery-request-only", toolCallId: "tool-call-recovery-request-only" };
  const requestOnlyCommitment = journal.commit({ command: "request-only-secret" });
  await journal.append({
    ...common,
    eventId: "event-recovery-request-only",
    phase: "request",
    correlation: requestOnlyCorrelation,
    operationName: "script",
    outcome: "received",
    requestCommitment: requestOnlyCommitment,
    safePayload: audit.makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 19, argumentsCommitment: requestOnlyCommitment }),
  });

  const startedCorrelation = { ...baseCorrelation, requestId: "request-recovery-started", toolCallId: "tool-call-recovery-started" };
  const startedCommitment = journal.commit({ command: "started-secret" });
  const startedCommon = { ...common, operationName: "execute_command", requestCommitment: startedCommitment };
  await journal.append({
    ...startedCommon,
    eventId: "event-recovery-started-request",
    phase: "request",
    correlation: startedCorrelation,
    outcome: "received",
    safePayload: audit.makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 14, argumentsCommitment: startedCommitment }),
  });
  await journal.append({
    ...startedCommon,
    eventId: "event-recovery-started-authorization",
    phase: "authorization",
    correlation: startedCorrelation,
    outcome: "allowed",
    safePayload: audit.makeAuthorizationAuditPayload({ decision: "allowed", policyDigest: "d".repeat(64), personaDigest: "e".repeat(64), approvalKind: "none" }),
  });
  const startedExecutionCorrelation = { ...startedCorrelation, executionId: "execution-recovery-started" };
  await journal.append({
    ...startedCommon,
    eventId: "event-recovery-started-execution",
    phase: "execution",
    correlation: startedExecutionCorrelation,
    outcome: "started",
    safePayload: audit.makeExecutionAuditPayload({ state: "started", executor: "tool-dispatcher", profile: null, proofDigest: null }),
  });

  journal.close();
  journal.close();
  assert.throws(() => journal.commit("closed"), /journal is closed/u);
  journal = await openSecurityAuditJournal();
  const recovered = db.listSecurityAuditEvents();
  assert.equal((await journal.verify()).eventCount, 20);
  const requestOnly = recovered.filter(event => event.correlation.requestId === requestOnlyCorrelation.requestId);
  assert.equal(JSON.stringify(requestOnly.map(event => [event.phase, event.outcome])), JSON.stringify([
    ["request", "received"], ["authorization", "denied"], ["execution", "not_started"], ["result", "denied"],
  ]));
  const started = recovered.filter(event => event.correlation.requestId === startedCorrelation.requestId);
  assert.equal(JSON.stringify(started.map(event => [event.phase, event.outcome])), JSON.stringify([
    ["request", "received"], ["authorization", "allowed"], ["execution", "started"], ["result", "interrupted"],
  ]));
  assert.equal(started[3].correlation.executionId, "execution-recovery-started");
  assert(recovered.slice(16).every(event => event.code === "SEC06_RECOVERED_INCOMPLETE_REQUEST"));
  for (const removed of [1, 2, 3, 4]) {
    db.db.exec("BEGIN");
    db.db.exec("DROP TRIGGER security_audit_events_no_delete");
    db.db.prepare("DELETE FROM security_audit_events WHERE sequence > ?").run(20 - removed);
    await assert.rejects(() => journal.verify(), /checkpoint differs/u);
    db.db.exec("ROLLBACK");
    journal.close();
    journal = await openSecurityAuditJournal();
    assert.equal((await journal.verify()).eventCount, 20);
  }
  await assert.rejects(() => journal.append({}), /append input|phase is invalid/u);
  assert.throws(() => journal.commit("poisoned"), /journal is poisoned/u);
  journal.close();
  journal = await openSecurityAuditJournal();
  assert.throws(() => db.insertSecurityAuditEvent({
    ...recovered.at(-1),
    sequence: 21,
    eventId: "event-invalid-principal",
    correlation: { ...recovered.at(-1).correlation, requestId: "request-invalid-principal" },
    principal: "forged-principal",
    previousEventHash: recovered.at(-1).eventHash,
    eventHash: `hmac-sha256:${"9".repeat(64)}`,
  }), /CHECK constraint failed/u);
  assert.throws(() => db.db.prepare("UPDATE security_audit_events SET outcome='forged' WHERE sequence=20").run(), /append-only/u);
  assert.throws(() => db.db.prepare("DELETE FROM security_audit_events WHERE sequence=20").run(), /append-only/u);
  assert.throws(() => db.db.prepare("UPDATE security_audit_state SET created_at='2026-01-01T00:00:00.000Z'").run(), /immutable/u);
  assert.throws(() => db.db.prepare("DELETE FROM security_audit_state").run(), /immutable/u);
  assert.throws(() => db.db.prepare("DELETE FROM security_audit_head").run(), /cannot be deleted/u);
  const stateUpdateTriggerSql = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='security_audit_state_no_update'").get().sql;
  db.db.exec("BEGIN");
  try {
    db.db.exec("DROP TRIGGER security_audit_state_no_update");
    db.db.prepare("UPDATE security_audit_state SET created_at='invalid'").run();
    await assert.rejects(() => openSecurityAuditJournal(), /state is invalid/u);
  } finally {
    db.db.exec("ROLLBACK");
  }
  const stateDeleteTriggerSql = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='security_audit_state_no_delete'").get().sql;
  db.db.exec("BEGIN");
  try {
    db.db.exec("DROP TRIGGER security_audit_state_no_delete");
    db.db.exec("DELETE FROM security_audit_state");
    await assert.rejects(() => openSecurityAuditJournal(), /key is missing/u);
  } finally {
    db.db.exec("ROLLBACK");
  }
  await assert.rejects(() => openSecurityAuditJournal(explicitWrapper({ unwrapKey: async () => Buffer.alloc(31) })), /key is unavailable/u);
  assert.match(stateUpdateTriggerSql, /security audit state is immutable/u);
  assert.match(stateDeleteTriggerSql, /security audit state is immutable/u);
  const snapshot = await db.createConsistentDatabaseSnapshot();
  const { createInMemoryBootstrapDatabase } = await import("../../dist/bootstrap-database.js");
  const restored = createInMemoryBootstrapDatabase(snapshot.bytes);
  try {
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM security_audit_state").get().count, 1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM security_audit_head").get().count, 1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM security_audit_events").get().count, 20);
  } finally {
    restored.close();
  }
  journal.close();
  db.db.exec("BEGIN");
  try {
    db.db.exec("DROP TRIGGER security_audit_events_no_update");
    db.db.prepare("UPDATE security_audit_events SET outcome='forged' WHERE sequence=20").run();
    await assert.rejects(() => openSecurityAuditJournal(), /event hash differs/u);
  } finally {
    db.db.exec("ROLLBACK");
  }
  const eventDeleteTriggerSql = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='security_audit_events_no_delete'").get().sql;
  db.db.exec("BEGIN");
  try {
    db.db.exec("DROP TRIGGER security_audit_events_no_delete");
    db.db.exec("DROP TRIGGER security_audit_head_no_delete");
    db.db.exec("DELETE FROM security_audit_events");
    db.db.exec("DELETE FROM security_audit_head");
    db.db.exec(eventDeleteTriggerSql);
    db.db.exec(headDeleteTriggerSql);
    db.db.exec("COMMIT");
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM security_audit_state").get().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM security_audit_head").get().count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM security_audit_events").get().count, 0);
  await assert.rejects(() => openSecurityAuditJournal(), /checkpoint is missing/u);
  await db.closeDb();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({
    scenario,
    persistedAcrossReopen: true,
    appendOnlyTriggers: true,
    snapshotContainsKeyAndChain: true,
    secretBytesAbsent: true,
    tamperDetected: true,
    tailTruncationDetected: true,
    missingCheckpointDetected: true,
    genesisPublishedAtomically: true,
  }));
} else if (scenario === "wal-corruption") {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const writer = new Database(mainPath);
  try {
    assert.equal(String(writer.pragma("journal_mode = WAL", { simple: true })).toLowerCase(), "wal");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE wal_probe(value TEXT NOT NULL)");
    writer.prepare("INSERT INTO wal_probe(value) VALUES (?)").run("committed-in-wal");
    const baseline = Object.freeze({
      main: await fs.readFile(mainPath),
      wal: await fs.readFile(`${mainPath}-wal`),
      shm: await fs.readFile(`${mainPath}-shm`),
    });
    assert(baseline.wal.length > 56);
    writer.close();

    const restoreBaseline = async wal => {
      await fs.writeFile(mainPath, baseline.main);
      await fs.writeFile(`${mainPath}-wal`, wal);
      await fs.writeFile(`${mainPath}-shm`, baseline.shm);
    };
    const corruptedHeader = Buffer.from(baseline.wal);
    corruptedHeader[0] ^= 0xff;
    const corruptedFrame = Buffer.from(baseline.wal);
    corruptedFrame[56] ^= 0xff;
    const invalidVersion = Buffer.from(baseline.wal);
    invalidVersion.writeUInt32BE(1, 4);
    const invalidPageSize = Buffer.from(baseline.wal);
    invalidPageSize.writeUInt32BE(1_000, 8);
    const encodedMaximumPageSize = Buffer.from(baseline.wal);
    encodedMaximumPageSize.writeUInt32BE(1, 8);
    const invalidHeaderChecksum = Buffer.from(baseline.wal);
    invalidHeaderChecksum[16] ^= 0xff;
    const invalidFramePage = Buffer.from(baseline.wal);
    invalidFramePage.writeUInt32BE(0, 32);
    const invalidFrameSalt = Buffer.from(baseline.wal);
    invalidFrameSalt[40] ^= 0xff;
    const bigEndianMagic = Buffer.from(baseline.wal);
    bigEndianMagic.writeUInt32BE(0x377f0683, 0);
    const variants = Object.freeze([
      Object.freeze({ name: "header-magic", wal: corruptedHeader }),
      Object.freeze({ name: "frame-checksum", wal: corruptedFrame }),
      Object.freeze({ name: "truncated-frame", wal: baseline.wal.subarray(0, baseline.wal.length - 1) }),
      Object.freeze({ name: "truncated-header", wal: Buffer.alloc(31) }),
      Object.freeze({ name: "format-version", wal: invalidVersion }),
      Object.freeze({ name: "page-size", wal: invalidPageSize }),
      Object.freeze({ name: "encoded-maximum-page-size", wal: encodedMaximumPageSize }),
      Object.freeze({ name: "header-checksum", wal: invalidHeaderChecksum }),
      Object.freeze({ name: "frame-page-identity", wal: invalidFramePage }),
      Object.freeze({ name: "frame-salt-identity", wal: invalidFrameSalt }),
      Object.freeze({ name: "big-endian-checksum", wal: bigEndianMagic }),
    ]);

    for (const variant of variants) {
      await restoreBaseline(variant.wal);
      const before = Object.freeze({
        main: await fs.readFile(mainPath),
        wal: await fs.readFile(`${mainPath}-wal`),
        shm: await fs.readFile(`${mainPath}-shm`),
      });
      await assert.rejects(() => openBootstrapDatabase(10), /SQLite WAL/u, variant.name);
      assert.deepEqual(await fs.readFile(mainPath), before.main, `${variant.name} mutated main`);
      assert.deepEqual(await fs.readFile(`${mainPath}-wal`), before.wal, `${variant.name} mutated WAL`);
      assert.deepEqual(await fs.readFile(`${mainPath}-shm`), before.shm, `${variant.name} mutated SHM`);
    }

    await restoreBaseline(baseline.wal);
    const walAlias = path.join(outside, "wal-hardlink-alias");
    await fs.link(`${mainPath}-wal`, walAlias);
    const linkedWal = await fs.readFile(`${mainPath}-wal`);
    await assert.rejects(() => openBootstrapDatabase(10), /SQLite WAL|PATH_IDENTITY_CHANGED/u, "hardlinked WAL");
    assert.deepEqual(await fs.readFile(`${mainPath}-wal`), linkedWal);
    await fs.unlink(walAlias);

    await restoreBaseline(baseline.wal);
    await fs.unlink(`${mainPath}-wal`);
    await fs.mkdir(`${mainPath}-wal`);
    const beforeDirectoryMain = await fs.readFile(mainPath);
    const beforeDirectoryShm = await fs.readFile(`${mainPath}-shm`);
    await assert.rejects(() => openBootstrapDatabase(10), /SQLite WAL|PATH_/u, "directory WAL");
    assert.deepEqual(await fs.readFile(mainPath), beforeDirectoryMain);
    assert.deepEqual(await fs.readFile(`${mainPath}-shm`), beforeDirectoryShm);
    assert.equal((await fs.lstat(`${mainPath}-wal`)).isDirectory(), true);
    await fs.rmdir(`${mainPath}-wal`);

    await restoreBaseline(baseline.wal);
    const recovered = await openBootstrapDatabase(10);
    assert.equal(recovered.database.prepare("SELECT value FROM wal_probe").get()?.value, "committed-in-wal");
    await recovered.close();
    await getBootstrapPathStore().close();
    console.log(JSON.stringify({ scenario, corruptionsDenied: variants.length, identityViolationsDenied: 2, sourceByteIdentical: true, validWalRecovered: true, cleanClose: true }));
  } finally {
    if (writer.open) writer.close();
  }
} else if (scenario === "snapshot") {
  const db = await import("../../dist/db.js");
  const now = new Date().toISOString();
  db.insertSession({ id: "snapshot-session", persona_name: "developer", title: "Snapshot", created_at: now, updated_at: now });
  db.insertMessage({ session_id: "snapshot-session", role: "user", content: "committed-in-wal", tool_calls: null, tool_call_id: null, created_at: now });
  assert.equal(await fs.access(`${mainPath}-wal`).then(() => true, () => false), true);
  const snapshot = await db.createConsistentDatabaseSnapshot();
  assert.equal(snapshot.validation.schemaVersion, 10);
  assert.equal(snapshot.validation.quickCheck, "ok");
  assert.equal(snapshot.validation.integrityCheck, "ok");
  assert.equal(snapshot.validation.foreignKeyViolations, 0);
  const { createInMemoryBootstrapDatabase } = await import("../../dist/bootstrap-database.js");
  const restored = createInMemoryBootstrapDatabase(snapshot.bytes);
  let restoredMessage;
  try {
    restoredMessage = restored.prepare("SELECT content FROM messages WHERE session_id = ?").get("snapshot-session")?.content;
  } finally {
    restored.close();
  }
  assert.equal(restoredMessage, "committed-in-wal");
  await db.closeDb();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, schemaVersion: snapshot.validation.schemaVersion, walContentPreserved: true, checksPassed: true, cleanClose: true }));
} else {
  const db = await import("../../dist/db.js");
  const now = new Date().toISOString();
  db.touchSession("missing-before-first-session");
  const session = { id: "coverage-session", persona_name: "developer", title: "Coverage", created_at: now, updated_at: now };
  db.insertSession(session);
  assert.equal(db.getSession(session.id).title, "Coverage");
  assert.equal(db.updateSessionTitle(session.id, "Updated"), true);
  assert.equal(db.updateSessionTitle("missing", "No-op"), false);
  db.touchSession(session.id);
  assert.equal(db.listSessions().length, 1);
  assert.equal(db.getLastUserMessageId(session.id), null);
  db.insertMessage({ session_id: session.id, role: "user", content: "needle user", tool_calls: null, tool_call_id: null, created_at: now });
  db.insertMessage({ session_id: session.id, role: "assistant", content: "needle assistant", tool_calls: "[]", tool_call_id: "call-1", created_at: now });
  assert.equal(db.getMessagesBySession(session.id).length, 2);
  assert.equal(db.searchAcrossSessions("needle", 10).length, 2);
  const lastUser = db.getLastUserMessageId(session.id);
  assert.equal(typeof lastUser, "number");
  assert.equal(db.getMessagesUpTo(session.id, lastUser).length, 1);
  assert.equal(db.deleteMessagesAfterLastUserMessage(session.id), 1);
  assert.equal(db.deleteMessagesAfterLastUserMessage("missing"), 0);

  const memoryId = db.insertMemory("remember needle", "observation", ["coverage"], Buffer.from([1, 2, 3]));
  const memoryWithoutEmbedding = db.insertMemory("without embedding", "observation", [], null);
  db.updateMemoryEmbedding(memoryId, Buffer.from([4, 5]));
  assert.equal(db.searchMemories("needle", 5).length, 1);
  assert.equal(db.getAllMemoriesWithEmbedding().length, 1);
  assert.equal(db.getMemoriesWithoutEmbedding().length, 1);
  assert.equal(db.listMemories(5).length, 2);
  assert.equal(db.getRecentMemories(5).length, 2);

  db.insertTaskRow({
    session_id: session.id, task_id: "first", subject: "first", description: null,
    status: "pending", active_form: null, owner: null, metadata_json: "{}",
    sort_order: db.getNextTaskSortOrder(session.id), created_at: now, updated_at: now,
  });
  db.insertTaskRow({
    session_id: session.id, task_id: "second", subject: "second", description: "detail",
    status: "pending", active_form: null, owner: "coverage", metadata_json: '{"kind":"coverage"}',
    sort_order: db.getNextTaskSortOrder(session.id), created_at: now, updated_at: now,
  });
  assert.equal(db.getTasksBySessionId(session.id).length, 2);
  assert.equal(db.getTaskBySessionAndId(session.id, "first").subject, "first");
  db.insertTaskDependency({ session_id: session.id, task_id: "second", blocker_id: "first", created_at: now });
  assert.equal(db.getTaskDependenciesBySessionId(session.id).length, 1);
  assert.equal(db.updateTaskRow({
    session_id: session.id, task_id: "first", subject: "renamed", description: null,
    status: "in_progress", active_form: "working", owner: null, metadata_json: "{}", updated_at: now,
  }), true);
  assert.equal(db.updateTaskRow({
    session_id: session.id, task_id: "missing", subject: "missing", description: null,
    status: "pending", active_form: null, owner: null, metadata_json: "{}", updated_at: now,
  }), false);
  assert.equal(db.deleteTaskBySessionAndId(session.id, "second"), true);
  assert.equal(db.deleteTaskBySessionAndId(session.id, "second"), false);
  assert.equal(db.deleteTasksBySessionId(session.id), 1);

  const cronId = db.insertCronJob({ session_id: session.id, message: "wake", fire_at: now, interval: "1h", tag: "coverage", active: 1 });
  const minimalCronId = db.insertCronJob({ session_id: "", message: "minimal", fire_at: now, interval: "", tag: "", active: undefined });
  assert.equal(db.getCronJob(minimalCronId).active, 1);
  assert.equal(db.listCronJobs().length, 2);
  assert.equal(db.listCronJobs(true).length, 2);
  assert.equal(db.getCronJob(cronId).message, "wake");
  db.updateCronJobLastFired(cronId, now);
  db.deactivateCronJob(cronId);
  db.deactivateCronJob(minimalCronId);
  assert.equal(db.listCronJobs(true).length, 0);

  const left = db.upsertEntity("left", "node", { side: "left" });
  const right = db.upsertEntity("right", "node");
  assert.equal(db.upsertEntity("left", "updated", { side: "updated" }), left);
  assert.equal(db.getEntity(left).name, "left");
  assert.equal(db.getEntityByName("right").id, right);
  assert.equal(db.searchEntities("lef", 5).length, 1);
  assert.equal(db.listEntities(5).length, 2);
  db.insertEdge(left, right, "relates", { weight: 1 });
  db.insertEdge(left, right, "relates");
  db.insertEdge(left, right, "relates-null", null);
  assert.equal(db.getEdgesForEntity(left).length, 2);
  assert.equal(db.getEdgesForEntity(right).length, 2);

  const pinId = db.insertPin(session.id, "pin");
  assert.equal(db.getPinsBySession(session.id).length, 1);
  db.deletePin(pinId);
  db.deleteMemory(memoryId);
  db.deleteMemory(memoryWithoutEmbedding);
  db.deleteMessagesBySession(session.id);
  db.deleteSession(session.id);
  const schemaVersion = db.getDatabaseSchemaVersion();
  await db.closeDb();
  await getBootstrapPathStore().close();
  console.log(JSON.stringify({ scenario, crudCovered: true, schemaVersion }));
}
