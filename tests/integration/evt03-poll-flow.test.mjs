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

function sseChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-evt03",
    object: "chat.completion.chunk",
    created: 1,
    model: "evt03-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function finishText(response, content) {
  response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
  response.write(sseChunk({ role: "assistant", content }));
  response.write(sseChunk({}, "stop"));
  response.end("data: [DONE]\n\n");
}

function finishTool(response, id, name, args) {
  response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
  response.write(sseChunk({
    role: "assistant",
    tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }));
  response.write(sseChunk({}, "tool_calls"));
  response.end("data: [DONE]\n\n");
}

async function startFakeProvider() {
  const port = await freePort();
  const held = new Map();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages || [];
    const user = [...messages].reverse().find(message => message.role === "user")?.content || "";
    const last = messages.at(-1);
    requests.push({ user, messages, stream: body.stream });
    if (body.stream !== true) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "EVT-03" }, finish_reason: "stop" }] }));
      return;
    }
    if (user === "hold-poll-target") {
      held.set(user, response);
      response.once("close", () => held.delete(user));
      return;
    }
    if (user === "subscribe-poll") {
      if (last?.role === "tool") finishText(response, "poll-subscribed");
      else finishTool(response, "call-evt03-subscribe", "poll_subscribe", {
        source: "webhook:*",
        tagFilters: { team: "开发*", priority: "high" },
        mode: "wake",
        persistent: true,
        debounceMs: 0,
      });
      return;
    }
    if (user.startsWith("[事件唤醒 poll.external_event")) {
      finishText(response, "poll-wake-handled");
      return;
    }
    if (user.startsWith("[事件注入 poll.external_event")) {
      finishText(response, "poll-injection-handled");
      return;
    }
    finishText(response, `reply-${user}`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    held,
    release(user, content) {
      const response = held.get(user);
      assert(response, `held response missing: ${user}`);
      held.delete(user);
      finishText(response, content);
    },
    async close() {
      for (const response of held.values()) response.destroy();
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
    profiles: { default: { model: "evt03-model", apiKey: "evt03-secret", baseURL: providerBaseURL, providerType: "openai-compatible" } },
    settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
  }, null, 2));
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
  await waitFor(async () => {
    const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
    return response?.ok === true;
  }, { timeoutMs: 30_000, label: "EVT-03 product server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

async function api(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* SSE or plain text */ }
  return { status: response.status, body, response };
}

function consumeSse(response) {
  const events = [];
  const waiters = [];
  const done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split(/\r?\n/u).find(value => value.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(event)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
    return events;
  })();
  void done.catch(() => undefined);
  return {
    events,
    done,
    waitForEvent(predicate) {
      const existing = events.find(predicate);
      return existing ? Promise.resolve(existing) : new Promise(resolve => waiters.push({ predicate, resolve }));
    },
  };
}

async function stopProduct(product) {
  const termination = await terminateProcessTreeAsync(product.child);
  const logs = product.logs();
  assert.equal(termination.childExited, true, `server cleanup failed\nstdout=${logs.stdout}\nstderr=${logs.stderr}`);
}

test("EVT-03 authenticated ingress wakes idle Session and injects running flow", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-evt03-flow-");
  const token = "evt03-poll-flow-token";
  const provider = await startFakeProvider();
  let product;
  try {
    product = await startProduct(fixture, provider.baseURL, token);
    const created = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Poll Target" }) });
    assert.equal(created.status, 200);
    const sessionId = created.body.session.id;
    const unauthorizedIngress = await fetch(`${product.base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceEventId: "unauthorized", source: "webhook:push", payload: {} }),
    });
    assert.equal(unauthorizedIngress.status, 401);

    const subscribeResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "subscribe-poll" }),
    });
    const subscribeStream = consumeSse(subscribeResponse);
    const approval = await subscribeStream.waitForEvent(event => event.type === "ask_user");
    assert.equal((await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId, runId: approval.runId, questionId: approval.questionId, answer: "yes" }),
    })).status, 200);
    const subscribeEvents = await subscribeStream.done;
    assert(subscribeEvents.some(event => event.type === "answer_chunk" && event.content === "poll-subscribed"));

    assert.equal((await api(product.base, token, "/events", {
      method: "POST",
      body: JSON.stringify({ sourceEventId: "forged-target", source: "webhook:push", targetSessionId: sessionId, payload: {} }),
    })).status, 400);
    const nonmatch = await api(product.base, token, "/events", {
      method: "POST",
      body: JSON.stringify({ sourceEventId: "nonmatch", source: "webhook:push", tags: { team: "开发一组", priority: "low" }, payload: {} }),
    });
    assert.deepEqual(nonmatch.body, { matched: 0, enqueued: 0, duplicates: 0 });

    const idle = await api(product.base, token, "/events", {
      method: "POST",
      body: JSON.stringify({ sourceEventId: "idle-1", source: "webhook:push", tags: { team: "开发一组", priority: "high" }, payload: { phase: "idle" } }),
    });
    assert.equal(idle.status, 202);
    assert.deepEqual(idle.body, { matched: 1, enqueued: 1, duplicates: 0 });
    await waitFor(() => provider.requests.some(request => request.stream === true
      && request.user.startsWith("[事件唤醒 poll.external_event") && request.user.includes('"phase": "idle"')), {
      timeoutMs: 15_000,
      label: "EVT-03 idle wake",
    });

    const holdResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "hold-poll-target" }),
    });
    const holdStream = consumeSse(holdResponse);
    await holdStream.waitForEvent(event => event.type === "run_started");
    await waitFor(() => provider.held.has("hold-poll-target"), { timeoutMs: 10_000, label: "EVT-03 held flow" });

    const running = await api(product.base, token, "/events", {
      method: "POST",
      body: JSON.stringify({ sourceEventId: "running-1", source: "webhook:push", tags: { team: "开发二组", priority: "high" }, payload: { phase: "running" } }),
    });
    assert.deepEqual(running.body, { matched: 1, enqueued: 1, duplicates: 0 });
    provider.release("hold-poll-target", "held-complete");
    const heldEvents = await holdStream.done;
    assert(heldEvents.some(event => event.type === "answer_chunk" && event.content === "poll-injection-handled"));
    assert.equal(provider.requests.filter(request => request.stream === true
      && request.user.startsWith("[事件注入 poll.external_event") && request.user.includes('"phase": "running"')).length, 1);
  } finally {
    if (product) await stopProduct(product);
    await provider.close();
    await removeFixture(fixture);
  }
});
