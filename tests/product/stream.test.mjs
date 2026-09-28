import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { LLMClient } from "../../src/llm.ts";

async function withProvider(handler, run) {
  let requests = 0;
  const server = createServer((req, res) => { req.resume(); handler(res, ++requests); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const llm = new LLMClient({ apiKey: "local-fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture" });
  try { await run(llm, () => requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const chunk = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const finished = reason => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
const streamError = `data: ${JSON.stringify({ error: { message: "network connection reset during generation", type: "server_error" } })}\n\n`;
async function collect(llm, events = [], signal) {
  for await (const event of llm.chatStream([{ role: "user", content: "test" }], undefined, signal)) events.push(event);
  return events;
}

for (const [name, delta] of [
  ["文字", { content: "已经生成的正文" }],
  ["工具参数", { tool_calls: [{ index: 0, id: "half", type: "function", function: { name: "write", arguments: '{"path":' } }] }],
]) test(`${name}断流后不发第二次请求、不产生成功结果`, async () => {
  await withProvider((res, n) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(n === 1 ? chunk(delta) + streamError : chunk({ content: "第二次回答" }) + finished("stop"));
  }, async (llm, requests) => {
    const events = [];
    await assert.rejects(() => collect(llm, events), /流式请求失败/);
    assert.equal(requests(), 1);
    assert.equal(events.some(event => event.type === "result"), false);
    assert.deepEqual(events.filter(event => event.type === "delta").map(event => event.content), delta.content ? [delta.content] : []);
  });
});

test("建立流之前的暂时错误仍可重试，成功只返回一份回答", async () => {
  await withProvider((res, n) => {
    if (n === 1) { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":{"message":"busy"}}'); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(chunk({ content: "正常答案" }) + finished("stop"));
  }, async (llm, requests) => {
    const events = await collect(llm);
    assert.equal(requests(), 2);
    assert.deepEqual(events.map(event => event.type), ["delta", "result"]);
    assert.equal(events[1].message.content, "正常答案");
  });
});

for (const ending of ["", finished("length")]) test(`未完成的工具参数不能因连接关闭或长度限制而成功 (${ending ? "length" : "EOF"})`, async () => {
  await withProvider(res => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(chunk({ tool_calls: [{ index: 0, id: "half", type: "function", function: { name: "write", arguments: '{"path":' } }] }) + ending);
  }, async (llm, requests) => {
    const events = [];
    await assert.rejects(() => collect(llm, events), /未完整结束/);
    assert.equal(requests(), 1);
    assert.equal(events.some(event => event.type === "result"), false);
  });
});

test("正常工具流仅在完整结束后返回完整参数", async () => {
  await withProvider(res => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(chunk({ tool_calls: [{ index: 0, id: "complete", type: "function", function: { name: "read", arguments: '{"path":' } }] })
      + chunk({ tool_calls: [{ index: 0, function: { arguments: '"file.txt"}' } }] }) + finished("tool_calls"));
  }, async (llm, requests) => {
    const events = await collect(llm);
    assert.equal(requests(), 1);
    assert.equal(events.at(-1).message.tool_calls[0].function.arguments, '{"path":"file.txt"}');
  });
});
