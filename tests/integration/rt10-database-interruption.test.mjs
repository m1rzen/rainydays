import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  makeTempDir,
  pathExists,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
  waitForChildExit,
} from "../helpers.mjs";

function spawnDbFixture(fixture, mode, sessionId, marker = null) {
  const child = spawnManaged(process.execPath, [path.join(projectRoot, "tests", "fixtures", "rt10-db-interruption-child.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAINYDAYS_APP_ROOT: projectRoot,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
      RT10_DB_MODE: mode,
      RT10_DB_SESSION_ID: sessionId,
      ...(marker ? { RT10_DB_MARKER: marker } : {}),
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, logs: () => ({ stdout, stderr }) };
}

async function runDbFixture(fixture, mode, sessionId) {
  const instance = spawnDbFixture(fixture, mode, sessionId);
  assert.equal(await waitForChildExit(instance.child, 30_000), true, `${mode} fixture timed out\n${JSON.stringify(instance.logs())}`);
  assert.equal(instance.child.exitCode, 0, `${mode} fixture failed\n${JSON.stringify(instance.logs())}`);
  return instance.logs().stdout.trim();
}

async function verify(fixture) {
  return JSON.parse(await runDbFixture(fixture, "verify", "rt10-verify"));
}

test("RT-10 SQLite rolls back an interrupted write and permits exactly one retry", { timeout: 90_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt10-db-");
  const marker = path.join(fixture, "transaction-open.marker");
  let interrupted;
  try {
    await runDbFixture(fixture, "commit", "rt10-baseline");
    interrupted = spawnDbFixture(fixture, "interrupt", "rt10-interrupted", marker);
    await waitFor(() => pathExists(marker), { timeoutMs: 20_000, label: "RT-10 open SQLite transaction" });
    const terminated = await terminateProcessTreeAsync(interrupted.child);
    assert.equal(terminated.childExited, true, `interrupted DB child remained alive\n${JSON.stringify(interrupted.logs())}`);

    assert.deepEqual(await verify(fixture), { baseline: 1, interrupted: 0 });
    await runDbFixture(fixture, "commit", "rt10-interrupted");
    assert.deepEqual(await verify(fixture), { baseline: 1, interrupted: 1 });
  } finally {
    if (interrupted) await terminateProcessTreeAsync(interrupted.child).catch(() => undefined);
    await removeFixture(fixture);
  }
});
