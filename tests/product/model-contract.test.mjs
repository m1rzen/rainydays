import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LLMClient } from "../../src/llm.ts";
import { probeProviderConnection } from "../../src/model-connection.ts";

const prompt = [{ role: "user", content: "公开测试输入" }];
const call = (id = "read-one", args = '{"path":"one.txt"}') => ({
  id, type: "function", function: { name: "read", arguments: args },
});
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

async function withProvider(handler, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const bytes = []; for await (const part of request) bytes.push(part);
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
    requests.push(body);
    await handler(body, response, requests.length);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new LLMClient({ apiKey: "local-fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture" });
  try { await run(client, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function stream(response, chunks) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n");
}

async function collect(client, events = [], signal) {
  for await (const event of client.chatStream(prompt, undefined, signal)) events.push(event);
  return events;
}

test("D02 非流式被长度截断的回答不能当作完成", async () => {
  await withProvider((_body, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "尚未写完" }, finish_reason: "length" }] }));
  }, async (client, requests) => {
    await assert.rejects(client.chat(prompt), /未完整结束/);
    assert.equal(requests.length, 1);
  });
});

test("D02 即使服务声明tool_calls完成，残缺JSON也不能发出成功结果", async () => {
  await withProvider((_body, response) => stream(response, [
    chunk({ tool_calls: [{ ...call("incomplete", '{"path":'), index: 0 }] }), chunk({}, "tool_calls"),
  ]), async (client, requests) => {
    const events = [];
    await assert.rejects(collect(client, events), /工具参数/);
    assert.equal(events.some(event => event.type === "result"), false);
    assert.equal(requests.length, 1);
  });
});

const usage = { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 };

test("D02 交错的并行工具参数保持配对，并读取空choices的最终usage", async () => {
  await withProvider((_body, response) => stream(response, [
    chunk({ tool_calls: [{ ...call("second", '{"path":'), index: 1 }, { ...call("first", '{"path":'), index: 0 }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"one.txt"}' } }, { index: 1, function: { arguments: '"two.txt"}' } }] }),
    chunk({}, "tool_calls"), { choices: [], usage },
  ]), async (client, requests) => {
    const events = await collect(client);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].message.tool_calls, [call("first"), call("second", '{"path":"two.txt"}')]);
    assert.deepEqual(events[0].usage, usage);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
  });
});

test("D02 非流式返回真实usage，下一次请求不包含宿主元数据", async () => {
  await withProvider((_body, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }], usage }));
  }, async (client, requests) => {
    const reply = await client.chat(prompt);
    assert.deepEqual(reply.usage, usage);
    await client.chat([...prompt, reply]);
    assert.deepEqual(requests[1].messages[1], { role: "assistant", content: "完成" });
  });
});

test("D02 缺失usage保留未知，不虚构零费用", async () => {
  await withProvider((_body, response) => stream(response, [chunk({ content: "完成" }), chunk({}, "stop")]), async client => {
    const events = await collect(client);
    assert.equal(events.at(-1).usage, undefined);
    assert.equal(events.at(-1).message.content, "完成");
  });
});

for (const [name, calls, reason, expected] of [
  ["无标识", [call("")], "tool_calls", /标识/],
  ["重复标识", [call(), call()], "tool_calls", /标识/],
  ["残缺参数", [call("half", '{"path":')], "tool_calls", /工具参数/],
  ["非对象参数", [call("array", "[]")], "tool_calls", /JSON对象/],
  ["stop与工具矛盾", [call()], "stop", /结束状态/],
  ["没有工具", [], "tool_calls", /结束状态/],
]) test(`D02 两种响应均拒绝${name}`, async () => {
  await withProvider((body, response) => {
    if (body.stream) stream(response, [chunk({ tool_calls: calls.map((value, index) => ({ ...value, index })) }), chunk({}, reason)]);
    else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: calls }, finish_reason: reason }] }));
    }
  }, async (client, requests) => {
    await assert.rejects(client.chat(prompt), expected);
    const events = [];
    await assert.rejects(collect(client, events), expected);
    assert.equal(events.some(event => event.type === "result"), false);
    assert.equal(requests.length, 2);
  });
});

test("D02 非流式完整并行工具及其结果可继续对话", async () => {
  await withProvider((_body, response, count) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: count === 1
      ? { role: "assistant", content: "", tool_calls: [call("first"), call("second", '{"path":"two.txt"}')] }
      : { role: "assistant", content: "已核对两个结果" }, finish_reason: count === 1 ? "tool_calls" : "stop" }], usage }));
  }, async (client, requests) => {
    const first = await client.chat(prompt);
    const second = await client.chat([...prompt, first, { role: "tool", tool_call_id: "first", content: "甲" }, { role: "tool", tool_call_id: "second", content: "乙" }]);
    assert.equal(second.content, "已核对两个结果");
    assert.deepEqual(requests[1].messages.slice(-2).map(message => message.tool_call_id), ["first", "second"]);
    assert.equal(requests[1].messages[1].usage, undefined);
  });
});

for (const [status, message, code] of [
  [401, "invalid key", "AUTHENTICATION"], [403, "monthly usage limit", "QUOTA"],
  [403, "denied", "PERMISSION"], [429, "busy", "RATE_LIMIT"], [503, "unavailable", "PROVIDER"],
]) test(`D02 设置检测真实HTTP ${status}/${code}一次返回可行动错误`, async () => {
  await withProvider((_body, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: `${message} SECRET_FIXTURE` } }));
  }, async (client, requests) => {
    const result = await probeProviderConnection(client);
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE/);
    assert.deepEqual(requests[0], { model: "fixture", messages: [{ role: "user", content: "Reply OK." }], max_tokens: 16 });
  });
});

for (const mode of ["stream", "chat"]) test(`D02 ${mode}等待模型时取消不重试`, { timeout: 5000 }, async () => {
  const received = Promise.withResolvers();
  await withProvider((_body, response) => {
    if (mode === "stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(chunk({ content: "" }))}\n\n`);
    }
    received.resolve(); // The provider deliberately never finishes this request.
  }, async (client, requests) => {
    const controller = new AbortController();
    const pending = mode === "stream" ? collect(client, [], controller.signal) : client.chat(prompt, undefined, controller.signal);
    await received.promise;
    const stopped = assert.rejects(pending, error => error?.code === "RUN_CANCELLED");
    controller.abort(new Error("用户停止"));
    await stopped;
    assert.equal(requests.length, 1);
  });
});

test("D02 已显示文字后取消不产出成功结果", async () => {
  await withProvider((_body, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk({ content: "可保留的正文" }))}\n\n`);
  }, async (client, requests) => {
    const controller = new AbortController();
    const events = [];
    await assert.rejects(async () => {
      for await (const event of client.chatStream(prompt, undefined, controller.signal)) {
        events.push(event);
        controller.abort(new Error("用户停止"));
      }
    }, error => error?.code === "RUN_CANCELLED");
    assert.deepEqual(events, [{ type: "delta", content: "可保留的正文" }]);
    assert.equal(requests.length, 1);
  });
});

test("D02 设置检测网络断开一次返回网络处理建议", async () => {
  await withProvider((_body, response) => response.destroy(), async (client, requests) => {
    const result = await probeProviderConnection(client);
    assert.equal(result.code, "NETWORK");
    assert.match(result.message, /检查网络和模型地址/);
    assert.equal(requests.length, 1);
  });
});
