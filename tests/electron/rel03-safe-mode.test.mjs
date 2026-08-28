import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
        model: "rel03-model",
        apiKey: "",
        baseURL: "https://provider.invalid/v1",
        providerType: "openai-compatible",
      },
    },
    settings: { defaultPersona: "general", workspaceRoot, departmentDataRoot, outputDir },
  }, null, 2));
}

function startElectron(userData, httpPort, cdpPort, extraArgs = [], extraEnv = {}) {
  const child = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu", ...extraArgs], {
    env: {
      ...process.env,
      PORT: String(httpPort),
      RAINYDAYS_E2E_USE_DIST: "1",
      RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath,
      ELECTRON_ENABLE_LOGGING: "1",
      ...extraEnv,
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, logs: () => ({ stdout, stderr }) };
}

async function connectPage(cdpPort, predicate, label) {
  let connected = null;
  await waitFor(async () => {
    let candidate;
    try {
      candidate = await connectCdp(cdpPort);
      if (!await predicate(candidate)) {
        candidate.close();
        return false;
      }
      connected = candidate;
      return true;
    } catch {
      candidate?.close();
      return false;
    }
  }, { timeoutMs: 30_000, intervalMs: 150, label });
  return connected;
}

async function connectNormal(cdpPort, httpPort) {
  return connectPage(cdpPort, client => client.evaluate("location.origin").then(origin => origin === `http://127.0.0.1:${httpPort}`), "REL-03 normal workbench");
}

async function connectSafe(cdpPort) {
  return connectPage(cdpPort, client => client.evaluate("document.title").then(title => title === "RainyDays 安全模式"), "REL-03 safe-mode recovery window");
}

async function waitNormalReady(instance, httpPort, signal) {
  try {
    await waitFor(async () => {
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) throw new Error(`Electron exited ${instance.child.exitCode ?? instance.child.signalCode}`);
      try {
        return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        })).ok;
      } catch { return false; }
    }, { timeoutMs: 45_000, intervalMs: 100, label: "REL-03 normal service ready" });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(instance.logs())}`, { cause: error });
  }
}

function serviceStates(stdout) {
  return stdout.split(/\r?\n/u).flatMap(line => {
    try {
      const parsed = JSON.parse(line);
      return parsed.event === "rainydays_service_state" ? [parsed] : [];
    } catch { return []; }
  });
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

async function assertSafeDiagnostics(client, reason) {
  const diagnostics = await client.evaluate("JSON.parse(document.getElementById('recovery-diagnostics').textContent)");
  assert.equal(diagnostics.schemaVersion, 1);
  assert.equal(diagnostics.mode, "safe");
  assert.equal(diagnostics.reason, reason);
  assert.equal(typeof diagnostics.build.appVersion, "string");
  assert.equal(typeof diagnostics.build.buildId, "string");
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /api.?key|authorization|bearer|prompt|message|token/iu);
  assert(serialized.length < 4_096);
  return diagnostics;
}

async function stopSafe(instance, client) {
  const closing = client.evaluate("document.getElementById('quit-recovery').click()").catch(() => undefined);
  assert.equal(await waitForChildExit(instance.child, 20_000), true, `REL-03 safe-mode Electron did not exit\n${JSON.stringify(instance.logs())}`);
  await closing;
  client.close();
}

test("REL-03 detects a real main-process crash loop before starting the backend", { timeout: 180_000 }, async context => {
  const userData = await makeTempDir("mini-lux-rel03-main-");
  await prepareFixture(userData);
  let instance;
  let client;
  try {
    for (let crash = 0; crash < 3; crash += 1) {
      const [httpPort, cdpPort] = await freeDistinctPorts(2);
      instance = startElectron(userData, httpPort, cdpPort);
      await waitNormalReady(instance, httpPort, context.signal);
      client = await connectNormal(cdpPort, httpPort);
      client.close();
      client = null;
      await terminateProcessTreeAsync(instance.child);
      instance = null;
    }

    const [safeHttpPort, safeCdpPort] = await freeDistinctPorts(2);
    instance = startElectron(userData, safeHttpPort, safeCdpPort);
    client = await connectSafe(safeCdpPort);
    const diagnostics = await assertSafeDiagnostics(client, "main-crash-loop");
    assert.equal(diagnostics.crashes.uncleanLaunches, 3);
    await assert.rejects(() => boundedFetch(`http://127.0.0.1:${safeHttpPort}/api/status`, { signal: AbortSignal.timeout(1_000) }));
    assert(instance.logs().stderr.includes('"event":"rainydays_safe_mode"'));
    await stopSafe(instance, client);
    instance = null;
    client = null;
    const ledger = JSON.parse(await readFile(path.join(userData, "recovery-state.json"), "utf8"));
    assert.equal(ledger.activeLaunch, false);
    assert.equal(ledger.safeMode, true);
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});

test("REL-03 converts a startup service launch loop into safe mode", { timeout: 90_000 }, async () => {
  const userData = await makeTempDir("mini-lux-rel03-startup-");
  await prepareFixture(userData);
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = startElectron(userData, httpPort, cdpPort, [], {
    RAINYDAYS_E2E_NODE_EXECUTABLE: path.join(userData, "missing-node.exe"),
  });
  let client;
  try {
    client = await connectSafe(cdpPort);
    const diagnostics = await assertSafeDiagnostics(client, "service-crash-loop");
    assert.equal(diagnostics.crashes.serviceCrashLoops, 1);
    assert(serviceStates(`${instance.logs().stdout}\n${instance.logs().stderr}`).some(state => state.phase === "crash-loop"));
    await assert.rejects(() => boundedFetch(`http://127.0.0.1:${httpPort}/api/status`, { signal: AbortSignal.timeout(1_000) }));
    await stopSafe(instance, client);
    client = null;
  } finally {
    client?.close();
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});

test("REL-03 enters safe mode after repeated renderer crashes without replacing the main process", { timeout: 150_000 }, async context => {
  const userData = await makeTempDir("mini-lux-rel03-renderer-");
  await prepareFixture(userData);
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = startElectron(userData, httpPort, cdpPort);
  let client;
  try {
    await waitNormalReady(instance, httpPort, context.signal);
    const mainPid = instance.child.pid;
    client = await connectNormal(cdpPort, httpPort);
    for (let crash = 1; crash <= 3; crash += 1) {
      await client.send("Page.crash").catch(() => undefined);
      client.close();
      client = null;
      await waitFor(() => (instance.logs().stderr.match(/"event":"rainydays_renderer_gone"/gu) ?? []).length >= crash, {
        timeoutMs: 10_000,
        label: `REL-03 renderer crash ${crash}`,
      });
      if (crash < 3) client = await connectNormal(cdpPort, httpPort);
    }
    client = await connectSafe(cdpPort);
    const diagnostics = await assertSafeDiagnostics(client, "renderer-crash-loop");
    assert.equal(diagnostics.crashes.rendererCrashLoops, 1);
    assert.equal(instance.child.pid, mainPid);
    await assert.rejects(() => boundedFetch(`http://127.0.0.1:${httpPort}/api/status`, { signal: AbortSignal.timeout(1_000) }));
    await stopSafe(instance, client);
    client = null;
  } finally {
    client?.close();
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});

test("REL-03 turns a real service crash loop into backend-free safe mode", { timeout: 180_000 }, async context => {
  const userData = await makeTempDir("mini-lux-rel03-service-");
  await prepareFixture(userData);
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = startElectron(userData, httpPort, cdpPort);
  let client;
  try {
    await waitNormalReady(instance, httpPort, context.signal);
    const mainPid = instance.child.pid;
    client = await connectNormal(cdpPort, httpPort);
    let generation = 0;
    for (let crash = 1; crash <= 6; crash += 1) {
      const ready = await waitFor(() => serviceStates(instance.logs().stdout).find(state => state.phase === "ready" && state.generation > generation), {
        timeoutMs: 30_000,
        label: `REL-03 service generation ${crash}`,
      });
      generation = ready.generation;
      assert(Number.isSafeInteger(ready.pid) && ready.pid > 0);
      await killService(ready.pid);
    }
    await waitFor(() => serviceStates(`${instance.logs().stdout}\n${instance.logs().stderr}`).some(state => state.phase === "crash-loop"), {
      timeoutMs: 15_000,
      label: "REL-03 service crash-loop state",
    });
    client.close();
    client = await connectSafe(cdpPort);
    const diagnostics = await assertSafeDiagnostics(client, "service-crash-loop");
    assert.equal(diagnostics.crashes.serviceCrashLoops, 1);
    assert.equal(instance.child.pid, mainPid);
    await assert.rejects(() => boundedFetch(`http://127.0.0.1:${httpPort}/api/status`, { signal: AbortSignal.timeout(1_000) }));
    await stopSafe(instance, client);
    client = null;
  } finally {
    client?.close();
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});
