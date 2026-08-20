import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-rt04-runtime-");
const dataDir = path.join(fixture, "data");
const playbooksDir = path.join(fixture, "playbooks");
await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(playbooksDir, { recursive: true }),
]);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
  RAINYDAYS_PLAYBOOKS_DIR: playbooksDir,
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});

const [
  { LLMClient },
  { ConversationMemory },
  { runSubAgent },
  playbook,
  { webSearchExec },
  { fetchUrlExec },
  { RunCancellationError, NEVER_ABORT_SIGNAL },
  { ToolArgumentsError },
  { closeDb, insertMessage, insertSession },
  { APIUserAbortError },
] = await Promise.all([
  import("../../dist/llm.js"),
  import("../../dist/memory.js"),
  import("../../dist/subagent.js"),
  import("../../dist/playbook.js"),
  import("../../dist/tools/search-tool.js"),
  import("../../dist/tools/web.js"),
  import("../../dist/run-cancellation.js"),
  import("../../dist/tool-pipeline.js"),
  import("../../dist/db.js"),
  import("openai"),
]);

const originalFetch = globalThis.fetch;
test.after(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  await removeFixture(fixture);
});

function makeLlm(create) {
  const llm = new LLMClient({
    apiKey: "rt04-fixture-key",
    baseURL: "https://provider.invalid/v1",
    model: "rt04-fixture-model",
  });
  llm.client.chat.completions.create = create;
  return llm;
}

function invocation(signal = NEVER_ABORT_SIGNAL, overrides = {}) {
  return {
    signal,
    network: { fetch: (url, init) => globalThis.fetch(url, init) },
    getToolDefinitions: () => [{ type: "function", function: { name: "fixture", description: "fixture", parameters: { type: "object" } } }],
    executeTool: async () => "fixture-result",
    ...overrides,
  };
}

test("RT-04 LLM client binds one signal through non-stream and stream state machines", async () => {
  const controller = new AbortController();
  const observed = [];
  const llm = makeLlm(async (params, options) => {
    observed.push({ params, signal: options?.signal });
    return {
      choices: [{
        message: {
          content: "answer",
          tool_calls: [{ id: "call-1", function: { name: "fixture", arguments: "{\"ok\":true}" } }],
        },
      }],
    };
  });
  const answer = await llm.chat(
    [{ role: "user", content: "hello" }],
    invocation().getToolDefinitions(),
    controller.signal,
  );
  assert.equal(answer.content, "answer");
  assert.equal(answer.tool_calls?.[0]?.function.name, "fixture");
  assert.equal(observed[0].signal, controller.signal);
  assert.equal(observed[0].params.tool_choice, "auto");

  llm.client.chat.completions.create = async () => {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  };
  await assert.rejects(
    () => llm.chat([{ role: "user", content: "deny" }], undefined, controller.signal),
    /LLM 请求失败: unauthorized/u,
  );

  const streamSignal = new AbortController();
  llm.client.chat.completions.create = async (_params, options) => {
    assert.equal(options.signal, streamSignal.signal);
    return (async function* chunks() {
      yield { choices: [{ delta: { content: "A", tool_calls: [{ index: 0, id: "call-stream", function: { name: "fixture", arguments: "{\"" } }] } }] };
      yield { choices: [{ delta: { content: "B", tool_calls: [{ index: 0, function: { arguments: "ok\":true}" } }] } }] };
      yield { choices: [{}] };
    })();
  };
  const events = [];
  for await (const event of llm.chatStream(
    [{ role: "user", content: "stream" }],
    invocation().getToolDefinitions(),
    streamSignal.signal,
  )) events.push(event);
  assert.deepEqual(events.slice(0, 2), [
    { type: "delta", content: "A" },
    { type: "delta", content: "B" },
  ]);
  assert.equal(events.at(-1).message.content, "AB");
  assert.equal(events.at(-1).message.tool_calls[0].function.arguments, "{\"ok\":true}");

  const cancelled = new AbortController();
  const reason = new RunCancellationError("RUN_CANCELLED", "LLM pre-cancelled");
  cancelled.abort(reason);
  let providerCalls = 0;
  llm.client.chat.completions.create = async () => { providerCalls += 1; };
  await assert.rejects(
    () => llm.chat([{ role: "user", content: "never" }], undefined, cancelled.signal),
    error => error === reason,
  );
  assert.equal(providerCalls, 0);
});

test("RT-04 LLM adapter accepts only the SDK's signal-bound abort as cooperative cancellation", async () => {
  const cooperative = new AbortController();
  const entered = Promise.withResolvers();
  const llm = makeLlm(async (_params, options) => {
    entered.resolve();
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
    throw new APIUserAbortError();
  });
  const running = llm.chat([{ role: "user", content: "held provider" }], undefined, cooperative.signal);
  await entered.promise;
  cooperative.abort(new Error("provider request cancelled"));
  await assert.rejects(
    () => running,
    error => error?.code === "RUN_CANCELLED" && /provider request cancelled/u.test(error.message),
  );

  const failed = new AbortController();
  const failedEntered = Promise.withResolvers();
  llm.client.chat.completions.create = async (_params, options) => {
    failedEntered.resolve();
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("provider cleanup failed");
  };
  const failedRun = llm.chat([{ role: "user", content: "failed settlement" }], undefined, failed.signal);
  await failedEntered.promise;
  failed.abort(new Error("provider request cancelled"));
  await assert.rejects(
    () => failedRun,
    error => error?.code === "RUN_SETTLEMENT_FAILED" && /provider cleanup failed/u.test(String(error.errors?.[1])),
  );
});

test("RT-04 memory compaction is atomic across success, fallback, and cancellation", async () => {
  const populate = memory => {
    memory.setSystemPrompt("runtime fixture");
    for (let index = 0; index < 18; index += 1) {
      memory.add({ role: index % 2 === 0 ? "user" : "assistant", content: `${index}:` + "x".repeat(5_000) });
    }
  };

  const compacted = new ConversationMemory(100);
  populate(compacted);
  assert.equal(await compacted.compact({ chat: async (_messages, _tools, signal) => {
    assert.equal(signal, NEVER_ABORT_SIGNAL);
    return { role: "assistant", content: "governed summary" };
  } }, NEVER_ABORT_SIGNAL), true);
  assert.equal(compacted.hasSummary(), true);
  assert(compacted.getTokenEstimate() < 28_000);

  const fallback = new ConversationMemory(100);
  populate(fallback);
  assert.equal(await fallback.compact({ chat: async () => { throw new Error("summary unavailable"); } }, NEVER_ABORT_SIGNAL), true);
  assert.equal(fallback.hasSummary(), false);
  assert(fallback.getTokenEstimate() <= 28_000);

  const unchanged = new ConversationMemory(100);
  populate(unchanged);
  const before = unchanged.getAll();
  const cancelled = new AbortController();
  const reason = new RunCancellationError("RUN_CANCELLED", "memory cancelled");
  cancelled.abort(reason);
  await assert.rejects(() => unchanged.compact({ chat: async () => ({ role: "assistant", content: "unreachable" }) }, cancelled.signal), error => error === reason);
  assert.deepEqual(unchanged.getAll(), before);

  const sessionId = "rt04-memory-session";
  const now = new Date().toISOString();
  insertSession({ id: sessionId, persona_name: "rt04", title: "memory", created_at: now, updated_at: now });
  const persisted = new ConversationMemory(6);
  persisted.setSessionId(sessionId);
  persisted.addMany([
    { role: "user", content: "persisted user" },
    { role: "assistant", content: "", tool_calls: [{ id: "persisted-tool", type: "function", function: { name: "fixture", arguments: "{}" } }] },
    { role: "tool", content: "head\n" + "middle-error\n".repeat(200) + "tail", tool_call_id: "persisted-tool" },
    { role: "assistant", content: "persisted answer" },
  ]);
  const restored = new ConversationMemory(6);
  restored.loadFromDb(sessionId);
  assert.equal(restored.getMessageCount(), 4);
  assert.match(restored.getAll()[2].content, /结果已压缩/u);
  assert.equal(restored.getAll()[1].tool_calls[0].function.name, "fixture");
  restored.setSystemPrompt("restored system");
  for (let index = 0; index < 10; index += 1) restored.add({ role: "user", content: `bounded-${index}` });
  assert(restored.getMessageCount() <= 6);
  restored.clear();
  assert.deepEqual(restored.getAll(), [{ role: "system", content: "restored system" }]);
  restored.reset();
  assert.equal(restored.getMessageCount(), 0);
});

test("RT-04 subagent preserves normal tool rounds while cancellation remains exceptional", async () => {
  const context = { sessionId: "session-a", runId: "run-a" };
  let llmCalls = 0;
  let toolCalls = 0;
  const result = await runSubAgent({
    llm: { chat: async () => {
      llmCalls += 1;
      return llmCalls === 1
        ? { role: "assistant", content: "", tool_calls: [{ id: "tool-1", type: "function", function: { name: "fixture", arguments: "{\"value\":1}" } }] }
        : { role: "assistant", content: "complete" };
    } },
    persona: { systemPrompt: "subagent fixture" },
    prompt: "run",
    context: "bounded context",
    capabilityContext: context,
    invocation: invocation(NEVER_ABORT_SIGNAL, { executeTool: async (candidate, name, args, callId) => {
      assert.equal(candidate, context);
      assert.deepEqual([name, args, callId], ["fixture", "{\"value\":1}", "tool-1"]);
      toolCalls += 1;
      return "tool-ok";
    } }),
  });
  assert.equal(result, "complete");
  assert.deepEqual([llmCalls, toolCalls], [2, 1]);

  await assert.rejects(
    () => runSubAgent({
      llm: { chat: async () => ({ role: "assistant", content: "", tool_calls: [{ id: "bad", type: "function", function: { name: "fixture", arguments: "[1]" } }] }) },
      persona: { systemPrompt: "subagent fixture" },
      prompt: "invalid",
      capabilityContext: context,
      invocation: invocation(NEVER_ABORT_SIGNAL, {
        executeTool: async (_candidate, _name, rawArgs) => {
          assert.equal(rawArgs, "[1]");
          throw new ToolArgumentsError("工具参数必须是 JSON object");
        },
      }),
    }),
    error => error?.code === "TOOL_ARGUMENTS_INVALID" && /JSON object/u.test(error.message),
  );

  await assert.rejects(
    () => runSubAgent({
      llm: { chat: async () => { throw new Error("provider failed"); } },
      persona: { systemPrompt: "subagent fixture" },
      prompt: "fail",
      capabilityContext: context,
      invocation: invocation(),
    }),
    /provider failed/u,
  );
});

test("RT-04 playbook passes one signal through every step and closes child lineage once", async () => {
  const name = "rt04-runtime";
  await playbook.createPlaybook({
    name,
    description: "RT-04 runtime fixture",
    steps: [{ message: "tool step" }, { message: "final step", description: "finish" }],
  });
  const child = { sessionId: "session-playbook", runId: "run-playbook" };
  const signal = new AbortController().signal;
  let llmCalls = 0;
  let toolCalls = 0;
  let finishes = 0;
  const executor = playbook.createPlaybookExecuteExec({ chat: async (_messages, tools, observedSignal) => {
    assert.equal(observedSignal, signal);
    assert.equal(tools.length, 1);
    llmCalls += 1;
    return llmCalls === 1
      ? { role: "assistant", content: "step", tool_calls: [{ id: "pb-tool", type: "function", function: { name: "fixture", arguments: "{\"step\":1}" } }] }
      : { role: "assistant", content: "done" };
  } }, { systemPrompt: "playbook fixture" });
  const output = await executor({ name }, undefined, invocation(signal, {
    deriveChild: () => child,
    finishChild: candidate => { assert.equal(candidate, child); finishes += 1; },
    executeTool: async (candidate, toolName, args, callId) => {
      assert.equal(candidate, child);
      assert.deepEqual([toolName, args, callId], ["fixture", "{\"step\":1}", "pb-tool"]);
      toolCalls += 1;
      return "playbook-tool-result";
    },
  }));
  assert.match(output, /执行完成/u);
  assert.match(output, /playbook-tool-result/u);
  assert.deepEqual([llmCalls, toolCalls, finishes], [2, 1, 1]);

  const missing = await playbook.executePlaybook("missing-playbook", { chat: async () => { throw new Error("unreachable"); } }, { systemPrompt: "fixture" }, child, invocation());
  assert.equal(missing.status, "failed");
  assert.match(missing.results[0], /Playbook 不存在/u);
});

test("RT-04 web tools use bounded local responses and preserve in-flight cancellation", async () => {
  globalThis.fetch = async (_url, options) => {
    assert(options.signal instanceof AbortSignal);
    return new Response(`
      <div class="result"><a class="result__a" href="https://duck.test/l/?uddg=https%3A%2F%2Fexample.test%2Fdoc">Title &amp; More</a>
      <a class="result__snippet">Snippet &lt;safe&gt;</a></div></div>
    `, { status: 200, headers: { "content-type": "text/html" } });
  };
  const search = await webSearchExec({ query: "runtime", max_results: 1 }, undefined, invocation());
  assert.match(search, /Title & More/u);
  assert.match(search, /https:\/\/example\.test\/doc/u);

  globalThis.fetch = async () => new Response("not found", { status: 503 });
  await assert.rejects(() => webSearchExec({ query: "denied" }, undefined, invocation()), /HTTP 503/u);

  globalThis.fetch = async () => new Response("<html>none</html>", { status: 200 });
  assert.match(await webSearchExec({ query: "none" }, undefined, invocation()), /未找到/u);

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await fetchUrlExec({ url: "https://local.test/json", format: "json" }, undefined, invocation()), "{\n  \"ok\": true\n}");

  globalThis.fetch = async () => new Response("<style>hide</style><nav>nav</nav><p>Hello &amp; safe</p><footer>foot</footer>", { status: 200, headers: { "content-type": "text/html" } });
  assert.equal(await fetchUrlExec({ url: "https://local.test/html" }, undefined, invocation()), "Hello & safe");

  globalThis.fetch = async () => new Response("raw-value", { status: 200, headers: { "content-type": "text/plain" } });
  assert.equal(await fetchUrlExec({ url: "https://local.test/raw", format: "raw" }, undefined, invocation()), "raw-value");

  globalThis.fetch = async () => { throw new Error("local transport failure"); };
  await assert.rejects(() => fetchUrlExec({ url: "https://local.test/fail" }, undefined, invocation()), /local transport failure/u);

  for (const [executor, args, label] of [
    [webSearchExec, { query: "cancel" }, "web_search"],
    [fetchUrlExec, { url: "https://local.test/hold" }, "fetch_url"],
  ]) {
    const entered = Promise.withResolvers();
    globalThis.fetch = async (_url, options) => {
      entered.resolve();
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("fetch aborted", "AbortError"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      });
    };
    const controller = new AbortController();
    const running = executor(args, undefined, invocation(controller.signal));
    await entered.promise;
    controller.abort(new RunCancellationError("RUN_CANCELLED", `${label} cancelled`));
    await assert.rejects(() => running, error => error?.code === "RUN_CANCELLED" && error.message === `${label} cancelled`);
  }

  const parserController = new AbortController();
  const parserReason = new RunCancellationError("RUN_CANCELLED", "independent parser cancellation");
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    text: async () => {
      parserController.abort(parserReason);
      throw new DOMException("response parser failed", "AbortError");
    },
  });
  await assert.rejects(
    () => fetchUrlExec({ url: "https://local.test/parser", format: "raw" }, undefined, invocation(parserController.signal)),
    error => error?.code === "RUN_SETTLEMENT_FAILED"
      && error instanceof AggregateError
      && error.errors.some(candidate => /response parser failed/u.test(String(candidate))),
  );
});

test("RT-04 LLM retry classification remains cancellable across rate, server, network, and stream outcomes", async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, _delay, ...args) => realSetTimeout(handler, 0, ...args);
  const realWarn = console.warn;
  console.warn = () => undefined;
  try {
    const llm = makeLlm(async () => ({ choices: [{ message: { content: null } }] }));
    let attempts = 0;
    llm.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate"), { status: 429 });
      return { choices: [{ message: { content: null } }] };
    };
    assert.deepEqual(await llm.chat([{ role: "user", content: "rate" }]), { role: "assistant", content: "", tool_calls: undefined });
    assert.equal(attempts, 2);

    attempts = 0;
    llm.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("server"), { status: 503 });
      return { choices: [{ message: { content: "recovered" } }] };
    };
    assert.equal((await llm.chat([{ role: "user", content: "server" }], undefined, NEVER_ABORT_SIGNAL)).content, "recovered");

    llm.client.chat.completions.create = async () => { throw new Error("network failed"); };
    await assert.rejects(() => llm.chat([{ role: "user", content: "network" }]), /已重试 3 次/u);
    llm.client.chat.completions.create = async () => { throw "primitive failure"; };
    await assert.rejects(() => llm.chat([{ role: "user", content: "primitive" }]), /primitive failure/u);

    attempts = 0;
    llm.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("stream rate"), { status: 429 });
      return (async function* emptyStream() { yield { choices: [{ delta: {} }] }; })();
    };
    const events = [];
    for await (const event of llm.chatStream([{ role: "user", content: "stream retry" }])) events.push(event);
    assert.equal(events.at(-1).message.tool_calls, undefined);

    llm.client.chat.completions.create = async () => { throw Object.assign(new Error("bad stream"), { status: 400 }); };
    await assert.rejects(async () => {
      for await (const _event of llm.chatStream([{ role: "user", content: "bad" }])) { /* no events */ }
    }, /LLM 流式请求失败: bad stream/u);

    const cancelled = new AbortController();
    const reason = new RunCancellationError("RUN_CANCELLED", "stream cancelled");
    llm.client.chat.completions.create = async () => (async function* heldStream() {
      cancelled.abort(reason);
      yield { choices: [{ delta: { content: "unreachable" } }] };
    })();
    await assert.rejects(async () => {
      for await (const _event of llm.chatStream([{ role: "user", content: "cancel" }], undefined, cancelled.signal)) { /* no events */ }
    }, error => error === reason);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.warn = realWarn;
  }
});

test("RT-04 memory and subagent reject malformed persisted and child-turn states deterministically", async () => {
  const sessionId = "rt04-memory-malformed";
  const now = new Date().toISOString();
  insertSession({ id: sessionId, persona_name: "rt04", title: "malformed", created_at: now, updated_at: now });
  insertMessage({ session_id: sessionId, role: "assistant", content: "", tool_calls: "{bad", tool_call_id: null, created_at: now });
  insertMessage({ session_id: sessionId, role: "tool", content: "short", tool_calls: null, tool_call_id: "call", created_at: now });
  const loaded = new ConversationMemory(10);
  loaded.loadFromDb(sessionId);
  assert.equal(loaded.getAll()[0].tool_calls, undefined);
  loaded.addMany([]);
  assert.equal(await loaded.compact({ chat: async () => ({ role: "assistant", content: "unreachable" }) }), false);

  const orphan = new ConversationMemory(2);
  orphan.addMany([
    { role: "user", content: "old" },
    { role: "tool", content: "x".repeat(2_000), tool_call_id: "orphan" },
    { role: "user", content: "recent" },
  ]);
  assert.deepEqual(orphan.getAll(), [{ role: "user", content: "recent" }]);

  const summaryMerge = new ConversationMemory(100);
  summaryMerge.add({ role: "system", content: "## 对话摘要\nold" });
  for (let index = 0; index < 10; index += 1) {
    summaryMerge.add(index === 0
      ? { role: "assistant", content: "x".repeat(75_000), tool_calls: [{ id: "edge", type: "function", function: { name: "fixture", arguments: "{}" } }] }
      : index === 1
        ? { role: "tool", content: "edge-result", tool_call_id: "edge" }
        : { role: "user", content: `recent-${index}` });
  }
  assert.equal(await summaryMerge.compact({ chat: async messages => {
    assert.match(messages[1].content, /## 对话摘要\nold/u);
    return { role: "assistant", content: "merged" };
  } }), true);

  const child = { sessionId: "session-edge", runId: "run-edge" };
  const base = { persona: { systemPrompt: "edge" }, prompt: "edge", capabilityContext: child, invocation: invocation() };
  await assert.rejects(() => runSubAgent({ ...base, llm: { chat: async () => null } }), /子 agent 返回为空/u);
  await assert.rejects(
    () => runSubAgent({
      ...base,
      invocation: invocation(NEVER_ABORT_SIGNAL, {
        executeTool: async () => { throw new ToolArgumentsError("工具参数不是合法 JSON"); },
      }),
      llm: { chat: async () => ({ role: "assistant", content: "", tool_calls: [{ id: "bad", type: "function", function: { name: "fixture", arguments: "{" } }] }) },
    }),
    error => error?.code === "TOOL_ARGUMENTS_INVALID" && /不是合法 JSON/u.test(error.message),
  );
  assert.equal(await runSubAgent({ ...base, llm: { chat: async () => ({ role: "assistant", content: "" }) } }), "(子 agent 无回复)");
  await assert.rejects(() => runSubAgent({ ...base, llm: { chat: async () => { throw "string failure"; } } }), /string failure/u);
  await assert.rejects(
    () => runSubAgent({ ...base, llm: { chat: async () => ({ role: "assistant", content: "", tool_calls: [{ id: "loop", type: "function", function: { name: "fixture", arguments: "{}" } }] }) } }),
    /达到最大循环次数/u,
  );
});

test("RT-04 playbook validates definitions and makes failure, callback, and cancellation states observable", async () => {
  const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
  assert.throws(() => playbook.validatePlaybookSource("edge", bytes([])), /格式无效/u);
  assert.throws(() => playbook.validatePlaybookSource("edge", bytes({ name: "other", description: "x", steps: [] })), /定义无效/u);
  assert.throws(() => playbook.validatePlaybookSource("edge", bytes({ name: "edge", description: "x", steps: [null] })), /步骤 1 无效/u);
  assert.throws(() => playbook.validatePlaybookSource("edge", bytes({ name: "edge", description: "x", steps: [{}] })), /步骤 1 无效/u);
  assert.throws(() => playbook.validatePlaybookSource("edge", bytes({ name: "edge", description: "x", steps: [{ message: "x", description: 1 }] })), /步骤 1 无效/u);
  assert.equal(playbook.validatePlaybookSource("edge", bytes({ name: "edge", description: "x", steps: [{ message: "x" }] })).steps[0].description, undefined);

  await writeFile(path.join(playbooksDir, "broken.json"), "{bad", "utf8");
  const realError = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await playbook.listPlaybooks()).some(entry => entry.name === "broken"), false);
  } finally {
    console.error = realError;
  }

  playbook.updateRun("missing-run", 1, "ignored");
  const partial = playbook.createRun("partial", 2, { sessionId: "partial-session", runId: "partial-run" });
  playbook.updateRun(partial.id, 1, "first");
  assert.equal(partial.status, "running");

  const child = { sessionId: "session-playbook-edge", runId: "run-playbook-edge" };
  const callbackEvents = [];
  const failed = await playbook.executePlaybook(
    "rt04-runtime",
    { chat: async () => { throw new Error("step failed"); } },
    { systemPrompt: "edge" },
    child,
    invocation(),
    (...args) => callbackEvents.push(args),
  );
  assert.equal(failed.status, "failed");
  assert.equal(callbackEvents.length, 1);
  assert.match(callbackEvents[0][3], /错误: step failed/u);

  const objectFailure = await playbook.executePlaybook(
    "rt04-runtime",
    { chat: async () => ({ role: "assistant", content: "", tool_calls: [{ id: "bad", type: "function", function: { name: "fixture", arguments: "[]" } }] }) },
    { systemPrompt: "edge" },
    child,
    invocation(NEVER_ABORT_SIGNAL, {
      executeTool: async () => { throw new ToolArgumentsError("工具参数必须是 JSON object"); },
    }),
  );
  assert.equal(objectFailure.status, "failed");
  assert.match(objectFailure.results[0], /JSON object/u);

  const controller = new AbortController();
  const reason = new RunCancellationError("RUN_CANCELLED", "playbook in-flight cancelled");
  const running = playbook.executePlaybook(
    "rt04-runtime",
    { chat: async () => { controller.abort(reason); throw reason; } },
    { systemPrompt: "edge" },
    child,
    invocation(controller.signal),
  );
  await assert.rejects(() => running, error => error === reason);
  assert(playbook.listActiveRuns(child).some(run => run.status === "aborted"));

  const executor = playbook.createPlaybookExecuteExec({ chat: async () => ({ role: "assistant", content: "" }) }, { systemPrompt: "edge" });
  await assert.rejects(() => executor({ name: "rt04-runtime" }), /缺少受控工具调用服务/u);
});

test("RT-04 web response branches remain bounded with the default invocation signal", async () => {
  globalThis.fetch = async () => new Response(`
    <div class="result"><a class="result__a" href="https://duck.test/?uddg=%E0%A4%A">&quot;Title&quot; &#39;one&#39;&nbsp;</a></div></div>
    <div class="result"><span>missing title</span></div></div>
  `, { status: 200 });
  const search = await webSearchExec({ query: "entities", max_results: 0 }, undefined, invocation());
  assert.match(search, /"Title" 'one'/u);
  assert.match(search, /🔗 https:\/\/duck\.test/u);

  globalThis.fetch = async () => { throw "primitive search failure"; };
  await assert.rejects(() => webSearchExec({ query: "primitive" }, undefined, invocation()), /primitive search failure/u);

  globalThis.fetch = async () => new Response("denied", { status: 418, statusText: "Teapot" });
  await assert.rejects(() => fetchUrlExec({ url: "https://local.test/status" }, undefined, invocation()), /HTTP 418 Teapot/u);

  const long = "x".repeat(8_100);
  globalThis.fetch = async () => new Response(JSON.stringify({ long }), { status: 200 });
  const longJson = await fetchUrlExec({ url: "https://local.test/long-json", format: "json" }, undefined, invocation());
  assert(longJson.length > long.length);
  assert.doesNotMatch(longJson, /已截断/u);
  globalThis.fetch = async () => new Response(long, { status: 200 });
  assert.equal(await fetchUrlExec({ url: "https://local.test/long-raw", format: "raw" }, undefined, invocation()), long);
  assert.equal(await fetchUrlExec({ url: "https://local.test/long-text" }, undefined, invocation()), long);

  globalThis.fetch = async () => { throw "primitive fetch failure"; };
  await assert.rejects(() => fetchUrlExec({ url: "https://local.test/primitive" }, undefined, invocation()), /primitive fetch failure/u);
});
