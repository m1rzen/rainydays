import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  freePort,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

async function runSeed(fixture, mode) {
  const child = spawnManaged(process.execPath, ["tests/fixtures/ds08-notification-seed.mjs", fixture, mode], {
    cwd: projectRoot,
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DS-08 seed timed out\nstdout=${stdout}\nstderr=${stderr}`)), 30_000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(exitCode, 0, `DS-08 seed failed\nstdout=${stdout}\nstderr=${stderr}`);
  return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
}

async function startProvider() {
  const port = await freePort();
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "ds08", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "ds08", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function startProduct(fixture, providerBaseURL, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: { default: { model: "test-model", apiKey: "ds08-secret", baseURL: providerBaseURL, providerType: "openai-compatible" } },
    settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1",
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "",
      DEPARTMENT_DATA_ROOT: "",
      OUTPUT_DIR: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => (await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null))?.ok === true, {
    timeoutMs: 30_000,
    label: "DS-08 server",
  });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

let childRequestId = 0;
async function stopProduct(product) {
  if (!product) return;
  const requestId = `ds08-shutdown-${++childRequestId}`;
  const settled = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      product.child.off("message", onMessage);
      resolve(true);
    };
    product.child.on("message", onMessage);
  });
  product.child.send({ type: "rt01-shutdown", requestId });
  await settled;
  await terminateProcessTreeAsync(product.child);
}

async function api(product, token, route, options = {}) {
  const response = await fetch(`${product.base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  return { status: response.status, body };
}

test("DS-08 legacy event backfill remains atomically capped at 500 rows", async () => {
  const fixture = await makeTempDir("mini-lux-ds08-cap-");
  try {
    await fs.mkdir(path.join(fixture, "data"), { recursive: true });
    await runSeed(fixture, "seed");
    const result = await runSeed(fixture, "cap");
    assert.deepEqual(result, { schemaVersion: 11, capped: 500 });
  } finally {
    await removeFixture(fixture);
  }
});

test("DS-08 persists background notifications, streams state, and acknowledges navigation targets", async () => {
  const fixture = await makeTempDir("mini-lux-ds08-");
  const token = "ds08-api-token";
  let product;
  let provider;
  try {
    await fs.mkdir(path.join(fixture, "data"), { recursive: true });
    await runSeed(fixture, "seed");
    await runSeed(fixture, "backfill");
    provider = await startProvider();
    product = await startProduct(fixture, provider.baseURL, token);

    const initial = await api(product, token, "/desktop/state");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.schemaVersion, 1);
    assert.equal(initial.body.unread, 4);
    assert.equal(initial.body.notifications.length, 4);
    assert.equal(initial.body.sessions.find(session => session.id === "ds08-session-a").unread, 3);
    assert.equal(initial.body.firstUnreadSessionId, initial.body.notifications.find(notification => notification.unread).sessionId);

    const abort = new AbortController();
    const stream = await fetch(`${product.base}/desktop/events`, {
      headers: { "X-RainyDays-Token": token },
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    const streamReader = stream.body.getReader();
    const firstChunk = new TextDecoder().decode((await streamReader.read()).value);
    assert.match(firstChunk, /"type":"state"/u);
    await streamReader.cancel();
    abort.abort();

    const chat = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "X-RainyDays-Session": "ds08-session-a", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "ds08-session-a", message: "finish" }),
    });
    const chatBody = await chat.text();
    assert.equal(chat.status, 200, chatBody);
    await waitFor(async () => (await api(product, token, "/desktop/state")).body.notifications.some(notification => notification.title === "运行完成"), {
      timeoutMs: 10_000,
      label: "DS-08 run completion notification",
    });

    const completed = await api(product, token, "/desktop/state");
    assert.equal(completed.body.unread, 5);
    const completion = completed.body.notifications.find(notification => notification.title === "运行完成");
    assert.equal(completion.sessionId, "ds08-session-a");
    assert.equal(completion.targetTab, "session");

    const crossSessionRead = await api(product, token, "/desktop/sessions/ds08-session-b/read", {
      method: "POST", body: "{}", headers: { "X-RainyDays-Session": "ds08-session-a" },
    });
    assert.equal(crossSessionRead.status, 400);
    assert.match(crossSessionRead.body.error, /identity 冲突/u);

    const sessionRead = await api(product, token, "/desktop/sessions/ds08-session-a/read", {
      method: "POST", body: "{}", headers: { "X-RainyDays-Session": "ds08-session-a" },
    });
    assert.equal(sessionRead.status, 200);
    assert.equal(sessionRead.body.changed, 4);
    assert.equal(sessionRead.body.state.unread, 1);
    const idempotent = await api(product, token, "/desktop/sessions/ds08-session-a/read", {
      method: "POST", body: "{}", headers: { "X-RainyDays-Session": "ds08-session-a" },
    });
    assert.equal(idempotent.body.changed, 0);

    const remaining = sessionRead.body.state.notifications.find(notification => notification.unread);
    const singleRead = await api(product, token, `/desktop/notifications/${encodeURIComponent(remaining.id)}/read`, {
      method: "POST",
      headers: { "X-RainyDays-Session": remaining.sessionId },
      body: JSON.stringify({ sessionId: remaining.sessionId }),
    });
    assert.equal(singleRead.status, 200);
    assert.equal(singleRead.body.changed, true);
    assert.equal(singleRead.body.state.unread, 0);
  } finally {
    await stopProduct(product);
    await provider?.close();
    await removeFixture(fixture);
  }
});
