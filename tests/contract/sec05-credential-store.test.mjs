import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnManaged, waitForChildExit } from "../helpers.mjs";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec05-credentials-"));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
delete process.env.DEEPSEEK_API_KEY;
delete process.env.LLM_API_KEY;

const legacySecret = "legacy-secret-value-123456";
await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, JSON.stringify({
  defaultProfile: "default",
  profiles: {
    default: {
      model: "legacy-model",
      apiKey: legacySecret,
      baseURL: "https://provider.example/v1",
      providerType: "openai-compatible",
    },
  },
  settings: {},
}, null, 2));

const credentialStore = await import("../../dist/credential-store.js");
credentialStore.configureCredentialProtector({
  protect: plaintext => Buffer.from([...Buffer.from(plaintext, "utf8")].map(byte => byte ^ 0xa5)),
  unprotect: ciphertext => Buffer.from([...ciphertext].map(byte => byte ^ 0xa5)).toString("utf8"),
});
const config = await import("../../dist/config.js");

test.after(async () => {
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-05 migrates legacy plaintext to an opaque reference before publishing runtime config", async () => {
  await config.initializeConfig();
  assert.equal(config.getCurrentProfile().apiKey, legacySecret);

  const configText = await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH, "utf8");
  assert.equal(configText.includes(legacySecret), false);
  const persisted = JSON.parse(configText);
  assert.equal(Object.hasOwn(persisted.profiles.default, "apiKey"), false);
  assert.match(persisted.profiles.default.credentialRef, /^cred_[a-f0-9]{32}$/u);

  const vaultText = await fs.readFile(path.join(fixture, "credentials.vault.json"), "utf8");
  assert.equal(vaultText.includes(legacySecret), false);
  const vault = JSON.parse(vaultText);
  assert.deepEqual(Object.keys(vault.entries), [persisted.profiles.default.credentialRef]);

  const restarted = await import(`../../dist/config.js?restart=${Date.now()}`);
  await restarted.initializeConfig();
  assert.equal(restarted.getCurrentProfile().apiKey, legacySecret);
});

test("SEC-05 migration failure preserves legacy plaintext, cleans orphan ciphertext and publishes no runtime", async () => {
  const failureFixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec05-failure-"));
  const failureSecret = "must-survive-failed-migration";
  const child = spawnManaged(process.execPath, ["tests/fixtures/sec05-migration-failure.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, SEC05_FAILURE_FIXTURE: failureFixture, SEC05_FAILURE_SECRET: failureSecret },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const exited = await waitForChildExit(child, 20_000);
    assert.equal(exited, true, stderr);
    assert.equal(child.exitCode, 0, stderr);
    assert.match(stdout, /"failedClosed":true/u);
  } finally {
    await fs.rm(failureFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("SEC-05 rotates references on key update and removes retired credentials after config commit", async () => {
  const before = JSON.parse(await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH, "utf8"));
  const oldReference = before.profiles.default.credentialRef;
  const replacement = "replacement-secret-value-789";

  await config.upsertProfile("default", { apiKey: replacement });
  const after = JSON.parse(await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH, "utf8"));
  assert.match(after.profiles.default.credentialRef, /^cred_[a-f0-9]{32}$/u);
  assert.notEqual(after.profiles.default.credentialRef, oldReference);
  assert.equal(JSON.stringify(after).includes(replacement), false);

  const vault = JSON.parse(await fs.readFile(path.join(fixture, "credentials.vault.json"), "utf8"));
  assert.equal(Object.hasOwn(vault.entries, oldReference), false);
  assert.equal(Object.hasOwn(vault.entries, after.profiles.default.credentialRef), true);
  assert.equal(config.getCurrentProfile().apiKey, replacement);
});
