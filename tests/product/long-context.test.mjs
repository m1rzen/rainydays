import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-long-context-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data") });
const [{ insertSession, insertMessage, closeDb }, { ConversationMemory }, { readExec }, { NEVER_ABORT_SIGNAL }] = await Promise.all([
  import("../../src/db.ts"), import("../../src/memory.ts"), import("../../src/tools/filesystem-lux.ts"), import("../../src/run-cancellation.ts"),
]);
test.after(async () => { await closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-long-context-")); await rm(fixture, { recursive: true, force: true }); });
const now = new Date().toISOString();
for (const id of ["long-a", "long-b"]) insertSession({ id, persona_name: "fixture", title: "长对话", created_at: now, updated_at: now });
const message = (session, content, role = "assistant") => insertMessage({ session_id: session, role, content, created_at: now });
const invocation = sessionId => ({ capabilityContext: { sessionId }, signal: NEVER_ABORT_SIGNAL, path: { rootIdForEnv: () => null } });

test("D03 read retrieves immutable paged history after restoring session memory", async () => {
  const early = message("long-a", "唯一早期事实：ABC57\n" + "可分页原文\n".repeat(24));
  for (let index = 0; index < 20; index++) { message("long-a", `第${index+1}轮问题`, "user"); message("long-a", `第${index+1}轮回答`); }
  const foreign = message("long-b", "不应被其他会话取回");
  const restored = new ConversationMemory(8); restored.loadFromDb("long-a");
  const index = await readExec({ file_path: "history:", limit: 1 }, {}, invocation("long-a"));
  assert.match(index, new RegExp(`history:${early}`)); assert.match(index, /下一页 offset=2/);
  const first = await readExec({ file_path: `history:${early}`, offset: 1, limit: 12 }, {}, invocation("long-a"));
  assert.match(first, /唯一早期事实：ABC57/); assert.match(first, /下一页 offset=13/);
  const next = await readExec({ file_path: `history:${early}`, offset: 13, limit: 12 }, {}, invocation("long-a"));
  assert.match(next, /13 \|/);
  await assert.rejects(readExec({ file_path: `history:${foreign}` }, {}, invocation("long-a")), error => error.code === "TOOL_ARGUMENTS_INVALID");
  await assert.rejects(readExec({ file_path: "history:../../config.json" }, {}, invocation("long-a")), error => error.code === "TOOL_ARGUMENTS_INVALID");
});

test("D03 message thresholds never silently trim original context", () => {
  insertSession({ id: "threshold", persona_name: "fixture", title: "threshold", created_at: now, updated_at: now });
  const memory = new ConversationMemory(3);
  memory.setSessionId("threshold");
  memory.addMany(Array.from({ length: 20 }, (_, index) => ({ role: "user", content: `原始要求${index}` })));
  assert.equal(memory.getAll().filter(item => item.role === "user").length, 20);
  const restored = new ConversationMemory(3); restored.loadFromDb("threshold");
  assert(restored.getAll().some(item => item.content === "原始要求0"));
});

test("D03 compaction keeps exact user constraints, document references and paired recent tools", async () => {
  const memory = new ConversationMemory();
  const artifactPath = path.join(fixture, "必须保留.docx");
  memory.addMany([
    { role: "user", content: "不要覆盖原文件；引用原始事实" },
    { role: "assistant", content: "", tool_calls: [{ id: "document", type: "function", function: { name: "create_docx", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "document", content: JSON.stringify({ status: "success", truncated: false, content: JSON.stringify({ type: "document_output", format: "docx", path: artifactPath }) }) },
    ...Array.from({ length: 18 }, () => ({ role: "assistant", content: "旧资料".repeat(2000) })),
    { role: "assistant", content: "", tool_calls: [{ id: "paired-a", type: "function", function: { name: "read", arguments: "{}" } }, { id: "paired-b", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "paired-a", content: "甲" }, { role: "tool", tool_call_id: "paired-b", content: "乙" },
    { role: "user", content: "结合两项资料继续" },
  ]);
  await memory.compact({ chat: async () => ({ role: "assistant", content: "短摘要，未编造原文" }) });
  const messages = memory.getAll();
  assert(messages.some(item => item.role === "user" && item.content === "不要覆盖原文件；引用原始事实"));
  assert(messages.find(item => item.role === "system").content.includes(JSON.stringify(artifactPath)));
  assert.deepEqual(messages.filter(item=>item.role==='tool').map(item=>item.tool_call_id), ["paired-a", "paired-b"]);
  assert.deepEqual(messages.find(item=>item.tool_calls?.[0]?.id==='paired-a').tool_calls.map(item=>item.id), ["paired-a", "paired-b"]);
});

function largeMemory() {
  const memory = new ConversationMemory();
  memory.setSystemPrompt("核对原始资料");
  memory.add({ role: "user", content: "不要覆盖原文件，成果另存" });
  memory.addMany(Array.from({ length: 18 }, () => ({ role: "assistant", content: "旧资料".repeat(2000) })));
  memory.add({ role: "user", content: "继续核对事实" });
  return memory;
}

for (const [label, chat] of [["failed", async () => { throw new Error("fixture unavailable"); }], ["empty", async () => ({ role: "assistant", content: " " })]]) {
  test(`D03 ${label} summaries do not discard context or continue guessing`, async () => {
    const memory = largeMemory(); const before = memory.getAll();
    await assert.rejects(memory.compact({ chat }), error => error.code === "CONTEXT_COMPACTION_FAILED");
    assert.deepEqual(memory.getAll(), before);
  });
}

test("D03 summary timeout and user cancellation end even if the adapter ignores abort", { timeout: 2000 }, async () => {
  const memory = largeMemory(); const before = memory.getAll();
  await assert.rejects(memory.compact({ chat: () => new Promise(()=>{}) }, undefined, undefined, { summaryTimeoutMs: 20 }), error => error.code === "CONTEXT_COMPACTION_FAILED");
  assert.deepEqual(memory.getAll(), before);
  const controller = new AbortController();
  const pending = memory.compact({ chat: () => new Promise(()=>{}) }, controller.signal);
  controller.abort(new Error("user stopped"));
  await assert.rejects(pending, error => error.code === "RUN_CANCELLED");
  assert.deepEqual(memory.getAll(), before);
});

test("D03 the latest parallel tool group is kept whole even when it exceeds the recent-message threshold", async () => {
  const memory = new ConversationMemory();
  const calls = Array.from({ length: 12 }, (_, index) => ({ id: `fresh-${index}`, type: "function", function: { name: "read", arguments: "{}" } }));
  memory.addMany([{ role: "user", content: "读取这些原文后核对" }, { role: "assistant", content: "", tool_calls: calls },
    ...calls.map(call=>({role:"tool",tool_call_id:call.id,content:"x".repeat(10000)}))]);
  const before = memory.getAll();
  await assert.rejects(memory.compact({ chat: () => assert.fail("cannot summarize away the latest tool group") }), error=>error.code==='CONTEXT_BUDGET_EXCEEDED');
  assert.deepEqual(memory.getAll(),before);
});

test("D03 oversized original user requirements stop explicitly and remain unchanged", async () => {
  const memory=new ConversationMemory();
  const original="禁止覆盖原文件；需要保留的用户原话。".repeat(10000);
  memory.add({role:'user',content:original});
  await assert.rejects(memory.compact({chat:()=>assert.fail('must not summarize away oversized protected user requirements')}),error=>error.code==='CONTEXT_BUDGET_EXCEEDED');
  assert.equal(memory.getAll().at(-1).content,original);
});
