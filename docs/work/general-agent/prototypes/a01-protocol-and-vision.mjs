// Throwaway A01 experiment. Not a production MCP client, browser driver or model evaluator.
// Run: node --import tsx <this-file> <temporary SDK install directory>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const folder = path.resolve(process.argv[2]);
const sdk = suffix => import(pathToFileURL(path.join(folder, "node_modules/@modelcontextprotocol/sdk/dist/esm", suffix)));
const { McpServer } = await sdk("server/mcp.js");
const { z } = await import(pathToFileURL(path.join(folder, "node_modules/zod/index.js")));
function server() {
  const instance = new McpServer({ name: "a01-local-fixture", version: "1.0.0" });
  instance.registerTool("sum", { inputSchema: { values: z.array(z.number()) } }, async ({ values }) => {
    const sum = values.reduce((a, b) => a + b, 0);
    return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } };
  });
  return instance;
}
if (process.argv[3] === "server") {
  const { StdioServerTransport } = await sdk("server/stdio.js");
  await server().connect(new StdioServerTransport());
} else {
  const result = {};
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
  const { StreamableHTTPServerTransport } = await sdk("server/streamableHttp.js");
  async function roundTrip(transport) {
    const client = new Client({ name: "a01-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools[0].name, "sum");
      const output = await client.callTool({ name: "sum", arguments: { values: [3, 5, 13] } });
      assert.equal(output.structuredContent.sum, 21);
      return { discovered: tools.tools.map(tool => tool.name), output: output.structuredContent, protocolRoundTrip: true };
    } finally { await client.close(); }
  }
  result.stdio = await roundTrip(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(import.meta.url), folder, "server"], stderr: "pipe" }));
  const http = createServer(async (request, response) => {
    const instance = server();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void instance.close(); });
    try { await instance.connect(transport); await transport.handleRequest(request, response); }
    catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  try { result.http = await roundTrip(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`))); }
  finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }

  const userData = path.join(folder, "browser-user-data");
  await mkdir(userData, { recursive: true });
  Object.assign(process.env, { RAINYDAYS_USER_DATA_DIR: userData, RAINYDAYS_DATA_DIR: path.join(userData, "data"),
    RAINYDAYS_CONFIG_PATH: path.join(userData, "no-private-config.json") });
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");
  const { BrowserSessionManager } = await import(pathToFileURL(path.join(projectRoot, "src/browser.ts")));
  const { projectMessagesForProvider } = await import(pathToFileURL(path.join(projectRoot, "src/llm.ts")));
  const page = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<form id="form"><input id="entry" aria-label="Entry"><button>Submit</button></form><script>window.submits=0;form.onsubmit=e=>{e.preventDefault();submits++}</script>');
  });
  await new Promise(resolve => page.listen(0, "127.0.0.1", resolve));
  const browser = new BrowserSessionManager();
  try {
    await browser.open("a01", { url: `http://127.0.0.1:${page.address().port}`, backend: "cdp", headless: true });
    const snapshot = await browser.snapshot("a01", {});
    const ref = snapshot.match(/"Entry" \[ref=(e\d+)\]/u)?.[1];
    assert(ref, snapshot);
    await browser.fill("a01", ref, "RainyDays");
    await browser.evaluate("a01", "document.getElementById('entry').focus()");
    await browser.press("a01", "Enter");
    const submits = await browser.evaluate("a01", "window.submits");
    await browser.press("a01", "Tab");
    result.browser = { enterSubmitted: submits > 0, tabMovedFocus: await browser.evaluate("a01", "document.activeElement.id!=='entry'") };
    const shot = await browser.screenshot("a01");
    const bytes = await readFile(shot.path);
    const attachment = { id: "att_" + "a".repeat(32), kind: "image", name: "fixture.png", mime: "image/png", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") };
    const resolve = () => ({ attachment, bytes });
    const projected = projectMessagesForProvider("a01", [{ role: "user", content: "test", attachments: [attachment] }], resolve, "data-uri");
    assert.equal(projected[0].content[1].image_url.url, `data:image/png;base64,${bytes.toString("base64")}`);
    let toolImageError;
    try { projectMessagesForProvider("a01", [{ role: "tool", tool_call_id: "probe", content: "", attachments: [attachment] }], resolve, "data-uri"); }
    catch (error) { toolImageError = error.message; }
    result.vision = { screenshotBytes: bytes.length, userImageProjection: true, toolImageError, realModel: "not run" };
  } finally { await browser.close("a01"); await new Promise(resolve => page.close(resolve)); }
  await writeFile(path.join(folder, "protocol-and-vision.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
