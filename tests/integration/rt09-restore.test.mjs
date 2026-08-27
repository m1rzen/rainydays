import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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

test("RT-09 restart restores every persisted session runtime and selects the latest", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt09-restore-");
  const token = "rt09-restore-token";
  const workspace = path.join(fixture, "workspace");
  const output = path.join(fixture, "output");
  await Promise.all([
    mkdir(path.join(fixture, "data"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(path.join(fixture, "department"), { recursive: true }),
    mkdir(output, { recursive: true }),
  ]);
  const configPath = path.join(fixture, "config.json");
  await writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "rt09-model",
        apiKey: "rt09-secret",
        baseURL: "http://127.0.0.1:9/v1",
        providerType: "openai-compatible",
      },
    },
    settings: {
      defaultPersona: "general",
      workspaceRoot: workspace,
      departmentDataRoot: path.join(fixture, "department"),
      outputDir: output,
    },
  }, null, 2));

  // Pre-seed two sessions directly into the database before the product starts.
  const seederPort = await freePort();
  const seeder = spawnManaged(process.execPath, ["tests/fixtures/rt09-restore-seeder.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RT09_SEED_PORT: String(seederPort),
      RT09_USER_DATA_DIR: fixture,
      RT09_DATA_DIR: path.join(fixture, "data"),
    },
  });
  let seederStdout = "";
  seeder.stdout.setEncoding("utf8");
  seeder.stdout.on("data", chunk => { seederStdout += chunk; });
  try {
    await waitFor(() => {
      try { return JSON.parse(seederStdout).ready === true; }
      catch { return false; }
    }, { timeoutMs: 15_000, label: "RT-09 session seeder" });
  } finally {
    await terminateProcessTreeAsync(seeder);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
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
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(async () => {
      const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
      return response?.ok === true;
    }, { timeoutMs: 30_000, label: "RT-09 product server" });

    const sessionsResponse = await fetch(`${base}/sessions`, { headers: { "X-RainyDays-Token": token } });
    const sessionsPayload = await sessionsResponse.json();
    const sessions = sessionsPayload.sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessionsPayload.current, sessions[0].id, "latest session must stay selected");

    const statusResponse = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } });
    const status = await statusResponse.json();
    const loaded = status.runtimes.map(runtime => runtime.sessionId).sort();
    assert.deepEqual(loaded, sessions.map(session => session.id).sort(), "every persisted session must have a restored runtime");
    assert.match(stdout, /自动恢复会话/);
  } finally {
    const termination = await terminateProcessTreeAsync(child);
    assert.equal(termination.childExited, true);
    await removeFixture(fixture);
  }
});
