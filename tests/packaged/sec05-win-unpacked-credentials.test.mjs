import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, pathExists, projectRoot, removeFixture, terminateProcessTreeAsync, waitFor } from "../helpers.mjs";
import { launchTracked } from "./smoke-helpers.mjs";

const executable = path.join(projectRoot, "release", "win-unpacked", "RainyDays.exe");

function launch(userData, httpPort, cdpPort) {
  const instance = launchTracked(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: { ...process.env, PORT: String(httpPort), ELECTRON_ENABLE_LOGGING: "1", DEEPSEEK_API_KEY: "must-not-be-inherited" },
    timeoutMs: 45_000,
    label: "SEC-05 win-unpacked credential service",
    readyProbe: async () => {
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`)).ok; } catch { return false; }
    },
  });
  return instance;
}

async function stop(instance, httpPort, cdpPort) {
  let client;
  try {
    client = await connectCdp(cdpPort);
    const closeRequest = client.send("Browser.close").catch(() => undefined);
    await waitFor(() => instance.child.exitCode !== null, { timeoutMs: 20_000, label: "SEC-05 graceful Electron exit" });
    await closeRequest;
  } catch (error) {
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    throw error;
  } finally { client?.close(); }
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${httpPort}/`); return false; } catch { return true; }
  }, { timeoutMs: 20_000, label: "SEC-05 HTTP shutdown" });
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${cdpPort}/json/version`); return false; } catch { return true; }
  }, { timeoutMs: 20_000, label: "SEC-05 CDP shutdown" });
}

async function configured(cdpPort) {
  const client = await connectCdp(cdpPort);
  try {
    return await waitFor(async () => {
      try {
        const value = await client.evaluate(`(async()=>{const r=await fetch('/api/settings');return {status:r.status,body:await r.json()}})()`);
        return value?.status === 200 ? value.body.profiles?.[0]?.hasApiKey : null;
      } catch { return null; }
    }, { timeoutMs: 20_000, label: "SEC-05 configured provider" });
  } finally { client.close(); }
}

test("SEC-05 win-unpacked migrates with safeStorage and decrypts after restart without plaintext persistence", { timeout: 150_000 }, async () => {
  assert.equal(process.platform, "win32");
  assert.equal(await pathExists(executable), true, "win-unpacked executable is missing");
  const userData = await makeTempDir("mini-lux-sec05-packaged-");
  const secret = "packaged-dpapi-secret-never-plaintext";
  await fs.writeFile(path.join(userData, "config.json"), JSON.stringify({
    defaultProfile: "default",
    profiles: { default: { model: "m", apiKey: secret, baseURL: "https://provider.example" } },
    settings: {},
  }, null, 2));
  try {
    for (let launchIndex = 0; launchIndex < 2; launchIndex++) {
      const [httpPort, cdpPort] = await freeDistinctPorts(2);
      const instance = launch(userData, httpPort, cdpPort);
      try {
        try { await instance.ready; }
        catch (error) {
          const logs = instance.logs();
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
        }
        assert.equal(await configured(cdpPort), true);
        const configText = await fs.readFile(path.join(userData, "config.json"), "utf8");
        const vaultText = await fs.readFile(path.join(userData, "credentials.vault.json"), "utf8");
        assert.equal(configText.includes(secret), false);
        assert.equal(vaultText.includes(secret), false);
        const persisted = JSON.parse(configText);
        assert.equal(Object.hasOwn(persisted.profiles.default, "apiKey"), false);
        assert.match(persisted.profiles.default.credentialRef, /^cred_[a-f0-9]{32}$/u);
      } finally { await stop(instance, httpPort, cdpPort); }
    }
  } finally { await removeFixture(userData); }
});
