import assert from "node:assert/strict";
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

async function safeModeAvailable(cdpPort) {
  let client;
  try {
    client = await connectCdp(cdpPort);
    return await client.evaluate("document.title") === "RainyDays 安全模式";
  } catch { return false; }
  finally { client?.close(); }
}

test("REL-03 win-unpacked safe mode exposes only bounded diagnostics and no backend", {
  skip: process.platform !== "win32" || process.arch !== "x64",
  timeout: 90_000,
}, async () => {
  assert.equal(await pathExists(executable), true, "win-unpacked executable is missing");
  const build = JSON.parse(await fs.readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const userData = await makeTempDir("mini-lux-rel03-packaged-");
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = launchTracked(executable, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    "--disable-gpu",
    "--safe-mode",
  ], {
    env: { ...process.env, PORT: String(httpPort), ELECTRON_ENABLE_LOGGING: "1" },
    timeoutMs: 45_000,
    label: "REL-03 win-unpacked safe mode",
    readyProbe: () => safeModeAvailable(cdpPort),
  });
  let client;
  try {
    try { await instance.ready; }
    catch (error) {
      const logs = instance.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    client = await connectCdp(cdpPort);
    const diagnostics = await client.evaluate("JSON.parse(document.getElementById('recovery-diagnostics').textContent)");
    assert.deepEqual(Object.keys(diagnostics).sort(), ["build", "crashes", "integrity", "mode", "reason", "schemaVersion"]);
    assert.equal(diagnostics.mode, "safe");
    assert.equal(diagnostics.reason, "forced");
    assert.equal(diagnostics.build.appVersion, build.appVersion);
    assert.equal(diagnostics.build.buildId, build.buildId);
    const serialized = JSON.stringify(diagnostics);
    assert(serialized.length < 4_096);
    assert.doesNotMatch(serialized, /api.?key|authorization|bearer|prompt|message|token/iu);
    await assert.rejects(() => boundedFetch(`http://127.0.0.1:${httpPort}/api/status`, { signal: AbortSignal.timeout(1_000) }));

    const quit = client.evaluate("document.getElementById('quit-recovery').click()").catch(() => undefined);
    await waitFor(() => instance.child.exitCode !== null, { timeoutMs: 20_000, label: "REL-03 packaged safe-mode exit" });
    await quit;
    client.close();
    client = null;
    await waitFor(async () => {
      try { await boundedFetch(`http://127.0.0.1:${cdpPort}/json/version`); return false; }
      catch { return true; }
    }, { timeoutMs: 20_000, label: "REL-03 packaged CDP cleanup" });
    const ledger = JSON.parse(await fs.readFile(path.join(userData, "recovery-state.json"), "utf8"));
    assert.equal(ledger.activeLaunch, false);
    assert.equal(ledger.safeMode, true);
    assert.equal(ledger.safeModeReason, "forced");
  } finally {
    client?.close();
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await removeFixture(userData);
  }
});
