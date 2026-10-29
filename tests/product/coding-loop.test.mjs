import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-coding-loop-"));
const appRoot = path.resolve(import.meta.dirname, "../..");
const git = execFileSync(path.join(process.env.SystemRoot, "System32/where.exe"), ["git.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u).find(Boolean);
Object.assign(process.env, { RAINYDAYS_APP_ROOT: appRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(appRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(appRoot, "skills"), RAINYDAYS_GIT_EXECUTABLE: await fs.realpath(git) });
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const [{ Agent }, { ConversationMemory }, { getPersona, createEffectivePersona, PERSONA_MANAGEMENT_TOOLS }, { createSession }, { capabilityBroker }, { pathPolicy }, config, interaction, { closeDb }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"), import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/config.ts"), import("../../src/tools/ask-user-tool.ts"), import("../../src/db.ts"),
]);
await config.initializeConfig(); await config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: true });
const builtin = await getPersona("general"); assert(builtin);
const authorities = [];
test.after(async () => {
  for (const authority of authorities) await capabilityBroker.retireAuthority(authority);
  closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-coding-loop-"));
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const call = (name, args) => ({ name, args });
const revision = text => { const value = /版本: ([a-f0-9]{64})/u.exec(text)?.[1]; assert(value, text); return value; };
async function run(workspace, next) {
  // Preserve the default declared tools; this isolated fixture does not install
  // index.ts's runtime persona-management hooks.
  const persona = createEffectivePersona({ ...builtin, tools: builtin.tools.filter(name => !PERSONA_MANAGEMENT_TOOLS.includes(name)), env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory", "search-tree", "create-file", "replace-file"] }]) }); authorities.push(authority);
  let requests = 0;
  const llm = { async chat() { return { role: "assistant", content: "代码检查" }; }, async *chatStream(messages) {
    requests++;
    const last = messages.at(-1), outcome = last.role === "tool" ? JSON.parse(last.content) : null;
    const action = await next(outcome, requests);
    yield { type: "result", message: action ? { role: "assistant", content: "", tool_calls: (Array.isArray(action) ? action : [action]).map(item => ({ id: crypto.randomUUID(), type: "function", function: { name: item.name, arguments: JSON.stringify(item.args) } })) } : { role: "assistant", content: "已检查实际退出结果；差异见代码修改记录。缺依赖检查仍失败，未安装软件。" } };
  } };
  const memory = new ConversationMemory(), agent = new Agent(llm, memory, persona, authority), session = createSession(persona, "代码修正"); agent.setSession(session.id);
  const questions = [], events = await interaction.runWithInteractionChannel({ sessionId: session.id, runId: session.id }, { emit(event) {
    if (event.type !== "ask_user") return;
    questions.push(event);
    const answer = event.options.includes("本次任务允许运行命令") ? "本次任务允许运行命令" : "确认执行";
    assert(interaction.submitAnswer(session.id, session.id, event.questionId, answer));
  } }, async () => { const out = []; for await (const event of agent.run("修复项目并运行测试，保留已有修改；最多三次修正，失败如实交付", session.id)) out.push(event); return out; });
  return { events, memory, requests, questions };
}

for (const language of ["javascript", "python"]) test(`A04 default Agent reads, edits and checks a dirty ${language} project using real tools`, { timeout: 60_000 }, async () => {
  const workspace = path.join(fixture, language), js = language === "javascript";
  await fs.mkdir(workspace);
  const core = js ? "sum.mjs" : "calc.py", wrapper = js ? "report.mjs" : "report.py";
  const source = js ? "export const sum = (a, b) => a - b;\n" : "def double(x):\n    return None\n";
  const marker = js ? "// 用户未提交注释\n" : "# 用户未提交注释\n";
  const report = js ? "import {sum} from './sum.mjs'; export const report = () => 'OLD=' + sum(2,3);\n" : "from calc import double\ndef report():\n    return 'OLD=' + str(double(4))\n";
  const check = js ? "node --test" : "python -m unittest -q";
  await fs.writeFile(path.join(workspace, core), source);
  await fs.writeFile(path.join(workspace, wrapper), report);
  await fs.writeFile(path.join(workspace, js ? "sum.test.mjs" : "test_calc.py"), js ? "import test from 'node:test'; import assert from 'node:assert/strict'; import {report} from './report.mjs'; test('result',()=>assert.equal(report(),'RESULT=5'));\n" : "import unittest\nfrom report import report\nclass T(unittest.TestCase):\n    def test_result(self):\n        self.assertEqual(report(), 'RESULT=8')\n");
  const gitRun = args => execFileSync(git, args, { cwd: workspace, windowsHide: true, encoding: "utf8" });
  gitRun(["init", "-q"]); gitRun(["add", "--", "."]);
  await fs.appendFile(path.join(workspace, core), marker);
  await fs.writeFile(path.join(workspace, "用户笔记.txt"), "USER_UNTRACKED_KEEP");
  const headBefore = await fs.readFile(path.join(workspace, ".git/HEAD"), "utf8");
  const versions = new Map(), replacements = js ? ["a * b", "a + b + 1", "a + b"] : ["x + x"];
  let step = 0, currentExpression = js ? "a - b" : "None", pending;
  const receipts = [], checks = [];
  const actions = [
    () => call("read_repo", { path: workspace, level: "summary" }),
    outcome => { assert.match(outcome.content, /untracked/u); assert.match(outcome.content, /sum|calc/u); return call("execute_command", { command: check, cwd: workspace }); },
  ];
  for (let attempt = 0; attempt < replacements.length; attempt++) {
    actions.push(outcome => { assert.equal(outcome.status, "error"); assert.match(outcome.content, /退出码 1/u); checks.push(outcome); return call("read", { file_path: path.join(workspace, core) }); });
    actions.push(outcome => { versions.set(core, revision(outcome.content)); return call("read", { file_path: path.join(workspace, wrapper) }); });
    actions.push(outcome => {
      versions.set(wrapper, revision(outcome.content));
      const files = [{ file_path: path.join(workspace, core), expected_revision: versions.get(core), edits: [{ old_string: currentExpression, new_string: replacements[attempt] }] }];
      currentExpression = replacements[attempt];
      if (attempt === 0) files.push({ file_path: path.join(workspace, wrapper), expected_revision: versions.get(wrapper), edits: [{ old_string: "OLD=", new_string: "RESULT=" }] });
      return call("edit_files", { files });
    });
    actions.push(outcome => { assert.equal(outcome.status, "success", outcome.content); receipts.push(JSON.parse(outcome.content)); return call("execute_command", { command: check, cwd: workspace }); });
  }
  actions.push(outcome => { assert.equal(outcome.status, "success", outcome.content); assert.match(outcome.content, /退出码 0/u); checks.push(outcome); return call("execute_command", { command: "rainydays_a04_missing_tool_4c981 --version", cwd: workspace }); });
  actions.push(outcome => { assert.equal(outcome.status, "error"); assert.match(outcome.content, /命令未找到/u); pending = outcome; });
  const result = await run(workspace, outcome => actions[step++]?.(outcome));
  assert.equal(result.events.some(event => event.type === "error"), false, JSON.stringify(result.events.filter(event => event.type === "error")));
  assert(pending); assert.equal(checks.length, replacements.length + 1); assert.equal(receipts.length, replacements.length);
  assert(receipts.every(receipt => receipt.changes.every(change => change.status === "written" && change.diff.includes("+"))));
  assert.match(await fs.readFile(path.join(workspace, core), "utf8"), /用户未提交注释/u);
  assert.equal(await fs.readFile(path.join(workspace, "用户笔记.txt"), "utf8"), "USER_UNTRACKED_KEEP");
  assert.equal(await fs.readFile(path.join(workspace, ".git/HEAD"), "utf8"), headBefore);
  assert.match(gitRun(["status", "--porcelain=v1"]), /用户|\\/u);
  assert.equal(result.questions.filter(event => event.options.includes("本次任务允许运行命令")).length, 1);
});

test("A04 repeated failing check without a code change stops after three executions", { timeout: 30_000 }, async () => {
  await config.updateSettingsDomain("common", { ...config.getConfigSnapshot().domains.common, maxIterations: 6 });
  const workspace = path.join(fixture, "no-progress"); await fs.mkdir(workspace);
  const result = await run(workspace, () => call("execute_command", { command: "node -e \"require('fs').appendFileSync('attempts.txt','attempt\\n'); process.exit(1)\"", cwd: workspace }));
  assert.equal(result.requests, 4);
  assert.equal((await fs.readFile(path.join(workspace, "attempts.txt"), "utf8")).trim().split("\n").length, 3);
  assert(result.events.some(event => event.type === "error" && /重复|无进展/u.test(event.content)));
});

test("A04 three real repair rounds that still fail stop before a fourth edit", { timeout: 40_000 }, async () => {
  await config.updateSettingsDomain("common", { ...config.getConfigSnapshot().domains.common, maxIterations: 30 });
  const workspace = path.join(fixture, "repair-budget"); await fs.mkdir(workspace);
  const target = path.join(workspace, "value.txt"); await fs.writeFile(target, "value=0\n");
  const check = call("execute_command", { command: "node -e \"console.log(require('fs').readFileSync('value.txt','utf8')); process.exit(1)\"", cwd: workspace });
  const actions = [() => check];
  for (let attempt = 1; attempt <= 3; attempt++) {
    actions.push(outcome => { assert.equal(outcome.status, "error"); return call("read", { file_path: target }); });
    actions.push(outcome => call("edit_files", { files: [{ file_path: target, expected_revision: revision(outcome.content), edits: [{ old_string: `value=${attempt - 1}`, new_string: `value=${attempt}` }] }] }));
    actions.push(outcome => { assert.equal(outcome.status, "success"); return attempt === 3 ? [check, call("execute_command", { command: "echo MUST_NOT_RUN>after-budget.txt", cwd: workspace })] : check; });
  }
  let cursor = 0;
  const result = await run(workspace, outcome => { assert(cursor < actions.length, "must not request a fourth automatic repair"); return actions[cursor++](outcome); });
  assert.equal(result.requests, 10);
  assert.equal(result.events.filter(event => event.type === "tool_result" && event.toolName === "edit_files").length, 3);
  assert.equal(result.events.filter(event => event.type === "tool_result" && event.toolName === "execute_command" && event.toolStatus === "error").length, 4);
  assert.equal(result.events.filter(event => event.type === "tool_result" && event.toolStatus === "denied").length, 1);
  assert(result.events.some(event => event.type === "error" && /3次自动修正.*仍未通过/u.test(event.content)));
  assert.equal(await fs.readFile(target, "utf8"), "value=3\n");
  await assert.rejects(fs.access(path.join(workspace, "after-budget.txt")));
});

test("A04 unchanged edit receipts do not reset failing command repetition", { timeout: 30_000 }, async () => {
  const workspace = path.join(fixture, "unchanged-repair"); await fs.mkdir(workspace);
  const target = path.join(workspace, "value.txt"); await fs.writeFile(target, "same\n");
  const check = call("execute_command", { command: "node -e \"require('fs').appendFileSync('attempts.txt','attempt\\n'); process.exit(1)\"", cwd: workspace });
  let step = 0;
  const result = await run(workspace, outcome => {
    const phase = step++ % 3;
    if (phase === 0) return check;
    if (phase === 1) return call("read", { file_path: target });
    return call("edit_files", { files: [{ file_path: target, expected_revision: revision(outcome.content), edits: [{ old_string: "same", new_string: "same" }] }] });
  });
  assert.equal(result.requests, 10);
  assert.equal((await fs.readFile(path.join(workspace, "attempts.txt"), "utf8")).trim().split("\n").length, 3);
  assert(result.events.some(event => event.type === "error" && /重复|无进展/u.test(event.content)));
});

test("A04 a serial edit and check batch can pass the fourth check after three actual changes", { timeout: 30_000 }, async () => {
  const workspace = path.join(fixture, "batched-repair"); await fs.mkdir(workspace);
  const target = path.join(workspace, "value.txt"); await fs.writeFile(target, "value=0\n");
  const check = call("execute_command", { command: "node -e \"process.exit(require('fs').readFileSync('value.txt','utf8').includes('value=3') ? 0 : 1)\"", cwd: workspace });
  let step = 0, version, count = 0;
  const result = await run(workspace, outcome => {
    if (step++ === 0) return check;
    if (step % 2 === 0) {
      if (count === 3) { assert.equal(outcome.status, "success", outcome.content); return; }
      assert.equal(outcome.status, "error"); return call("read", { file_path: target });
    }
    version = revision(outcome.content); count++;
    return [call("edit_files", { files: [{ file_path: target, expected_revision: version, edits: [{ old_string: `value=${count - 1}`, new_string: `value=${count}` }] }] }), check];
  });
  assert.equal(result.events.some(event => event.type === "error"), false, JSON.stringify(result.events));
  assert.equal(result.events.filter(event => event.type === "tool_result" && event.toolName === "execute_command").length, 4);
  assert.equal(await fs.readFile(target, "utf8"), "value=3\n");
});
