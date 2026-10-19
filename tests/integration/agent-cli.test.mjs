import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitFor } from "../helpers.mjs";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-agent-cli-"));
const workspace = path.join(fixture, "中文 项目"), appRoot = path.resolve(import.meta.dirname, "../..");
await fs.mkdir(workspace);
Object.assign(process.env, { RAINYDAYS_APP_ROOT: appRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(appRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(appRoot, "skills") });
const credentials = await import("../../dist/credential-store.js");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const [{ getPersona, createEffectivePersona }, { capabilityBroker }, { pathPolicy }, { createSession }, { Agent }, { ConversationMemory }, { closeDb }, { initializeConfig }, { registerNativeProcessConsentHandler }, { shutdownExecutionRuntime }] = await Promise.all([
  import("../../dist/persona.js"), import("../../dist/tools/index.js"), import("../../dist/path-runtime.js"), import("../../dist/session.js"), import("../../dist/agent.js"), import("../../dist/memory.js"), import("../../dist/db.js"), import("../../dist/config.js"), import("../../dist/native-process-consent.js"), import("../../dist/execution-runtime.js"),
]);
await initializeConfig();
const builtin = await getPersona("general");
assert(builtin);
const cliNames = ["execute_command", "shell_start", "shell_input", "shell_output", "shell_list", "shell_resize", "shell_kill"];
// This isolated fixture does not install index.ts's unrelated task/persona hooks.
const persona = createEffectivePersona({ ...builtin, tools: builtin.tools.filter(name => name === "search_tools" || cliNames.includes(name)), env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory"] }]) });
test.after(async () => {
  await capabilityBroker.retireAuthority(authority); await shutdownExecutionRuntime(); closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-agent-cli-"));
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("A03 built-in default Agent discovers real CLI tools, exposes an owned read view and reports actual completion", { timeout: 45_000 }, async () => {
  const names = cliNames;
  assert(names.every(name => builtin.tools.includes(name)), "built-in default assistant must allow CLI discovery");
  let round = 0, terminalId, reader;
  const consents = [], events = [];
  const unregister = registerNativeProcessConsentHandler(challenge => { consents.push(challenge); return "approve"; });
  const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const llm = { async chat() { return { role: "assistant", content: "CLI 测试" }; }, async *chatStream(messages, tools) {
    const schemaNames = tools.map(tool => tool.function.name);
    let command;
    switch (round++) {
      case 0:
        assert(names.every(name => !schemaNames.includes(name)), "CLI schemas should load on demand");
        command = call("discover", "search_tools", { keywords: names.join(" ") }); break;
      case 1:
        assert(names.every(name => schemaNames.includes(name)), "default assistant must discover all CLI operations");
        command = call("short", "execute_command", { command: "echo 默认助手命令已运行", cwd: workspace }); break;
      case 2:
        assert.match(messages.at(-1).content, /默认助手命令已运行/u);
        command = call("start", "shell_start", { name: "助手检查", shell: "cmd", cwd: workspace }); break;
      case 3:
        terminalId = /ID: (term_[a-f0-9-]+)/u.exec(messages.at(-1).content)?.[1]; assert(terminalId);
        reader = agent.getTerminalReader(); assert(reader?.isCurrent()); assert.equal(reader.get(terminalId)?.cwd, workspace);
        assert.equal(Object.hasOwn(reader, "input"), false);
        command = call("write", "shell_input", { terminalId, input: "echo CLI_VIEW_READY>view-ready.txt" }); break;
      case 4:
        await waitFor(async () => { try { return (await fs.readFile(path.join(workspace, "view-ready.txt"), "utf8")).trim() === "CLI_VIEW_READY"; } catch { return false; } }, { timeoutMs: 5000 });
        assert(reader.list().some(item => item.id === terminalId));
        assert.match(reader.output(terminalId, 0, 20000).data, /CLI_VIEW_READY/u);
        assert.throws(() => reader.output("term_unknown"), /终端不存在/u);
        command = call("exit", "shell_input", { terminalId, input: "exit 7" }); break;
      case 5:
        await waitFor(async () => reader.get(terminalId)?.status !== "running", { timeoutMs: 5000 });
        command = call("read", "shell_output", { terminalId, offset: 0, limit: 5000 }); break;
      default:
        assert.match(messages.at(-1).content, /退出码: 7/u); assert.match(messages.at(-1).content, /结束原因: child-failed/u);
        yield { type: "result", message: { role: "assistant", content: "命令执行完成；测试终端按预期退出7。" } }; return;
    }
    yield { type: "result", message: { role: "assistant", content: "", tool_calls: [command] } };
  } };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  agent.setSession(createSession(persona, "默认助手 CLI").id);
  try {
    for await (const event of agent.run("运行命令并检查终端结果", "a03-default-cli")) events.push(event);
    assert.equal(events.some(event => event.type === "error"), false, JSON.stringify(events.filter(event => event.type === "error")));
    assert.deepEqual(events.filter(event => event.type === "tool_result" && event.toolStatus === "success").map(event => event.toolName), ["search_tools", "execute_command", "shell_start", "shell_input", "shell_input", "shell_output"]);
    assert.deepEqual(consents.map(value => value.toolName), ["execute_command", "shell_start", "shell_input", "shell_input"]);
    assert.equal(agent.getTerminalReader(), null); assert.equal(reader.isCurrent(), false);
    assert.throws(() => reader.output(terminalId), /终端.*结束|终端.*失效/u);
  } finally { unregister(); }
});
