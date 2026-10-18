import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-model-agent-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)),
  RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks") });
const [{ Agent }, { LLMClient }, { ConversationMemory }, { createEffectivePersona }, { createSession },
  { capabilityBroker }, { pathPolicy }, { closeDb }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/llm.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"),
  import("../../src/session.ts"), import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/db.ts"),
]);
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-model-agent-"));
  await rm(fixture, { recursive: true, force: true });
});

async function runScenario(name, reply) {
  const workspace = path.join(fixture, name);
  await mkdir(workspace);
  await writeFile(path.join(workspace, "one.txt"), "唯一资料甲：21");
  await writeFile(path.join(workspace, "two.txt"), "唯一资料乙：34");
  const requests = [];
  let streams = 0;
  const server = createServer(async (request, response) => {
    const bytes = []; for await (const part of request) bytes.push(part);
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
    requests.push(body);
    if (!body.stream) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "资料核对" }, finish_reason: "stop" }] }));
      return;
    }
    const { calls, text } = reply(++streams, workspace);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunks = [{ choices: [{ delta: calls ? { tool_calls: calls } : { content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] }];
    response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const persona = createEffectivePersona({ name: "general", displayName: "Test", description: "Fixture", permissionLevel: "read_only",
    tools: ["read"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["read-file", "read-directory"] }]) });
  try {
    const client = new LLMClient({ apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture" });
    const memory = new ConversationMemory();
    const agent = new Agent(client, memory, persona, authority);
    agent.setSession(createSession(persona, "Fixture").id);
    const events = [];
    for await (const event of agent.run("核对两份本地资料", `d02-${name}`)) events.push(event);
    return { events, requests, messages: memory.getAll() };
  } finally {
    await capabilityBroker.retireAuthority(authority);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

const read = (id, index, filename) => ({ id, index, type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: filename }) } });

test("D02 无DATA_ROOT的真实默认Agent可读取已选范围，并行后串行核对再回答", async () => {
  const { events, requests } = await runScenario("complete", (step, workspace) => step === 1
    ? { calls: [read("read-two", 1, path.join(workspace, "two.txt")), read("read-one", 0, path.join(workspace, "one.txt"))] }
    : step === 2 ? { calls: [read("read-again", 0, path.join(workspace, "one.txt"))] } : { text: "甲21，乙34，已复核。" });
  const results = events.filter(event => event.type === "tool_result");
  assert.equal(results.length, 3);
  assert(results.every(event => event.toolStatus === "success"), JSON.stringify(results));
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.filter(event => event.type === "answer_chunk").map(event => event.content).join(""), "甲21，乙34，已复核。");
  const streams = requests.filter(body => body.stream);
  assert.equal(streams.length, 3);
  const toolReplies = streams[1].messages.filter(message => message.role === "tool");
  assert.deepEqual(toolReplies.map(message => message.tool_call_id), ["read-one", "read-two"]);
  assert.match(toolReplies[0].content, /唯一资料甲：21/);
  assert.match(toolReplies[1].content, /唯一资料乙：34/);
  assert.equal(streams[2].messages.at(-1).tool_call_id, "read-again");
});

test("D02 一批调用含残缺JSON时，真实Agent不执行其中任何工具", async () => {
  const malformed = read("read-broken", 1, "two.txt");
  malformed.function.arguments = '{"file_path":';
  const { events, requests, messages } = await runScenario("incomplete", () => ({ calls: [read("read-valid", 0, "one.txt"), malformed] }));
  assert.equal(events.filter(event => event.type === "tool_call" || event.type === "tool_result").length, 0);
  assert.match(events.find(event => event.type === "error").content, /工具参数不是完整JSON/);
  assert.equal(messages.some(message => message.role === "tool"), false);
  assert.equal(requests.filter(body => body.stream).length, 1);
});

test("D02 无DATA_ROOT不放宽绝对路径读取范围", async () => {
  const outside = path.join(fixture, "outside.txt");
  await writeFile(outside, "不可读取的范围外资料");
  const { events } = await runScenario("out-of-scope", step => step === 1
    ? { calls: [read("outside", 0, outside)] } : { text: "无法读取范围外文件。" });
  const result = events.find(event => event.type === "tool_result");
  assert(result);
  assert.notEqual(result.toolStatus, "success");
  assert.match(result.content, /PATH_ROOT_DENIED/);
  assert.doesNotMatch(result.content, /不可读取的范围外资料/);
});
