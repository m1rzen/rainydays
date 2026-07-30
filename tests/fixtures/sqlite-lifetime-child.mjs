import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [scenario, fixture, outside] = process.argv.slice(2);
assert(["normal", "sidecar-link", "main-replacement", "main-hardlink", "crud"].includes(scenario));
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

  const taskIds = db.insertTasks(session.id, ["first", "second"]);
  assert.equal(db.getTasksBySessionId(session.id).length, 2);
  assert.equal(db.getTask(taskIds[0]).subject, "first");
  db.updateTaskStatusInDb(taskIds[0], "in_progress", "working");
  db.updateTaskStatusInDb(taskIds[1], "completed");
  db.updateTaskSubject(taskIds[0], "renamed");
  db.deleteTask(taskIds[1]);

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
