import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
  waitForChildExit,
} from "../helpers.mjs";

const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

async function prepareFixture(userData) {
  const workspaceRoot = path.join(userData, "workspace");
  const departmentDataRoot = path.join(userData, "department");
  const outputDir = path.join(userData, "output");
  await Promise.all([workspaceRoot, departmentDataRoot, outputDir].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(userData, "config.json"), JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "ds01-model",
        apiKey: "",
        baseURL: "https://provider.invalid/v1",
        providerType: "openai-compatible",
      },
    },
    settings: { defaultPersona: "general", workspaceRoot, departmentDataRoot, outputDir },
  }, null, 2));
}

function electronEnvironment(httpPort) {
  return {
    ...process.env,
    PORT: String(httpPort),
    RAINYDAYS_E2E_USE_DIST: "1",
    RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath,
    ELECTRON_ENABLE_LOGGING: "1",
  };
}

async function startElectron(userData, httpPort, cdpPort, signal) {
  const child = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: electronEnvironment(httpPort),
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited ${child.exitCode ?? child.signalCode}`);
    try {
      return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })).ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 45_000, intervalMs: 100, label: "DS-01 Electron service ready" });
  return { child, logs: () => ({ stdout, stderr }) };
}

async function connectRenderer(cdpPort, httpPort) {
  let connected = null;
  await waitFor(async () => {
    let candidate;
    try {
      candidate = await connectCdp(cdpPort);
      if (await candidate.evaluate("location.origin") !== `http://127.0.0.1:${httpPort}`) {
        candidate.close();
        return false;
      }
      connected = candidate;
      return true;
    } catch {
      candidate?.close();
      return false;
    }
  }, { timeoutMs: 20_000, intervalMs: 150, label: "DS-01 trusted renderer" });
  return connected;
}

async function stopElectron(instance, client, httpPort) {
  const closeRequest = client.send("Browser.close").catch(() => undefined);
  assert.equal(await waitForChildExit(instance.child, 20_000), true, "DS-01 Electron did not exit after Browser.close");
  await closeRequest;
  client.close();
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${httpPort}/`); return false; }
    catch { return true; }
  }, { timeoutMs: 10_000, label: "DS-01 service cleanup" });
}

async function readWindowState(userData) {
  return JSON.parse(await readFile(path.join(userData, "window-state.json"), "utf8"));
}

async function createSession(client, title) {
  const created = await client.evaluate(`fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:${JSON.stringify(title)}})}).then(response=>response.json())`);
  return created.session.id;
}

test("DS-01 restores reachable bounds, routes a second-instance Session and reloads a crashed renderer", { timeout: 180_000 }, async context => {
  const userData = await makeTempDir("mini-lux-ds01-electron-");
  await prepareFixture(userData);
  await writeFile(path.join(userData, "window-state.json"), JSON.stringify({
    schemaVersion: 1,
    bounds: { x: 30_000, y: 30_000, width: 1000, height: 700 },
    maximized: false,
    fullscreen: false,
    displayId: "removed-display",
  }));
  let first;
  let second;
  let client;
  try {
    const [firstHttpPort, firstCdpPort] = await freeDistinctPorts(2);
    first = await startElectron(userData, firstHttpPort, firstCdpPort, context.signal);
    client = await connectRenderer(firstCdpPort, firstHttpPort);
    const reachable = await client.evaluate("window.electronAPI.windowState()");
    assert.notEqual(reachable.bounds.x, 30_000);
    assert.notEqual(reachable.bounds.y, 30_000);
    assert(reachable.bounds.width >= 800 && reachable.bounds.height >= 600);
    await stopElectron(first, client, firstHttpPort);
    const firstState = await readWindowState(userData);
    assert.deepEqual(firstState.bounds, reachable.bounds);
    assert.equal(firstState.maximized, false);
    first = null;
    client = null;

    const [secondHttpPort, secondCdpPort] = await freeDistinctPorts(2);
    second = await startElectron(userData, secondHttpPort, secondCdpPort, context.signal);
    const electronPid = second.child.pid;
    client = await connectRenderer(secondCdpPort, secondHttpPort);
    const restored = await client.evaluate("window.electronAPI.windowState()");
    assert.equal(restored.maximized, false);
    assert.deepEqual(restored.bounds, firstState.bounds);

    const sessionA = await createSession(client, "DS-01 first instance");
    const sessionB = await createSession(client, "DS-01 second-instance target");
    assert.notEqual(sessionA, sessionB);
    await client.evaluate(`fetch('/api/sessions/${sessionA}/select',{method:'POST'}).then(response=>response.json())`);
    const duplicate = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--session=${sessionB}`, "--disable-gpu"], {
      env: electronEnvironment(secondHttpPort),
    });
    try {
      assert.equal(await waitForChildExit(duplicate, 15_000), true, "DS-01 second instance did not exit");
      assert.equal(duplicate.exitCode, 0);
    } finally {
      await terminateProcessTreeAsync(duplicate).catch(() => undefined);
    }
    await waitFor(async () => {
      const sessions = await client.evaluate("fetch('/api/sessions').then(response=>response.json())");
      return sessions.current === sessionB;
    }, { timeoutMs: 10_000, label: "DS-01 second-instance Session route" });
    const focused = await client.evaluate("window.electronAPI.windowState()");
    assert.equal(focused.visible, true);
    assert.equal(focused.minimized, false);

    await client.send("Page.crash").catch(() => undefined);
    client.close();
    client = null;
    await waitFor(() => second.logs().stderr.includes('"event":"rainydays_renderer_gone"'), {
      timeoutMs: 10_000,
      label: "DS-01 renderer crash diagnostic",
    });
    client = await connectRenderer(secondCdpPort, secondHttpPort);
    assert.equal(second.child.pid, electronPid);
    const recoveredSessions = await client.evaluate("fetch('/api/sessions').then(response=>response.json())");
    assert.equal(recoveredSessions.current, sessionB);
    assert.equal((await boundedFetch(`http://127.0.0.1:${secondHttpPort}/`)).status, 200);

    await stopElectron(second, client, secondHttpPort);
    second = null;
    client = null;
    const finalState = await readWindowState(userData);
    assert.deepEqual(finalState.bounds, firstState.bounds);
    assert.equal(finalState.maximized, false);
  } finally {
    client?.close();
    if (first) await terminateProcessTreeAsync(first.child).catch(() => undefined);
    if (second) await terminateProcessTreeAsync(second.child).catch(() => undefined);
    await removeFixture(userData);
  }
});
