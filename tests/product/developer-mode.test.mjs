import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-devmode-"));
const workspace = path.join(fixture, "中文 项目");
await mkdir(path.join(fixture, "data")); await mkdir(workspace);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const config = await import("../../src/config.ts");
await config.initializeConfig();
const developer = await import("../../src/developer-execution.ts");
const { parseSettingsDomains, defaultSettingsDomains } = await import("../../src/settings-schema.ts");
const { closeDb } = await import("../../src/db.ts");
const setDeveloperMode = enabled => config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: enabled });
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-devmode-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("A15 developer mode defaults off, accepts legacy settings and cannot be enabled by an imported bundle", async () => {
  const legacy = defaultSettingsDomains(); delete legacy.shell.developerMode;
  assert.equal(parseSettingsDomains(legacy).shell.developerMode, false);
  assert.equal(config.getConfigSnapshot().domains.shell.developerMode, false);
  assert.equal(developer.isDeveloperModeEnabled(), false);
  assert.equal(developer.isDeveloperCommandTool("execute_command"), false);
  const bundle = config.exportSettings(); bundle.domains.shell.developerMode = true;
  assert.equal(config.prepareSettingsImport(bundle).domains.shell.developerMode, false);
  await setDeveloperMode(true);
  assert.equal(developer.isDeveloperCommandTool("execute_command"), true);
  assert.equal(developer.isDeveloperCommandTool("script"), false, "scripts stay in the isolated runtime");
  await setDeveloperMode(false);
  assert.equal(developer.isDeveloperModeEnabled(), false);
  const env = developer.developerEnvironment({ PATH: "C:\\tools", RAINYDAYS_SECRET: "x", ELECTRON_RUN_AS_NODE: "1", GIT_AUTHOR_NAME: "me" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_AUTHOR_NAME", "PATH", "PYTHONIOENCODING"]);
});

test("A15 user toolchain runs in the chosen directory with Unicode output and the real exit code", async () => {
  const result = await developer.runDeveloperCommand({
    command: "node -e \"console.log('中文输出', process.cwd()); console.error('warn'); process.exit(7)\"",
    cwd: workspace, timeoutSeconds: 30, signal: new AbortController().signal,
  });
  assert.equal(result.reason, "completed"); assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /中文输出/u); assert(result.stdout.includes(workspace)); assert.match(result.stderr, /warn/u);
  const formatted = developer.formatDeveloperResult(result, 30);
  assert.equal(formatted.failed, true); assert.match(formatted.text, /退出码 7/u);
  const big = await developer.runDeveloperCommand({ command: "node -e \"for (let i = 0; i < 20000; i++) console.log('line ' + i)\"", cwd: workspace, timeoutSeconds: 30, signal: new AbortController().signal });
  assert.equal(big.exitCode, 0); assert(big.omittedStdoutChars > 0); assert.match(big.stdout, /line 19999\s*$/u, "the tail of long output is kept");
});

test("A15 project test runners that failed in isolation go red to green with the user toolchain", { timeout: 120_000 }, async () => {
  const { writeFile } = await import("node:fs/promises");
  const run = command => developer.runDeveloperCommand({ command, cwd: workspace, timeoutSeconds: 90, signal: new AbortController().signal });
  await writeFile(path.join(workspace, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  await writeFile(path.join(workspace, "sum.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  const nodeRed = await run("node --test");
  assert.equal(nodeRed.exitCode, 1, nodeRed.stdout + nodeRed.stderr); assert.match(nodeRed.stdout, /fail 1/u);
  await writeFile(path.join(workspace, "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  const nodeGreen = await run("node --test");
  assert.equal(nodeGreen.exitCode, 0, nodeGreen.stdout + nodeGreen.stderr); assert.match(nodeGreen.stdout, /pass 1/u);

  await writeFile(path.join(workspace, "calc.py"), "def double(x):\n    return x + x + 1\n");
  await writeFile(path.join(workspace, "test_calc.py"), "import unittest\nfrom calc import double\nclass T(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(4), 8)\n");
  const pyRed = await run("python -m unittest -q");
  assert.equal(pyRed.exitCode, 1, pyRed.stdout + pyRed.stderr); assert.match(pyRed.stderr, /FAILED/u);
  await writeFile(path.join(workspace, "calc.py"), "def double(x):\n    return x + x\n");
  const pyGreen = await run("python -m unittest -q");
  assert.equal(pyGreen.exitCode, 0, pyGreen.stdout + pyGreen.stderr); assert.match(pyGreen.stderr, /OK/u);

  assert.equal((await run("git init -q && git status --short")).exitCode, 0);
  const npm = await run("npm --version");
  assert.equal(npm.exitCode, 0); assert.match(npm.stdout, /^\d+\.\d+/mu);
});

test("A15 timeout and run cancellation terminate the command process tree", async () => {
  const started = Date.now();
  const timedOut = await developer.runDeveloperCommand({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: workspace, timeoutSeconds: 1, signal: new AbortController().signal });
  assert.equal(timedOut.reason, "timeout"); assert.equal(timedOut.exitCode, null);
  assert(Date.now() - started < 8000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const cancelStart = Date.now();
  await assert.rejects(developer.runDeveloperCommand({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: workspace, timeoutSeconds: 60, signal: controller.signal }));
  assert(Date.now() - cancelStart < 5300, "cancelled command must stop within the 5 second target");
});

test("A15 default Agent asks in-app once per task, runs commands as the user and re-asks in the next task", { timeout: 60_000 }, async () => {
  const [{ Agent }, { ConversationMemory }, { createEffectivePersona, getPersona }, { createSession }, { capabilityBroker }, { pathPolicy }, interaction, { registerNativeProcessConsentHandler }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/ask-user-tool.ts"), import("../../src/native-process-consent.ts"),
  ]);
  await setDeveloperMode(true);
  const builtin = await getPersona("general"); assert(builtin);
  const persona = createEffectivePersona({ ...builtin, tools: ["execute_command"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory"] }]) });
  const nativeConsents = [];
  const unregister = registerNativeProcessConsentHandler(challenge => { nativeConsents.push(challenge); return "deny"; });
  let calls = [], counter = 0, systemPrompt = "";
  const outputs = [];
  const llm = {
    async chat() { return { role: "assistant", content: "开发模式" }; },
    async *chatStream(messages) {
      systemPrompt = messages[0].content;
      const last = messages.at(-1); if (last.role === "tool") outputs.push(last.content);
      const next = calls.shift();
      yield { type: "result", message: next ? { role: "assistant", content: "", tool_calls: [{ id: `dev-${++counter}`, type: "function", function: { name: "execute_command", arguments: JSON.stringify(next) } }] } : { role: "assistant", content: "完成" } };
    },
  };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  const session = createSession(persona, "开发模式");
  agent.setSession(session.id);
  const questions = [];
  const run = (runId, answer) => interaction.runWithInteractionChannel({ sessionId: session.id, runId }, { emit(event) {
    if (event.type !== "ask_user") return;
    questions.push(event);
    assert(interaction.submitAnswer(session.id, runId, event.questionId, answer));
  } }, async () => { const events = []; for await (const event of agent.run("运行项目命令", runId)) events.push(event); return events; });
  try {
    calls = [{ command: "node -e \"console.log('DEV_NODE', process.version)\"", cwd: workspace }, { command: "node -e \"process.exit(3)\"", cwd: workspace, timeout: 20 }];
    const first = await run("dev-first", "本次任务允许运行命令");
    assert.equal(questions.length, 1, "one in-app approval covers later commands in the same task");
    assert.deepEqual(questions[0].options, ["本次任务允许运行命令", "仅这一次", "拒绝执行"]);
    assert.match(questions[0].question, /以你的 Windows 身份运行命令/u);
    assert.deepEqual(first.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success", "error"]);
    assert.match(outputs[0], /DEV_NODE v\d+/u); assert.match(outputs[1], /退出码 3/u);
    assert.match(systemPrompt, /## 开发模式/u);
    calls = [{ command: "echo 第二任务", cwd: workspace }];
    const second = await run("dev-second", "拒绝执行");
    assert.equal(questions.length, 2, "approval does not carry into the next task");
    assert.deepEqual(second.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["denied"]);
    assert.equal(nativeConsents.length, 0, "developer mode uses the in-app approval instead of native isolation consent");
  } finally {
    unregister();
    await capabilityBroker.retireAuthority(authority);
    await setDeveloperMode(false);
  }
});
