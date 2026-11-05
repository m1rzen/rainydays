import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { startMcpHttpFixture } from "../fixtures/mcp-http-server.mjs";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-remote-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json") });
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(`fake-vault:${value}`), unprotect: value => Buffer.from(value).toString().slice("fake-vault:".length) });
const config = await import("../../src/config.ts"); await config.initializeConfig();
const { McpConnection } = await import("../../src/mcp/client.ts");
const { parseMcpServers } = await import("../../src/mcp/settings.ts");
const { issueResourceOwner, retireResourceOwner } = await import("../../src/resource-owner.ts");
const owner = () => issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] });
const signal = () => new AbortController().signal;
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-remote-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
test("A06 real Streamable HTTP supports JSON and SSE responses without eagerly reading resources", async () => {
  for (const sse of [false, true]) {
    const http = await startMcpHttpFixture({ sse }), owned = owner();
    try {
      const [server] = parseMcpServers([{ name: "fixture-http", enabled: true, transport: "http", command: "", args: [], url: http.url }]);
      const connection = new McpConnection(server);
      await connection.open(fixture, owned, signal(), { fetch: globalThis.fetch });
      assert.equal((await connection.listTools(signal()))[0].name, "remote");
      const result = await connection.call("remote", {}, signal()); assert.equal(result.status, "success"); assert.match(result.content, /远端MCP完成/u);
      const content = JSON.parse(result.content); assert.equal(content.structuredContent.answer, 42); assert(content.content.some(item => item.type === "image" && item.data.startsWith("iVBOR")));
      assert.equal(http.state.reads, 0);
      assert.equal(connection.hasResources, true);
      const resource = await connection.readResource("fixture://notes/one", signal());
      assert.equal(resource.status, "success"); assert.match(resource.content, /按需资源 中文/u); assert.equal(http.state.reads, 1);
    } finally { await retireResourceOwner(owned); await http.close(); }
  }
});
test("A06 a lost write response remains unknown and is never automatically replayed", async () => {
  const http = await startMcpHttpFixture({ sse: true }), owned = owner();
  try {
    const [server] = parseMcpServers([{ name: "fixture-fault", enabled: true, transport: "http", command: "", args: [], url: http.url }]);
    const connection = new McpConnection(server, 700); await connection.open(fixture, owned, signal(), { fetch: globalThis.fetch });
    const result = await connection.call("remote", { action: "write-lost" }, signal());
    assert.equal(result.status, "error"); assert.match(result.content, /未知/u); assert.equal(http.state.writes, 1); assert.equal(http.state.calls, 1);
  } finally { await retireResourceOwner(owned); await http.close(); }
});

test("A06 HTTP token is read from the vault and sent to the configured endpoint", async () => {
  const token = "obviously-fake-remote-token", reference = await credentials.storeCredential(token);
  const http = await startMcpHttpFixture({ token }), owned = owner();
  try {
    const [server] = parseMcpServers([{ name: "fixture-token", enabled: true, transport: "http", command: "", args: [], url: http.url, auth: { mode: "token", credentialRef: reference } }]);
    const connection = new McpConnection(server); await connection.open(fixture, owned, signal(), { fetch: globalThis.fetch });
    assert.equal((await connection.call("remote", {}, signal())).status, "success"); assert.equal(http.state.rejected, 0);
  } finally { await retireResourceOwner(owned); await http.close(); }
});

test("A06 scoped networking honors SDK manual redirects and never forwards a token to another origin", async () => {
  const { createScopedNetworkGateway } = await import("../../src/network-policy.ts");
  let received = 0;
  const sink = createServer((_req, response) => { received++; response.end("fixture sink"); });
  await new Promise(resolve => sink.listen(0, "127.0.0.1", resolve));
  const http = await startMcpHttpFixture({ redirectTo: `http://127.0.0.1:${sink.address().port}/sink` }), owned = owner();
  try {
    const gateway = createScopedNetworkGateway({ context: { networkPolicy: { mode: "unrestricted" } }, inspected: { policy: { riskClasses: ["network"], effects: ["network"] } }, signal: signal() });
    const reference = await credentials.storeCredential("obviously-fake-must-not-redirect-token");
    const [server] = parseMcpServers([{ name: "fixture-redirect", enabled: true, transport: "http", command: "", args: [], url: http.url, auth: { mode: "token", credentialRef: reference } }]);
    const connection = new McpConnection(server);
    await assert.rejects(connection.open(fixture, owned, signal(), { fetch: (url, init) => gateway.fetch(String(url), init) }));
    assert.equal(received, 0, "SDK must see the redirect response before a second request is issued");
  } finally { await retireResourceOwner(owned); await http.close(); await new Promise(resolve => sink.close(resolve)); }
});

test("A06 unauthorized after a tool side effect cannot trigger SDK authentication and replay", async () => {
  const http = await startMcpHttpFixture(), owned = owner(); let authActions = 0;
  const authProvider = { redirectUrl: "http://127.0.0.1/callback", clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] }, tokens: () => ({ access_token: "obviously-fake-oauth-access", token_type: "Bearer" }), clientInformation: () => ({ client_id: "fixture-client" }), redirectToAuthorization: () => { authActions++; throw new Error("must not request more authorization after a write"); }, saveCodeVerifier: () => { authActions++; }, codeVerifier: () => "fixture", saveTokens: () => { authActions++; } };
  try {
    const [server] = parseMcpServers([{ name: "fixture-write-auth", enabled: true, transport: "http", command: "", args: [], url: http.url }]);
    const connection = new McpConnection(server, 700); await connection.open(fixture, owned, signal(), { fetch: globalThis.fetch, authProvider });
    const result = await connection.call("remote", { action: "write-unauthorized" }, signal());
    assert.equal(result.code, "MCP_AUTH_REQUIRED"); assert.equal(http.state.writes, 1); assert.equal(http.state.calls, 1); assert.equal(authActions, 0); assert.match(result.content, /未知/u);
  } finally { await retireResourceOwner(owned); await http.close(); }
});
