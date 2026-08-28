import assert from "node:assert/strict";
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
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body };
}

async function startProduct(fixture, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rt10-terminal-model",
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
  }, { timeoutMs: 30_000, label: "RT-10 Terminal product server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

let childRequestCounter = 0;

function childRequest(child, input) {
  const requestId = `rt10-terminal-${++childRequestCounter}`;
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
        const error = new Error(message.error || "RT-10 Terminal child request failed");
        if (typeof message.code === "string") error.code = message.code;
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(new Error(`RT-10 Terminal child request timed out: ${input.type}`)), 10_000);
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
  const listed = await api(product.base, "rt10-terminal-token", "/terminals", {
    headers: { "X-RainyDays-Session": sessionId },
  });
  assert.equal(listed.status, 200);
  return started.terminal.id;
}

test("RT-10 service crash removes a running Terminal tree and permits one clean replacement", {
  skip: process.platform !== "win32" || process.arch !== "x64",
  timeout: 120_000,
}, async () => {
  const fixture = await makeTempDir("mini-lux-rt10-terminal-");
  const token = "rt10-terminal-token";
  const workspace = path.join(fixture, "workspace");
  const marker = path.join(workspace, "terminal-running.marker");
  const system32 = path.join(process.env.SystemRoot ?? process.env.WINDIR, "System32");
  const observedProcessPaths = [
    path.join(projectRoot, "dist", "native", "sandbox-host.exe"),
    path.join(system32, "cmd.exe"),
    path.join(system32, "PING.EXE"),
  ];
  let first;
  let second;
  let sessionId;
  try {
    first = await startProduct(fixture, token);
    const created = await api(first.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "RT-10 Terminal recovery" }) });
    sessionId = created.body.session.id;
    assert.equal((await api(first.base, token, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);
    const baselineProcessIds = new Set((await observeWindowsProcessReferences(observedProcessPaths)).matchingProcesses.map(process => process.processId));
    const terminalId = await startTerminal(first, sessionId);
    await childRequest(first.child, {
      type: "ds04-interactive-input",
      request: { id: terminalId, input: `echo running>"${marker}" & ping.exe -t 127.0.0.1\r`, appendNewline: false },
    });
    await waitFor(async () => {
      try { return (await fs.readFile(marker, "utf8")).trim() === "running"; }
      catch { return false; }
    }, { timeoutMs: 20_000, label: "RT-10 running Terminal descendant" });
    const running = await observeWindowsProcessReferences(observedProcessPaths);
    const terminalProcessIds = running.matchingProcesses
      .map(process => process.processId)
      .filter(processId => !baselineProcessIds.has(processId));
    assert(terminalProcessIds.length >= 2, "Terminal isolation tree was not observed before the crash");

    const terminated = await terminateProcessTreeAsync(first.child);
    assert.equal(terminated.childExited, true, `service process remained alive\n${JSON.stringify(first.logs())}`);
    await waitFor(async () => {
      const remaining = new Set((await observeWindowsProcessReferences(observedProcessPaths)).matchingProcesses.map(process => process.processId));
      return terminalProcessIds.every(processId => !remaining.has(processId));
    }, { timeoutMs: 20_000, label: "RT-10 Terminal process-tree cleanup" });

    second = await startProduct(fixture, token);
    first = null;
    assert.equal((await api(second.base, token, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);
    const recovered = await api(second.base, token, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body.terminals, []);
    await startTerminal(second, sessionId);
    const replacement = await api(second.base, token, "/terminals", { headers: { "X-RainyDays-Session": sessionId } });
    assert.equal(replacement.body.terminals.length, 1);
  } finally {
    if (first) {
      await terminateProcessTreeAsync(first.child);
      let recovery;
      try {
        recovery = await startProduct(fixture, token);
        if (sessionId) {
          assert.equal((await api(recovery.base, token, `/sessions/${sessionId}/select`, { method: "POST" })).status, 200);
          await startTerminal(recovery, sessionId);
        }
        await childRequest(recovery.child, { type: "rt01-shutdown" });
      } finally {
        if (recovery) await terminateProcessTreeAsync(recovery.child).catch(() => undefined);
      }
    }
    if (second) {
      await childRequest(second.child, { type: "rt01-shutdown" }).catch(() => undefined);
      await terminateProcessTreeAsync(second.child).catch(() => undefined);
    }
    await removeFixture(fixture);
  }
});
