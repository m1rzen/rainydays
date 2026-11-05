import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMcpHttpFixture } from "../fixtures/mcp-http-server.mjs";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-http-agent-")), project = path.resolve(import.meta.dirname, "../..");
Object.assign(process.env, { RAINYDAYS_APP_ROOT: project, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(project, "personas") });
const credentials = await import("../../src/credential-store.ts"); credentials.configureCredentialProtector({ protect: value => Buffer.from(`fake-vault:${value}`), unprotect: value => Buffer.from(value).toString().slice("fake-vault:".length) });
const config = await import("../../src/config.ts"); await config.initializeConfig();
const [{ Agent }, { ConversationMemory }, { createEffectivePersona, getPersona }, { createSession }, { capabilityBroker }, { pathPolicy }, interaction, { McpConnection }, runtime, { issueResourceOwner, retireResourceOwner }, { mcpToolName }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"), import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/ask-user-tool.ts"), import("../../src/mcp/client.ts"), import("../../src/mcp/runtime.ts"), import("../../src/resource-owner.ts"), import("../../src/mcp/settings.ts"),
]);
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-http-agent-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
test("A06 ordinary Agent uses token HTTP and on-demand resources through one server approval", { timeout: 20000 }, async () => {
  const token = "obviously-fake-agent-http-token", http = await startMcpHttpFixture({ token, sse: true }); let authority;
  try {
    await config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: true });
    await config.updateSettingsDomain("mcp", { servers: [{ name: "agent-http", enabled: true, transport: "http", command: "", args: [], url: http.url, auth: { mode: "token" } }], authValues: { "agent-http": token } });
    const [server] = config.getConfigSnapshot().domains.mcp.servers, owned = issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] });
    const probe = new McpConnection(server);
    try { await probe.open("", owned, new AbortController().signal, { fetch: globalThis.fetch }); server.tools = await probe.listTools(new AbortController().signal); server.protocolVersion = probe.protocolVersion; server.resources = probe.hasResources; } finally { await retireResourceOwner(owned); }
    await config.updateSettingsDomain("mcp", { servers: [server] });
    const builtin = await getPersona("general"), names = runtime.mcpRuntimeToolNames(); assert.equal(names.length, 3);
    const persona = createEffectivePersona({ ...builtin, tools: ["search_tools", ...names], env: { WORKSPACE_ROOT: fixture }, allowedRoots: [fixture], networkPolicy: { mode: "loopback" } });
    authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file", "read-directory"] }]) });
    runtime.registerMcpTools(capabilityBroker, authority, persona.tools);
    const calls = [["search_tools", { keywords: "MCP agent-http" }], [mcpToolName(server.name, "remote"), {}], [mcpToolName(server.name, "read_resource", "resource"), { uri: "fixture://notes/one" }], [mcpToolName(server.name, "remote"), { action: "fail" }]]; let counter = 0;
    const outputs = [], llm = { async chat() { return { role: "assistant", content: "HTTP fixture" }; }, async *chatStream(messages) { if (messages.at(-1).role === "tool") outputs.push(messages.at(-1).content); const next = calls.shift(); yield { type: "result", message: next ? { role: "assistant", content: "", tool_calls: [{ id: `http-${++counter}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { role: "assistant", content: "远端资源已核对" } }; } };
    const agent = new Agent(llm, new ConversationMemory(), persona, authority), session = createSession(persona, "HTTP fixture"); agent.setSession(session.id);
    const questions = [], events = await interaction.runWithInteractionChannel({ sessionId: session.id, runId: "http-agent" }, { emit(event) { if (event.type === "ask_user") { questions.push(event); assert(interaction.submitAnswer(session.id, "http-agent", event.questionId, "本次任务允许此服务器")); } } }, async () => { const result = []; for await (const event of agent.run("使用远端MCP资源", "http-agent")) result.push(event); return result; });
    assert.equal(questions.length, 1); assert(questions[0].question.includes(http.url)); assert(!questions[0].question.includes("Windows 身份"));
    assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success", "success", "success", "error"]);
    assert(outputs.some(text => text.includes("按需资源 中文"))); assert.equal(http.state.reads, 1); assert.equal(http.state.rejected, 0);
  } finally { if (authority) await capabilityBroker.retireAuthority(authority); await http.close(); }
});
