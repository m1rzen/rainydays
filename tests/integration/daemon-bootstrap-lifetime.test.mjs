import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { freePort, makeTempDir, projectRoot, removeFixture, waitFor } from "../helpers.mjs";

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit before timeout")), timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function cleanupTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    await new Promise(resolve => execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
  } else child.kill("SIGKILL");
}

test("SEC-02 Daemon holds Node, loader and server leases until runtime ready and cleans the process tree", { timeout: 90_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-daemon-lifetime-");
  const userData = path.join(fixture, "user-data");
  await fs.mkdir(userData, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(projectRoot, "dist", "daemon.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAINYDAYS_APP_ROOT: projectRoot,
      RAINYDAYS_USER_DATA_DIR: userData,
      RAINYDAYS_DATA_DIR: path.join(userData, "data"),
      DEPARTMENT_DATA_ROOT: path.join(userData, "department"),
      PORT: String(port),
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: path.join(fixture, "must-not-load"),
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  try {
    const status = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        return response.status === 401 ? response.status : false;
      } catch {
        return false;
      }
    }, { timeoutMs: 45_000, intervalMs: 100, label: "daemon runtime ready" });
    assert.equal(status, 401);
    assert.match(stdout, /RainyDays .* 已启动/u);
    assert.equal(child.connected, true);
    child.send({ type: "rainydays-daemon-shutdown" });
    const exited = await waitForExit(child, 20_000);
    assert.deepEqual(exited, { code: 0, signal: null }, `daemon failed\nstdout=${stdout}\nstderr=${stderr}`);
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/status`);
        return false;
      } catch {
        return true;
      }
    }, { timeoutMs: 10_000, intervalMs: 100, label: "daemon listener cleanup" });
  } finally {
    await cleanupTree(child);
    await removeFixture(fixture);
  }
});
