import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-mcp-client-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json") });
const { initializeConfig } = await import("../../src/config.ts"); await initializeConfig();
const { McpConnection } = await import("../../src/mcp/client.ts");
const { issueResourceOwner, retireResourceOwner } = await import("../../src/resource-owner.ts");
const { parseMcpServers, mcpToolName } = await import("../../src/mcp/settings.ts");
const [server] = parseMcpServers([{ name: "fixture-local", enabled: true, transport: "stdio", command: process.execPath, args: [path.resolve("tests/fixtures/mcp-server.mjs")], url: "" }]);
const owner = () => issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] });
const signal = () => new AbortController().signal;
test.after(async () => { const { closeDb } = await import("../../src/db.ts"); closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-mcp-client-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test("A05 real SDK stdio initializes, lists every page and distinguishes server namespaces", async () => {
  const owned = owner(), connection = new McpConnection(server);
  try {
    await connection.open(fixture, owned, signal());
    const tools = await connection.listTools(signal()); assert.deepEqual(tools.map(tool => tool.name), ["echo", "fail", "hang"]);
    assert(connection.protocolVersion);
    assert.notEqual(mcpToolName("server-one", "echo"), mcpToolName("server-two", "echo"));
    assert.match(mcpToolName("server-one", "echo"), /^mcp__server-one__echo_/u);
    const result = await connection.call("echo", { text: "成功 中文" }, signal());
    assert.equal(result.status, "success"); assert.match(result.content, /成功 中文/u); assert(!result.content.includes("fixture stderr"));
    assert.equal((await connection.call("fail", {}, signal())).code, "MCP_TOOL_ERROR");
    assert.equal((await connection.call("echo", { action: "throw" }, signal())).code, "MCP_TOOL_ERROR");
  } finally { await retireResourceOwner(owned); }
});

test("A05 list changes invalidate the bound schema instead of using old arguments", async () => {
  const owned = owner(), connection = new McpConnection(server);
  try {
    await connection.open(fixture, owned, signal()); await connection.listTools(signal());
    await connection.call("echo", { action: "changed" }, signal());
    assert.equal((await connection.call("echo", {}, signal())).code, "MCP_SCHEMA_CHANGED");
    const updated = await connection.listTools(signal()); assert.deepEqual(updated[0].inputSchema.required, ["text"]);
  } finally { await retireResourceOwner(owned); }
});

test("A05 two real servers with the same tool name keep their results and namespaces separate", async () => {
  const firstOwner = owner(), secondOwner = owner();
  const first = new McpConnection(server), second = new McpConnection({ ...server, name: "other-local" });
  try {
    await Promise.all([first.open(fixture, firstOwner, signal()), second.open(fixture, secondOwner, signal())]);
    assert.deepEqual(await first.listTools(signal()), await second.listTools(signal()));
    const [a, b] = await Promise.all([first.call("echo", { text: "first-server" }, signal()), second.call("echo", { text: "second-server" }, signal())]);
    assert.equal(a.server, "fixture-local"); assert.equal(b.server, "other-local");
    assert.match(a.content, /first-server/u); assert.match(b.content, /second-server/u);
    assert.notEqual(mcpToolName(a.server, "echo"), mcpToolName(b.server, "echo"));
  } finally { await Promise.all([retireResourceOwner(firstOwner), retireResourceOwner(secondOwner)]); }
});

test("A05 crash and timeout return typed failures and cancellation cleans a live process tree", { timeout: 20000 }, async () => {
  for (const action of ["crash", "crash-tree", "timeout", "cancel"]) {
    const owned = owner(), connection = new McpConnection(server, action === "timeout" ? 700 : 5000);
    try {
      await connection.open(fixture, owned, signal());
      const controller = new AbortController(), pidFile = path.join(fixture, `${action}.json`);
      const resultPromise = connection.call(action === "crash" ? "echo" : "hang", action === "crash" ? { action } : { pidFile, action }, controller.signal);
      if (action === "cancel") {
        for (let n = 0; n < 100; n++) { if (await fs.stat(pidFile).catch(() => false)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        controller.abort();
      }
      assert.equal((await resultPromise).code, action.startsWith("crash") ? "MCP_CONNECTION_LOST" : action === "timeout" ? "MCP_TIMEOUT" : "MCP_CANCELLED");
      if (action !== "crash") for (const pid of JSON.parse(await fs.readFile(pidFile, "utf8"))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { await retireResourceOwner(owned); }
  }
});

test("A05 an abruptly exiting app leaves no MCP server or descendant behind", { timeout: 15000 }, async () => {
  const directory = path.join(fixture, "abrupt"), pidFile = path.join(directory, "pids.json"); await fs.mkdir(directory);
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/mcp-caller.mjs"), directory, server.args[0], pidFile], { windowsHide: true, stdio: "ignore" });
  try {
    for (let n = 0; n < 300; n++) { if (await fs.stat(pidFile).catch(() => false)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8"));
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    for (let n = 0; n < 100; n++) { if (pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
