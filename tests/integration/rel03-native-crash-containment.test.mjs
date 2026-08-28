import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  freePort,
  makeTempDir,
  observeWindowsProcessReferences,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

const token = "rel03-native-token";

async function api(base, route, options = {}) {
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
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body };
}

async function startProduct(fixture) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rel03-native-model",
        apiKey: "",
        baseURL: "https://provider.invalid/v1",
        providerType: "openai-compatible",
      },
    },
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
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "",
      DEPARTMENT_DATA_ROOT: "",
      OUTPUT_DIR: "",
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => {
    const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
    return response?.ok === true;
  }, { timeoutMs: 30_000, label: "REL-03 native containment server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

let childRequestCounter = 0;

function childRequest(child, input) {
  const requestId = `rel03-native-${++childRequestCounter}`;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      if (message.ok) finish(null, message.value);
      else {
        const error = new Error(message.error || "REL-03 native child request failed");
        if (typeof message.code === "string") error.code = message.code;
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(new Error(`REL-03 native child request timed out: ${input.type}`)), 10_000);
    timer.unref?.();
    child.on("message", onMessage);
    child.send({ ...input, requestId }, error => { if (error) finish(error); });
  });
}

async function startTerminal(product, sessionId) {
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
  assert.match(started.terminal.id, /^term_[a-f0-9]{8}$/u);
  const listed = await api(product.base, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
  assert.equal(listed.status, 200);
  return started.terminal.id;
}

async function killNativeHost(pid) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert(systemRoot, "Windows system root is unavailable");
  await new Promise((resolve, reject) => {
    execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error && error.code !== 128) reject(new Error(`native host taskkill failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

test("REL-03 contains a native host crash and creates only one clean replacement", {
  skip: process.platform !== "win32" || process.arch !== "x64",
  timeout: 90_000,
}, async () => {
  const fixture = await makeTempDir("mini-lux-rel03-native-");
  const sandboxHost = path.join(projectRoot, "dist", "native", "sandbox-host.exe");
  let product;
  let sessionId;
  let crashInjected = false;
  let replacementStarted = false;
  let fixtureSafeToRemove = false;
  try {
    product = await startProduct(fixture);
    const created = await api(product.base, "/sessions", { method: "POST", body: JSON.stringify({ title: "REL-03 native containment" }) });
    sessionId = created.body.session.id;
    assert.equal((await api(product.base, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);
    const baseline = new Set((await observeWindowsProcessReferences([sandboxHost])).matchingProcesses.map(process => process.processId));
    await startTerminal(product, sessionId);
    const hostPid = await waitFor(async () => {
      const observed = await observeWindowsProcessReferences([sandboxHost]);
      return observed.matchingProcesses.map(process => process.processId).find(pid => !baseline.has(pid)) ?? null;
    }, { timeoutMs: 20_000, label: "REL-03 native sandbox host" });

    await killNativeHost(hostPid);
    crashInjected = true;
    await waitFor(async () => !(await observeWindowsProcessReferences([sandboxHost])).matchingProcesses.some(process => process.processId === hostPid), {
      timeoutMs: 20_000,
      label: "REL-03 crashed native host exit",
    });
    assert.equal(product.child.exitCode, null);
    assert.equal((await api(product.base, "/status")).status, 200);
    const stopped = await waitFor(async () => {
      const listed = await api(product.base, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
      return listed.status === 200 && listed.body.terminals.length === 1 && listed.body.terminals[0].status !== "running"
        ? listed.body.terminals[0]
        : null;
    }, { timeoutMs: 15_000, label: "REL-03 crashed Terminal containment" });
    assert(["exited", "killed", "error"].includes(stopped.status));

    await startTerminal(product, sessionId);
    replacementStarted = true;
    const replacement = await api(product.base, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
    assert.equal(replacement.status, 200);
    assert.equal(replacement.body.terminals.filter(terminal => terminal.status === "running").length, 1);
    assert.equal(replacement.body.terminals.filter(terminal => terminal.status !== "running").length, 1);
    assert.equal(product.child.exitCode, null);
    await childRequest(product.child, { type: "rt01-shutdown" });
    fixtureSafeToRemove = true;
  } finally {
    if (product) {
      if (crashInjected && !replacementStarted && sessionId) {
        try {
          assert.equal((await api(product.base, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);
          await startTerminal(product, sessionId);
          replacementStarted = true;
        } catch { /* Keep the fixture root if native ACL recovery could not complete. */ }
      }
      if (replacementStarted) {
        try { await childRequest(product.child, { type: "rt01-shutdown" }); fixtureSafeToRemove = true; }
        catch { /* Process-tree cleanup below is still attempted. */ }
      }
      await terminateProcessTreeAsync(product.child).catch(() => undefined);
    }
    if (fixtureSafeToRemove || !crashInjected) await removeFixture(fixture);
  }
});
