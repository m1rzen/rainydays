import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-agent-loop-"));
const workspace = path.join(fixture, "workspace");
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
const { parseSettingsDomains, defaultSettingsDomains } = await import("../../src/settings-schema.ts");
const [{ Agent, resolveMaxIterations }, { ConversationMemory }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, { TaskToolSelection }, { closeDb }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
  import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/task-tools.ts"), import("../../src/db.ts"),
]);
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-agent-loop-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const call = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const setMaxIterations = value => config.updateSettingsDomain("common", { ...config.getConfigSnapshot().domains.common, maxIterations: value });
async function makeAgent(llm, tools = ["get_current_time"]) {
  const persona = createEffectivePersona({ name: "general", displayName: "Test", description: "", permissionLevel: "read_only", tools, env: { OUTPUT_DIR: workspace }, allowedRoots: [], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { OUTPUT_DIR: "output" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "output", role: "output", configuredPath: workspace, permissions: ["read-file", "read-directory"] }]) });
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  agent.setSession(createSession(persona, "A14").id);
  return agent;
}
const collect = async (agent, input, runId) => { const events = []; for await (const event of agent.run(input, runId)) events.push(event); return events; };

test("A14 iteration cap comes from common.maxIterations, defaults to 200 and reports unfinished work honestly", async () => {
  const legacy = defaultSettingsDomains(); assert.equal(legacy.common.maxIterations, 200);
  assert.equal(parseSettingsDomains(legacy).common.maxIterations, 200);
  assert.equal(resolveMaxIterations(), 200);
  await setMaxIterations(3);
  assert.equal(resolveMaxIterations(), 3);
  let requests = 0;
  const agent = await makeAgent({ async chat() { return { role: "assistant", content: "x" }; }, async *chatStream() {
    requests++;
    yield { type: "result", message: { role: "assistant", content: "", tool_calls: [call(`loop-${requests}`, "get_current_time")] } };
  } });
  const events = await collect(agent, "一直查时间", "cap-run");
  assert.equal(requests, 3);
  assert.equal(events.filter(event => event.type === "tool_result").length, 3);
  const last = events.at(-1);
  assert.equal(last.type, "error"); assert.match(last.content, /最大循环次数（3）/u); assert.match(last.content, /尚未完成/u);
  await setMaxIterations(200);
});

test("A14 steering enters the next model request without replaying executed tools and continues after an answer", async () => {
  let agent; let requests = 0; let toolResults = 0;
  const seen = [];
  agent = await makeAgent({ async chat() { return { role: "assistant", content: "x" }; }, async *chatStream(messages) {
    const step = requests++;
    seen.push(messages.filter(message => message.role === "user").map(message => message.content));
    toolResults = messages.filter(message => message.role === "tool").length;
    if (step === 0) {
      assert.equal(agent.steer("other-run", "错误的 run"), false);
      assert.equal(agent.steer("steer-run", "   "), false);
      assert.equal(agent.steer("steer-run", "请改用英文回答"), true);
      yield { type: "result", message: { role: "assistant", content: "", tool_calls: [call("time-1", "get_current_time")] } };
    } else if (step === 1) {
      assert.equal(messages.at(-1).role, "user"); assert.equal(messages.at(-1).content, "请改用英文回答");
      assert.equal(toolResults, 1);
      assert.equal(agent.steer("steer-run", "再补一句总结"), true);
      yield { type: "result", message: { role: "assistant", content: "Done." } };
    } else {
      assert.equal(messages.at(-1).content, "再补一句总结"); assert.equal(toolResults, 1, "executed tool must not be replayed");
      yield { type: "result", message: { role: "assistant", content: "Summary." } };
    }
  } });
  const events = await collect(agent, "查一下时间", "steer-run");
  assert.equal(requests, 3);
  assert.deepEqual(events.filter(event => event.type === "steer").map(event => event.content), ["请改用英文回答", "再补一句总结"]);
  assert.equal(events.filter(event => event.type === "tool_result").length, 1);
  assert.deepEqual(events.filter(event => event.type === "answer_done").map(event => event.content), ["Done.", "Summary."]);
  assert.equal(agent.steer("steer-run", "结束后"), false, "steering is bound to an active run");
  assert.deepEqual(agent.takePendingSteers(), []);
  const { getMessagesBySession: getMessages } = await import("../../src/db.ts");
  assert(getMessages(agent.getSessionId()).some(message => message.role === "user" && message.content === "请改用英文回答"), "steer is persisted as a user message");
});

test("A14 developer mode makes core coding and plan tools resident without widening the persona allowlist", () => {
  const names = ["read", "search_tools", "list_memories", "execute_command", "shell_start", "edit_files", "read_repo", "task_create", "task_update"];
  const descriptors = names.map(name => ({ name, schema: { type: "function", function: { name } } }));
  const colleague = new TaskToolSelection("general", descriptors);
  assert.deepEqual(colleague.protocols().map(d => d.name), ["read", "search_tools"]);
  const developer = new TaskToolSelection("general", descriptors, { developerMode: true });
  assert.deepEqual(developer.protocols().map(d => d.name), ["read", "search_tools", "execute_command", "shell_start", "edit_files", "read_repo", "task_create", "task_update"]);
  assert.equal(developer.has("list_memories"), false, "non-core tools still need discovery");
  const narrow = new TaskToolSelection("general", descriptors.filter(d => d.name !== "execute_command"), { developerMode: true });
  assert.equal(narrow.has("execute_command"), false, "resident set never adds tools outside the allowlist");
});
