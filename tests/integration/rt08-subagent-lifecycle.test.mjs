import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const databaseFixture = await makeTempDir("mini-lux-rt08-lifecycle-db-");
await fs.mkdir(path.join(databaseFixture, "data"), { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: databaseFixture,
  RAINYDAYS_DATA_DIR: path.join(databaseFixture, "data"),
});
const [
  { CapabilityBroker },
  { ConversationMemory },
  { PathPolicy },
  { SubagentRegistry },
  { createSubagentExecutors },
  { closeDb },
] = await Promise.all([
  import("../../dist/capability-broker.js"),
  import("../../dist/memory.js"),
  import("../../dist/path-policy.js"),
  import("../../dist/subagent-registry.js"),
  import("../../dist/tools/subagent-tools.js"),
  import("../../dist/db.js"),
]);
after(async () => {
  closeDb();
  await removeFixture(databaseFixture);
});

const readPolicy = Object.freeze({ riskClasses: ["read"], approval: "none", effects: [] });
const approvalPolicy = Object.freeze({ riskClasses: ["write"], approval: "user", effects: ["filesystem"] });
const controlPolicy = Object.freeze({ riskClasses: ["control"], approval: "none", effects: ["control"] });
const spawnPolicy = Object.freeze({ riskClasses: ["read", "network", "control"], approval: "none", effects: ["network", "control"] });
const definition = name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const registration = (name, policy) => ({ name, definition: definition(name), policy, executor: async () => name });

function effectivePersona(name, tools) {
  return Object.freeze({
    name,
    displayName: name,
    description: name,
    tools: Object.freeze([...tools]),
    env: Object.freeze({}),
    allowedRoots: Object.freeze([]),
    networkPolicy: Object.freeze({ mode: "deny" }),
    systemPrompt: `${name} system`,
    digest: `${name}-digest`,
  });
}

function parsed(value) {
  return JSON.parse(value);
}

test("RT-08 authentic lifecycle adapters detach from parent, attenuate tools, and settle stop/shutdown", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-rt08-lifecycle-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const pathPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 8) });
  const basePath = await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: root, permissions: ["read-file"] }]);
  const broker = new CapabilityBroker({ resolveSessionPersona: id => id === "session-a" ? "developer" : null, pathPolicy });
  const lifecycleNames = ["subagent", "subagent_list", "subagent_output", "subagent_peek", "subagent_post", "subagent_stop", "subagent_wait"];
  broker.registerStaticTool(registration("read_value", readPolicy));
  broker.registerStaticTool(registration("write_value", approvalPolicy));
  for (const name of lifecycleNames) broker.registerStaticTool(registration(name, name === "subagent" ? spawnPolicy : controlPolicy));
  const parentPersona = effectivePersona("developer", ["read_value", "write_value", ...lifecycleNames]);
  const childPersona = effectivePersona("reviewer", ["read_value", "write_value", "subagent"]);
  const authority = broker.createRuntimeAuthority({
    name: parentPersona.name,
    tools: parentPersona.tools,
    env: {},
    rootEnv: {},
    systemPrompt: parentPersona.systemPrompt,
    allowedRoots: [],
    pathAuthority: pathPolicy.deriveAuthority(basePath, []),
    networkPolicy: { mode: "deny" },
  });
  const parent = broker.beginAgentRun(authority, "session-a", "parent-run");
  const registry = new SubagentRegistry("session-a");
  const parentController = new AbortController();
  const childTools = [];
  let releaseFirst;
  let calls = 0;
  const llm = {
    chat: async (_messages, tools) => {
      calls += 1;
      childTools.push(tools.map(tool => tool.function.name));
      if (calls === 1) await new Promise(resolve => { releaseFirst = resolve; });
      return calls === 1 ? { role: "assistant", content: "stale" } : { role: "assistant", content: "corrected" };
    },
  };
  const detached = new Set();
  const invocation = Object.freeze({
    capabilityContext: parent,
    signal: parentController.signal,
    path: {},
    network: { fetch: async () => new Response("unused") },
    execution: {},
    resourceOwner: broker.getResourceOwner(parent),
    auditContext: null,
    deriveChild: request => broker.deriveInvocationChild(parent, request),
    finishChild: context => broker.finishContext(context),
    deriveDetachedChild: (request, runId) => {
      const context = broker.deriveDetachedInvocationChild(parent, request, runId);
      detached.add(context);
      return context;
    },
    finishDetachedChild: async context => {
      detached.delete(context);
      await broker.finishDetachedContext(context);
    },
    executeDetachedTool: async () => "unused",
    createDetachedNetwork: () => ({ fetch: async () => new Response("unused") }),
    getUnattendedChildToolNames: () => broker.getUnattendedChildToolNames(parent),
    listCurrentToolDefinitions: () => broker.getToolDefinitions(parent),
    getToolDefinitions: context => broker.getToolDefinitions(context),
    executeTool: async () => "unused",
  });
  const memory = new ConversationMemory(20);
  memory.setSystemPrompt("parent");
  memory.add({ role: "user", content: "canvas fact" });
  const executors = createSubagentExecutors({
    registry,
    llm,
    persona: parentPersona,
    memory,
    resolvePersona: name => name === childPersona.name ? childPersona : null,
  });

  const spawned = parsed(await executors.subagent({
    description: "review child",
    prompt: "review",
    persona: "reviewer",
    inherit_canvas: true,
  }, { _SESSION_ID: "session-a" }, invocation));
  assert.equal(spawned.status, "running");
  while (typeof releaseFirst !== "function") await new Promise(resolve => setTimeout(resolve, 1));
  broker.finishContext(parent);
  assert.equal([...detached].every(context => broker.isContextActive(context)), true);
  assert.deepEqual(childTools[0], ["read_value"]);
  assert.equal(parsed(await executors.subagent_list({})).length, 1);
  assert.equal(parsed(await executors.subagent_output({ task_id: spawned.taskId }, undefined, invocation)).status, "running");
  parsed(await executors.subagent_post({ task_id: spawned.taskId, message: "use corrected direction" }));
  releaseFirst();
  const completed = parsed(await executors.subagent_wait({ task_id: spawned.taskId }, undefined, invocation));
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "corrected");
  assert.equal(parsed(await executors.subagent_peek({ task_id: spawned.taskId, scope: "full" })).events.some(event => event.type === "sideband"), true);
  assert.equal(detached.size, 0);

  const nextParent = broker.beginAgentRun(authority, "session-a", "next-parent");
  const heldRegistry = new SubagentRegistry("session-a");
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const heldInvocation = Object.freeze({
    ...invocation,
    capabilityContext: nextParent,
    resourceOwner: broker.getResourceOwner(nextParent),
    deriveChild: request => broker.deriveInvocationChild(nextParent, request),
    deriveDetachedChild: (request, runId) => broker.deriveDetachedInvocationChild(nextParent, request, runId),
    getUnattendedChildToolNames: () => broker.getUnattendedChildToolNames(nextParent),
    listCurrentToolDefinitions: () => broker.getToolDefinitions(nextParent),
  });
  const heldExecutors = createSubagentExecutors({
    registry: heldRegistry,
    llm: { chat: async (_messages, _tools, signal) => new Promise((_, reject) => {
      enteredResolve();
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }) },
    persona: parentPersona,
    memory,
    resolvePersona: () => null,
  });
  const held = parsed(await heldExecutors.subagent({ description: "held child", prompt: "hold" }, {}, heldInvocation));
  await entered;
  assert.equal((await heldRegistry.output(held.taskId)).status, "running");
  await heldRegistry.shutdown();
  assert.equal(heldRegistry.get(held.taskId).status, "aborted");
  broker.finishContext(nextParent);
  await broker.retireAuthority(authority);
});
