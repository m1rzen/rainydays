import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-agent-"));
const project = path.resolve(import.meta.dirname, "../..");
Object.assign(process.env, { RAINYDAYS_APP_ROOT: project, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(project, "personas") });
const config = await import("../../src/config.ts"); await config.initializeConfig();
const [{ Agent }, { ConversationMemory }, { createEffectivePersona, getPersona }, { createSession }, { capabilityBroker }, { pathPolicy }, interaction, { McpConnection }, runtime, { issueResourceOwner, retireResourceOwner }, { mcpToolName }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"), import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/ask-user-tool.ts"), import("../../src/mcp/client.ts"), import("../../src/mcp/runtime.ts"), import("../../src/resource-owner.ts"), import("../../src/mcp/settings.ts"),
]);
const mode = value => config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: value });
await mode(true);
await config.updateSettingsDomain("mcp", { servers: [{ name: "agent-fixture", enabled: true, transport: "stdio", command: process.execPath, args: [path.join(project, "tests/fixtures/mcp-server.mjs")], url: "", cwd: fixture }] });
const server = config.getConfigSnapshot().domains.mcp.servers[0];
const testOwner = issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] });
const probe = new McpConnection(server);
try { await probe.open(fixture, testOwner, new AbortController().signal); server.tools = await probe.listTools(new AbortController().signal); server.protocolVersion = probe.protocolVersion; } finally { await retireResourceOwner(testOwner); }
await config.updateSettingsDomain("mcp", { servers: [server] });
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-agent-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test("A05 ordinary Agent discovers MCP lazily, uses typed errors and asks once per server per task", { timeout: 45000 }, async () => {
  const builtin = await getPersona("general"), names = runtime.mcpRuntimeToolNames();
  assert.equal(names.length, 4);
  const persona = createEffectivePersona({ ...builtin, tools: ["search_tools", ...names], env: { WORKSPACE_ROOT: fixture }, allowedRoots: [fixture], networkPolicy: { mode: "unrestricted" } });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["initial-cwd", "read-file", "read-directory"] }]) });
  runtime.registerMcpTools(capabilityBroker, authority, persona.tools);
  let calls = [], counter = 0;
  const schemas = [], outputs = [];
  const llm = { async chat() { return { role: "assistant", content: "MCP fixture" }; }, async *chatStream(messages, tools) {
    schemas.push(tools.map(tool => tool.function.name));
    if (messages.at(-1).role === "tool") outputs.push(JSON.parse(messages.at(-1).content));
    const next = calls.shift(), call = typeof next === "function" ? next() : next;
    yield { type: "result", message: call ? { role: "assistant", content: "", tool_calls: [{ id: `mcp-${++counter}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "完成" } };
  } };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority), session = createSession(persona, "MCP fixture"); agent.setSession(session.id);
  const questions = [];
  const run = (id, signal) => interaction.runWithInteractionChannel({ sessionId: session.id, runId: id }, { emit(event) { if (event.type === "ask_user") { questions.push(event); assert(interaction.submitAnswer(session.id, id, event.questionId, "本次任务允许此服务器")); } } }, async () => { const events = []; for await (const event of agent.run("使用MCP fixture", id, signal)) events.push(event); return events; });
  try {
    calls = [["search_tools", { keywords: "MCP agent-fixture" }], [mcpToolName(server.name, "echo"), { text: "任务完成" }], [mcpToolName(server.name, "fail"), {}], [mcpToolName(server.name, "echo"), { action: "large" }], () => { const page = JSON.parse(outputs.at(-1).content); return ["mcp_read_result", { resultId: page.resultId, offset: page.nextOffset }]; }];
    const first = await run("mcp-first");
    assert.equal(questions.length, 1); assert.match(questions[0].question, /agent-fixture/u);
    assert.deepEqual(schemas[0], ["search_tools"]);
    assert(schemas[1].includes(mcpToolName(server.name, "echo")));
    assert.deepEqual(first.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success", "success", "error", "success", "success"]);
    const page = first.filter(event => event.type === "tool_result" && event.toolName === "mcp_read_result")[0];
    const retainedId = JSON.parse(page.content).resultId;
    assert.equal(JSON.parse(page.content).offset, 12000); assert(JSON.parse(page.content).nextOffset > 12000);
    assert(first.filter(event => event.type === "tool_result").every(event => event.toolOutputTruncated === false));
    assert.equal(first.find(event => event.toolCode === "MCP_TOOL_ERROR")?.toolStatus, "error");
    calls = [["search_tools", { keywords: "MCP agent-fixture" }], ["mcp_read_result", { resultId: retainedId, offset: 0 }], [mcpToolName(server.name, "echo"), { text: "第二任务" }]];
    const second = await run("mcp-second"); assert.equal(questions.length, 2);
    assert.equal(runtime.mcpConnectedCount(server), 0, "task end closes the active connection");
    assert.equal(second.find(event => event.toolCode === "MCP_RESULT_UNAVAILABLE")?.toolStatus, "error");
    const pidFile = path.join(fixture, "agent-cancel.json"), controller = new AbortController();
    calls = [["search_tools", { keywords: "MCP agent-fixture" }], [mcpToolName(server.name, "hang"), { pidFile }]];
    const pending = run("mcp-cancel", controller.signal); const rejection = assert.rejects(pending, error => error.code === "RUN_CANCELLED");
    for (let n = 0; n < 200; n++) { if (await fs.stat(pidFile).catch(() => false)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8")); const cancelledAt = Date.now(); controller.abort(); await rejection;
    assert(Date.now() - cancelledAt < 5000); for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(runtime.mcpConnectedCount(server), 0);
    await mode(false); assert.deepEqual(runtime.mcpRuntimeToolNames(), []);
    calls = [["search_tools", { keywords: "MCP agent-fixture" }], [mcpToolName(server.name, "echo"), { text: "must not run" }]];
    const disabled = await run("mcp-disabled");
    assert.equal(disabled.find(event => event.toolName === mcpToolName(server.name, "echo") && event.type === "tool_result")?.toolCode, "TOOL_ARGUMENTS_INVALID");
    assert(!schemas.at(-1).some(name => name.startsWith("mcp_")), "an existing Session also hides MCP after switching to colleague mode");
  } finally { await capabilityBroker.retireAuthority(authority); await mode(false); }
});
