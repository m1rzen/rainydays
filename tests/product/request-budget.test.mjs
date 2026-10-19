import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LLMClient } from "../../src/llm.ts";

async function fixture(run, handle = null) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (handle) { await handle(body, response, requests.length); return; }
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 117, completion_tokens: 2, total_tokens: 119 } })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = budget => new LLMClient({ apiKey: "fixture-only", model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1`, ...budget });
  try { await run(client, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("D03 final request rejects excess system and tool schemas before either transport sends", async () => {
  await fixture(async (make, requests) => {
    const client = make({ contextWindowTokens: 1024, outputReserveTokens: 128 });
    const messages = [{ role: "system", content: "必须完整计算的系统提示".repeat(250) }, { role: "user", content: "开始" }];
    const tools = [{ type: "function", function: { name: "fixture", description: "动态工具说明".repeat(250), parameters: { type: "object", properties: {} } } }];
    await assert.rejects(client.chat(messages, tools), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
    await assert.rejects(async () => { for await (const _event of client.chatStream(messages, tools)) { /* consume */ } }, error => error.code === "CONTEXT_BUDGET_EXCEEDED");
    assert.equal(requests.length, 0);
  });
});

test("D03 budget is configurable, reserves output and records estimation error from actual usage", async () => {
  await fixture(async (make, requests) => {
    const messages = [{ role: "user", content: "资料".repeat(800) }];
    await assert.rejects(make({ contextWindowTokens: 1024, outputReserveTokens: 128 }).chat(messages), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
    const client = make({ contextWindowTokens: 8192, outputReserveTokens: 256 });
    await client.chat(messages);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 256);
    const budget = client.getBudgetReport();
    assert.equal(budget.contextWindowTokens, 8192);
    assert.equal(budget.actualPromptTokens, 117);
    assert.equal(budget.estimationErrorTokens, budget.estimatedInputTokens - 117);
    assert(budget.estimatedInputTokens + 256 <= 8192);
  });
});

test("D03 dynamically discovered schemas are checked again on the next request", async () => {
  await fixture(async (make, requests) => {
    const client = make({ contextWindowTokens: 1024, outputReserveTokens: 128 });
    const messages = [{ role: "user", content: "开始" }];
    await client.chat(messages);
    const tools = [{ type: "function", function: { name: "discovered", description: "x".repeat(6000), parameters: { type: "object", properties: {} } } }];
    await assert.rejects(client.chat(messages, tools), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
    assert.equal(requests.length, 1);
    assert.throws(() => make({ contextWindowTokens: 1024, outputReserveTokens: 1024 }), /回复预留/);
  });
});

test("D03 concurrent sessions pair each request's estimate with its own usage", async () => {
  let releaseFirst, firstReceived;
  const received = new Promise(resolve => { firstReceived = resolve; });
  await fixture(async make => {
    const client = make({ contextWindowTokens: 8192, outputReserveTokens: 256 });
    const firstMessages = [{ role: "user", content: "a".repeat(1000) }];
    const first = client.chat(firstMessages);
    await received;
    await client.chat([{ role: "user", content: "b" }]);
    releaseFirst(); await first;
    const report = client.getBudgetReport();
    assert.equal(report.estimatedInputTokens, client.estimateRequest(firstMessages).estimatedInputTokens);
    assert.equal(report.actualPromptTokens, 400);
    assert.equal(report.estimationErrorTokens, report.estimatedInputTokens - 400);
  }, async (_body, response, index) => {
    if (index === 1) { const gate = new Promise(resolve => { releaseFirst = resolve; }); firstReceived(); await gate; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: index === 1 ? 400 : 100, completion_tokens: 2, total_tokens: index === 1 ? 402 : 102 } }));
  });
});
