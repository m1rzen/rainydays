import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  makeTempDir,
  pathExists,
  projectRoot,
  removeFixture,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";
import { launchTracked } from "./smoke-helpers.mjs";

const executable = path.join(projectRoot, "release", "win-unpacked", "RainyDays.exe");

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

async function killService(pid) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert(systemRoot, "Windows system root is unavailable");
  await new Promise((resolve, reject) => {
    execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error && error.code !== 128) reject(new Error(`service taskkill failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

async function stop(instance, httpPort, cdpPort) {
  let client;
  try {
    client = await connectCdp(cdpPort);
    const closeRequest = client.send("Browser.close").catch(() => undefined);
    await waitFor(() => instance.child.exitCode !== null, { timeoutMs: 20_000, label: "RT-10 packaged graceful exit" });
    await closeRequest;
  } catch (error) {
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    throw error;
  } finally {
    client?.close();
  }
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${httpPort}/`); return false; }
    catch { return true; }
  }, { timeoutMs: 20_000, label: "RT-10 packaged backend cleanup" });
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${cdpPort}/json/version`); return false; }
    catch { return true; }
  }, { timeoutMs: 20_000, label: "RT-10 packaged CDP cleanup" });
}

test("RT-10 win-unpacked app restarts its isolated backend and cleans it on quit", { timeout: 120_000 }, async () => {
  assert.equal(process.platform, "win32");
  assert.equal(await pathExists(executable), true, "win-unpacked executable is missing");
  const userData = await makeTempDir("mini-lux-rt10-packaged-");
  const workspaceRoot = path.join(userData, "workspace");
  const departmentDataRoot = path.join(userData, "department");
  const outputDir = path.join(userData, "output");
  await Promise.all([workspaceRoot, departmentDataRoot, outputDir].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(userData, "config.json"), JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rt10-packaged-model",
        apiKey: "",
        baseURL: "https://provider.invalid/v1",
        providerType: "openai-compatible",
      },
    },
    settings: { defaultPersona: "general", workspaceRoot, departmentDataRoot, outputDir },
  }, null, 2));
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = launchTracked(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: { ...process.env, PORT: String(httpPort), ELECTRON_ENABLE_LOGGING: "1" },
    timeoutMs: 45_000,
    label: "RT-10 win-unpacked service",
    readyProbe: async () => {
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`)).ok; }
      catch { return false; }
    },
  });
  try {
    try { await instance.ready; }
    catch (error) {
      const logs = instance.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    const initial = await waitFor(() => serviceStates(instance.logs().stdout).find(state => state.phase === "ready" && state.generation === 1), {
      timeoutMs: 10_000,
      label: "RT-10 packaged initial service",
    });
    assert.notEqual(initial.pid, instance.child.pid);
    await killService(initial.pid);
    const restarted = await waitFor(() => serviceStates(instance.logs().stdout).find(state => state.phase === "ready" && state.generation >= 2), {
      timeoutMs: 30_000,
      label: "RT-10 packaged restarted service",
    });
    assert.notEqual(restarted.pid, initial.pid);
    assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/`)).status, 200);
    await stop(instance, httpPort, cdpPort);
    assert(serviceStates(instance.logs().stdout).some(state => state.phase === "stopped"));
  } finally {
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});
