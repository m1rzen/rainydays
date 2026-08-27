import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [mode, fixture, barrierOrGeneration] = process.argv.slice(2);
assert(["crash", "recover", "recover-crash", "lock-probe", "enospc-retry", "failure-matrix", "journal-matrix", "prepared-stage-matrix", "stage-toctou"].includes(mode));
assert(path.isAbsolute(fixture));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
await fs.mkdir(path.join(fixture, "data"), { recursive: true });

const credentialStore = await import("../../dist/credential-store.js");
credentialStore.configureCredentialProtector(Object.freeze({
  protect: plaintext => Buffer.from(`wrapped:${plaintext}`, "utf8"),
  unprotect: ciphertext => {
    const value = Buffer.from(ciphertext).toString("utf8");
    if (!value.startsWith("wrapped:")) throw new Error("test ciphertext rejected");
    return value.slice("wrapped:".length);
  },
}));

const personaSource = (generation, skill = "common-skill") => Buffer.from([
  "---",
  "name: common-persona",
  `skills: [${skill}]`,
  "tools: []",
  "network_policy: deny",
  "---",
  `Persona ${generation}`,
].join("\n"), "utf8");
const playbookSource = generation => Buffer.from(JSON.stringify({
  name: "common-playbook",
  description: `generation-${generation}`,
  steps: [{ message: `Run ${generation}`, description: "One" }],
}), "utf8");

if (mode === "lock-probe") {
  const release = await (await import("../../dist/managed-restore.js")).acquireManagedRestoreLock();
  process.stdout.write("RESTORE_LOCK_ACQUIRED\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  await release();
} else if (mode === "failure-matrix") {
  const restore = await import("../../dist/managed-restore.js");
  const validWrapper = credentialStore.createBackupDataKeyWrapper();
  const source = () => [{ path: "data/mini-lux.db", bytes: Buffer.from("generation-b") }];
  const wrapper = overrides => Object.freeze({
    algorithm: "electron-safe-storage",
    scope: "windows-dpapi-current-user-v1",
    wrapDataKey: validWrapper.wrapDataKey,
    unwrapDataKey: validWrapper.unwrapDataKey,
    ...overrides,
  });
  const invalidCalls = [
    () => restore.performManagedRestore(null, validWrapper),
    () => restore.performManagedRestore([], validWrapper),
    () => restore.performManagedRestore(new Array(261).fill(null), validWrapper),
    () => restore.performManagedRestore(source(), null),
    () => restore.performManagedRestore(source(), wrapper({ algorithm: "other" })),
    () => restore.performManagedRestore(source(), wrapper({ scope: "other" })),
    () => restore.performManagedRestore(source(), wrapper({ wrapDataKey: null })),
    () => restore.performManagedRestore(source(), wrapper({ unwrapDataKey: null })),
    () => restore.performManagedRestore([null], validWrapper),
    () => restore.performManagedRestore([{ path: 7, bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "/data/mini-lux.db", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data\\mini-lux.db", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data/mini-lux.db\0", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data/personas/BAD.md", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data/personas/name.json", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data/skills/name.json", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "playbooks/name.md", bytes: Buffer.from("x") }], validWrapper),
    () => restore.performManagedRestore([{ path: "data/mini-lux.db", bytes: "x" }], validWrapper),
    () => restore.performManagedRestore([
      { path: "data/mini-lux.db", bytes: Buffer.from("x") },
      { path: "data/mini-lux.db", bytes: Buffer.from("y") },
    ], validWrapper),
    () => restore.performManagedRestore([{ path: "config.json", bytes: Buffer.from("x") }], validWrapper),
  ];
  for (const invoke of invalidCalls) await assert.rejects(invoke, /invalid|missing/iu);

  for (const invalidWrappedKey of ["not-a-buffer", Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1)]) {
    await assert.rejects(
      () => restore.performManagedRestore(source(), wrapper({ wrapDataKey: async () => invalidWrappedKey })),
      /journal key wrapping failed/iu
    );
    assert.equal(await restore.hasPendingManagedRestore(), false);
  }
  await assert.rejects(
    () => restore.performManagedRestore(source(), validWrapper, point => {
      if (point === "stage:set-complete") throw new Error("pre-PREPARED fault");
    }),
    /pre-PREPARED fault/u
  );
  assert.equal(await restore.hasPendingManagedRestore(), false);

  const restoreRoot = path.join(fixture, ".rainydays-restore");
  await fs.writeFile(path.join(restoreRoot, "active.json"), "{}");
  await assert.rejects(() => restore.performManagedRestore(source(), validWrapper), /already pending/u);
  await fs.unlink(path.join(restoreRoot, "active.json"));

  await fs.writeFile(path.join(fixture, "data", "mini-lux.db"), "generation-a");
  await assert.rejects(
    () => restore.performManagedRestore(source(), validWrapper, point => {
      if (point === "live:before-write" || point === "recovery:before-write") throw new Error(`persistent fault: ${point}`);
    }),
    error => error instanceof AggregateError && /rollback is incomplete/u.test(error.message)
  );
  assert.equal(await restore.hasPendingManagedRestore(), true);
  const recovered = await restore.recoverPendingManagedRestore(validWrapper);
  assert.deepEqual(recovered, { recovered: true, phase: "prepared" });

  const cleanupPending = await restore.performManagedRestore(source(), validWrapper, async (point, context) => {
    if (point !== "journal:committed-published") return;
    await fs.writeFile(path.join(restoreRoot, "transactions", context.transactionId, "unexpected.bin"), "unexpected");
  });
  assert.equal(cleanupPending.cleanupPending, true);
  assert.equal(await restore.hasPendingManagedRestore(), true);
  const unexpected = path.join(restoreRoot, "transactions", cleanupPending.transactionId, "unexpected.bin");
  await assert.rejects(() => restore.recoverPendingManagedRestore(validWrapper), /unknown artifacts/u);
  await fs.unlink(unexpected);
  assert.deepEqual(await restore.recoverPendingManagedRestore(validWrapper), { recovered: true, phase: "committed" });

  const invalidStageCleanup = await restore.performManagedRestore(source(), validWrapper, async (point, context) => {
    if (point !== "journal:committed-published") return;
    await fs.writeFile(path.join(restoreRoot, "transactions", context.transactionId, "old", "unexpected.bin"), "unexpected");
  });
  assert.equal(invalidStageCleanup.cleanupPending, true);
  const invalidStageArtifact = path.join(restoreRoot, "transactions", invalidStageCleanup.transactionId, "old", "unexpected.bin");
  await assert.rejects(() => restore.recoverPendingManagedRestore(validWrapper), /stage file name is invalid/u);
  await fs.unlink(invalidStageArtifact);
  assert.deepEqual(await restore.recoverPendingManagedRestore(validWrapper), { recovered: true, phase: "committed" });

  const { getBootstrapPathStore } = await import("../../dist/bootstrap-path-store.js");
  const store = getBootstrapPathStore();
  const zeroSidecar = path.join(fixture, "data", "mini-lux.db-wal");
  await fs.writeFile(zeroSidecar, Buffer.alloc(0));
  await assert.rejects(
    () => store.publishManagedRestore(source(), validWrapper),
    error => error?.code === "PATH_IDENTITY_CHANGED"
  );
  await fs.unlink(zeroSidecar);
  let publicationLeaseDenied = false;
  await store.publishManagedRestore(source(), validWrapper, async point => {
    if (point !== "stage:set-complete") return;
    await assert.rejects(
      () => store.openDatabaseFileLease(),
      error => error?.code === "PATH_AUTHORITY_STALE"
    );
    publicationLeaseDenied = true;
  });
  assert.equal(publicationLeaseDenied, true);
  await store.close();

  const release = await restore.acquireManagedRestoreLock();
  await release();
  await release();
  console.log(JSON.stringify({
    invalidCalls: invalidCalls.length,
    invalidWrappedKeys: 3,
    prePreparedCleanup: true,
    pendingDenied: true,
    aggregateRollbackFailure: true,
    cleanupPendingRecovered: true,
    invalidStageCleanupDenied: true,
    zeroSidecarDenied: true,
    publicationLeaseDenied: true,
    idempotentLockRelease: true,
  }));
} else if (mode === "prepared-stage-matrix") {
  const restore = await import("../../dist/managed-restore.js");
  const { hashTree } = await import("../helpers.mjs");
  const validWrapper = credentialStore.createBackupDataKeyWrapper();
  const restoreRoot = path.join(fixture, ".rainydays-restore");
  const journalPath = path.join(restoreRoot, "active.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  assert.equal(journal.phase, "prepared");
  const transaction = path.join(restoreRoot, "transactions", journal.transactionId);
  const newIndex = journal.entries.findIndex(entry => entry.new.present);
  assert.notEqual(newIndex, -1);
  const newStage = path.join(transaction, "new", `${String(newIndex).padStart(4, "0")}.bin`);
  const newStageBytes = await fs.readFile(newStage);
  const heldNewDirectory = path.join(transaction, "new-held-for-test");
  const cases = [
    {
      name: "missing-new-stage",
      mutate: () => fs.unlink(newStage),
      restore: () => fs.writeFile(newStage, newStageBytes),
    },
    {
      name: "extra-old-stage",
      mutate: () => fs.writeFile(path.join(transaction, "old", "9999.bin"), "unexpected"),
      restore: () => fs.unlink(path.join(transaction, "old", "9999.bin")),
    },
    {
      name: "extra-new-stage",
      mutate: () => fs.writeFile(path.join(transaction, "new", "9999.bin"), "unexpected"),
      restore: () => fs.unlink(path.join(transaction, "new", "9999.bin")),
    },
    {
      name: "missing-new-directory",
      mutate: () => fs.rename(path.join(transaction, "new"), heldNewDirectory),
      restore: () => fs.rename(heldNewDirectory, path.join(transaction, "new")),
    },
    {
      name: "new-directory-is-file",
      mutate: async () => {
        await fs.rename(path.join(transaction, "new"), heldNewDirectory);
        await fs.writeFile(path.join(transaction, "new"), "not-a-directory");
      },
      restore: async () => {
        await fs.unlink(path.join(transaction, "new"));
        await fs.rename(heldNewDirectory, path.join(transaction, "new"));
      },
    },
  ];
  for (const entry of cases) {
    await entry.mutate();
    const before = await hashTree(fixture);
    await assert.rejects(
      () => restore.recoverPendingManagedRestore(validWrapper),
      error => /prepared stage/iu.test(String(error?.message))
        || ["PATH_NOT_FOUND", "PATH_OPERATION_DENIED", "PATH_IDENTITY_CHANGED", "PATH_TYPE_MISMATCH"].includes(error?.code),
      entry.name
    );
    assert.equal(await hashTree(fixture), before, entry.name);
    await entry.restore();
  }
  newStageBytes.fill(0);
  assert.deepEqual(await restore.recoverPendingManagedRestore(validWrapper), { recovered: true, phase: "prepared" });
  console.log(JSON.stringify({ preparedStageVariants: cases.length, zeroMutationRejections: true, validRecoveryAfterRejection: true }));
} else if (mode === "journal-matrix") {
  const restore = await import("../../dist/managed-restore.js");
  const validWrapper = credentialStore.createBackupDataKeyWrapper();
  const journalPath = path.join(fixture, ".rainydays-restore", "active.json");
  const originalBytes = await fs.readFile(journalPath);
  const original = JSON.parse(originalBytes.toString("utf8"));
  await assert.rejects(() => restore.recoverPendingManagedRestore(), /credential protection is unavailable/u);

  const oldIndex = original.entries.findIndex(entry => entry.old.present);
  assert.notEqual(oldIndex, -1);
  const oldStage = path.join(
    fixture,
    ".rainydays-restore",
    "transactions",
    original.transactionId,
    "old",
    `${String(oldIndex).padStart(4, "0")}.bin`
  );
  const oldStageBytes = await fs.readFile(oldStage);
  const corruptStageBytes = Buffer.from(oldStageBytes);
  corruptStageBytes[0] ^= 0xff;
  await fs.writeFile(oldStage, corruptStageBytes);
  await assert.rejects(() => restore.recoverPendingManagedRestore(validWrapper), /staged file differs/u);
  await fs.writeFile(oldStage, oldStageBytes);
  if (process.platform === "win32") {
    const stageAlias = `${oldStage}.alias`;
    await fs.link(oldStage, stageAlias);
    await assert.rejects(
      () => restore.recoverPendingManagedRestore(validWrapper),
      /target identity is invalid|prepared stage artifact is invalid|PATH_IDENTITY_CHANGED/u
    );
    await fs.unlink(stageAlias);
  }

  const variants = [];
  const addJsonVariant = (name, mutate, pattern) => {
    const value = structuredClone(original);
    mutate(value);
    variants.push({ name, bytes: Buffer.from(JSON.stringify(value), "utf8"), pattern });
  };
  variants.push(
    { name: "empty", bytes: Buffer.alloc(0), pattern: /journal size is invalid/u },
    { name: "invalid-json", bytes: Buffer.from("{", "utf8"), pattern: /not valid JSON/u },
    { name: "null-root", bytes: Buffer.from("null", "utf8"), pattern: /journal is invalid/u },
    { name: "array-root", bytes: Buffer.from("[]", "utf8"), pattern: /journal is invalid/u }
  );
  addJsonVariant("extra-root-field", value => { value.extra = true; }, /fields are invalid/u);
  addJsonVariant("missing-root-field", value => { delete value.scope; }, /fields are invalid/u);
  addJsonVariant("schema", value => { value.schemaVersion = 2; }, /journal is invalid/u);
  addJsonVariant("transaction-id-type", value => { value.transactionId = 7; }, /journal is invalid/u);
  addJsonVariant("transaction-id-shape", value => { value.transactionId = "not-a-uuid"; }, /journal is invalid/u);
  addJsonVariant("phase", value => { value.phase = "publishing"; }, /journal is invalid/u);
  addJsonVariant("phase-substitution", value => { value.phase = "rolled_back"; }, /journal authentication failed/u);
  addJsonVariant("scope", value => { value.scope = "foreign-user"; }, /journal is invalid/u);
  addJsonVariant("wrapped-key-type", value => { value.wrappedKey = 7; }, /journal is invalid/u);
  addJsonVariant("wrapped-key-alphabet", value => { value.wrappedKey = "***"; }, /journal is invalid/u);
  addJsonVariant("mac-type", value => { value.mac = 7; }, /journal is invalid/u);
  addJsonVariant("mac-shape", value => { value.mac = "sha256:00"; }, /journal is invalid/u);
  addJsonVariant("entries-type", value => { value.entries = null; }, /journal is invalid/u);
  addJsonVariant("entries-empty", value => { value.entries = []; }, /journal is invalid/u);
  addJsonVariant("entries-limit", value => { value.entries = new Array(261).fill(value.entries[0]); }, /journal is invalid/u);
  addJsonVariant("entry-null", value => { value.entries[0] = null; }, /entry 0 is invalid/u);
  addJsonVariant("entry-extra", value => { value.entries[0].extra = true; }, /entry 0 fields are invalid/u);
  addJsonVariant("entry-path", value => { value.entries[0].path = "../escape.md"; }, /journal paths are invalid/u);
  addJsonVariant("entry-duplicate", value => { value.entries[1].path = value.entries[0].path; }, /journal paths are invalid/u);
  addJsonVariant("old-state-null", value => { value.entries[0].old = null; }, /old state is invalid/u);
  addJsonVariant("old-state-extra", value => { value.entries[0].old.extra = true; }, /old state fields are invalid/u);
  addJsonVariant("old-present", value => { value.entries[0].old.present = "false"; }, /old state is invalid/u);
  addJsonVariant("old-bytes-negative", value => { value.entries[0].old.bytes = -1; }, /old state is invalid/u);
  addJsonVariant("old-bytes-unsafe", value => { value.entries[0].old.bytes = Number.MAX_SAFE_INTEGER + 1; }, /old state is invalid/u);
  addJsonVariant("old-bytes-limit", value => { value.entries[0].old.bytes = 256 * 1024 * 1024 + 1; }, /old state is invalid/u);
  addJsonVariant("old-hash-type", value => { value.entries[0].old.sha256 = 7; }, /old state is invalid/u);
  addJsonVariant("old-hash-shape", value => { value.entries[0].old.sha256 = "0"; }, /old state is invalid/u);
  addJsonVariant("absent-state-inconsistent", value => {
    value.entries[0].old = { present: false, bytes: 1, sha256: "0".repeat(64) };
  }, /old state is invalid/u);
  addJsonVariant("database-missing", value => {
    value.entries = value.entries.filter(entry => entry.path !== "data/mini-lux.db");
  }, /database is missing/u);
  addJsonVariant("wrapped-key-empty", value => { value.wrappedKey = ""; }, /wrapped key is invalid/u);
  addJsonVariant("wrapped-key-limit", value => {
    value.wrappedKey = Buffer.alloc(64 * 1024 + 1).toString("base64");
  }, /wrapped key is invalid/u);

  for (const variant of variants) {
    await fs.writeFile(journalPath, variant.bytes);
    await assert.rejects(
      () => restore.recoverPendingManagedRestore(validWrapper),
      error => variant.pattern.test(String(error?.message)),
      variant.name
    );
  }
  await fs.writeFile(journalPath, originalBytes);
  for (const invalidKey of [Buffer.alloc(31), new Uint8Array(32), null]) {
    await assert.rejects(
      () => restore.recoverPendingManagedRestore({ unwrapDataKey: async () => invalidKey }),
      /journal key is unavailable/u
    );
  }
  await fs.writeFile(journalPath, originalBytes);
  assert.deepEqual(await restore.recoverPendingManagedRestore(validWrapper), { recovered: true, phase: "prepared" });

  const invalidOrphan = path.join(fixture, ".rainydays-restore", "transactions", "not-a-transaction");
  await fs.mkdir(invalidOrphan);
  await assert.rejects(() => restore.recoverPendingManagedRestore(), /orphan transaction name is invalid/u);
  await fs.rmdir(invalidOrphan);
  assert.deepEqual(await restore.recoverPendingManagedRestore(), { recovered: false, phase: null });
  console.log(JSON.stringify({
    journalVariants: variants.length,
    invalidUnwrappedKeys: 3,
    missingProtectorDenied: true,
    corruptStageDenied: true,
    linkedStageDenied: process.platform === "win32",
    invalidOrphanDenied: true,
    validRecoveryAfterRejection: true,
  }));
} else if (mode === "crash" || mode === "enospc-retry" || mode === "stage-toctou") {
  const config = await import("../../dist/config.js");
  await config.initializeConfig();
  await config.upsertProfile("backup", {
    model: "model-b",
    baseURL: "https://provider.example/v1",
    apiKey: "secret-b",
    providerType: "openai-compatible",
  });
  const { getManagedPathStore } = await import("../../dist/managed-path-store.js");
  const managed = await getManagedPathStore();
  const skills = path.join(fixture, "data", "skills");
  await fs.mkdir(skills, { recursive: true });
  await fs.writeFile(path.join(skills, "common-skill.md"), "Skill B");
  await managed.createNamed("user-personas", "common-persona", ".md", personaSource("b"));
  await managed.createNamed("playbooks", "common-playbook", ".json", playbookSource("b"));
  await managed.writeOracle(Buffer.from(JSON.stringify({
    createdAt: "2026-08-14T00:00:00.000Z",
    projectPath: ".",
    summary: "generation-b",
    tree: "tree",
    headers: { "README.md": ["b"] },
  }), "utf8"));

  const db = await import("../../dist/db.js");
  const now = "2026-08-14T00:00:00.000Z";
  db.insertSession({ id: "restore-generation", persona_name: "developer", title: "B", created_at: now, updated_at: now });
  const { createManagedBackup } = await import("../../dist/data-backup.js");
  const backup = await createManagedBackup();
  const container = await (await import("../../dist/backup-container.js")).openBackupContainer(
    backup,
    credentialStore.createBackupDataKeyWrapper()
  );
  const files = (await import("../../dist/backup-container.js")).materializeBackupFiles(container);

  db.db.prepare("UPDATE sessions SET title='A' WHERE id='restore-generation'").run();
  await config.upsertProfile("backup", {
    model: "model-a",
    baseURL: "https://provider.example/v1",
    apiKey: "secret-a",
    providerType: "openai-compatible",
  });
  await fs.writeFile(path.join(skills, "common-skill.md"), "Skill A");
  await fs.writeFile(path.join(skills, "live-only.md"), "Live-only skill A");
  await fs.writeFile(path.join(fixture, "data", "personas", "common-persona.md"), personaSource("a"));
  await fs.writeFile(path.join(fixture, "data", "personas", "live-only.md"), personaSource("a-only", "live-only"));
  await fs.writeFile(path.join(fixture, "playbooks", "common-playbook.json"), playbookSource("a"));
  await fs.writeFile(path.join(fixture, "playbooks", "live-only.json"), playbookSource("a-only"));
  await managed.writeOracle(Buffer.from(JSON.stringify({
    createdAt: "2026-08-14T00:00:00.000Z",
    projectPath: ".",
    summary: "generation-a",
    tree: "tree",
    headers: { "README.md": ["a"] },
  }), "utf8"));
  await db.closeDb();
  const generationADatabase = mode === "enospc-retry" || mode === "stage-toctou"
    ? await fs.readFile(path.join(fixture, "data", "mini-lux.db"))
    : null;

  const { getBootstrapPathStore } = await import("../../dist/bootstrap-path-store.js");
  const store = getBootstrapPathStore();
  const sources = files.map(file => Object.freeze({ path: file.path, bytes: file.bytes }));
  const wrapper = credentialStore.createBackupDataKeyWrapper();
  if (mode === "enospc-retry") {
    let injected = false;
    await assert.rejects(() => store.publishManagedRestore(sources, wrapper, point => {
      if (injected || point !== "live:before-write") return;
      injected = true;
      const error = new Error("injected restore publication disk full");
      error.code = "ENOSPC";
      throw error;
    }), error => error?.code === "ENOSPC");
    assert.equal(injected, true);
    assert.equal(await fs.access(path.join(fixture, ".rainydays-restore", "active.json")).then(() => true, () => false), false);
    assert.deepEqual(await fs.readFile(path.join(fixture, "data", "mini-lux.db")), generationADatabase);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "config.json"), "utf8")).profiles.backup.model, "model-a");
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "LUX.oracle"), "utf8")).summary, "generation-a");
    assert.equal(await fs.readFile(path.join(skills, "common-skill.md"), "utf8"), "Skill A");
    for (const liveOnly of [
      path.join(skills, "live-only.md"),
      path.join(fixture, "data", "personas", "live-only.md"),
      path.join(fixture, "playbooks", "live-only.json"),
    ]) assert.equal(await fs.access(liveOnly).then(() => true, () => false), true);

    const retried = await store.publishManagedRestore(sources, wrapper);
    assert.equal(retried.cleanupPending, false);
    const { createRequire } = await import("node:module");
    const Database = createRequire(import.meta.url)("better-sqlite3");
    const committed = new Database(path.join(fixture, "data", "mini-lux.db"), { readonly: true, fileMustExist: true });
    try { assert.equal(committed.prepare("SELECT title FROM sessions WHERE id='restore-generation'").get()?.title, "B"); }
    finally { committed.close(); }
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "config.json"), "utf8")).profiles.backup.model, "model-b");
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "LUX.oracle"), "utf8")).summary, "generation-b");
    assert.equal(await fs.readFile(path.join(skills, "common-skill.md"), "utf8"), "Skill B");
    for (const liveOnly of [
      path.join(skills, "live-only.md"),
      path.join(fixture, "data", "personas", "live-only.md"),
      path.join(fixture, "playbooks", "live-only.json"),
    ]) assert.equal(await fs.access(liveOnly).then(() => true, () => false), false);
    await store.close();
    console.log(JSON.stringify({ injectedEnospc: true, exactRollbackA: true, journalCleared: true, sameSourcesRetryB: true }));
  } else if (mode === "stage-toctou") {
    const side = barrierOrGeneration;
    assert(["old", "new"].includes(side));
    let removedStage = null;
    let failNextWrite = false;
    const withheld = path.join(fixture, `withheld-${side}-stage.bin`);
    await assert.rejects(() => store.publishManagedRestore(sources, wrapper, async (point, context) => {
      if (point === "live:after-write" && !removedStage) {
        const journal = JSON.parse(await fs.readFile(path.join(fixture, ".rainydays-restore", "active.json"), "utf8"));
        const currentIndex = journal.entries.findIndex(entry => entry.path === context.path);
        const laterIndex = journal.entries.findIndex((entry, index) => index > currentIndex && entry[side].present);
        assert.notEqual(laterIndex, -1);
        removedStage = path.join(
          fixture,
          ".rainydays-restore",
          "transactions",
          journal.transactionId,
          side,
          `${String(laterIndex).padStart(4, "0")}.bin`
        );
        await fs.rename(removedStage, withheld);
        failNextWrite = true;
        return;
      }
      if (point === "live:before-write" && failNextWrite) throw new Error(`injected post-verification ${side} stage fault`);
    }), new RegExp(`injected post-verification ${side} stage fault`, "u"));
    assert(removedStage);
    await fs.unlink(withheld);
    assert.equal(await fs.access(path.join(fixture, ".rainydays-restore", "active.json")).then(() => true, () => false), false);
    assert.deepEqual(await fs.readFile(path.join(fixture, "data", "mini-lux.db")), generationADatabase);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "config.json"), "utf8")).profiles.backup.model, "model-a");
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "LUX.oracle"), "utf8")).summary, "generation-a");
    assert.equal(await fs.readFile(path.join(skills, "common-skill.md"), "utf8"), "Skill A");
    await store.close();
    console.log(JSON.stringify({ side, pinnedStageSurvivedPathRemoval: true, exactRollbackA: true, journalCleared: true }));
  } else {
    const wantedBarrier = barrierOrGeneration;
    await store.publishManagedRestore(sources, wrapper, point => {
      if (point !== wantedBarrier) return;
      process.stdout.write(`RESTORE_BARRIER:${point}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
    throw new Error("restore crash barrier unexpectedly returned");
  }
} else if (mode === "recover-crash") {
  const wantedBarrier = barrierOrGeneration;
  await (await import("../../dist/managed-restore.js")).recoverPendingManagedRestore(
    credentialStore.createBackupDataKeyWrapper(),
    point => {
      if (point !== wantedBarrier) return;
      process.stdout.write(`RESTORE_BARRIER:${point}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  );
  throw new Error("restore recovery crash barrier unexpectedly returned");
} else {
  const expected = barrierOrGeneration;
  assert(["A", "B"].includes(expected));
  const db = await import("../../dist/db.js");
  const title = db.db.prepare("SELECT title FROM sessions WHERE id='restore-generation'").get()?.title;
  assert.equal(title, expected);
  const configBytes = await fs.readFile(path.join(fixture, "config.json"));
  const parsedConfig = JSON.parse(configBytes.toString("utf8"));
  assert.equal(parsedConfig.profiles.backup.model, `model-${expected.toLowerCase()}`);
  const oracle = JSON.parse(await fs.readFile(path.join(fixture, "LUX.oracle"), "utf8"));
  assert.equal(oracle.summary, `generation-${expected.toLowerCase()}`);
  assert.equal(await fs.readFile(path.join(fixture, "data", "skills", "common-skill.md"), "utf8"), `Skill ${expected}`);
  assert.match(await fs.readFile(path.join(fixture, "data", "personas", "common-persona.md"), "utf8"), new RegExp(`Persona ${expected.toLowerCase()}`));
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture, "playbooks", "common-playbook.json"), "utf8")).description, `generation-${expected.toLowerCase()}`);
  for (const liveOnly of [
    path.join(fixture, "data", "skills", "live-only.md"),
    path.join(fixture, "data", "personas", "live-only.md"),
    path.join(fixture, "playbooks", "live-only.json"),
  ]) assert.equal(await fs.access(liveOnly).then(() => true, () => false), expected === "A");
  assert.equal(await fs.access(path.join(fixture, ".rainydays-restore", "active.json")).then(() => true, () => false), false);
  await db.closeDb();
  await (await import("../../dist/bootstrap-path-store.js")).getBootstrapPathStore().close();
  console.log(JSON.stringify({ expected, recoveredExactGeneration: true, startupGatePassed: true }));
}
