import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  freePort,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
  waitForChildExit,
} from "../helpers.mjs";

const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

function serviceStates(stdout) {
  return stdout.split(/\r?\n/u).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value?.event === "rainydays_service_state" ? [value] : [];
    } catch {
      return [];
    }
  });
}

function sseChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-rt10",
    object: "chat.completion.chunk",
    created: 1,
    model: "rt10-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startFakeProvider() {
  const port = await freePort();
  const state = { streamRequests: 0, heldResponse: null };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (body.stream !== true) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "RT-10" }, finish_reason: "stop" }] }));
      return;
    }
    state.streamRequests += 1;
    const user = [...(body.messages ?? [])].reverse().find(message => message.role === "user")?.content ?? "";
    if (user === "hold-active-run") {
      state.heldResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.flushHeaders?.();
      response.once("close", () => {
        if (state.heldResponse === response) state.heldResponse = null;
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    response.write(sseChunk({ role: "assistant", content: "after-restart-ok" }));
    response.write(sseChunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    state,
    async close() {
      state.heldResponse?.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function killService(pid) {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    assert(systemRoot, "Windows system root is unavailable");
    await new Promise((resolve, reject) => {
      execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, _stdout, stderr) => {
        if (error && error.code !== 128) reject(new Error(`service taskkill failed: ${stderr || error.message}`));
        else resolve();
      });
    });
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function startElectron(userData, httpPort, cdpPort, signal, providerBaseURL) {
  const workspaceRoot = path.join(userData, "workspace");
  const departmentDataRoot = path.join(userData, "department");
  const outputDir = path.join(userData, "output");
  await Promise.all([workspaceRoot, departmentDataRoot, outputDir].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(userData, "config.json"), JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rt10-model",
        apiKey: "rt10-provider-key",
        baseURL: providerBaseURL,
        providerType: "openai-compatible",
      },
    },
    settings: { defaultPersona: "general", workspaceRoot, departmentDataRoot, outputDir },
  }, null, 2));
  const child = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: {
      ...process.env,
      PORT: String(httpPort),
      RAINYDAYS_E2E_USE_DIST: "1",
      RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath,
      RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const readiness = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited ${child.exitCode ?? child.signalCode}`);
      try {
        const response = await boundedFetch(`http://127.0.0.1:${httpPort}/`, {
          signal: AbortSignal.any([readiness, AbortSignal.timeout(2_000)]),
        });
        return response.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 45_000, intervalMs: 100, label: "RT-10 Electron service ready" });
    return { child, logs: () => ({ stdout, stderr }) };
  } catch (error) {
    await terminateProcessTreeAsync(child).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

test("RT-10 Electron recovers a Session after its backend dies during an LLM request", { timeout: 120_000 }, async context => {
  const provider = await startFakeProvider();
  const userData = await makeTempDir("mini-lux-rt10-electron-");
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  let instance;
  let client;
  try {
    instance = await startElectron(userData, httpPort, cdpPort, context.signal, provider.baseURL);
    client = await connectCdp(cdpPort);
    await waitFor(async () => {
      try { return await client.evaluate("location.origin") === `http://127.0.0.1:${httpPort}`; }
      catch { return false; }
    }, { timeoutMs: 10_000, label: "RT-10 renderer origin" });
    const initial = await waitFor(() => serviceStates(instance.logs().stdout).find(state => state.phase === "ready" && state.generation === 1), {
      timeoutMs: 10_000,
      label: "RT-10 initial supervised service state",
    });
    assert(Number.isSafeInteger(initial.pid) && initial.pid > 0);
    const electronPid = instance.child.pid;
    const created = await client.evaluate(`fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'RT-10 recovered session'})}).then(response=>response.json())`);
    const sessionId = created.session.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/u);
    await client.evaluate(`(()=>{
      window.__rt10ChatResult=null;
      window.__rt10ChatPromise=fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)},message:'hold-active-run'})})
        .then(async response=>({ok:true,status:response.status,text:await response.text()}))
        .catch(error=>({ok:false,name:error.name,message:error.message}))
        .then(result=>{window.__rt10ChatResult=result;return result});
      return true;
    })()`);
    await waitFor(() => provider.state.streamRequests === 1 && provider.state.heldResponse !== null, {
      timeoutMs: 15_000,
      label: "RT-10 held LLM request",
    });

    await killService(initial.pid);
    await waitFor(() => serviceStates(instance.logs().stdout).some(state => state.phase === "backoff" && state.generation === 1), {
      timeoutMs: 10_000,
      label: "RT-10 restart backoff state",
    });
    const restarted = await waitFor(() => serviceStates(instance.logs().stdout).find(state => state.phase === "ready" && state.generation >= 2), {
      timeoutMs: 30_000,
      label: "RT-10 restarted service state",
    });
    assert.notEqual(restarted.pid, initial.pid);
    assert.equal(instance.child.pid, electronPid);
    await delay(100);
    assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/`)).status, 200);
    const recovered = await client.evaluate("fetch('/api/sessions').then(response=>response.json())");
    assert(recovered.sessions.some(session => session.id === sessionId));
    assert.equal(recovered.current, sessionId);
    await delay(500);
    assert.equal(provider.state.streamRequests, 1, "interrupted LLM request was duplicated after service restart");
    const interrupted = await waitFor(async () => {
      try { return await client.evaluate("window.__rt10ChatResult"); }
      catch { return null; }
    }, { timeoutMs: 10_000, label: "RT-10 interrupted chat settlement" });
    assert.equal(interrupted.ok, false);
    const recoveredChat = await client.evaluate(`fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)},message:'after-restart'})}).then(async response=>({status:response.status,text:await response.text()}))`, 30_000);
    assert.equal(recoveredChat.status, 200);
    assert.match(recoveredChat.text, /after-restart-ok/u);
    assert.equal(provider.state.streamRequests, 2);

    const closeRequest = client.send("Browser.close").catch(() => undefined);
    assert.equal(await waitForChildExit(instance.child, 20_000), true, "Electron did not complete supervised shutdown");
    await closeRequest;
    client.close();
    client = null;
    await waitFor(async () => {
      try { await boundedFetch(`http://127.0.0.1:${httpPort}/`); return false; }
      catch { return true; }
    }, { timeoutMs: 10_000, label: "RT-10 backend listener cleanup" });
    assert(serviceStates(instance.logs().stdout).some(state => state.phase === "stopped"));
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await provider.close();
    await removeFixture(userData);
  }
});
