import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { LLMClient } from "../../src/llm.ts";
import { getSessionThinkingEffort, setSessionThinkingEffort } from "../../src/request-budget.ts";
import { gcableModelCatalog, describeGcableModel, resolveGcableRequestModel } from "../../src/gcable-models.ts";

test("Gcable catalog preserves the pool's distinct switches and effort levels", () => {
  assert.deepEqual(gcableModelCatalog.map(p => [p.model, p.canDisableThinking, p.efforts]), [
    ["Gcable-Pro", true, ["low", "high", "max"]],
    ["Gcable-Plus", true, ["low", "medium", "xhigh"]],
    ["Gcable-Max", false, ["low", "high", "max"]],
  ]);
  for (const preset of gcableModelCatalog) {
    for (const effort of preset.efforts) {
      const model = preset.variants[effort];
      assert.deepEqual(describeGcableModel(model), { model: preset.model, thinking: true, effort });
      assert.equal(resolveGcableRequestModel(model), model);
    }
  }
  assert.deepEqual(describeGcableModel("Gcable-Pro"), { model: "Gcable-Pro", thinking: false, effort: "high" });
  assert.deepEqual(describeGcableModel("Gcable-Plus"), { model: "Gcable-Plus", thinking: false, effort: "medium" });
  assert.deepEqual(describeGcableModel("Gcable-Max"), { model: "Gcable-Max", thinking: true, effort: "low" });
  assert.equal(describeGcableModel("unknown"), undefined);
});

test("Gcable saved aliases reach chat, streaming and connection probes without conflicting generic effort", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const bytes = []; for await (const part of request) bytes.push(part);
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
    requests.push(body);
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = "gcable-request-effort";
    for (const preset of gcableModelCatalog) {
      for (const model of [preset.model, ...Object.values(preset.variants)]) {
        const client = new LLMClient({ model, baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" });
        const prompt = [{ role: "user", content: "OK" }];
        await client.chat(prompt);
        for await (const _event of client.chatStream(prompt)) { /* consume */ }
        await client.probe(AbortSignal.timeout(2000));
        assert(requests.slice(-3).every(r => r.model === model && !Object.hasOwn(r, "reasoning_effort")));
      }
    }
    setSessionThinkingEffort(session, "xhigh", "Gcable-Plus-Medium");
    const client = model => new LLMClient({ model, baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" });
    await client("Gcable-Plus-Medium").chat([{ role: "user", content: "OK" }], undefined, undefined, undefined, session);
    assert.equal(requests.at(-1).model, "Gcable-Plus-XHigh");
    for await (const _event of client("Gcable-Pro").chatStream([{ role: "user", content: "OK" }], undefined, undefined, session)) { /* consume */ }
    assert.equal(requests.at(-1).model, "Gcable-Pro");
    await client("Gcable-Max-High").chat([{ role: "user", content: "OK" }], undefined, undefined, undefined, session);
    assert.equal(requests.at(-1).model, "Gcable-Max-High", "a stale xhigh from Plus cannot break Max");
    setSessionThinkingEffort(session, "low", "Gcable-Pro-High");
    await client("Gcable-Pro-Max").chat([{ role: "user", content: "OK" }], undefined, undefined, undefined, session);
    assert.equal(requests.at(-1).model, "Gcable-Pro-Max", "saving a different model alias invalidates the old session override");
    assert(!requests.some(r => Object.hasOwn(r, "reasoning_effort")));
    assert.deepEqual(getSessionThinkingEffort(session, "Gcable-Plus-Medium").availableEfforts, ["low", "medium", "xhigh"]);
    assert.deepEqual(getSessionThinkingEffort(session, "Gcable-Pro").availableEfforts, []);
    assert.throws(() => setSessionThinkingEffort(session, "high", "Gcable-Plus-Medium"), /不支持/);
    assert.throws(() => setSessionThinkingEffort(session, "max", "Gcable-Pro"), /未开启/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("Gcable explicit efforts retain xhigh/max and never override a disabled switch", () => {
  assert.equal(resolveGcableRequestModel("Gcable-Pro-Thinking", "max"), "Gcable-Pro-Max");
  assert.equal(resolveGcableRequestModel("Gcable-Plus-Thinking", "xhigh"), "Gcable-Plus-XHigh");
  assert.equal(resolveGcableRequestModel("Gcable-Max", "max"), "Gcable-Max-Thinking-Max");
  assert.equal(resolveGcableRequestModel("Gcable-Pro", "max"), "Gcable-Pro");
  assert.throws(() => resolveGcableRequestModel("Gcable-Plus-Thinking", "high"), /不支持/);
  assert.throws(() => resolveGcableRequestModel("Gcable-Max", "medium"), /不支持/);
});
