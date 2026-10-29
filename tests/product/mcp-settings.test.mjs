import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-settings-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json") });
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(`fixture-protected:${value}`), unprotect: value => Buffer.from(value).toString().slice("fixture-protected:".length) });
const config = await import("../../src/config.ts");
const { defaultSettingsDomains, parseSettingsDomains } = await import("../../src/settings-schema.ts");
await config.initializeConfig();
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-settings-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const oldServer = { name: "fixture-local", enabled: false, transport: "stdio", command: "node", args: ["server.mjs"], url: "" };

test("A05 legacy settings keep an empty MCP list and upgrade old six-field server entries", () => {
  assert.deepEqual(config.getConfigSnapshot().domains.mcp.servers, []);
  const domains = defaultSettingsDomains(); domains.mcp.servers = [oldServer];
  const [server] = parseSettingsDomains(domains).mcp.servers;
  assert.equal(server.cwd, ""); assert.deepEqual(server.env, {}); assert.deepEqual(server.tools, []);
  assert.equal(server.enabled, false); assert.equal(server.command, "node");
});

test("A05 importing settings cannot add, replace or enable local MCP servers", async () => {
  const imported = config.exportSettings(); imported.domains.mcp.servers = [{ ...oldServer, enabled: true }];
  assert.deepEqual(config.prepareSettingsImport(imported).domains.mcp.servers, []);
  await config.updateSettingsDomain("mcp", { servers: [{ ...oldServer, cwd: fixture }] });
  const current = config.getConfigSnapshot().domains.mcp;
  const replacement = config.exportSettings(); replacement.domains.mcp.servers = [{ ...oldServer, name: "injected", enabled: true }];
  assert.deepEqual(config.prepareSettingsImport(replacement).domains.mcp, current);
  assert.equal(config.prepareSettingsImport(replacement).domains.shell.developerMode, false);
});

test("A05 environment secrets stay in the vault across form updates and exports", async () => {
  const server = { ...oldServer, env: { FIXTURE_SECRET: "" } };
  await config.updateSettingsDomain("mcp", { servers: [server], envValues: { [server.name]: { FIXTURE_SECRET: "obviously-fake-mcp-fixture-secret" } } });
  const reference = config.getConfigSnapshot().domains.mcp.servers[0].env.FIXTURE_SECRET;
  assert.match(reference, /^cred_/u);
  assert.equal(await credentials.readCredential(reference), "obviously-fake-mcp-fixture-secret");
  for (const view of [config.getPublicConfig(), config.exportSettings()]) {
    assert(!JSON.stringify(view).includes(reference));
    assert(!JSON.stringify(view).includes("obviously-fake-mcp-fixture-secret"));
  }
  await config.updateSettingsDomain("mcp", { servers: [server] });
  assert.equal(config.getConfigSnapshot().domains.mcp.servers[0].env.FIXTURE_SECRET, reference);
  await assert.rejects(config.updateSettingsDomain("mcp", { servers: [{ ...server, env: { FIXTURE_SECRET: "cred_00000000000000000000000000000000" } }] }), /秘密输入/u);
});

test("A05 changing launch settings invalidates the previously tested tool catalog", async () => {
  const [server] = config.getConfigSnapshot().domains.mcp.servers;
  server.tools = [{ name: "old-tool", description: "old schema", inputSchema: { type: "object", properties: {} } }]; server.protocolVersion = "fixture";
  await config.updateSettingsDomain("mcp", { servers: [server] });
  assert.equal(config.getConfigSnapshot().domains.mcp.servers[0].tools.length, 1);
  await config.updateSettingsDomain("mcp", { servers: [{ ...server, args: ["changed-server.mjs"] }] });
  const updated = config.getConfigSnapshot().domains.mcp.servers[0];
  assert.deepEqual(updated.tools, []); assert.equal(updated.protocolVersion, "");
});
