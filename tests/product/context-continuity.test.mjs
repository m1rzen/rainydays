import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-continuity-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data") });
const [{ insertSession, closeDb }, { ConversationMemory, KEEP_RECENT_TOOL_RESULTS }, { readExec }, { NEVER_ABORT_SIGNAL }, { requiresHumanDespiteAuto }] = await Promise.all([
  import("../../src/db.ts"), import("../../src/memory.ts"), import("../../src/tools/filesystem-lux.ts"), import("../../src/run-cancellation.ts"), import("../../src/auto-approval-policy.ts"),
]);
test.after(async () => { await closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-continuity-")); await rm(fixture, { recursive: true, force: true }); });

const now = new Date().toISOString();
const budget = window => messages => ({ contextWindowTokens: window, outputReserveTokens: 0, estimatedInputTokens: Math.ceil(JSON.stringify(messages).length / 2) });
const noModel = { chat: async () => { throw new Error("pruning must not call the model"); } };
const invocation = sessionId => ({ capabilityContext: { sessionId }, signal: NEVER_ABORT_SIGNAL, path: { rootIdForEnv: () => null } });

function toolHistory(sessionId, count, size = 4000) {
  insertSession({ id: sessionId, persona_name: "fixture", title: "长任务", created_at: now, updated_at: now });
  const memory = new ConversationMemory();
  memory.setSessionId(sessionId);
  memory.add({ role: "user", content: "持续开发这个功能" });
  for (let index = 0; index < count; index++) {
    const id = `call-${index}`;
    memory.addMany([
      { role: "assistant", content: `第${index}步`, tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: `结果${index}开头` + "x".repeat(size) + `结果${index}结尾` },
    ]);
  }
  return memory;
}

test("older large tool results are folded without a model call and stay retrievable", async () => {
  const memory = toolHistory("prune-a", 24);
  const before = memory.getAll();
  const window = Math.ceil(JSON.stringify(before).length / 2 / 0.6);
  assert.equal(await memory.compact(noModel, undefined, undefined, { assess: budget(window) }), true);
  const tools = memory.getAll().filter(item => item.role === "tool");
  assert.equal(tools.length, 24);
  const folded = tools.slice(0, -KEEP_RECENT_TOOL_RESULTS), whole = tools.slice(-KEEP_RECENT_TOOL_RESULTS);
  for (const item of folded) { assert(item.content.length < 1200); assert.match(item.content, /history:\d+/u); assert.match(item.content, /开头/u); assert.match(item.content, /结尾/u); }
  for (const item of whole) assert(item.content.length > 4000);
  assert.deepEqual(tools.map(item => item.tool_call_id), before.filter(item => item.role === "tool").map(item => item.tool_call_id));
  const original = await readExec({ file_path: `history:${tools[0].historyId}` }, {}, invocation("prune-a"));
  assert.match(original, /结果0结尾/u);
  assert.equal(memory.getSummaryGeneration(), 0);
});

test("folding does nothing below the prepare watermark and is idempotent", async () => {
  const memory = toolHistory("prune-b", 24);
  const size = Math.ceil(JSON.stringify(memory.getAll()).length / 2);
  assert.equal(await memory.compact(noModel, undefined, undefined, { assess: budget(size * 4) }), false);
  assert(memory.getAll().filter(item => item.role === "tool").every(item => item.content.length > 4000));
  const window = Math.ceil(size / 0.6);
  await memory.compact(noModel, undefined, undefined, { assess: budget(window) });
  const once = memory.getAll();
  assert.equal(await memory.compact(noModel, undefined, undefined, { assess: budget(window) }), false);
  assert.deepEqual(memory.getAll(), once);
});

test("results that cannot be retrieved from history are never folded", async () => {
  const memory = new ConversationMemory();
  memory.add({ role: "user", content: "无会话" });
  for (let index = 0; index < 20; index++) memory.addMany([{ role: "assistant", content: "", tool_calls: [{ id: `c${index}`, type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: `c${index}`, content: "y".repeat(4000) }]);
  const size = Math.ceil(JSON.stringify(memory.getAll()).length / 2);
  await memory.compact(noModel, undefined, undefined, { assess: budget(Math.ceil(size / 0.6)) });
  assert(memory.getAll().filter(item => item.role === "tool").every(item => item.content.length === 4000));
});

test("a model summary advances the generation used for handoff advice", async () => {
  const memory = toolHistory("generation", 24, 200);
  memory.addMany(Array.from({ length: 12 }, () => ({ role: "assistant", content: "旧资料".repeat(1000) })));
  const size = Math.ceil(JSON.stringify(memory.getAll()).length / 2);
  assert.equal(await memory.compact({ chat: async () => ({ role: "assistant", content: "短摘要" }) }, undefined, undefined, { assess: budget(Math.ceil(size / 0.95)) }), true);
  assert.equal(memory.getSummaryGeneration(), 1);
});

test("Auto still stops for deletion, publishing and outbound actions", () => {
  const stopped = [
    ["execute_command", { command: "rm -rf build" }], ["execute_command", { command: "del /s /q out" }], ["bash", { command: "Remove-Item -Recurse C:\\data" }],
    ["execute_command", { command: "cd repo && git push origin main" }], ["execute_command", { command: "git reset --hard HEAD~1" }], ["execute_command", { command: "git clean -fd" }],
    ["execute_command", { command: "npm publish" }], ["execute_command", { command: "curl -X POST https://example.invalid/a" }], ["execute_command", { command: "curl --data x=1 https://example.invalid" }],
    ["execute_command", { command: "Invoke-RestMethod -Method Post -Uri https://example.invalid" }], ["execute_command", { command: "format D:" }],
    ["shell_input", { input: "git push\n" }], ["script", { code: "shutil.rmtree('x'); os.system('git push')" }], ["computer_use", { action: "click" }], ["browser_fill", {}], ["browser_eval", {}], ["routine_delete", {}],
  ];
  for (const [tool, args] of stopped) assert.equal(typeof requiresHumanDespiteAuto(tool, args), "string", `${tool} ${JSON.stringify(args)}`);
  assert.equal(typeof requiresHumanDespiteAuto("some_tool", {}, { remoteMcp: true }), "string");
});

test("Auto keeps routine development work flowing", () => {
  const allowed = [
    ["execute_command", { command: "git status && git diff --stat" }], ["execute_command", { command: "npm run check:product" }], ["execute_command", { command: "Get-ChildItem | Format-Table" }],
    ["execute_command", { command: "curl -s https://example.invalid/health" }], ["bash", { command: "ls -la" }], ["write", { file_path: "a.txt" }], ["edit", { file_path: "a.txt" }], ["browser_open", { url: "https://example.invalid" }],
  ];
  for (const [tool, args] of allowed) assert.equal(requiresHumanDespiteAuto(tool, args), null, `${tool} ${JSON.stringify(args)}`);
});
