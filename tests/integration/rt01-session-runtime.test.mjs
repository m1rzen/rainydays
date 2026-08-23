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
    id: "chatcmpl-rt01",
    object: "chat.completion.chunk",
    created: 1,
    model: "rt01-model",
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
  const aborted = new Set();
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
    requests.push({ user, model: body.model, messages });

    if (user.startsWith("hold-")) {
      held.set(user, response);
      response.once("close", () => {
        held.delete(user);
        if (!response.writableEnded) aborted.add(user);
      });
      return;
    }
    if (user.startsWith("ask-")) {
      if (last?.role === "tool") finishText(response, `answered-${user}`);
      else finishTool(response, `call-${user}`, "ask_user", { question: `question-${user}`, options: ["yes", "no"] });
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
    held,
    aborted,
    requests,
    close: async () => {
      for (const response of held.values()) response.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function api(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      "X-RainyDays-Token": token,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* SSE or plain text */ }
  return { status: response.status, body, response };
}

async function startProduct(fixture, providerBaseURL, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(workspace, "a.txt"), "runtime-a");
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rt01-model",
        apiKey: "rt01-secret",
        baseURL: providerBaseURL,
        providerType: "openai-compatible",
      },
    },
    settings: {
      defaultPersona: "general",
      workspaceRoot: workspace,
      departmentDataRoot: department,
      outputDir: output,
    },
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
  }, { timeoutMs: 30_000, label: "RT-01 product server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

let childRequestCounter = 0;

async function childRequest(child, input) {
  const requestId = `rt01-child-${++childRequestCounter}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`RT-01 child request timed out: ${input.type}`));
    }, 10_000);
    timer.unref?.();
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      if (message.ok) resolve(message.value);
      else {
        const error = new Error(message.error || "RT-01 child request failed");
        if (typeof message.code === "string") error.code = message.code;
        reject(error);
      }
    };
    child.on("message", onMessage);
    child.send({ ...input, requestId }, error => {
      if (!error) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      reject(error);
    });
  });
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
    waitForEvent: predicate => {
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

test("RT-01 real server isolates parallel Session runtimes and run-local interaction", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt01-runtime-");
  const token = "rt01-session-runtime-token";
  const provider = await startFakeProvider();
  let product;
  try {
    product = await startProduct(fixture, provider.baseURL, token);
    const createdA = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Runtime A" }) });
    const createdB = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Runtime B" }) });
    assert.equal(createdA.status, 200);
    assert.equal(createdB.status, 200);
    const sessionA = createdA.body.session.id;
    const sessionB = createdB.body.session.id;

    const missingDirectIdentity = await api(product.base, token, "/files/roots");
    assert.equal(missingDirectIdentity.status, 400);
    const boundDirect = await api(product.base, token, "/files/roots", { headers: { "X-RainyDays-Session": sessionA } });
    assert.equal(boundDirect.status, 200);
    const conflictingDirectIdentity = await api(product.base, token, `/files/roots?sessionId=${encodeURIComponent(sessionB)}`, {
      headers: { "X-RainyDays-Session": sessionA },
    });
    assert.equal(conflictingDirectIdentity.status, 400);
    assert.match(conflictingDirectIdentity.body.error, /冲突/);
    assert.equal((await api(product.base, token, `/sessions/${sessionA}/select`, { method: "POST" })).status, 200);
    const staleManualChallenge = await childRequest(product.child, {
      type: "rt01-manual-consent-prepare",
      operation: "terminal-clear",
      request: { id: "rt01-nonexistent-terminal" },
    });
    assert.equal(staleManualChallenge.operation, "terminal-clear");
    const missingChatIdentity = await api(product.base, token, "/chat", {
      method: "POST",
      body: JSON.stringify({ message: "must-not-use-selection" }),
    });
    assert.equal(missingChatIdentity.status, 400);
    assert.match(missingChatIdentity.body.error, /sessionId/);
    const providerRequestsBeforeConflict = provider.requests.length;
    const conflictingChatIdentity = await api(product.base, token, "/chat", {
      method: "POST",
      headers: { "X-RainyDays-Session": sessionA },
      body: JSON.stringify({ sessionId: sessionB, message: "must-not-reach-provider" }),
    });
    assert.equal(conflictingChatIdentity.status, 400);
    assert.match(conflictingChatIdentity.body.error, /冲突/);
    const conflictingClearIdentity = await api(product.base, token, "/clear", {
      method: "POST",
      headers: { "X-RainyDays-Session": sessionA },
      body: JSON.stringify({ sessionId: sessionB }),
    });
    assert.equal(conflictingClearIdentity.status, 400);
    assert.match(conflictingClearIdentity.body.error, /冲突/);
    const conflictingAnswerIdentity = await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      headers: { "X-RainyDays-Session": sessionA },
      body: JSON.stringify({ sessionId: sessionB, runId: "forged-run", questionId: "forged-question", answer: "yes" }),
    });
    assert.equal(conflictingAnswerIdentity.status, 400);
    assert.match(conflictingAnswerIdentity.body.error, /冲突/);
    assert.equal(provider.requests.length, providerRequestsBeforeConflict);
    assert.equal((await api(product.base, token, `/sessions/${sessionB}/select`, { method: "POST" })).status, 200);
    await assert.rejects(() => childRequest(product.child, {
      type: "rt01-manual-consent-decide",
      challengeId: staleManualChallenge.challengeId,
      decision: "approve",
      operation: staleManualChallenge.operation,
      argumentsDigest: staleManualChallenge.argumentsDigest,
    }), /challenge|consent|失效|不存在|invalid|unavailable/iu);
    for (const sessionId of [sessionA, sessionB]) {
      const terminals = await api(product.base, token, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
      assert.equal(terminals.status, 200);
      assert.deepEqual(terminals.body.terminals, []);
    }

    const [chatA, chatB] = await Promise.all([
      fetch(`${product.base}/chat`, { method: "POST", headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionA, message: "hold-a" }) }),
      fetch(`${product.base}/chat`, { method: "POST", headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionB, message: "hold-b" }) }),
    ]);
    assert.equal(chatA.status, 200);
    assert.equal(chatB.status, 200);
    const streamA = consumeSse(chatA);
    const streamB = consumeSse(chatB);
    await waitFor(() => provider.held.size === 2, { timeoutMs: 10_000, label: "parallel provider requests" });

    const status = await api(product.base, token, "/status");
    assert.deepEqual(new Set(status.body.runtimes.filter(runtime => runtime.running).map(runtime => runtime.sessionId)), new Set([sessionA, sessionB]));
    const duplicateA = await api(product.base, token, "/chat", { method: "POST", body: JSON.stringify({ sessionId: sessionA, message: "duplicate" }) });
    assert.equal(duplicateA.status, 409);
    const destructiveWhileRunning = await Promise.all([
      api(product.base, token, `/sessions/${sessionA}`, { method: "DELETE" }),
      api(product.base, token, `/sessions/${sessionA}/rollback`, { method: "POST" }),
      api(product.base, token, `/sessions/${sessionA}/fork`, { method: "POST", body: JSON.stringify({}) }),
      api(product.base, token, "/clear", {
        method: "POST",
        headers: { "X-RainyDays-Session": sessionA },
        body: JSON.stringify({ sessionId: sessionA }),
      }),
      api(product.base, token, "/settings/general", {
        method: "PUT",
        body: JSON.stringify({ workspaceRoot: path.join(fixture, "workspace") }),
      }),
    ]);
    assert.deepEqual(destructiveWhileRunning.map(result => result.status), [409, 409, 409, 409, 409]);
    const selectedA = await api(product.base, token, `/sessions/${sessionA}/select`, { method: "POST" });
    assert.equal(selectedA.status, 200);

    finishText(provider.held.get("hold-b"), "reply-b");
    provider.held.delete("hold-b");
    finishText(provider.held.get("hold-a"), "reply-a");
    provider.held.delete("hold-a");
    const [eventsA, eventsB] = await Promise.all([streamA.done, streamB.done]);
    assert(eventsA.some(event => event.type === "answer_chunk" && event.content === "reply-a"));
    assert(eventsB.some(event => event.type === "answer_chunk" && event.content === "reply-b"));

    const historyA = await api(product.base, token, `/sessions/${sessionA}/messages`, { headers: { "X-RainyDays-Session": sessionA } });
    const historyB = await api(product.base, token, `/sessions/${sessionB}/messages`, { headers: { "X-RainyDays-Session": sessionB } });
    assert(historyA.body.messages.some(message => message.content === "hold-a"));
    assert(historyA.body.messages.some(message => message.content === "reply-a"));
    assert(!historyA.body.messages.some(message => message.content === "hold-b" || message.content === "reply-b"));
    assert(historyB.body.messages.some(message => message.content === "hold-b"));
    assert(historyB.body.messages.some(message => message.content === "reply-b"));
    assert(!historyB.body.messages.some(message => message.content === "hold-a" || message.content === "reply-a"));

    const [cancelChatA, cancelChatB] = await Promise.all([
      fetch(`${product.base}/chat`, {
        method: "POST",
        headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionA, message: "hold-cancel-a" }),
      }),
      fetch(`${product.base}/chat`, {
        method: "POST",
        headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionB, message: "hold-cancel-b" }),
      }),
    ]);
    const cancelStreamA = consumeSse(cancelChatA);
    const cancelStreamB = consumeSse(cancelChatB);
    const [startedA, startedB] = await Promise.all([
      cancelStreamA.waitForEvent(event => event.type === "run_started"),
      cancelStreamB.waitForEvent(event => event.type === "run_started"),
    ]);
    await waitFor(
      () => provider.held.has("hold-cancel-a") && provider.held.has("hold-cancel-b"),
      { timeoutMs: 10_000, label: "RT-04 held provider requests" },
    );

    const crossCancel = await api(product.base, token, "/chat/cancel", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionB, runId: startedA.runId }),
    });
    assert.equal(crossCancel.status, 409);
    assert.equal(provider.aborted.size, 0);

    const cancelledA = await api(product.base, token, "/chat/cancel", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionA, runId: startedA.runId }),
    });
    assert.equal(cancelledA.status, 200, JSON.stringify(cancelledA.body));
    assert.deepEqual(cancelledA.body, { cancelled: true, settled: true, sessionId: sessionA, runId: startedA.runId });
    const cancelledEventsA = await cancelStreamA.done;
    assert(cancelledEventsA.some(event => event.type === "run_cancelled" && event.runId === startedA.runId));
    await waitFor(() => provider.aborted.has("hold-cancel-a"), { timeoutMs: 10_000, label: "RT-04 provider abort A" });
    assert.equal(provider.aborted.has("hold-cancel-b"), false);

    const afterCancelStatus = await api(product.base, token, "/status");
    assert.equal(afterCancelStatus.body.runtimes.find(runtime => runtime.sessionId === sessionA).running, false);
    assert.equal(afterCancelStatus.body.runtimes.find(runtime => runtime.sessionId === sessionB).running, true);
    const staleCancel = await api(product.base, token, "/chat/cancel", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionA, runId: startedA.runId }),
    });
    assert.equal(staleCancel.status, 409);

    const nextAResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionA, message: "after-cancel-a" }),
    });
    const nextAEvents = await consumeSse(nextAResponse).done;
    assert(nextAEvents.some(event => event.type === "answer_chunk" && event.content === "reply-after-cancel-a"));
    finishText(provider.held.get("hold-cancel-b"), "cancel-b-finished");
    provider.held.delete("hold-cancel-b");
    const completedEventsB = await cancelStreamB.done;
    assert(completedEventsB.some(event => event.type === "answer_chunk" && event.content === "cancel-b-finished"));
    assert.notEqual(startedA.runId, startedB.runId);

    const [askResponseA, askResponseB] = await Promise.all([
      fetch(`${product.base}/chat`, { method: "POST", headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionA, message: "ask-a" }) }),
      fetch(`${product.base}/chat`, { method: "POST", headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionB, message: "ask-b" }) }),
    ]);
    const askStreamA = consumeSse(askResponseA);
    const askStreamB = consumeSse(askResponseB);
    const [questionA, questionB] = await Promise.all([
      askStreamA.waitForEvent(event => event.type === "ask_user"),
      askStreamB.waitForEvent(event => event.type === "ask_user"),
    ]);
    assert.notEqual(questionA.runId, questionB.runId);
    const crossAnswer = await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionB, runId: questionB.runId, questionId: questionA.questionId, answer: "cross" }),
    });
    assert.equal(crossAnswer.status, 409);
    for (const question of [questionA, questionB]) {
      const answer = await api(product.base, token, "/ask-user/answer", {
        method: "POST",
        body: JSON.stringify({ sessionId: question.sessionId, runId: question.runId, questionId: question.questionId, answer: "yes" }),
      });
      assert.equal(answer.status, 200);
    }
    const [askEventsA, askEventsB] = await Promise.all([askStreamA.done, askStreamB.done]);
    assert(askEventsA.some(event => event.type === "answer_chunk" && event.content === "answered-ask-a"));
    assert(askEventsB.some(event => event.type === "answer_chunk" && event.content === "answered-ask-b"));

    const beforeClear = (await api(product.base, token, "/status")).body.runtimes;
    const bBefore = beforeClear.find(runtime => runtime.sessionId === sessionB).messageCount;
    const cleared = await api(product.base, token, "/clear", {
      method: "POST",
      headers: { "X-RainyDays-Session": sessionA },
      body: JSON.stringify({ sessionId: sessionA }),
    });
    assert.equal(cleared.status, 200);
    const afterClear = (await api(product.base, token, "/status")).body.runtimes;
    assert.equal(afterClear.find(runtime => runtime.sessionId === sessionB).messageCount, bBefore);
    assert(afterClear.find(runtime => runtime.sessionId === sessionA).messageCount < beforeClear.find(runtime => runtime.sessionId === sessionA).messageCount);

    const nextWorkspace = path.join(fixture, "workspace-v2");
    await fs.mkdir(nextWorkspace);
    const settingsUpdated = await api(product.base, token, "/settings/general", {
      method: "PUT",
      body: JSON.stringify({ workspaceRoot: nextWorkspace }),
    });
    assert.equal(settingsUpdated.status, 200, JSON.stringify(settingsUpdated.body));
    for (const sessionId of [sessionA, sessionB]) {
      const roots = await api(product.base, token, "/files/roots", { headers: { "X-RainyDays-Session": sessionId } });
      assert.equal(roots.status, 200);
      assert.equal(roots.body.roots.find(root => root.id === "workspace").path, nextWorkspace);
    }

    const providerUpdated = await api(product.base, token, "/settings/providers/default", {
      method: "PUT",
      body: JSON.stringify({ model: "rt01-model-v2", baseURL: provider.baseURL, apiKey: "rt01-secret", providerType: "openai-compatible" }),
    });
    assert.equal(providerUpdated.status, 200, JSON.stringify(providerUpdated.body));
    const profileResponses = await Promise.all([sessionA, sessionB].map((sessionId, index) => fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: `profile-${index}` }),
    })));
    const profileStreams = profileResponses.map(response => consumeSse(response));
    await Promise.all(profileStreams.map(stream => stream.done));
    const profileRequests = provider.requests.filter(request => request.user.startsWith("profile-"));
    assert.equal(profileRequests.length, 2);
    assert(profileRequests.every(request => request.model === "rt01-model-v2"));

    const deletedA = await api(product.base, token, `/sessions/${sessionA}`, { method: "DELETE" });
    assert.equal(deletedA.status, 200);
    const finalStatus = await api(product.base, token, "/status");
    assert.equal(finalStatus.body.runtimes.some(runtime => runtime.sessionId === sessionA), false);
    assert.equal(finalStatus.body.runtimes.some(runtime => runtime.sessionId === sessionB), true);

    const shutdownChat = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionB, message: "hold-shutdown" }),
    });
    assert.equal(shutdownChat.status, 200);
    const shutdownStream = consumeSse(shutdownChat);
    await waitFor(() => provider.held.has("hold-shutdown"), { timeoutMs: 10_000, label: "shutdown held run" });
    const shutdownRequest = childRequest(product.child, { type: "rt01-shutdown" });
    const shutdownEvents = await shutdownStream.done;
    assert(shutdownEvents.some(event => event.type === "run_cancelled"));
    await waitFor(() => provider.aborted.has("hold-shutdown"), { timeoutMs: 10_000, label: "RT-04 shutdown provider abort" });
    assert.deepEqual(await shutdownRequest, { shutDown: true });
  } catch (error) {
    const logs = product?.logs() ?? { stdout: "", stderr: "" };
    throw new Error(`RT-01 product flow failed: ${error instanceof Error ? error.stack || error.message : String(error)}\nstdout=${logs.stdout}\nstderr=${logs.stderr}`, { cause: error });
  } finally {
    if (product) await stopProduct(product);
    await provider.close();
    await removeFixture(fixture);
  }
});

test("DS-04 real server binds raw PTY input and resize to a short focused interaction grant", {
  skip: process.platform !== "win32" || process.arch !== "x64",
  timeout: 90_000,
}, async () => {
  const fixture = await makeTempDir("mini-lux-ds04-interaction-");
  const token = "ds04-interaction-token";
  const provider = await startFakeProvider();
  let product;
  try {
    product = await startProduct(fixture, provider.baseURL, token);
    const created = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "DS-04 PTY" }) });
    const sessionId = created.body.session.id;
    assert.equal((await api(product.base, token, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);

    const challenge = await childRequest(product.child, {
      type: "rt01-manual-consent-prepare",
      operation: "terminal-start",
      request: { shell: "cmd" },
    });
    const started = await childRequest(product.child, {
      type: "rt01-manual-consent-decide",
      challengeId: challenge.challengeId,
      decision: "approve",
      operation: challenge.operation,
      argumentsDigest: challenge.argumentsDigest,
    });
    const terminalId = started.terminal.id;
    assert.match(terminalId, /^term_[a-f0-9]{8}$/u);

    await childRequest(product.child, {
      type: "ds04-interactive-input",
      request: { id: terminalId, input: "echo DS04_INTERACTION_OK\r", appendNewline: false },
    });
    await waitFor(async () => {
      const output = await api(product.base, token, `/terminals/${terminalId}/output?offset=0&limit=100000`, {
        headers: { "X-RainyDays-Session": sessionId },
      });
      return output.status === 200 && output.body.data.includes("DS04_INTERACTION_OK");
    }, { timeoutMs: 15_000, label: "DS-04 raw PTY output" });

    const resized = await childRequest(product.child, {
      type: "ds04-interactive-resize",
      request: { id: terminalId, cols: 91, rows: 37 },
    });
    assert.deepEqual({ cols: resized.terminal.cols, rows: resized.terminal.rows }, { cols: 91, rows: 37 });
    await assert.rejects(() => childRequest(product.child, {
      type: "ds04-interactive-resize",
      request: { id: terminalId, cols: 92, rows: 38 },
      presence: { windowId: 1, webContentsId: 1, topFrame: true, windowVisible: true, windowFocused: false },
    }), /focused trusted renderer/iu);

    await childRequest(product.child, { type: "ds04-invalidate-interaction" });
    await assert.rejects(() => childRequest(product.child, {
      type: "ds04-interactive-input",
      request: { id: terminalId, input: "echo MUST_NOT_RUN\r", appendNewline: false },
    }), error => error?.code === "PTY_INTERACTION_GRANT_REQUIRED");
    const afterRevoke = await api(product.base, token, `/terminals/${terminalId}/output?offset=0&limit=100000`, {
      headers: { "X-RainyDays-Session": sessionId },
    });
    assert.equal(afterRevoke.body.data.includes("MUST_NOT_RUN"), false);

    const source = await fs.readFile(path.join(projectRoot, "src", "index.ts"), "utf8");
    assert.match(source, /TERMINAL_INTERACTION_MAX_MS = 10 \* 60_000/u);
    assert.match(source, /TERMINAL_INTERACTION_IDLE_MS = 2 \* 60_000/u);
    assert.match(source, /now >= grant\.expiresAt \|\| now >= grant\.idleExpiresAt/u);
    assert.match(source, /if \(terminalInteractionGrants\.get\(key\) !== grant\) return;/u);
    assert.equal((source.match(/assertTerminalInteractionCurrent\(grant\);/gu) ?? []).length, 2);
    const electronMain = await fs.readFile(path.join(projectRoot, "electron", "main.cjs"), "utf8");
    assert.doesNotMatch(electronMain, /invalidateManualTerminalConsent\(false\)/u);
  } catch (error) {
    const logs = product?.logs() ?? { stdout: "", stderr: "" };
    throw new Error(`DS-04 interaction flow failed: ${error instanceof Error ? error.stack || error.message : String(error)}\nstdout=${logs.stdout}\nstderr=${logs.stderr}`, { cause: error });
  } finally {
    if (product) {
      await childRequest(product.child, { type: "rt01-shutdown" }).catch(() => undefined);
      await stopProduct(product);
    }
    await provider.close();
    await removeFixture(fixture);
  }
});
