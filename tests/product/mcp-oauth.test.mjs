import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { startMcpHttpFixture } from "../fixtures/mcp-http-server.mjs";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-oauth-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json") });
const credentials = await import("../../src/credential-store.ts"); credentials.configureCredentialProtector({ protect: value => Buffer.from(`fake-vault:${value}`), unprotect: value => Buffer.from(value).toString().slice("fake-vault:".length) });
const config = await import("../../src/config.ts"); await config.initializeConfig();
const { createMcpOAuthProvider } = await import("../../src/mcp/oauth-provider.ts");
const { readMcpOAuthState, resetMcpOAuth } = await import("../../src/mcp/oauth-store.ts");
const { McpConnection } = await import("../../src/mcp/client.ts");
const { issueResourceOwner, retireResourceOwner } = await import("../../src/resource-owner.ts");
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-oauth-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
test("A06 SDK OAuth registers, uses PKCE, stores tokens privately, refreshes and rejects a removed login", async () => {
  const http = await startMcpHttpFixture({ oauth: true }); const owners = [];
  try {
    await config.updateSettingsDomain("mcp", { servers: [{ name: "fixture-oauth", enabled: true, transport: "http", command: "", args: [], url: http.url, auth: { mode: "oauth" } }] });
    const [server] = config.getConfigSnapshot().domains.mcp.servers; let redirect;
    const provider = await createMcpOAuthProvider(server, { redirectUrl: "http://127.0.0.1:37651/mcp/oauth/callback", state: "obviously-fake-ui-state", redirect: async url => { redirect = url; } });
    assert.equal(await auth(provider, { serverUrl: server.url, fetchFn: globalThis.fetch }), "REDIRECT"); assert(redirect);
    const response = await fetch(redirect, { redirect: "manual" }), callback = new URL(response.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "obviously-fake-ui-state");
    assert.equal(await auth(provider, { serverUrl: server.url, authorizationCode: callback.searchParams.get("code"), fetchFn: globalThis.fetch }), "AUTHORIZED");
    assert.equal(http.state.registrations, 1); assert.equal(http.state.exchanges, 1);
    const persisted = await readMcpOAuthState(server); assert(persisted.verifier); assert(persisted.tokens.refresh_token); assert.equal(persisted.tokens.issuer, new URL(server.url).origin);
    for (const view of [config.getPublicConfig(), config.exportSettings()]) { const text = JSON.stringify(view); assert(!text.includes(persisted.tokens.access_token)); assert(!text.includes(persisted.tokens.refresh_token)); assert(!text.includes(persisted.verifier)); }
    for (let round = 0; round < 2; round++) {
      if (round) http.state.accessToken = "expired-fixture-token";
      const owner = issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] }); owners.push(owner);
      const connection = new McpConnection(server); await connection.open(fixture, owner, new AbortController().signal, { fetch: globalThis.fetch });
      assert.equal((await connection.call("remote", {}, new AbortController().signal)).status, "success"); await retireResourceOwner(owner);
    }
    assert.equal(http.state.refreshes, 1);
    await resetMcpOAuth(server.name); await assert.rejects(provider.tokens(), /changed/u);
    assert.equal(config.getConfigSnapshot().domains.mcp.servers[0].auth.credentialRef, "");
  } finally { await Promise.all(owners.map(owner => retireResourceOwner(owner))); await http.close(); }
});
