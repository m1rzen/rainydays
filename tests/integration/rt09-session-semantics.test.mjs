import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-rt09-sessions-");
const dataDir = path.join(fixture, "data");
await mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
});
const [
  sessionModule,
  { closeDb, getMessagesBySession, insertMessage, getPinsBySession, insertPin, deleteMessagesAfterLastUserMessage },
  { createTask, updateTask, getTasksBySession },
] = await Promise.all([
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/task.js"),
]);

const persona = Object.freeze({
  name: "rt09-fixture",
  displayName: "RT-09",
  description: "fixture",
  tools: Object.freeze([]),
  env: Object.freeze({}),
  allowedRoots: Object.freeze([]),
  networkPolicy: Object.freeze({ mode: "deny" }),
  systemPrompt: "RT-09 fixture",
  digest: "rt09-digest",
});

after(async () => {
  closeDb();
  await removeFixture(fixture);
});

test("RT-09 fork copies messages, Task DAG with dependencies, and pins in one transaction", () => {
  const source = sessionModule.createSession(persona, "RT-09 source");
  insertPin(source.id, "pin-a");
  insertPin(source.id, "pin-b");
  const now = new Date().toISOString();
  insertMessage({ session_id: source.id, role: "user", content: "u1", tool_calls: null, tool_call_id: null, created_at: now });
  insertMessage({ session_id: source.id, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }]), tool_call_id: null, created_at: now });
  insertMessage({ session_id: source.id, role: "tool", content: "r1", tool_calls: null, tool_call_id: "c1", created_at: now });
  insertMessage({ session_id: source.id, role: "user", content: "u2", tool_calls: null, tool_call_id: null, created_at: now });
  createTask(source.id, { id: "setup", subject: "准备" });
  createTask(source.id, { id: "deploy", subject: "部署", blockedBy: ["setup"] });
  updateTask(source.id, "setup", { status: "completed" });

  const forked = sessionModule.forkSession(source.id, null, persona);
  const messages = getMessagesBySession(forked.id);
  assert.equal(messages.length, 4);
  assert.equal(messages.map(m => m.role).join(","), "user,assistant,tool,user");
  assert.equal(JSON.parse(messages[1].tool_calls)[0].id, "c1");

  const tasks = getTasksBySession(forked.id);
  assert.equal(tasks.length, 2);
  const setup = tasks.find(t => t.id === "setup");
  const deploy = tasks.find(t => t.id === "deploy");
  assert.equal(setup.status, "completed");
  assert.equal(deploy.blockedBy.join(","), "setup");
  assert.equal(deploy.blocked, false);

  const pins = getPinsBySession(forked.id);
  assert.equal(pins.map(p => p.content).join(","), "pin-a,pin-b");
});

test("RT-09 rollback keeps the last user message and removes the trailing assistant/tool round without orphans", () => {
  const s = sessionModule.createSession(persona, "RT-09 rollback");
  const now = new Date().toISOString();
  insertMessage({ session_id: s.id, role: "user", content: "question", tool_calls: null, tool_call_id: null, created_at: now });
  insertMessage({ session_id: s.id, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "x1", type: "function", function: { name: "t", arguments: "{}" } }]), tool_call_id: null, created_at: now });
  insertMessage({ session_id: s.id, role: "tool", content: "result", tool_calls: null, tool_call_id: "x1", created_at: now });
  insertMessage({ session_id: s.id, role: "assistant", content: "final answer", tool_calls: null, tool_call_id: null, created_at: now });

  const deleted = deleteMessagesAfterLastUserMessage(s.id);
  assert.equal(deleted, 3);
  const remaining = getMessagesBySession(s.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].role, "user");
  assert.equal(remaining[0].content, "question");
  assert.equal(remaining.filter(m => m.role === "tool" || m.role === "assistant").length, 0);
});

test("RT-09 background semantic title succeeds, falls back, and never overwrites a manual rename", async () => {
  const s = sessionModule.createSession(persona, undefined);
  assert.equal(s.title, "新对话");
  const stored = sessionModule.autoGenerateTitle(s.id, "这是一条非常长的首条消息".repeat(5));
  assert.equal(stored.endsWith("..."), true);
  assert.equal(sessionModule.getSessionInfo(s.id).title, stored);

  const successLlm = { chat: async () => ({ role: "assistant", content: " \"部署流水线排障\" " }) };
  await sessionModule.generateSemanticSessionTitle(successLlm, s.id, "content", stored);
  assert.equal(sessionModule.getSessionInfo(s.id).title, "部署流水线排障");

  const failing = sessionModule.createSession(persona, undefined);
  const failingFallback = sessionModule.autoGenerateTitle(failing.id, "短消息");
  const failingLlm = { chat: async () => { throw new Error("provider down"); } };
  await sessionModule.generateSemanticSessionTitle(failingLlm, failing.id, "content", failingFallback);
  assert.equal(sessionModule.getSessionInfo(failing.id).title, failingFallback);

  const manual = sessionModule.createSession(persona, undefined);
  const manualFallback = sessionModule.autoGenerateTitle(manual.id, "原始首条消息");
  sessionModule.renameSession(manual.id, "我的自定义标题");
  await sessionModule.generateSemanticSessionTitle(successLlm, manual.id, "content", manualFallback);
  assert.equal(sessionModule.getSessionInfo(manual.id).title, "我的自定义标题");
});
