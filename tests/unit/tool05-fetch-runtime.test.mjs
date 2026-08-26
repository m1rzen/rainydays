import assert from "node:assert/strict";
import test from "node:test";
import {
  FETCH_MAX_RESPONSE_BYTES,
  duckDuckGoSearchProvider,
  parseDuckDuckGoResults,
  parseFetchMaxLength,
  parseFetchTimeout,
  parseSearchMaxResults,
  readBoundedResponse,
  renderFetchedContent,
} from "../../dist/fetch-runtime.js";
import { fetchMarkdownDef, fetchMarkdownExec } from "../../dist/tools/web.js";
import { createWebSearchExecutor, webSearchDef } from "../../dist/tools/search-tool.js";
import { getToolTimeoutMs } from "../../dist/tool-protocol.js";

const neverAborted = new AbortController().signal;

function invocation(fetcher, signal = neverAborted) {
  return { signal, network: { fetch: fetcher } };
}

test("TOOL-05 fetch_markdown schema matches the Lux contract and bounds resource controls", () => {
  const properties = fetchMarkdownDef.function.parameters.properties;
  assert.equal(fetchMarkdownDef.function.name, "fetch_markdown");
  assert.deepEqual(fetchMarkdownDef.function.parameters.required, ["url"]);
  assert.deepEqual(Object.keys(properties).sort(), ["max_length", "raw", "timeout", "url"]);
  assert.equal(properties.max_length.maximum, 200_000);
  assert.equal(properties.timeout.maximum, 120_000);
  assert(getToolTimeoutMs("fetch_markdown") > properties.timeout.maximum);
  assert.equal(webSearchDef.function.parameters.properties.max_results.maximum, 20);
  assert.equal(parseFetchMaxLength(undefined), 20_000);
  assert.equal(parseFetchTimeout(undefined), 30_000);
  assert.equal(parseSearchMaxResults(undefined), 5);
  assert.throws(() => parseFetchMaxLength(0), /max_length/u);
  assert.throws(() => parseFetchTimeout(99), /timeout/u);
  assert.throws(() => parseSearchMaxResults(21), /max_results/u);
});

test("TOOL-05 Readability extracts article content into source-traceable Markdown without active content", () => {
  const html = `<!doctype html><html><head><title>Fallback title</title></head><body>
    <nav>Navigation poison</nav><main><article><h1>Useful story</h1>
    <p>This is a sufficiently substantial article paragraph with <strong>important</strong> facts and
    <a href="/source">a cited source</a> for readers who need the complete context.
    <a href="https://safe.example/a) [spoof](https://evil.example/">hostile destination</a></p>
    <script>globalThis.pwned = true</script></article></main><footer>Footer poison</footer>
  </body></html>`;
  const output = renderFetchedContent({
    bytes: Buffer.from(html), contentType: "text/html; charset=utf-8",
    finalUrl: "https://example.com/articles/one", raw: false, maxLength: 20_000,
  });
  assert.match(output, /^# Fallback title/mu);
  assert.match(output, /^## Useful story/mu);
  assert.match(output, /Source: https:\/\/example\.com\/articles\/one/u);
  assert.match(output, /\[a cited source\]\(https:\/\/example\.com\/source\)/u);
  assert.doesNotMatch(output, /Navigation poison|Footer poison|globalThis\.pwned/u);
  assert.match(output, /safe\.example\/a%29%20/u);
  assert.doesNotMatch(output, /\]\(https:\/\/evil\.example/u);
});

test("TOOL-05 raw and non-HTML responses remain exact text with explicit truncation", () => {
  const json = "{\"ok\":true,\"value\":42}";
  assert.equal(renderFetchedContent({
    bytes: Buffer.from(json), contentType: "application/json", finalUrl: "https://api.example/data",
    raw: false, maxLength: 100,
  }), json);
  assert.equal(renderFetchedContent({
    bytes: Buffer.from("<b>raw</b>"), contentType: "text/html", finalUrl: "https://example.com/",
    raw: true, maxLength: 100,
  }), "<b>raw</b>");
  const truncated = renderFetchedContent({
    bytes: Buffer.from("x".repeat(100)), contentType: "text/plain", finalUrl: "https://example.com/",
    raw: false, maxLength: 40,
  });
  assert.equal(truncated.length, 40);
  assert.match(truncated, /\[Content truncated\]$/u);
  assert.throws(() => renderFetchedContent({
    bytes: Buffer.from([0, 1, 2]), contentType: "application/octet-stream", finalUrl: "https://example.com/a.bin",
    raw: true, maxLength: 100,
  }), /Unsupported content type/u);
});

test("TOOL-05 response reader cancels declared, streamed, and aborted bodies", async () => {
  let declaredCancelled = false;
  const declaredBody = new ReadableStream({ cancel() { declaredCancelled = true; } });
  await assert.rejects(
    () => readBoundedResponse(new Response(declaredBody, { headers: { "content-length": String(FETCH_MAX_RESPONSE_BYTES + 1) } }), neverAborted),
    /exceeds/u,
  );
  assert.equal(declaredCancelled, true);

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(FETCH_MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(() => readBoundedResponse(new Response(body), neverAborted), /exceeds/u);

  let abortCancelled = false;
  const pending = new ReadableStream({ cancel() { abortCancelled = true; } });
  const controller = new AbortController();
  const reading = readBoundedResponse(new Response(pending), controller.signal);
  controller.abort(new Error("fixture abort"));
  await assert.rejects(() => reading, /fixture abort/u);
  assert.equal(abortCancelled, true);
});

test("TOOL-05 DuckDuckGo adapter parses DOM variants and preserves direct source URLs", async () => {
  const html = `<html><body>
    <div class="result results_links"><h2><a data-x="1" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fa%3D1">Example &amp; Docs</a></h2>
      <div><a class="result__snippet">A <b>useful</b> result.</a></div></div>
    <div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div>
  </body></html>`;
  assert.deepEqual(parseDuckDuckGoResults(html, 5), [{
    title: "Example & Docs", snippet: "A useful result.", url: "https://example.com/doc?a=1",
  }]);
  const calls = [];
  const results = await duckDuckGoSearchProvider.search("safe query", 5, async (url, init) => {
    calls.push({ url, init });
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  }, neverAborted);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /q=safe%20query/u);
  assert.equal(results[0].url, "https://example.com/doc?a=1");

  let rejectedCancelled = false;
  const rejectedBody = new ReadableStream({ cancel() { rejectedCancelled = true; } });
  await assert.rejects(() => duckDuckGoSearchProvider.search("denied", 5, async () =>
    new Response(rejectedBody, { status: 503 }), neverAborted), /HTTP 503/u);
  assert.equal(rejectedCancelled, true);
});

test("TOOL-05 executors honor status, max_length and provider source formatting", async () => {
  const html = `<article><h1>Title</h1><p>${"content ".repeat(80)}</p></article>`;
  const fetched = await fetchMarkdownExec({ url: "https://example.com/a", max_length: 120 }, {}, invocation(async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })));
  assert.equal(fetched.length, 120);
  assert.match(fetched, /\[Content truncated\]$/u);
  await assert.rejects(() => fetchMarkdownExec({ url: "https://example.com/private" }, {}, invocation(async () =>
    new Response("login required", { status: 401, statusText: "Unauthorized" }))), /HTTP 401 Unauthorized/u);

  const provider = {
    id: "fixture-provider",
    async search() { return [{ title: "Result", snippet: "Summary", url: "https://source.example/item" }]; },
  };
  const output = await createWebSearchExecutor(provider)({ query: "topic" }, {}, invocation(async () => new Response("unused")));
  assert.match(output, /Provider: fixture-provider/u);
  assert.match(output, /Source: https:\/\/source\.example\/item/u);
});
