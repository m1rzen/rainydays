import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-product-"));
await mkdir(path.join(fixture, "data"));
await mkdir(path.join(fixture, "playbooks"));
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const { ConversationMemory } = await import("../../src/memory.ts");
const { closeDb, insertSession } = await import("../../src/db.ts");
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-product-"));
  await rm(fixture, { recursive: true, force: true });
});

const call = id => ({ id, type: "function", function: { name: "read", arguments: "{}" } });
test("完整资料进入上下文，恢复会话后仍保留单行和多行原文", async () => {
  const now = new Date().toISOString();
  insertSession({ id: "product-memory", persona_name: "product", title: "fixture", created_at: now, updated_at: now });
  const memory = new ConversationMemory();
  memory.setSessionId("product-memory");
  const payloads = [JSON.stringify({ rows: "正文".repeat(4000), conclusion: "最后一项不可丢" }), "前言\n" + "事实与依据\n".repeat(1000) + "结论"];
  const messages = [
    { role: "user", content: "请分析资料" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    ...payloads.map((content, index) => ({ role: "tool", content, tool_call_id: index ? "b" : "a" })),
  ];
  memory.addMany(messages);
  assert.deepEqual(memory.getAll(), messages);
  assert.equal(await memory.compact({ chat: () => assert.fail("预算内不应摘要") }), false);
  const restored = new ConversationMemory();
  restored.loadFromDb("product-memory");
  assert.deepEqual(restored.getAll(), messages);
});

test("最近资料超预算时明确停止且不丢原文", async () => {
  const memory = new ConversationMemory();
  memory.addMany([{ role: "assistant", content: "", tool_calls: [call("large")] }, { role: "tool", tool_call_id: "large", content: "文".repeat(80000) }]);
  const before = memory.getAll();
  await assert.rejects(() => memory.compact({ chat: () => assert.fail("不能摘要当前工具结果") }), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
  assert.deepEqual(memory.getAll(), before);
});

test("摘要边界保留整组工具结果，不遗漏第二个结果", async () => {
  const memory = new ConversationMemory();
  memory.addMany([
    { role: "user", content: "旧记录".repeat(25000) },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "a", content: "结果甲" },
    { role: "tool", tool_call_id: "b", content: "结果乙" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `后续 ${i}` })),
  ]);
  await memory.compact({ chat: async messages => {
    assert.match(messages[1].content, /结果甲/);
    assert.match(messages[1].content, /结果乙/);
    return { role: "assistant", content: "已记录甲乙" };
  } });
  assert(memory.hasSummary());
});

test("摘要后仍超预算时保留原上下文，不提交不合格摘要", async () => {
  const memory = new ConversationMemory();
  memory.addMany(Array.from({ length: 18 }, () => ({ role: "user", content: "x".repeat(5000) })));
  const before = memory.getAll();
  await assert.rejects(() => memory.compact({ chat: async () => ({ role: "assistant", content: "x".repeat(80000) }) }), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
  assert.deepEqual(memory.getAll(), before);
});

test("Agent 断流后保存已显示文字和失败提示，重开会话可恢复", async () => {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"),
  ]);
  const persona = createEffectivePersona({ name: "product-stream", displayName: "Product", description: "Fixture", tools: [], env: {}, allowedRoots: [fixture], networkPolicy: { mode: "unrestricted" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({
    ...persona,
    rootEnv: {},
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file"] }]),
  });
  const llm = {
    async chat() { return { role: "assistant", content: "Fixture title" }; },
    async *chatStream() {
      yield { type: "delta", content: "第一段正文\n" };
      yield { type: "delta", content: "第二段未完成" };
      throw new Error("provider stream interrupted");
    },
  };
  const memory = new ConversationMemory();
  const session = createSession(persona, "Fixture");
  const agent = new Agent(llm, memory, persona, authority);
  agent.setSession(session.id);
  const events = [];
  for await (const event of agent.run("请分析")) events.push(event);
  const partial = events.filter(event => event.type === "answer_chunk").map(event => event.content).join("");
  assert.equal(partial, "第一段正文\n第二段未完成");
  const error = events.find(event => event.type === "error");
  assert(error);
  const expected = `${partial}\n\n⚠️ ${error.content}`;
  assert.equal(memory.getAll().at(-1).content, expected);
  const restored = new ConversationMemory();
  restored.loadFromDb(session.id);
  assert.equal(restored.getAll().at(-1).content, expected);
  assert.equal(restored.getAll().at(-1).tool_calls, undefined);
});
