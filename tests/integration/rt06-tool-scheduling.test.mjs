import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { appendSecurityAuditEvent, createSecurityAuditCommitment, verifySecurityAuditChain } from "../../dist/security-audit.js";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

function assistant(content, toolCalls) {
  return { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

class FakeLlm {
  responses = [];
  queue(...responses) { this.responses.push(...responses); }
  async chat() { throw new Error("unexpected non-streaming LLM call"); }
  async *chatStream() {
    const message = this.responses.shift();
    assert(message, "fake LLM response queue is empty");
    yield { type: "result", message };
  }
}

async function collect(agent, input, signal) {
  const events = [];
  for await (const event of agent.run(input, undefined, signal)) events.push(event);
  return events;
}

function createMemoryAuditJournal() {
  const key = Buffer.alloc(32, 0x66);
  const events = [];
  let rejectedResultToolCallId = null;
  return {
    events,
    rejectResultFor: toolCallId => { rejectedResultToolCallId = toolCallId; },
    journal: Object.freeze({
      append: async input => {
        if (input.phase === "result" && input.correlation.toolCallId === rejectedResultToolCallId) {
          throw new Error("synthetic RT-06 audit delivery failure");
        }
        const event = appendSecurityAuditEvent(events, input, key);
        events.push(event);
        return event;
      },
      commit: value => createSecurityAuditCommitment(key, value),
      verify: async () => ({ schemaVersion: 1, integrity: "verified", ...verifySecurityAuditChain(events, key) }),
      close: () => key.fill(0),
    }),
  };
}

function rawFetch(id, url) {
  return toolCall(id, "fetch_url", { url, format: "raw" });
}

test("RT-06 Agent runs conflict-free reads concurrently and preserves barriers, order, failures, and cancellation settlement", async () => {
  const fixture = await makeTempDir("mini-lux-rt06-scheduling-");
  const dataDir = path.join(fixture, "data");
  await mkdir(dataDir, { recursive: true });
  Object.assign(process.env, {
    RAINYDAYS_APP_ROOT: projectRoot,
    RAINYDAYS_USER_DATA_DIR: fixture,
    RAINYDAYS_DATA_DIR: dataDir,
    RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
    RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
  });

  const originalFetch = globalThis.fetch;
  let transport = async () => { throw new Error("RT-06 transport was not configured"); };
  globalThis.fetch = (...args) => transport(...args);

  const [
    { Agent },
    { ConversationMemory },
    { createEffectivePersona },
    { createSession },
    { closeDb },
    { capabilityBroker, registerDynamicTool },
    { pathPolicy },
    { disableSupervisor },
  ] = await Promise.all([
    import("../../dist/agent.js"),
    import("../../dist/memory.js"),
    import("../../dist/persona.js"),
    import("../../dist/session.js"),
    import("../../dist/db.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/path-runtime.js"),
    import("../../dist/supervisor.js"),
  ]);

  const persona = createEffectivePersona({
    name: "rt06-scheduling",
    displayName: "RT-06 Scheduling",
    description: "RT-06 scheduling fixture",
    tools: ["fetch_url", "muse"],
    env: { WORKSPACE_ROOT: fixture },
    allowedRoots: [fixture],
    networkPolicy: { mode: "unrestricted" },
    systemPrompt: "RT-06 scheduling fixture",
  });
  const pathAuthority = await pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: fixture,
    permissions: ["read-file", "read-directory", "search-tree"],
  }]);
  const authority = capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });

  let firstReadDone = false;
  let serialDone = false;
  let secondReadStarted = false;
  registerDynamicTool(authority, {
    name: "muse",
    definition: {
      type: "function",
      function: {
        name: "muse",
        description: "serial RT-06 barrier",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    executor: async () => {
      assert.equal(firstReadDone, true, "serial barrier started before the preceding read settled");
      assert.equal(secondReadStarted, false, "following read crossed the serial barrier");
      serialDone = true;
      return "serial barrier complete";
    },
  });

  const llm = new FakeLlm();
  const memory = new ConversationMemory(80);
  const audit = createMemoryAuditJournal();
  const agent = new Agent(llm, memory, persona, authority, audit.journal);
  const session = createSession(persona, "RT-06 scheduling");
  agent.setSession(session.id);
  disableSupervisor();

  try {
    let active = 0;
    let maxActive = 0;
    const starts = [];
    const resolvers = new Map();
    transport = (url) => new Promise(resolve => {
      const name = new URL(url).pathname.slice(1);
      starts.push(name);
      active += 1;
      maxActive = Math.max(maxActive, active);
      resolvers.set(name, text => {
        active -= 1;
        resolve(new Response(text, { status: 200, headers: { "content-type": "text/plain" } }));
      });
      if (starts.length === 2) {
        resolvers.get("second")("second-result");
        setTimeout(() => resolvers.get("first")("first-result"), 25);
      }
    });
    llm.queue(
      assistant("", [rawFetch("rt06-first", "https://rt06.test/first"), rawFetch("rt06-second", "https://rt06.test/second")]),
      assistant("parallel complete"),
    );
    const parallelEvents = await collect(agent, "run two independent reads");
    const parallelResults = parallelEvents.filter(event => event.type === "tool_result");
    assert.equal(maxActive, 2);
    assert.deepEqual(starts, ["first", "second"]);
    assert.deepEqual(parallelResults.map(event => event.content), ["first-result", "second-result"]);
    assert.deepEqual(memory.getAll().filter(message => message.role === "tool").slice(-2).map(message => message.tool_call_id), ["rt06-first", "rt06-second"]);

    transport = async (url) => {
      const name = new URL(url).pathname.slice(1);
      if (name === "before") {
        assert.equal(serialDone, false);
        firstReadDone = true;
        return new Response("before-result", { status: 200 });
      }
      secondReadStarted = true;
      assert.equal(serialDone, true, "following read started before the serial barrier settled");
      return new Response("after-result", { status: 200 });
    };
    llm.queue(
      assistant("", [
        rawFetch("rt06-before", "https://rt06.test/before"),
        toolCall("rt06-barrier", "muse", {}),
        rawFetch("rt06-after", "https://rt06.test/after"),
      ]),
      assistant("barrier complete"),
    );
    const barrierEvents = await collect(agent, "preserve a serial barrier");
    assert.deepEqual(barrierEvents.filter(event => event.type === "tool_result").map(event => event.content), [
      "before-result", "serial barrier complete", "after-result",
    ]);

    let failureCalls = 0;
    transport = async (url) => {
      failureCalls += 1;
      if (new URL(url).pathname === "/fail") throw new Error("isolated transport failure");
      return new Response("survivor-result", { status: 200 });
    };
    llm.queue(
      assistant("", [rawFetch("rt06-fail", "https://rt06.test/fail"), rawFetch("rt06-survive", "https://rt06.test/survive")]),
      assistant("failure isolated"),
    );
    const failureEvents = await collect(agent, "isolate one read failure");
    assert.equal(failureCalls, 2);
    assert.deepEqual(failureEvents.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["error", "success"]);

    let cancellationStarts = 0;
    let cancellationSettlements = 0;
    let releaseStarted;
    const bothStarted = new Promise(resolve => { releaseStarted = resolve; });
    transport = (_url, init) => new Promise((resolve, reject) => {
      cancellationStarts += 1;
      if (cancellationStarts === 2) releaseStarted();
      init.signal.addEventListener("abort", () => {
        cancellationSettlements += 1;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
    llm.queue(assistant("", [
      rawFetch("rt06-cancel-a", "https://rt06.test/cancel-a"),
      rawFetch("rt06-cancel-b", "https://rt06.test/cancel-b"),
    ]));
    const controller = new AbortController();
    const cancelledRun = collect(agent, "cancel a parallel read batch", controller.signal);
    await bothStarted;
    controller.abort(new Error("RT-06 cancellation probe"));
    await assert.rejects(cancelledRun, /cancel/i);
    assert.equal(cancellationSettlements, 2);
    assert.deepEqual(memory.getAll().filter(message => message.role === "tool").slice(-2).map(message => message.tool_call_id), [
      "rt06-cancel-a", "rt06-cancel-b",
    ]);
    assert.equal((await audit.journal.verify()).integrity, "verified");
    for (const id of ["rt06-first", "rt06-second", "rt06-fail", "rt06-survive", "rt06-cancel-a", "rt06-cancel-b"]) {
      assert.deepEqual(audit.events.filter(event => event.correlation.toolCallId === id).map(event => event.phase), [
        "request", "authorization", "execution", "result",
      ]);
    }

    let priorityStarts = 0;
    let priorityStartedResolve;
    const priorityStarted = new Promise(resolve => { priorityStartedResolve = resolve; });
    transport = (_url, init) => new Promise((resolve, reject) => {
      priorityStarts += 1;
      if (priorityStarts === 2) priorityStartedResolve();
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    audit.rejectResultFor("rt06-audit-fail");
    const toolMessagesBeforeAuditFailure = memory.getAll().filter(message => message.role === "tool").length;
    llm.queue(assistant("", [
      rawFetch("rt06-cancel-first", "https://rt06.test/cancel-first"),
      rawFetch("rt06-audit-fail", "https://rt06.test/audit-fail"),
    ]));
    const priorityController = new AbortController();
    const priorityRun = collect(agent, "audit failure dominates parallel cancellation", priorityController.signal);
    await priorityStarted;
    priorityController.abort(new Error("RT-06 audit priority probe"));
    await assert.rejects(
      priorityRun,
      error => error?.message === "synthetic RT-06 audit delivery failure",
    );
    assert.equal(memory.getAll().filter(message => message.role === "tool").length, toolMessagesBeforeAuditFailure);
  } finally {
    globalThis.fetch = originalFetch;
    audit.journal.close();
    capabilityBroker.revokeAuthority(authority);
    closeDb();
    await removeFixture(fixture);
  }
});
