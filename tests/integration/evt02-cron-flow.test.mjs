import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
    id: "chatcmpl-evt02",
    object: "chat.completion.chunk",
    created: 1,
    model: "evt02-model",
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

async function startFakeProvider(state) {
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

    // 语义标题生成是非流式请求，不参与 flow 编排。
    if (body.stream !== true) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "EVT-02" }, finish_reason: "stop" }] }));
      return;
    }
    if (user.startsWith("hold-")) {
      held.set(user, response);
      response.once("close", () => held.delete(user));
      return;
    }
    if (user === "schedule-target") {
      if (last?.role === "tool") finishText(response, "cron-scheduled");
      else finishTool(response, "call-evt02-cron", "cron_schedule", {
        message: "injected-from-cron",
        delay: "1s",
        target: state.targetSessionId,
        tag: "中文 管理标签可超过EventBus机器标签限制但仍应正常触发",
      });
      return;
    }
    if (user === "schedule-cancel-target") {
      if (last?.role === "tool") finishText(response, "cancel-recovery-scheduled");
      else finishTool(response, "call-evt02-cancel-recovery", "cron_schedule", {
        message: "recover-after-active-cancel",
        delay: "1s",
        target: state.targetSessionId,
        tag: "cancel-recovery",
      });
      return;
    }
    if (user === "schedule-broadcast") {
      if (last?.role === "tool") finishText(response, "broadcast-scheduled");
      else finishTool(response, "call-evt02-broadcast", "cron_schedule", {
        message: "broadcast-from-cron",
        delay: "1s",
        target: "*",
        tag: "evt02-broadcast",
      });
      return;
    }
    if (user.startsWith("[事件注入 cron.triggered") || user.startsWith("[事件唤醒 cron.triggered")) {
      finishText(response, user.includes("broadcast-from-cron")
        ? "cron-broadcast-handled"
        : user.includes("recover-after-active-cancel")
          ? "cron-cancel-recovered"
          : "cron-injection-handled");
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
    requests,
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
    profiles: {
      default: {
        model: "evt02-model",
        apiKey: "evt02-secret",
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
  }, { timeoutMs: 30_000, label: "EVT-02 product server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
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

test("EVT-02 real Cron targets a running Session and injects a follow-up flow", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-evt02-flow-");
  const token = "evt02-cron-flow-token";
  const state = { targetSessionId: null };
  const provider = await startFakeProvider(state);
  let product;
  const eventAbort = new AbortController();
  try {
    product = await startProduct(fixture, provider.baseURL, token);
    const createdOwner = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Cron Owner" }) });
    const createdTarget = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Cron Target" }) });
    const createdBroadcast = await api(product.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "Cron Broadcast" }) });
    assert.equal(createdOwner.status, 200);
    assert.equal(createdTarget.status, 200);
    assert.equal(createdBroadcast.status, 200);
    const ownerSessionId = createdOwner.body.session.id;
    state.targetSessionId = createdTarget.body.session.id;
    const broadcastSessionId = createdBroadcast.body.session.id;

    const eventsResponse = await fetch(`${product.base}/events`, {
      headers: { "X-RainyDays-Token": token },
      signal: eventAbort.signal,
    });
    const eventStream = consumeSse(eventsResponse);

    // 目标 Session 先进入真实 running 状态，Provider 保持首轮响应不结束。
    const targetResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.targetSessionId, message: "hold-target" }),
    });
    const targetStream = consumeSse(targetResponse);
    await waitFor(() => provider.held.has("hold-target"), { timeoutMs: 10_000, label: "held target flow" });

    // 创建者 Session 通过真实 Agent 工具调用创建 1s 定时任务，并完成用户审批。
    const ownerResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: ownerSessionId, message: "schedule-target" }),
    });
    const ownerStream = consumeSse(ownerResponse);
    const approval = await ownerStream.waitForEvent(event => event.type === "ask_user");
    const approved = await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      body: JSON.stringify({
        sessionId: ownerSessionId,
        runId: approval.runId,
        questionId: approval.questionId,
        answer: "yes",
      }),
    });
    assert.equal(approved.status, 200);
    const ownerEvents = await ownerStream.done;
    assert(ownerEvents.some(event => event.type === "answer_chunk" && event.content === "cron-scheduled"));

    const cronEnvelope = await eventStream.waitForEvent(event => event.type === "event"
      && event.event?.type === "cron.triggered"
      && event.event?.targetSessionId === state.targetSessionId);
    assert.equal(cronEnvelope.event.payload.message, "injected-from-cron");
    assert.equal(cronEnvelope.event.payload.targetSessionId, state.targetSessionId);

    // EventBus dispatch interval 最大 500ms；保持目标 run，确保走 running injection 分支。
    await delay(800);
    const runtimeStatus = await api(product.base, token, "/status");
    assert(runtimeStatus.body.runtimes.some(runtime => runtime.sessionId === state.targetSessionId && runtime.running === true));
    provider.release("hold-target", "initial-target-finished");

    await waitFor(() => provider.requests.some(request => request.user.startsWith("[事件注入 cron.triggered")), {
      timeoutMs: 15_000,
      label: "running cron injection provider request",
    });
    const targetEvents = await targetStream.done;
    assert(targetEvents.some(event => event.type === "answer_chunk" && event.content === "initial-target-finished"));
    assert(targetEvents.some(event => event.type === "answer_chunk" && event.content === "cron-injection-handled"));
    assert.equal(provider.requests.filter(request => request.user.startsWith("[事件注入 cron.triggered") && request.user.includes("injected-from-cron")).length, 1);

    // active flow 在取走 injection 前被取消：ack-on-take 必须让 EventBus retry，随后 idle wake 恢复。
    const cancelTargetResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.targetSessionId, message: "hold-cancel-target" }),
    });
    const cancelTargetStream = consumeSse(cancelTargetResponse);
    const cancelRun = await cancelTargetStream.waitForEvent(event => event.type === "run_started");
    await waitFor(() => provider.held.has("hold-cancel-target"), { timeoutMs: 10_000, label: "held cancellation target" });

    const cancelScheduleResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: ownerSessionId, message: "schedule-cancel-target" }),
    });
    const cancelScheduleStream = consumeSse(cancelScheduleResponse);
    const cancelApproval = await cancelScheduleStream.waitForEvent(event => event.type === "ask_user");
    assert.equal((await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: ownerSessionId, runId: cancelApproval.runId, questionId: cancelApproval.questionId, answer: "yes" }),
    })).status, 200);
    await cancelScheduleStream.done;
    await eventStream.waitForEvent(event => event.type === "event" && event.event?.type === "cron.triggered"
      && event.event?.payload?.message === "recover-after-active-cancel");
    await delay(800);
    assert.equal((await api(product.base, token, "/chat/cancel", {
      method: "POST",
      body: JSON.stringify({ sessionId: state.targetSessionId, runId: cancelRun.runId }),
    })).status, 200);
    await cancelTargetStream.done;
    await waitFor(() => provider.requests.some(request => request.stream === true
      && request.user.startsWith("[事件唤醒 cron.triggered")
      && request.user.includes("recover-after-active-cancel")), {
      timeoutMs: 15_000,
      label: "cancelled injection idle recovery",
    });
    assert.equal(provider.requests.filter(request => request.stream === true
      && request.user.startsWith("[事件唤醒 cron.triggered")
      && request.user.includes("recover-after-active-cancel")).length, 1);

    // target="*" 在触发时展开为每个已注册 Session 一个稳定 envelope，并唤醒全部空闲 flow。
    const broadcastResponse = await fetch(`${product.base}/chat`, {
      method: "POST",
      headers: { "X-RainyDays-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: ownerSessionId, message: "schedule-broadcast" }),
    });
    const broadcastOwnerStream = consumeSse(broadcastResponse);
    const broadcastApproval = await broadcastOwnerStream.waitForEvent(event => event.type === "ask_user");
    assert.equal((await api(product.base, token, "/ask-user/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: ownerSessionId, runId: broadcastApproval.runId, questionId: broadcastApproval.questionId, answer: "yes" }),
    })).status, 200);
    const broadcastOwnerEvents = await broadcastOwnerStream.done;
    assert(broadcastOwnerEvents.some(event => event.type === "answer_chunk" && event.content === "broadcast-scheduled"));

    const expectedTargets = [ownerSessionId, state.targetSessionId, broadcastSessionId].sort();
    await waitFor(() => provider.requests.filter(request => request.stream === true && request.user.includes("broadcast-from-cron")
      && (request.user.startsWith("[事件唤醒 cron.triggered") || request.user.startsWith("[事件注入 cron.triggered"))).length >= 3, {
      timeoutMs: 15_000,
      label: "broadcast cron wake requests",
    });
    const broadcastRequests = provider.requests.filter(request => request.stream === true && request.user.includes("broadcast-from-cron")
      && (request.user.startsWith("[事件唤醒 cron.triggered") || request.user.startsWith("[事件注入 cron.triggered")));
    const actualTargets = broadcastRequests.map(request => JSON.parse(request.user.slice(request.user.indexOf("\n") + 1)).targetSessionId).sort();
    assert.deepEqual(actualTargets, expectedTargets);
  } finally {
    eventAbort.abort();
    if (product) await stopProduct(product);
    await provider.close();
    await removeFixture(fixture);
  }
});
