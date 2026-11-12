// Model stream closed early: the same model turn is re-requested only while it has no side effects.
// Synthetic local provider through the real OpenAI SDK; no real model is called.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-stream-retry-"));
await mkdir(path.join(fixture, "data"));
await mkdir(path.join(fixture, "playbooks"));
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const { LLMClient } = await import("../../src/llm.ts");
const { ConversationMemory } = await import("../../src/memory.ts");
const { closeDb } = await import("../../src/db.ts");
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-stream-retry-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const text = content => sse({ choices: [{ delta: { content } }] });
const toolDelta = (id, name, args) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), arguments: args } }] } }] });
const finish = reason => sse({ choices: [{ delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";
/** Sends part of a reply, then drops the connection (the SDK reports "Premature close"). */
const breaks = body => res => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(body); setTimeout(() => res.destroy(), 20); };
/** Sends part of a reply and ends cleanly without a finish_reason. */
const endsEarly = body => res => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(body); };
const completes = (body, reason) => res => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(body + finish(reason)); };

async function withProvider(script, run) {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", part => { raw += part; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (!body.stream) {
        // Session titles use a separate non-streaming request; it is not part of the turn under test.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "t", object: "chat.completion", created: 0, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "标题" }, finish_reason: "stop" }] }));
        return;
      }
      bodies.push(body);
      (script[bodies.length - 1] ?? script.at(-1))(res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const llm = new LLMClient({ apiKey: "local-fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture" });
  try { await run(llm, bodies); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function collect(llm, events = [], signal) {
  for await (const event of llm.chatStream([{ role: "user", content: "test" }], undefined, signal)) events.push(event);
  return events;
}

// ---- LLM layer -------------------------------------------------------------

for (const [name, drop] of [["连接断开", breaks], ["无结束状态", endsEarly]]) {
  test(`(a) 只有文字时${name}：丢弃本轮输出并重新请求同一轮`, async () => {
    await withProvider([drop(text("半截")), completes(text("完整回答"), "stop")], async (llm, bodies) => {
      const events = await collect(llm);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[1], bodies[0], "retry re-requests exactly the same turn");
      assert.deepEqual(events.map(event => event.type), ["delta", "retry", "delta", "result"]);
      assert.equal(events[1].attempt, 1);
      assert.equal(events[1].maxRetries, 2);
      assert.equal(events.at(-1).message.content, "完整回答");
    });
  });
}

test("(b) 工具调用已送出但未执行时断开：不产生部分工具，重试后得到完整调用", async () => {
  await withProvider([
    breaks(toolDelta("call-1", "write", '{"file_path":')),
    completes(toolDelta("call-2", "write", '{"file_path":"a.txt",') + toolDelta(null, null, '"content":"x"}'), "tool_calls"),
  ], async (llm, bodies) => {
    const events = await collect(llm);
    assert.equal(bodies.length, 2);
    assert.deepEqual(events.map(event => event.type), ["retry", "result"]);
    assert.deepEqual(events.at(-1).message.tool_calls.map(call => [call.id, call.function.arguments]), [["call-2", '{"file_path":"a.txt","content":"x"}']]);
  });
});

test("流式中断最多自动重试 2 次，之后以中断结束且不返回结果", async () => {
  await withProvider([breaks(text("一")), breaks(text("二")), breaks(text("三")), completes(text("不应请求"), "stop")], async (llm, bodies) => {
    const events = [];
    await assert.rejects(() => collect(llm, events), error => {
      assert.equal(error.code, "MODEL_STREAM_INTERRUPTED");
      assert.equal(error.retries, 2);
      assert.match(error.message, /已自动重试 2 次/u);
      return true;
    });
    assert.equal(bodies.length, 3);
    assert.equal(events.filter(event => event.type === "retry").length, 2);
    assert.equal(events.some(event => event.type === "result"), false);
  });
});

test("长度截断等确定性结束不重试", async () => {
  await withProvider([completes(text("太长"), "length"), completes(text("不应请求"), "stop")], async (llm, bodies) => {
    await assert.rejects(() => collect(llm), /未完整结束 \(length\)/u);
    assert.equal(bodies.length, 1);
  });
});

test("重试等待期间停止：按取消结束，不再请求", async () => {
  await withProvider([breaks(text("半截")), completes(text("不应请求"), "stop")], async (llm, bodies) => {
    const controller = new AbortController();
    const events = [];
    const { isRunCancellation } = await import("../../src/run-cancellation.ts");
    await assert.rejects(async () => {
      for await (const event of llm.chatStream([{ role: "user", content: "test" }], undefined, controller.signal)) {
        events.push(event);
        if (event.type === "retry") controller.abort(new Error("user stop"));
      }
    }, error => isRunCancellation(error));
    assert.equal(bodies.length, 1);
  });
});

// ---- Agent layer -----------------------------------------------------------

async function agentFixture(name, script) {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, audit] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/security-audit.ts"),
  ]);
  const output = path.join(fixture, name); await mkdir(output);
  const persona = createEffectivePersona({ name, displayName: "Fixture", description: "Fixture", permissionLevel: "coding", tools: ["write"], env: { OUTPUT_DIR: output }, allowedRoots: [output], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { OUTPUT_DIR: "output" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "output", role: "output", configuredPath: output, permissions: ["create-file", "replace-file"] }]) });
  const key = Buffer.alloc(32, 9);
  const auditEvents = [];
  const journal = {
    commit: value => audit.createSecurityAuditCommitment(key, value),
    append: async input => { const event = audit.appendSecurityAuditEvent(auditEvents, input, key); auditEvents.push(event); return event; },
  };
  const session = createSession(persona, "Fixture");
  return { Agent, persona, authority, journal, session, output, capabilityBroker, verifyAudit: () => audit.verifySecurityAuditChain(auditEvents, key), auditEvents };
}
async function runAgent(fx, llm, memory, prompt, runId) {
  const interaction = await import("../../src/tools/ask-user-tool.ts");
  const agent = new fx.Agent(llm, memory, fx.persona, fx.authority, fx.journal);
  agent.setSession(fx.session.id);
  const events = [];
  await interaction.runWithInteractionChannel({ sessionId: fx.session.id, runId }, { emit(event) {
    if (event.type !== "ask_user") return;
    const allow = event.options.find(option => /允许/u.test(option)) ?? event.options[0];
    assert(interaction.submitAnswer(fx.session.id, runId, event.questionId, allow));
  } }, async () => { for await (const event of agent.run(prompt, runId)) events.push(event); });
  return events;
}

test("(a) Agent：撤回已显示的半截文字，界面与记录只留一份完整回答", async () => {
  const fx = await agentFixture("retry-text", []);
  try {
    await withProvider([breaks(text("半截")), completes(text("完整回答"), "stop")], async (llm, bodies) => {
      const memory = new ConversationMemory();
      const events = await runAgent(fx, llm, memory, "你好", "retry-text-run");
      assert.equal(bodies.length, 2);
      assert.deepEqual(events.map(event => event.type), ["answer_chunk", "answer_retry", "answer_chunk", "answer_done"]);
      const retry = events[1];
      assert.equal(retry.retractChars, "半截".length);
      assert.equal(retry.retryAttempt, 1);
      assert.match(retry.content, /重新请求/u);
      // Replaying the visible stream the way the renderer does leaves only the complete answer.
      let shown = "";
      for (const event of events) {
        if (event.type === "answer_chunk") shown += event.content;
        if (event.type === "answer_retry") shown = shown.slice(0, shown.length - event.retractChars);
      }
      assert.equal(shown, "完整回答");
      assert.equal(events.some(event => event.type === "error"), false);
      const restored = new ConversationMemory();
      restored.loadFromDb(fx.session.id);
      const assistant = restored.getAll().filter(message => message.role === "assistant").map(message => message.content);
      assert.deepEqual(assistant, ["完整回答"]);
    });
  } finally { await fx.capabilityBroker.retireAuthority(fx.authority); }
});

test("(b) Agent：工具调用未执行时断开，重试后只执行一次写入，审计链有效", async () => {
  const fx = await agentFixture("retry-tool", []);
  try {
    const args = JSON.stringify({ file_path: "结果.txt", content: "写入一次" });
    await withProvider([
      breaks(text("我来写文件。") + toolDelta("w-1", "write", args.slice(0, 12))),
      completes(text("我来写文件。") + toolDelta("w-2", "write", args), "tool_calls"),
      completes(text("已写好"), "stop"),
    ], async (llm, bodies) => {
      const memory = new ConversationMemory();
      const events = await runAgent(fx, llm, memory, "写文件", "retry-tool-run");
      assert.equal(bodies.length, 3);
      assert.deepEqual(bodies[1].messages, bodies[0].messages, "the broken turn left nothing in the request");
      assert.deepEqual(events.filter(event => event.type === "tool_call").map(event => event.toolCallId), ["w-2"]);
      assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success"]);
      assert.equal(await readFile(path.join(fx.output, "结果.txt"), "utf8"), "写入一次");
      assert.equal(events.some(event => event.type === "error"), false);
      const toolCallIds = memory.getAll().flatMap(message => message.tool_calls ?? []).map(call => call.id);
      assert.deepEqual(toolCallIds, ["w-2"]);
      assert.deepEqual(memory.getAll().filter(message => message.role === "assistant").map(message => message.content), ["我来写文件。", "已写好"]);
      const audit = fx.verifyAudit();
      assert(audit.eventCount >= 4);
      assert.deepEqual([...new Set(fx.auditEvents.map(event => event.correlation.toolCallId))], ["w-2"]);
    });
  } finally { await fx.capabilityBroker.retireAuthority(fx.authority); }
});

test("(c) Agent：工具已执行后模型连接持续中断，不重做写入，以中断结束并列出已完成步骤与文件", async () => {
  const fx = await agentFixture("retry-after-write", []);
  try {
    const args = JSON.stringify({ file_path: "第一份.txt", content: "第一份内容" });
    await withProvider([
      completes(toolDelta("w-1", "write", args), "tool_calls"),
      breaks(text("接下来写第二份")), breaks(text("接下来")), breaks(text("接")),
      completes(toolDelta("w-2", "write", JSON.stringify({ file_path: "第二份.txt", content: "不应写入" })), "tool_calls"),
    ], async (llm, bodies) => {
      const memory = new ConversationMemory();
      const events = await runAgent(fx, llm, memory, "写两份文件", "retry-after-write-run");
      assert.equal(bodies.length, 4, "1 turn with the write + the next turn tried 3 times; no further request");
      assert.deepEqual(bodies[2].messages, bodies[1].messages);
      assert.deepEqual(bodies[3].messages, bodies[1].messages);
      assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolCallId), ["w-1"], "the completed write is not replayed");
      assert.equal(await readFile(path.join(fx.output, "第一份.txt"), "utf8"), "第一份内容");
      await assert.rejects(() => readFile(path.join(fx.output, "第二份.txt")), { code: "ENOENT" });
      assert.equal(events.filter(event => event.type === "answer_retry").length, 2);
      const error = events.at(-1);
      assert.equal(error.type, "error");
      assert.equal(error.interrupted, true);
      assert.match(error.content, /已中断/u);
      assert.match(error.content, /已自动重试 2 次/u);
      assert.match(error.content, /write/u);
      assert.match(error.content, /第一份\.txt/u);
      assert.match(error.content, /不会自动重放/u);
      // The interruption note survives a reopen; the discarded partial text does not.
      const restored = new ConversationMemory();
      restored.loadFromDb(fx.session.id);
      const last = restored.getAll().at(-1);
      assert.equal(last.role, "assistant");
      assert.equal(last.tool_calls, undefined);
      assert.match(last.content, /第一份\.txt/u);
      assert.doesNotMatch(last.content, /接下来写第二份/u);
      fx.verifyAudit();
      assert.deepEqual([...new Set(fx.auditEvents.map(event => event.correlation.toolCallId))], ["w-1"]);

      // Continuing is the user's call; the next run starts from the recorded results without replaying the write.
      const next = await withProvider([completes(text("两份都已处理"), "stop")], async (resumed, resumedBodies) => {
        const events = await runAgent(fx, resumed, restored, "继续", "retry-after-write-continue");
        assert.equal(resumedBodies.length, 1);
        assert(resumedBodies[0].messages.some(message => message.role === "tool" && message.tool_call_id === "w-1"));
        return events;
      });
      void next;
      fx.verifyAudit();
    });
  } finally { await fx.capabilityBroker.retireAuthority(fx.authority); }
});

test("D02 a gateway's 503 model_not_found is not retried, streamed or not", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "model_not_found", message: "分组 svip 下模型 no-such 无可用渠道", type: "new_api_error" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const llm = new LLMClient({ apiKey: "fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "no-such", providerType: "openai-compatible" });
    await assert.rejects(llm.chat([{ role: "user", content: "hi" }]), /model_not_found|模型不可用/u);
    assert.equal(requests, 1, "non-streamed request is sent once");
    requests = 0;
    await assert.rejects(async () => { for await (const event of llm.chatStream([{ role: "user", content: "hi" }])) void event; }, /model_not_found|模型不可用/u);
    assert.equal(requests, 1, "streamed request is sent once");
  } finally { server.close(); }
});
