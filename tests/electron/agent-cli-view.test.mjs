import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connectCdp, freeDistinctPorts, makeTempDir, projectRoot, removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor } from "../helpers.mjs";

function childRequest(child, input) {
  const requestId = `cli-view-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); child.off("message", receive); error ? reject(error) : resolve(value); };
    const receive = message => { if (message?.requestId === requestId) finish(message.ok ? null : new Error(message.error), message.value); };
    const timer = setTimeout(() => finish(new Error(`Test child timeout: ${input.type}`)), 10000);
    child.on("message", receive); child.send({ ...input, requestId }, error => { if (error) finish(error); });
  });
}

test("A03 real Electron renderer reads live Agent and retained manual terminal views without cross-session control", { timeout: 90_000 }, async () => {
  const fixture = await makeTempDir("rainydays-cli-view-"), workspace = path.join(fixture, "中文 项目"), token = "cli-view-fixture-token";
  await fs.mkdir(workspace);
  const [port, cdpPort] = await freeDistinctPorts(2), base = `http://127.0.0.1:${port}`;
  let release, blocked = false, stage = 0, terminalId, selected, lastTool = "";
  const chatAbort = new AbortController();
  const gate = new Promise(resolve => { release = resolve; });
  const api = async (route, method = "GET", body, sessionId = selected) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...(sessionId ? { "X-RainyDays-Session": sessionId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const call = (name, args) => [{ index: 0, id: `cli-${stage}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
  const model = createServer(async (request, response) => {
    try {
    const bytes = []; for await (const part of request) bytes.push(part);
    const body = JSON.parse(Buffer.concat(bytes).toString());
    lastTool = String(body.messages?.at(-1)?.content ?? "").slice(-1200);
    if (!body.stream) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "CLI view" }, finish_reason: "stop" }] })); return; }
    let calls;
    if (stage++ === 0) calls = call("search_tools", { keywords: "shell_start shell_input shell_output" });
    else if (stage === 2) calls = call("shell_start", { name: "助手实时输出", cwd: workspace });
    else if (stage === 3) { terminalId = /ID: (term_[a-f0-9-]+)/u.exec(body.messages.at(-1).content)?.[1]; assert(terminalId, `shell_start did not return a terminal: ${lastTool}`); calls = call("shell_input", { terminalId, input: "echo HTTP_CLI_LIVE>http-live.txt" }); }
    else if (stage === 4) { blocked = true; await gate; calls = call("shell_input", { terminalId, input: "exit 7" }); }
    else if (stage === 5) {
      await waitFor(async () => (await api("/terminals")).body.terminals.some(item => item.id === terminalId && item.status !== "running"), { timeoutMs: 5000 });
      calls = call("shell_output", { terminalId, offset: 0 });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = calls ? { tool_calls: calls } : { content: "终端已核对，实际退出7。" };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: `Fixture model stage ${stage}: ${error.message}` } })); }
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  await fs.writeFile(path.join(fixture, "config.json"), JSON.stringify({ defaultProfile: "default", profiles: { default: { model: "cli-view-fixture", apiKey: "fixture-only-key", baseURL: `http://127.0.0.1:${model.address().port}/v1`, providerType: "openai-compatible" } }, settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: "", departmentEnabled: false, outputDir: path.join(fixture, "output") } }));
  const daemon = spawnManaged(process.execPath, ["tests/fixtures/server-with-cli-approval.mjs"], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, PORT: String(port), RAINYDAYS_API_TOKEN: token, RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1", RAINYDAYS_APP_ROOT: projectRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills") } });
  let renderer, client, chat;
  let logs = ""; daemon.stdout.on("data", bytes => { logs += bytes; }); daemon.stderr.on("data", bytes => { logs += bytes; });
  try {
    await waitFor(async () => { if (daemon.exitCode !== null) throw new Error(`Test daemon exited ${daemon.exitCode}`); try { return (await api("/status")).status === 200; } catch { return false; } }, { timeoutMs: 30000 });
    selected = (await api("/sessions", "POST", { title: "CLI owner" })).body.session.id;
    assert.equal((await api(`/sessions/${selected}/select`, "POST", {})).status, 200);
    const challenge = await childRequest(daemon, { type: "rt01-manual-consent-prepare", operation: "terminal-start", request: { shell: "cmd" } });
    const manual = await childRequest(daemon, { type: "rt01-manual-consent-decide", challengeId: challenge.challengeId, decision: "approve", operation: challenge.operation, argumentsDigest: challenge.argumentsDigest });
    console.log("[A03 view] real manual terminal started");
    await waitFor(async () => (await api(`/terminals/${manual.terminal.id}/output?offset=0`)).body.data?.includes("Windows"), { timeoutMs: 5000 });
    // Record the actual unresolved native concurrency constraint, rather than
    // calling a retained output view proof of simultaneous live processes.
    const build = JSON.parse(await fs.readFile(path.join(projectRoot, "build-info.json"), "utf8"));
    const artifacts = build.versions.executionIsolation.artifacts;
    const host = artifacts.find(item => item.path.endsWith("sandbox-host.exe")), launcher = artifacts.find(item => item.path.endsWith("sandbox-launcher.node"));
    const addon = createRequire(import.meta.url)(path.join(projectRoot, "dist/native/sandbox-launcher.node"));
    assert.throws(() => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256), error => error.code === "EXEC_ACL_RECOVERY_REQUIRED");
    await childRequest(daemon, { type: "ds04-interactive-input", request: { id: manual.terminal.id, input: "exit 0\r", appendNewline: false } });
    await waitFor(async () => (await api("/terminals")).body.terminals.some(item => item.id === manual.terminal.id && item.status === "exited"), { timeoutMs: 5000 });
    chat = fetch(`${base}/api/chat`, { method: "POST", signal: chatAbort.signal, headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", "X-RainyDays-Session": selected }, body: JSON.stringify({ sessionId: selected, message: "运行终端检查" }) }).then(async response => { assert.equal(response.status, 200); return response.text(); });
    await waitFor(async () => blocked && (await fs.readFile(path.join(workspace, "http-live.txt"), "utf8").catch(() => "")).trim() === "HTTP_CLI_LIVE", { timeoutMs: 15000 });
    const listed = await api("/terminals"); assert.equal(listed.status, 200);
    console.log("[A03 view] live Agent and retained manual terminal views coexist");
    assert(listed.body.terminals.some(item => item.id === manual.terminal.id && item.readOnly === false));
    assert(listed.body.terminals.some(item => item.id === terminalId && item.readOnly === true));
    assert.equal((await api(`/terminals/${manual.terminal.id}/output`)).status, 200);
    const output = await api(`/terminals/${terminalId}/output?offset=0`); assert.equal(output.status, 200); assert.equal(output.body.info.readOnly, true); assert.match(output.body.data, /HTTP_CLI_LIVE/u);
    const other = (await api("/sessions", "POST", { title: "other owner" })).body.session.id;
    assert.equal((await api(`/terminals/${terminalId}/output`, "GET", undefined, other)).status, 404);
    assert.equal((await api(`/sessions/${selected}/select`, "POST", {})).status, 200);
    renderer = spawnManaged(path.join(projectRoot, "node_modules/electron/dist/electron.exe"), [path.join(projectRoot, "tests/fixtures/cli-view-electron.cjs"), `--remote-debugging-port=${cdpPort}`], { env: { ...process.env, RAINYDAYS_CLI_VIEW_URL: base, RAINYDAYS_CLI_VIEW_FIXTURE: fixture, RAINYDAYS_CLI_VIEW_TOKEN: token } });
    renderer.stdout.resume(); renderer.stderr.resume();
    client = await connectCdp(cdpPort);
    console.log("[A03 view] real Electron renderer connected");
    const expectedTitle = (await api("/sessions")).body.sessions.find(item => item.id === selected).title;
    await waitFor(async () => client.evaluate(`document.querySelector('.session-item.active[data-session-id="${selected}"]')!==null && document.getElementById('current-title').textContent===${JSON.stringify(expectedTitle)}`), { timeoutMs: 15000 });
    await client.evaluate(`window.__cliResizeCalls=[];window.electronAPI={terminalResize:request=>{window.__cliResizeCalls.push(request);return Promise.resolve({})}}`);
    await client.evaluate(`document.querySelector('[data-action="toggle-terminal"]').click()`);
    await waitFor(async () => client.evaluate(`document.getElementById('terminal-tab-${terminalId}')!==null`), { timeoutMs: 10000 });
    await client.evaluate(`document.getElementById('terminal-tab-${terminalId}').click()`);
    await waitFor(async () => client.evaluate(`['clear-terminal','kill-terminal','close-terminal'].every(action=>document.querySelector('[data-action="'+action+'"]').disabled)`), { timeoutMs: 5000 });
    assert.match(await client.evaluate(`document.getElementById('terminal-tab-${terminalId}').textContent`), /助手/u);
    await client.evaluate(`window.__cliResizeCalls.length=0`);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1131, height: 850, deviceScaleFactor: 1, mobile: false });
    await client.evaluate(`window.dispatchEvent(new Event('resize'));new Promise(resolve=>setTimeout(resolve,250))`);
    assert.equal(await client.evaluate(`window.__cliResizeCalls.length`), 0, "read-only terminal sent an implicit native resize request");
    await client.evaluate(`document.getElementById('terminal-tab-${manual.terminal.id}').click()`);
    await waitFor(async () => client.evaluate(`!document.querySelector('[data-action="kill-terminal"]').disabled`), { timeoutMs: 5000 });
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1040, height: 850, deviceScaleFactor: 1, mobile: false });
    await client.evaluate(`window.dispatchEvent(new Event('resize'))`);
    await waitFor(async () => client.evaluate(`window.__cliResizeCalls.some(request=>request.id==='${manual.terminal.id}')`), { timeoutMs: 5000 });
    release();
    assert.match(await chat, /退出码: 7/u);
    assert.equal((await api(`/terminals/${terminalId}/output`)).status, 404);
    assert.equal((await api(`/terminals/${manual.terminal.id}/output`)).status, 200);
  } catch (error) {
    const snapshot = terminalId ? await api(`/terminals/${terminalId}/output?offset=0`).catch(() => null) : null;
    throw new Error(`${error.message}\nFixture stage=${stage}; lastTool=${lastTool}\nterminal=${JSON.stringify(snapshot)}\n${logs.slice(-1500)}`, { cause: error });
  }
  finally {
    release(); chatAbort.abort(); if (chat) await chat.catch(() => undefined);
    if (client) { await client.send("Browser.close").catch(() => undefined); client.close(); }
    if (renderer) await terminateProcessTreeAsync(renderer);
    await childRequest(daemon, { type: "rt01-shutdown" }).catch(() => undefined); await terminateProcessTreeAsync(daemon);
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await removeFixture(fixture);
  }
});
