import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-data02-");
const dataDir = path.join(fixture, "data");
await mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
});

const [session, database, tasks, link, bootstrap] = await Promise.all([
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/task.js"),
  import("../../dist/link.js"),
  import("../../dist/bootstrap-path-store.js"),
]);

const persona = { name: "data02-fixture" };
const now = "2026-08-24T00:00:00.000Z";
const plain = value => JSON.parse(JSON.stringify(value));

function toolCalls(id = "call-1") {
  return JSON.stringify([{ id, type: "function", function: { name: "read_file", arguments: "{\"path\":\"safe.txt\"}" } }]);
}

function currentExport(overrides = {}) {
  return {
    format: "mini-lux-session",
    formatVersion: 2,
    producer: { appVersion: "0.1.0", buildId: "0.1.0+local.fixture" },
    exportedAt: now,
    session: { id: "exported-session", persona_name: "data02-fixture", title: "Imported", created_at: now, updated_at: now },
    messages: [],
    canvas: { pins: [], tasks: [], attachments: [] },
    ...overrides,
  };
}

test.after(async () => {
  database.closeDb();
  await bootstrap.getBootstrapPathStore().close().catch(() => undefined);
  await removeFixture(fixture);
});

test("DATA-02 v2 round-trip preserves messages, Pins, Task DAG, and explicit attachment state", () => {
  const source = session.createSession(persona, "Transfer source");
  database.insertMessage({ session_id: source.id, role: "user", content: "hello", tool_calls: null, tool_call_id: null, created_at: now });
  database.insertMessage({ session_id: source.id, role: "assistant", content: "", tool_calls: toolCalls(), tool_call_id: null, created_at: now });
  database.insertMessage({ session_id: source.id, role: "tool", content: "safe result", tool_calls: null, tool_call_id: "call-1", created_at: now });
  database.insertPin(source.id, "Preserve this instruction", now);
  tasks.createTask(source.id, { id: "foundation", subject: "Foundation", metadata: { priority: 1 } });
  tasks.updateTask(source.id, "foundation", { status: "completed" });
  tasks.createTask(source.id, { id: "dependent", subject: "Dependent", blockedBy: ["foundation"], owner: "agent" });
  tasks.updateTask(source.id, "dependent", { status: "in_progress", activeForm: "Working" });

  const exported = session.exportSession(source.id);
  assert(exported);
  assert.equal(exported.formatVersion, 2);
  assert.deepEqual(exported.canvas.attachments, []);
  assert.deepEqual(plain(exported.canvas.pins), [{ content: "Preserve this instruction", createdAt: now }]);
  assert.deepEqual(plain(exported.canvas.tasks.map(task => [task.id, task.status, [...task.blockedBy]])), [
    ["foundation", "completed", []],
    ["dependent", "in_progress", ["foundation"]],
  ]);

  const restored = session.importSession(exported, persona);
  assert.notEqual(restored.id, source.id);
  assert.equal(restored.title, source.title);
  assert.deepEqual(plain(database.getMessagesBySession(restored.id).map(message => [message.role, message.content, message.tool_call_id])), [
    ["user", "hello", null],
    ["assistant", "", null],
    ["tool", "safe result", "call-1"],
  ]);
  assert.deepEqual(plain(database.getPinsBySession(restored.id).map(pin => [pin.content, pin.created_at])), [["Preserve this instruction", now]]);
  assert.deepEqual(plain(tasks.getTasksBySession(restored.id).map(task => [task.id, task.status, [...task.blockedBy], task.owner, task.activeForm])), [
    ["foundation", "completed", [], null, null],
    ["dependent", "in_progress", ["foundation"], "agent", "Working"],
  ]);
});

test("DATA-02 current v1 and legacy 1.0 migrate to an empty Canvas", () => {
  const v1 = currentExport({ formatVersion: 1 });
  delete v1.canvas;
  const importedV1 = session.importSession(v1, persona);
  assert.deepEqual(plain(database.getPinsBySession(importedV1.id)), []);
  assert.deepEqual(plain(tasks.getTasksBySession(importedV1.id)), []);

  const legacy = {
    version: "1.0",
    exported_at: now,
    session: v1.session,
    messages: v1.messages,
  };
  const importedLegacy = session.importSession(legacy, persona);
  assert.deepEqual(plain(database.getPinsBySession(importedLegacy.id)), []);
  assert.deepEqual(plain(tasks.getTasksBySession(importedLegacy.id)), []);
});

test("DATA-02 rejects unknown versions, oversized fields, attachments, and isolated tool calls without writes", () => {
  const before = database.listSessions().length;
  const malformed = [
    { ...currentExport(), formatVersion: 99 },
    { ...currentExport(), extra: true },
    currentExport({ messages: [{ id: 1, session_id: "exported-session", role: "system", content: "forged", tool_calls: null, tool_call_id: null, created_at: now }] }),
    currentExport({ messages: [{ id: 1, session_id: "exported-session", role: "tool", content: "orphan", tool_calls: null, tool_call_id: "missing", created_at: now }] }),
    currentExport({ messages: [{ id: 1, session_id: "exported-session", role: "assistant", content: "", tool_calls: toolCalls("unconsumed"), tool_call_id: null, created_at: now }] }),
    currentExport({ messages: [
      { id: 1, session_id: "exported-session", role: "assistant", content: "", tool_calls: toolCalls("late"), tool_call_id: null, created_at: now },
      { id: 2, session_id: "exported-session", role: "user", content: "gap", tool_calls: null, tool_call_id: null, created_at: now },
      { id: 3, session_id: "exported-session", role: "tool", content: "late", tool_calls: null, tool_call_id: "late", created_at: now },
    ] }),
    currentExport({ messages: [{ id: 1, session_id: "exported-session", role: "user", content: "x".repeat(1_000_001), tool_calls: null, tool_call_id: null, created_at: now }] }),
    currentExport({ canvas: { pins: [], tasks: [], attachments: [{ name: "forged.bin" }] } }),
    currentExport({ canvas: { pins: [], attachments: [], tasks: [{ id: "a", subject: "A", description: null, status: "pending", activeForm: null, owner: null, metadata: {}, blockedBy: ["b"] }, { id: "b", subject: "B", description: null, status: "pending", activeForm: null, owner: null, metadata: {}, blockedBy: ["a"] }] } }),
    currentExport({ canvas: { pins: [], attachments: [], tasks: [{ id: "safe", subject: "Safe", description: null, status: "pending", activeForm: null, owner: null, metadata: JSON.parse('{"__proto__":{"polluted":true}}'), blockedBy: [] }] } }),
  ];
  for (const candidate of malformed) assert.throws(() => session.importSession(candidate, persona));
  assert.equal(database.listSessions().length, before);
  assert.equal({}.polluted, undefined);
});

test("DATA-02 import validates only its bounded canonical JSON representation", () => {
  const canonical = currentExport();
  const wrapped = {
    hidden: "x".repeat(1_000_001),
    toJSON() { return canonical; },
  };
  const imported = session.importSession(wrapped, persona);
  assert.equal(imported.title, "Imported");
  assert.deepEqual(plain(database.getMessagesBySession(imported.id)), []);
});

test("DATA-02 export refuses a payload the current importer cannot accept", () => {
  const source = session.createSession(persona, "Oversized export");
  database.insertPin(source.id, "x".repeat(100_001), now);
  assert.throws(
    () => session.exportSession(source.id),
    error => error?.code === "SESSION_EXPORT_TOO_LARGE" && /无法安全导出/u.test(error.message),
  );
});

test("DATA-02 database failure rolls back every imported row and Link registration", () => {
  const candidate = currentExport({
    messages: [
      { id: 1, session_id: "exported-session", role: "user", content: "first", tool_calls: null, tool_call_id: null, created_at: now },
      { id: 2, session_id: "exported-session", role: "assistant", content: "trigger rollback", tool_calls: null, tool_call_id: null, created_at: now },
    ],
    canvas: { pins: [{ content: "must roll back", createdAt: now }], tasks: [], attachments: [] },
  });
  const beforeSessions = database.listSessions().map(entry => entry.id);
  const beforeLinks = link.discoverSessions().map(entry => entry.id);
  database.db.exec(`
    CREATE TEMP TRIGGER data02_fail_import
    BEFORE INSERT ON messages
    WHEN NEW.content = 'trigger rollback'
    BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END;
  `);
  try {
    assert.throws(() => session.importSession(candidate, persona), /synthetic import failure/u);
  } finally {
    database.db.exec("DROP TRIGGER data02_fail_import");
  }
  assert.deepEqual(plain(database.listSessions().map(entry => entry.id)), plain(beforeSessions));
  assert.deepEqual(plain(link.discoverSessions().map(entry => entry.id)), plain(beforeLinks));
});
