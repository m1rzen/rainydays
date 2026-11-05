import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function startMcpHttpFixture({ token = "", sse = false, redirectTo = "", oauth = false } = {}) {
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  const state = { writes: 0, reads: 0, rejected: 0, calls: 0, registrations: 0, exchanges: 0, refreshes: 0, accessToken: "", rejectRefresh: false };
  let origin = "";
  const clients = new Map(), codes = new Map(), refreshTokens = new Map();
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["fixture:read"] }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] }));
  app.post("/register", (req, res) => { const client = { ...req.body, client_id: `fixture-client-${++state.registrations}` }; clients.set(client.client_id, client); res.status(201).json(client); });
  app.get("/authorize", (req, res) => {
    const client = clients.get(req.query.client_id);
    if (!client?.redirect_uris.includes(req.query.redirect_uri) || req.query.code_challenge_method !== "S256") { res.sendStatus(400); return; }
    const code = `obviously-fake-code-${randomUUID()}`; codes.set(code, { clientId: client.client_id, redirect: req.query.redirect_uri, challenge: req.query.code_challenge });
    const target = new URL(req.query.redirect_uri); target.searchParams.set("code", code); target.searchParams.set("state", req.query.state); res.redirect(302, target.href);
  });
  app.post("/token", (req, res) => {
    if (req.body.grant_type === "authorization_code") {
      const code = codes.get(req.body.code); codes.delete(req.body.code);
      if (!code || code.clientId !== req.body.client_id || code.redirect !== req.body.redirect_uri || code.challenge !== createHash("sha256").update(req.body.code_verifier || "").digest("base64url")) { res.status(400).json({ error: "invalid_grant" }); return; }
      state.exchanges++;
    } else if (req.body.grant_type === "refresh_token") {
      if (state.rejectRefresh || refreshTokens.get(req.body.refresh_token) !== req.body.client_id) { res.status(400).json({ error: "invalid_grant" }); return; }
      state.refreshes++;
    } else { res.status(400).json({ error: "unsupported_grant_type" }); return; }
    state.accessToken = `obviously-fake-access-${randomUUID()}`; const refresh = `obviously-fake-refresh-${randomUUID()}`; refreshTokens.set(refresh, req.body.client_id);
    res.json({ access_token: state.accessToken, token_type: "Bearer", expires_in: 60, refresh_token: refresh, scope: "fixture:read" });
  });
  const connections = new Set();
  app.post("/mcp", async (request, response) => {
    if (redirectTo) { response.redirect(307, redirectTo); return; }
    if ((token && request.headers.authorization !== `Bearer ${token}`) || (oauth && (!state.accessToken || request.headers.authorization !== `Bearer ${state.accessToken}`))) { state.rejected++; if (oauth) response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`); response.status(401).json({ error: "fixture token required" }); return; }
    const server = new Server({ name: "fixture-http", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !sse });
    connections.add(server);
    response.once("close", () => { void server.close(); connections.delete(server); });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "remote", description: "Fixture remote action", inputSchema: { type: "object", properties: { action: { type: "string" } } } }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async args => { state.reads++; return { contents: [{ uri: args.params.uri, mimeType: "text/plain", text: "按需资源 中文" }] }; });
    server.setRequestHandler(CallToolRequestSchema, async (args, extra) => {
      state.calls++;
      if (args.params.arguments?.action === "bad-image") return { content: [{ type: "image", mimeType: "image/svg+xml", data: "not-base64" }] };
      if (args.params.arguments?.action === "write-unauthorized") { state.writes++; response.status(401).json({ error: "fixture response lost behind unauthorized" }); return { content: [] }; }
      if (args.params.arguments?.action === "write-lost") { state.writes++; response.destroy(); await new Promise(resolve => extra.signal.addEventListener("abort", resolve, { once: true })); return { content: [] }; }
      if (args.params.arguments?.action === "hang") { await new Promise(resolve => extra.signal.addEventListener("abort", resolve, { once: true })); return { content: [] }; }
      if (args.params.arguments?.action === "fail") return { isError: true, content: [{ type: "text", text: "fixture remote error" }] };
      return { content: [{ type: "text", text: "远端MCP完成" }, { type: "resource_link", uri: "fixture://notes/one", name: "Fixture note", mimeType: "text/plain" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2kAAAAASUVORK5CYII=" }], structuredContent: { fixture: true, answer: 42 } };
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  app.get("/mcp", (_req, res) => res.sendStatus(405));
  app.delete("/mcp", (_req, res) => res.sendStatus(405));
  const http = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  origin = `http://127.0.0.1:${http.address().port}`;
  return { url: `${origin}/mcp`, state, async close() { await Promise.all([...connections].map(server => server.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } };
}
