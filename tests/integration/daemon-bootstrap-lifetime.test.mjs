import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  const credentialScope = createHash("sha256")
    .update("rainydays-test-daemon-credential-protector-v1\0", "utf8")
    .update(userData, "utf8")
    .digest("hex");
  child.on("message", message => {
    if (!message || typeof message !== "object"
      || JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(["operation", "requestId", "type", "value"])
      || message.type !== "rainydays-credential-request"
      || typeof message.requestId !== "string" || !/^[a-f0-9]{32}$/u.test(message.requestId)
      || (message.operation !== "protect" && message.operation !== "unprotect")
      || typeof message.value !== "string") return;
    try {
      const prefix = `test-daemon-protected:${credentialScope}:`;
      const value = message.operation === "protect"
        ? Buffer.from(`${prefix}${message.value}`, "utf8").toString("base64")
        : (() => {
            const plaintext = Buffer.from(message.value, "base64").toString("utf8");
            if (!plaintext.startsWith(prefix)) throw new Error("Test daemon credential scope mismatch");
            return plaintext.slice(prefix.length);
          })();
      child.send({ type: "rainydays-credential-result", requestId: message.requestId, ok: true, value });
    } catch {
      child.send({ type: "rainydays-credential-result", requestId: message.requestId, ok: false });
    }
  });

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

test("SEC-06 Daemon rejects pending credential requests when its parent IPC disconnects", { timeout: 30_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-daemon-credential-disconnect-");
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
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  try {
    const disconnectedAt = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`daemon did not forward a credential request\nstdout=${stdout}\nstderr=${stderr}`)), 10_000);
      timer.unref?.();
      child.once("message", message => {
        clearTimeout(timer);
        assert(message && typeof message === "object");
        assert.equal(message.type, "rainydays-credential-request");
        assert.equal(message.operation, "protect");
        const now = Date.now();
        child.disconnect();
        resolve(now);
      });
    });
    const exited = await waitForExit(child, 8_000);
    assert.equal(exited.code, 1, `daemon did not fail closed\nstdout=${stdout}\nstderr=${stderr}`);
    assert(Date.now() - disconnectedAt < 8_000, "daemon waited for the 25-second credential timeout");
  } finally {
    await cleanupTree(child);
    await removeFixture(fixture);
  }
});
