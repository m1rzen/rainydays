import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-agent-session-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data") });
const [{ closeDb, insertSession, getMessagesBySession }, { SubagentRegistry }, { createAgentSessionExecutors }, { createCompactContextExec, createConsolidateMemoryExec }, { ConversationMemory }, { getSessionAgentMapForTest }] = await Promise.all([
  import("../../src/db.ts"), import("../../src/subagent-registry.ts"), import("../../src/tools/agent-session-tools.ts"), import("../../src/tools/lux-cloud-tools.ts"), import("../../src/memory.ts"),
  import("../../src/lux-cloud-runtime.ts").then(module => ({ getSessionAgentMapForTest: module.viewSessionAgentMap })),
]);
test.after(async () => { closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-agent-session-")); await rm(fixture, { recursive: true, force: true }); });

const persona = Object.freeze({ name: "general", displayName: "g", description: "g", tools: Object.freeze([]), env: Object.freeze({}), allowedRoots: Object.freeze([]), networkPolicy: Object.freeze({ mode: "deny" }), systemPrompt: "system", digest: "d" });

function harness(llm, sessionId = "parent") {
  const controller = new AbortController();
  const context = { sessionId, allowedRoots: [], networkPolicy: { mode: "deny" } };
  const child = { sessionId, allowedTools: new Set(), allowedRoots: [], networkPolicy: { mode: "deny" } };
  const invocation = Object.freeze({
    capabilityContext: context, signal: controller.signal, network: { fetch: async () => { throw new Error("no network"); } }, path: {},
    getUnattendedChildToolNames: () => [], deriveDetachedChild: () => child, finishDetachedChild: async () => undefined, createDetachedNetwork: () => ({ fetch: async () => { throw new Error("no network"); } }),
    getToolDefinitions: () => [], listCurrentToolDefinitions: () => [], executeDetachedTool: async () => "", executeTool: async () => "",
  });
  const registry = new SubagentRegistry(sessionId);
  const models = new Map();
  const tools = createAgentSessionExecutors({ registry, llm, persona, resolveModel: name => models.get(name) ?? null });
  return { tools, invocation, registry, models };
}
const call = async (tool, args, invocation) => JSON.parse(await tool(args, {}, invocation));

test("agent_spawn really runs the model and agent_wait returns its answer", async () => {
  let calls = 0;
  const { tools, invocation, registry } = harness({ chat: async () => { calls++; return { role: "assistant", content: "审计完成：第 1 段无问题" }; } }, "real-run");
  const spawned = await call(tools.agent_spawn, { task: "审计冷存储", name: "auditor" }, invocation);
  assert.equal(spawned.allow_subagent, false);
  const settled = await call(tools.agent_wait, { event: { session: spawned.id }, timeout: 5 }, invocation);
  assert.equal(calls, 1);
  assert.equal(settled.trigger, "idle");
  assert.equal(settled.result, "审计完成：第 1 段无问题");
  const listed = await call(tools.agent_list, { scope: "current" }, invocation);
  assert.equal(listed.total, 1); assert.equal(listed.agents[0].status, "idle");
  await registry.shutdown();
});

test("agent_wait reports a timeout and agent_post reaches a running child", async () => {
  let release;
  const seen = [];
  const { tools, invocation, registry } = harness({ chat: async messages => { seen.push(messages.map(message => message.content).join("\n")); if (seen.length === 1) await new Promise(resolve => { release = resolve; }); return { role: "assistant", content: `完成${seen.length}` }; } }, "running");
  const spawned = await call(tools.agent_spawn, { task: "长任务" }, invocation);
  const waited = await call(tools.agent_wait, { event: { session: spawned.id }, timeout: 1 }, invocation);
  assert.equal(waited.trigger, "timeout"); assert.equal(waited.status, "streaming");
  const posted = await call(tools.agent_post, { id: spawned.id, message: "重点看第二段" }, invocation);
  assert.equal(posted.delivered, true);
  release();
  const settled = await call(tools.agent_wait, { event: { session: spawned.id }, timeout: 5 }, invocation);
  assert.equal(settled.result, "完成2");
  assert.match(seen[1], /重点看第二段/u);
  await assert.rejects(call(tools.agent_post, { id: spawned.id, message: "再来" }, invocation), /not running/u);
  await registry.shutdown();
});

test("agent_close stops a running child and failures are reported, not hidden", async () => {
  const { tools, invocation, registry } = harness({ chat: (_messages, _tools, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }, "closing");
  const spawned = await call(tools.agent_spawn, { task: "不会结束" }, invocation);
  await new Promise(resolve => setTimeout(resolve, 20));
  const closed = await call(tools.agent_close, { id: spawned.id }, invocation);
  assert.equal(closed.status, "interrupted"); assert.equal(closed.closed, true);
  await registry.shutdown();
  const failing = harness({ chat: async () => { throw new Error("模型 402"); } }, "failing");
  const failed = await call(failing.tools.agent_spawn, { task: "会失败" }, failing.invocation);
  const settled = await call(failing.tools.agent_wait, { event: { session: failed.id }, timeout: 5 }, failing.invocation);
  assert.equal(settled.trigger, "error"); assert.match(settled.error, /402/u);
  await failing.registry.shutdown();
});

test("unsupported agent options fail plainly instead of pretending", async () => {
  const { tools, invocation, registry } = harness({ chat: async () => ({ role: "assistant", content: "x" }) }, "plain");
  await assert.rejects(call(tools.agent_spawn, { task: "x", model: "不存在" }, invocation), /模型不存在/u);
  await assert.rejects(call(tools.agent_wait, { event: { session: "a" }, async: true }, invocation), /async/u);
  assert.equal((await call(tools.agent_cancel_wait, { id: "x" }, invocation)).cancelled, false);
  await assert.rejects(call(tools.agent_post, { id: "missing-agent", message: "hi" }, invocation), /does not exist/u);
  await registry.shutdown();
});

test("a long description still produces a task id the registry accepts", async () => {
  const { tools, invocation, registry } = harness({ chat: async () => ({ role: "assistant", content: "ok" }) }, "long-name");
  const spawned = await call(tools.agent_spawn, { task: "t", name: "a".repeat(120) }, invocation);
  assert((await call(tools.agent_peek, { id: spawned.id, scope: "status" }, invocation)).id === spawned.id);
  await registry.shutdown();
});

function longMemory(sessionId) {
  insertSession({ id: sessionId, persona_name: "fixture", title: "t", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const memory = new ConversationMemory();
  memory.setSessionId(sessionId);
  memory.add({ role: "user", content: "继续" });
  for (let index = 0; index < 14; index++) memory.add({ role: "assistant", content: `进展${index} ` + "内容".repeat(300) });
  memory.add({ role: "user", content: "接着做" });
  return memory;
}

test("compact_context really shrinks the conversation and uses the requested focus", async () => {
  const memory = longMemory("compact-real");
  const prompts = [];
  const llm = { estimateRequest: messages => ({ contextWindowTokens: 1_000_000, outputReserveTokens: 0, estimatedInputTokens: Math.ceil(JSON.stringify(messages).length / 2) }), chat: async messages => { prompts.push(messages.at(-1).content); return { role: "assistant", content: "真实摘要内容" }; } };
  const exec = createCompactContextExec(memory, llm);
  const signal = new AbortController().signal;
  const result = JSON.parse(await exec({ focus: "冷存储" }, {}, { signal, network: { fetch: undefined } }));
  assert.equal(result.status, "compacted");
  assert(result.tokens_after < result.tokens_before);
  assert.match(prompts[0], /冷存储/u);
  assert.equal(memory.getSummaryGeneration(), 1);
  assert.equal(getMessagesBySession("compact-real").length, 16, "the database keeps every original message");
  const map = JSON.stringify(getSessionAgentMapForTest("compact-real", {}));
  assert.match(map, /真实摘要内容/u);
});

test("deep consolidation requires a model and rejects non-JSON output", async () => {
  await assert.rejects(createConsolidateMemoryExec()({ level: "deep" }, {}, undefined), /模型/u);
  const db = await import("../../src/db.ts");
  db.insertMemory("陈铭津负责 RainyDays 项目", "fact", []);
  const signal = new AbortController().signal;
  await assert.rejects(createConsolidateMemoryExec({ chat: async () => ({ role: "assistant", content: "抱歉" }) })({ level: "deep" }, {}, { signal, network: {} }), /JSON/u);
  const result = JSON.parse(await createConsolidateMemoryExec({ chat: async () => ({ role: "assistant", content: '{"entities":[{"name":"陈铭津","kind":"person"},{"name":"RainyDays","kind":"project"}],"edges":[{"src":"陈铭津","dst":"RainyDays","relation":"负责"}]}' }) })({ level: "deep" }, {}, { signal, network: {} }));
  assert.equal(result.extractedNodes.length, 2);
  assert.equal(result.extractedEdges.length, 1);
});

function scopedHarness(llm, sessionId) {
  const controller = new AbortController(), derived = [];
  const childPersona = Object.freeze({ ...persona, tools: Object.freeze(["read", "glob", "grep", "web_search", "write", "edit", "execute_command", "create_docx"]) });
  const context = { sessionId, allowedRoots: [], networkPolicy: { mode: "deny" } };
  const invocation = Object.freeze({
    capabilityContext: context, signal: controller.signal, network: { fetch: async () => { throw new Error("no network"); } }, path: {},
    getUnattendedChildToolNames: () => ["read", "glob", "grep", "web_search", "write", "edit", "execute_command", "create_docx"],
    deriveDetachedChild: request => { derived.push(request); return { sessionId, allowedTools: new Set(request.tools), allowedRoots: [], networkPolicy: { mode: "deny" } }; },
    finishDetachedChild: async () => undefined, createDetachedNetwork: () => ({ fetch: async () => { throw new Error("no network"); } }),
    getToolDefinitions: () => [], listCurrentToolDefinitions: () => [], executeDetachedTool: async () => "", executeTool: async () => "",
  });
  const registry = new SubagentRegistry(sessionId);
  const tools = createAgentSessionExecutors({ registry, llm, persona: childPersona, resolveModel: () => null });
  return { tools, invocation, registry, controller, derived };
}

test("A12 at most two children run at once, each gets read-only tools, and results are marked as suggestions", async () => {
  const releases = [];
  const { tools, invocation, registry, derived } = scopedHarness({ chat: async () => { await new Promise(resolve => releases.push(resolve)); return { role: "assistant", content: "来源：README 第 3 行" }; } }, "a12-limit");
  const first = await call(tools.agent_spawn, { task: "读 README 找配置项", name: "reader" }, invocation);
  await call(tools.agent_spawn, { task: "读 CHANGELOG", name: "changelog" }, invocation);
  await assert.rejects(tools.agent_spawn({ task: "第三个" }, {}, invocation), /最多同时运行 2 个子任务/u);
  assert.equal(first.read_only, true); assert.match(first.note, /不是已核对的事实/u);
  for (const request of derived) assert.deepEqual([...request.tools].sort(), ["glob", "grep", "read", "web_search"], "no write, edit, process or document creation");
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  releases.shift()();
  const settled = await call(tools.agent_wait, { event: { session: first.id }, timeout: 5 }, invocation);
  assert.equal(settled.result, "来源：README 第 3 行"); assert.match(settled.note, /自己的工具核对/u);
  await call(tools.agent_spawn, { task: "第三个，现在有空位" }, invocation);
  for (const release of releases) release();
  await registry.shutdown();
});

test("A12 stopping the parent run stops its running children; finished results stay readable", async () => {
  let calls = 0;
  const { tools, invocation, registry, controller } = scopedHarness({ chat: async (_messages, _tools, signal) => {
    calls += 1;
    if (calls === 1) return { role: "assistant", content: "已完成的审查" };
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 30000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
    return { role: "assistant", content: "不应出现" };
  } }, "a12-cancel");
  const done = await call(tools.agent_spawn, { task: "快的", name: "fast" }, invocation);
  await call(tools.agent_wait, { event: { session: done.id }, timeout: 5 }, invocation);
  const slow = await call(tools.agent_spawn, { task: "慢的", name: "slow" }, invocation);
  controller.abort(new Error("parent cancelled"));
  const deadline = Date.now() + 5000;
  while (registry.get(slow.id).status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(registry.get(slow.id).status, "aborted");
  assert.equal(registry.get(done.id).result, "已完成的审查");
  await assert.rejects(tools.agent_spawn({ task: "取消后不能再派生" }, {}, invocation), /cancel|取消|abort/iu);
  await registry.shutdown();
});
