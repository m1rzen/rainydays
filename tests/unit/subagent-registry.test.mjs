import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-rt08-registry-");
await mkdir(path.join(fixture, "data"), { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
});
const [{ SubagentRegistry }, { closeDb }] = await Promise.all([
  import("../../dist/subagent-registry.js"),
  import("../../dist/db.js"),
]);
after(async () => {
  closeDb();
  await removeFixture(fixture);
});

function context(sessionId, suffix = "parent") {
  return Object.freeze({
    contextId: `context-${suffix}`,
    executionDomainId: `domain-${suffix}`,
    sessionId,
    runId: `run-${suffix}`,
    parentContextId: null,
    principal: "agent",
    persona: Object.freeze({ name: "fixture", digest: "digest" }),
    authorityEpoch: 1,
    allowedTools: Object.freeze([]),
    allowedRoots: Object.freeze([]),
    networkPolicy: Object.freeze({ mode: "deny" }),
    allowedRiskClasses: Object.freeze([]),
    approvalGrant: null,
  });
}

function persona(name = "fixture") {
  return Object.freeze({
    name,
    displayName: name,
    description: "fixture",
    tools: Object.freeze([]),
    env: Object.freeze({}),
    allowedRoots: Object.freeze([]),
    networkPolicy: Object.freeze({ mode: "deny" }),
    systemPrompt: `${name} system prompt`,
    digest: `${name}-digest`,
  });
}

function parentInvocation(sessionId, options = {}) {
  const finished = [];
  const derived = [];
  const parentContext = context(sessionId);
  let sequence = 0;
  const invocation = {
    capabilityContext: parentContext,
    signal: new AbortController().signal,
    path: {},
    network: { fetch: async () => new Response("unused") },
    execution: {},
    resourceOwner: {},
    auditContext: null,
    deriveChild: () => assert.fail("attached child derivation is unexpected"),
    finishChild: () => assert.fail("attached child finish is unexpected"),
    deriveDetachedChild: (_request, runId) => {
      const child = Object.freeze({
        ...context(sessionId, `child-${sequence += 1}`),
        contextId: `child-${sequence}`,
        executionDomainId: `child-domain-${sequence}`,
        runId,
        principal: "subagent",
        allowedTools: Object.freeze([]),
      });
      derived.push(child);
      return child;
    },
    finishDetachedChild: async child => {
      finished.push(child.contextId);
      options.cleanupEntered?.();
      if (options.cleanupWait) await options.cleanupWait;
      if (options.cleanupFailure) throw new Error("synthetic cleanup failure");
    },
    executeDetachedTool: async () => "unused",
    createDetachedNetwork: () => {
      if (options.networkFailure) throw new Error("synthetic network construction failure");
      return { fetch: async () => new Response("unused") };
    },
    getUnattendedChildToolNames: () => [],
    listCurrentToolDefinitions: () => [],
    getToolDefinitions: () => [],
    executeTool: async () => "unused",
  };
  return { invocation: Object.freeze(invocation), context: parentContext, derived, finished };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("fixture wait timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("RT-08 spawn returns immediately and post steers the next child checkpoint with inherited canvas", async () => {
  const registry = new SubagentRegistry("session-a");
  const parent = parentInvocation("session-a");
  let releaseFirst;
  let calls = 0;
  const seen = [];
  const llm = {
    chat: async messages => {
      calls += 1;
      seen.push(messages.map(message => ({ ...message })));
      if (calls === 1) await new Promise(resolve => { releaseFirst = resolve; });
      return calls === 1
        ? { role: "assistant", content: "stale" }
        : { role: "assistant", content: "steered" };
    },
  };
  const spawned = await registry.spawn({
    description: "analyze canvas",
    prompt: "work",
    persona: persona(),
    llm,
    parentContext: parent.context,
    parentInvocation: parent.invocation,
    inheritCanvas: true,
    canvasSnapshot: [{ role: "user", content: "parent canvas fact" }],
  });
  assert.equal(spawned.status, "running");
  await waitUntil(() => typeof releaseFirst === "function");
  registry.post(spawned.taskId, "use corrected direction");
  releaseFirst();
  const completed = await registry.wait(spawned.taskId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "steered");
  assert.equal(calls, 2);
  assert(seen[0].some(message => message.content === "parent canvas fact"));
  assert(seen[0].some(message => message.content.includes("Synthetic canvas fork notice")));
  assert(seen[1].some(message => message.content.includes("use corrected direction")));
  assert.equal(registry.peek(spawned.taskId, "full").events.some(event => event.type === "sideband"), true);
  assert.equal(parent.finished.length, 1);
  await registry.shutdown();
});

test("RT-08 output timeout is non-destructive, stop is idempotent, and results are UTF-8 bounded", async () => {
  const registry = new SubagentRegistry("session-b");
  const parent = parentInvocation("session-b");
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const llm = {
    chat: async (_messages, _tools, signal) => new Promise((resolve, reject) => {
      enteredResolve();
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  };
  const spawned = await registry.spawn({
    description: "hold child",
    prompt: "wait",
    persona: persona(),
    llm,
    parentContext: parent.context,
    parentInvocation: parent.invocation,
  });
  await entered;
  assert.equal((await registry.output(spawned.taskId, { block: true, timeoutMs: 10 })).status, "running");
  assert.equal((await registry.stop(spawned.taskId)).status, "aborted");
  assert.equal((await registry.stop(spawned.taskId)).status, "aborted");
  assert.equal(parent.finished.length, 1);

  const large = await registry.spawn({
    description: "large result",
    prompt: "return",
    persona: persona(),
    llm: { chat: async () => ({ role: "assistant", content: "界".repeat(100_000) }) },
    parentContext: parent.context,
    parentInvocation: parent.invocation,
  });
  const completed = await registry.wait(large.taskId);
  assert.equal(completed.status, "completed");
  assert(Buffer.byteLength(completed.result, "utf8") <= 128 * 1024);
  assert.match(completed.result, /\[subagent output truncated\]$/u);
  assert.equal(completed.result.includes("�"), false);
  await registry.shutdown();
});

test("RT-08 registries isolate Sessions, cap active children, and expose cleanup failures", async () => {
  const left = new SubagentRegistry("left");
  const right = new SubagentRegistry("right");
  const leftParent = parentInvocation("left");
  const gates = [];
  const hold = {
    chat: async (_messages, _tools, signal) => new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      gates.push(() => {
        signal.removeEventListener("abort", onAbort);
        resolve({ role: "assistant", content: "done" });
      });
    }),
  };
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    ids.push((await left.spawn({
      description: `child ${index}`,
      prompt: "hold",
      persona: persona(),
      llm: hold,
      parentContext: leftParent.context,
      parentInvocation: leftParent.invocation,
    })).taskId);
  }
  await assert.rejects(() => left.spawn({
    description: "ninth child",
    prompt: "denied",
    persona: persona(),
    llm: hold,
    parentContext: leftParent.context,
    parentInvocation: leftParent.invocation,
  }), error => error?.code === "SUBAGENT_LIMIT");
  assert.throws(() => right.get(ids[0]), error => error?.code === "SUBAGENT_NOT_FOUND");
  assert.equal(left.list().length, 8);
  await left.shutdown();
  assert(left.list().every(entry => entry.status === "aborted"));
  assert.equal(leftParent.finished.length, 8);
  await right.shutdown();

  const failing = new SubagentRegistry("cleanup");
  const failingParent = parentInvocation("cleanup", { cleanupFailure: true });
  const child = await failing.spawn({
    description: "cleanup child",
    prompt: "finish",
    persona: persona(),
    llm: { chat: async () => ({ role: "assistant", content: "done" }) },
    parentContext: failingParent.context,
    parentInvocation: failingParent.invocation,
  });
  await assert.rejects(() => failing.wait(child.taskId).then(() => failing.shutdown()), /synthetic cleanup failure/u);
  assert.equal(failing.get(child.taskId).status, "failed");
});

test("RT-08 terminal status publishes only after detached cleanup settles", async () => {
  const registry = new SubagentRegistry("cleanup-linearization");
  let releaseCleanup;
  let cleanupEnteredResolve;
  const cleanupEntered = new Promise(resolve => { cleanupEnteredResolve = resolve; });
  const cleanupWait = new Promise(resolve => { releaseCleanup = resolve; });
  const parent = parentInvocation("cleanup-linearization", { cleanupEntered: cleanupEnteredResolve, cleanupWait });
  const child = await registry.spawn({
    description: "cleanup linearization",
    prompt: "finish",
    persona: persona(),
    llm: { chat: async () => ({ role: "assistant", content: "done" }) },
    parentContext: parent.context,
    parentInvocation: parent.invocation,
  });
  await cleanupEntered;
  assert.equal(registry.get(child.taskId).status, "running");
  assert.throws(() => registry.post(child.taskId, "too late"), error => error?.code === "SUBAGENT_NOT_RUNNING");
  let shutdownSettled = false;
  const shutdown = registry.shutdown().then(() => { shutdownSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(shutdownSettled, false);
  releaseCleanup();
  await shutdown;
  assert.equal(registry.get(child.taskId).status, "completed");
});

test("RT-08 spawn rejects forged identity and oversized canvas before derivation, and cleans failed construction", async () => {
  const registry = new SubagentRegistry("bounded");
  const parent = parentInvocation("bounded");
  const base = {
    description: "bounded child",
    prompt: "work",
    persona: persona(),
    llm: { chat: async () => ({ role: "assistant", content: "done" }) },
    parentInvocation: parent.invocation,
  };
  await assert.rejects(
    () => registry.spawn({ ...base, parentContext: context("bounded", "forged") }),
    error => error?.code === "SUBAGENT_INVALID",
  );
  assert.equal(parent.derived.length, 0);
  await assert.rejects(
    () => registry.spawn({
      ...base,
      parentContext: parent.context,
      inheritCanvas: true,
      canvasSnapshot: [{ role: "user", content: "x".repeat(513 * 1024) }],
    }),
    error => error?.code === "SUBAGENT_LIMIT",
  );
  assert.equal(parent.derived.length, 0);

  const broken = parentInvocation("bounded", { networkFailure: true });
  await assert.rejects(
    () => registry.spawn({ ...base, parentContext: broken.context, parentInvocation: broken.invocation }),
    /synthetic network construction failure/u,
  );
  assert.equal(broken.derived.length, 1);
  assert.equal(broken.finished.length, 1);
  assert.equal(registry.list().length, 0);
  await registry.shutdown();
});

test("RT-08 stop and shutdown fail within a bound for a non-cooperative provider", async () => {
  const registry = new SubagentRegistry("non-cooperative", { settlementTimeoutMs: 20 });
  const parent = parentInvocation("non-cooperative");
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const child = await registry.spawn({
    description: "stuck child",
    prompt: "never settle",
    persona: persona(),
    llm: { chat: async () => { enteredResolve(); return new Promise(() => undefined); } },
    parentContext: parent.context,
    parentInvocation: parent.invocation,
  });
  await entered;
  await assert.rejects(() => registry.stop(child.taskId), error => error?.code === "SUBAGENT_SETTLEMENT_FAILED");
  await assert.rejects(() => registry.shutdown(), error => error?.code === "SUBAGENT_SETTLEMENT_FAILED");
  assert.equal(registry.closed, true);
});
