import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-config-"));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
const credentialStore = await import("../../dist/credential-store.js");
credentialStore.configureCredentialProtector({
  protect: plaintext => Buffer.from([...Buffer.from(plaintext, "utf8")].map(byte => byte ^ 0xa5)),
  unprotect: ciphertext => Buffer.from([...ciphertext].map(byte => byte ^ 0xa5)).toString("utf8"),
});
const config = await import("../../dist/config.js");

test.after(async () => {
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-02 config initializes and persists only through its managed authority", async () => {
  assert.throws(() => config.loadConfig(), /尚未通过受管存储初始化/);
  const initialized = await config.initializeConfig();
  assert.equal(initialized.defaultProfile, "default");
  assert.equal(config.getCurrentProfileName(), "default");
  assert.equal(config.getCurrentProfile().model.length > 0, true);
  assert.equal(config.getConfigPath(), path.join(fixture, "config.json"));
  assert.equal(initialized.settings.workspaceRoot, path.join(fixture, "workspace"));
  assert.notEqual(initialized.settings.workspaceRoot, os.homedir());
  assert.equal(await config.initializeConfig(), initialized);

  const snapshot = config.getConfigSnapshot();
  snapshot.settings.defaultPersona = "mutated-copy";
  assert.notEqual(config.getAppSettings().defaultPersona, "mutated-copy");
  assert.match(config.getConfigRevisionDigest(), /^[a-f0-9]{32}$/u);
  assert.equal(snapshot.revision, config.getConfigRevisionDigest());
});

test("SEC-02 provider mutations publish memory only after atomic persistence", async () => {
  await assert.rejects(() => config.upsertProfile("bad/name", { model: "m", baseURL: "https://example.test" }), /Profile 名称/);
  await assert.rejects(() => config.upsertProfile("constructor", { model: "m", baseURL: "https://example.test" }), /Profile 名称/);
  await assert.rejects(() => config.upsertProfile("missing-model", { baseURL: "https://example.test" }), /缺少 model/);
  await assert.rejects(() => config.upsertProfile("bad-url", { model: "m", baseURL: "file:///tmp/model" }), /默认只允许 HTTPS/);

  await config.upsertProfile("secondary", {
    model: "model-two",
    baseURL: "https://example.test/v1/",
    apiKey: "secret-value-123456",
    providerType: "openai-compatible",
  });
  const profile = config.listProfiles().find(entry => entry.name === "secondary");
  assert(profile);
  assert.equal(profile.baseURL, "https://example.test/v1");
  assert.equal(profile.hasApiKey, true);
  assert.equal(Object.hasOwn(profile, "apiKeyHint"), false);
  assert.equal(Object.hasOwn(profile, "apiKey"), false);
  assert.equal(config.switchProfile("absent"), false);
  assert.equal(config.switchProfile("secondary"), true);
  assert.equal(config.getCurrentProfileName(), "secondary");

  await config.upsertProfile("secondary", { model: "model-three" });
  assert.equal(config.getCurrentProfile().apiKey, "secret-value-123456");
  await assert.rejects(() => config.deleteProfile("secondary"), /当前使用中/);
  assert.equal(config.switchProfile("default"), true);
  await config.deleteProfile("secondary");
  await assert.rejects(() => config.deleteProfile("absent"), /不存在/);
  await assert.rejects(() => config.deleteProfile("default"), /至少保留/);
});

test("SEC-02 config coverage recovery exercises normalization and profile edge contracts", async () => {
  await config.initializeConfig();
  const normalized = config.prepareAppSettingsUpdate({}, {
    defaultProfile: "missing",
    profiles: { broken: {} },
    settings: {},
  });
  assert.deepEqual(normalized.profiles.broken, {
    model: "deepseek-chat",
    apiKey: "",
    baseURL: "https://api.deepseek.com",
    providerType: "openai-compatible",
    codexTransport: "auto",
    proxy: "",
    stripImages: false,
    knowledgeMaxCount: 20,
    personaProfileBindings: {},
  });
  assert.equal(normalized.defaultProfile, "broken");
  assert.equal(typeof normalized.settings.defaultPersona, "string");
  assert.equal(path.isAbsolute(normalized.settings.workspaceRoot), true);

  await assert.rejects(() => config.upsertProfile("missing-base", { model: "m" }), /缺少 baseURL/);
  await assert.rejects(() => config.upsertProfile("invalid-url", { model: "m", baseURL: "not a url" }), /有效的 URL/);
  await assert.rejects(() => config.upsertProfile("public-http", { model: "m", baseURL: "http://provider.example" }), /默认只允许 HTTPS/);
  await assert.rejects(() => config.upsertProfile("loopback-http", { model: "m", baseURL: "http://127.0.0.1:8080" }), /显式开发模式/);
  await assert.rejects(() => config.upsertProfile("url-credential", { model: "m", baseURL: "https://user:secret@provider.example" }), /不允许凭据/);
  await assert.rejects(() => config.upsertProfile("url-fragment", { model: "m", baseURL: "https://provider.example/#secret" }), /fragment/);
  process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER = "1";
  await config.upsertProfile("loopback-dev", { model: "m", baseURL: "http://localhost:8080" });
  delete process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER;
  await config.upsertProfile("short-key", { model: "m", baseURL: "https://example.test", apiKey: "short", providerType: "" });
  const short = config.listProfiles().find(profile => profile.name === "short-key");
  assert.equal(Object.hasOwn(short, "apiKeyHint"), false);
  assert.equal(short.providerType, "openai-compatible");
  await assert.rejects(() => config.deleteProfile("default"), /默认 Profile/);
  await config.upsertProfile("fallback", { model: "fallback-model", baseURL: "https://fallback.test" });
  await config.upsertProfile("fallback", { baseURL: "https://fallback-two.test" });
  assert.equal(config.switchProfile("fallback"), true);
  const withoutCurrent = config.getConfigSnapshot();
  delete withoutCurrent.profiles.fallback;
  withoutCurrent.defaultProfile = "default";
  await config.commitConfigSnapshot(withoutCurrent);
  assert.equal(config.getCurrentProfileName(), "default");
  const candidate = config.prepareAppSettingsUpdate({ defaultProfile: "short-key" });
  assert.equal(candidate.defaultProfile, "short-key");
  await config.deleteProfile("short-key");
});

test("SEC-02 Settings candidates validate paths before managed persistence", async () => {
  const before = config.getConfigRevisionDigest();
  assert.throws(() => config.prepareAppSettingsUpdate({ defaultProfile: "absent" }), /默认 Profile 不存在/);
  assert.throws(() => config.prepareAppSettingsUpdate({ outputDir: "  " }), /不能为空/);
  await assert.rejects(() => config.updateAppSettings({ workspaceRoot: "relative-root" }), /PATH_INPUT_INVALID|Path operation denied/);
  assert.equal(config.getConfigRevisionDigest(), before);
  await assert.rejects(() => config.updateAppSettings({ departmentDataRoot: `C:\\bad\0root` }), /PATH_INPUT_INVALID|Path operation denied/);
  assert.equal(config.getConfigRevisionDigest(), before);

  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await config.updateAppSettings({
    defaultPersona: "developer",
    workspaceRoot: workspace,
    departmentDataRoot: department,
    outputDir: output,
  });
  assert.notEqual(config.getConfigRevisionDigest(), before);
  assert.deepEqual(config.getAppSettings(), {
    defaultPersona: "developer",
    workspaceRoot: workspace,
    departmentDataRoot: department,
    outputDir: output,
  });
  const disk = JSON.parse(await fs.readFile(path.join(fixture, "config.json"), "utf8"));
  assert.deepEqual(disk.settings, config.getAppSettings());
  assert.equal(disk.revision, config.getPublicConfig().revision);
  assert.match(disk.revision, /^[a-f0-9]{32}$/u);
  const publicConfig = config.getPublicConfig();
  assert.equal(publicConfig.currentProfile, "default");
  assert.equal(publicConfig.configPath, path.join(fixture, "config.json"));
});

test("SEC-02 config rejects invalid persisted JSON and preserves runtime profile fallbacks", async () => {
  const persisted = await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH);
  await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, "{not-json");
  try {
    const isolatedConfig = await import(`../../dist/config.js?invalid-json=${Date.now()}`);
    await assert.rejects(() => isolatedConfig.initializeConfig(), /不是合法 JSON/u);
  } finally {
    await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, persisted);
  }
  const current = JSON.parse(persisted.toString("utf8"));
  await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, JSON.stringify({ ...current, schemaVersion: 999 }));
  try {
    const futureConfig = await import(`../../dist/config.js?future-schema=${Date.now()}`);
    await assert.rejects(() => futureConfig.initializeConfig(), /Schema 无效/u);
  } finally { await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, persisted); }
  await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, JSON.stringify({ ...current, unexpected: true }));
  try {
    const extraConfig = await import(`../../dist/config.js?extra-root=${Date.now()}`);
    await assert.rejects(() => extraConfig.initializeConfig(), /Schema 无效/u);
  } finally { await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, persisted); }
  const invalidReference = structuredClone(current);
  invalidReference.domains.nous.profile = "missing-profile";
  await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, JSON.stringify(invalidReference));
  process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER = "1";
  try {
    const invalidReferenceConfig = await import(`../../dist/config.js?invalid-reference=${Date.now()}`);
    await assert.rejects(() => invalidReferenceConfig.initializeConfig(), /不存在的 Profile/u);
  } finally {
    delete process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER;
    await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, persisted);
  }

  const snapshot = config.getConfigSnapshot();
  snapshot.profiles["raw-provider"] = {
    model: "raw-model", apiKey: "", baseURL: "https://raw-provider.test", providerType: "",
  };
  await config.commitConfigSnapshot(snapshot);
  assert.equal(config.listProfiles().find(profile => profile.name === "raw-provider")?.providerType, "openai-compatible");

  await config.upsertProfile("runtime-fallback", { model: "fallback", baseURL: "https://runtime-fallback.test" });
  assert.equal(config.switchProfile("runtime-fallback"), true);
  const live = config.loadConfig();
  const saved = live.profiles["runtime-fallback"];
  delete live.profiles["runtime-fallback"];
  assert.equal(config.getCurrentProfileName(), live.defaultProfile);
  live.profiles["runtime-fallback"] = saved;
  assert.equal(config.switchProfile(live.defaultProfile), true);
});

test("DS-09 domain credentials rotate transactionally and exports never contain secrets or references", async () => {
  const before = config.getConfigRevisionDigest();
  await assert.rejects(() => config.updateSettingsDomain("mcp", { servers: [
    { name: "duplicate", enabled: true, transport: "stdio", command: "one", args: [], url: "" },
    { name: "duplicate", enabled: true, transport: "stdio", command: "two", args: [], url: "" },
  ] }), /重复/u);
  assert.equal(config.getConfigRevisionDigest(), before);

  await config.updateSettingsDomain("asr", {
    provider: "volcengine", language: "zh-CN", endpoint: "https://asr.example.test", apiKey: "asr-secret-never-export", clearCredential: false,
  });
  const publicConfig = config.getPublicConfig();
  assert.deepEqual(publicConfig.domains.credentials, { asrConfigured: true, relayConfigured: false });
  assert.equal(Object.hasOwn(publicConfig.domains.asr, "credentialRef"), false);
  assert.equal(Object.hasOwn(publicConfig.domains.asr, "apiKey"), false);
  assert.equal(publicConfig.profiles.every(profile => !Object.hasOwn(profile, "apiKeyHint") && !Object.hasOwn(profile, "apiKey")), true);

  const bundle = config.exportSettings();
  const encoded = JSON.stringify(bundle);
  assert.doesNotMatch(encoded, /asr-secret-never-export|credentialRef|apiKey|accessToken/u);
  process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER = "1";
  const imported = config.prepareSettingsImport(bundle);
  assert.equal(typeof imported.domains.asr.credentialRef, "string");
  await config.validateAppSettingsPaths(imported.settings);

  const diskBytes = await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH);
  assert.equal(config.validatePersistedConfigBytes(diskBytes).includes(imported.domains.asr.credentialRef), true);
  delete process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER;
  await config.updateSettingsDomain("asr", { provider: "browser", language: "zh-CN", endpoint: "", apiKey: "", clearCredential: true });
  assert.equal(config.getPublicConfig().domains.credentials.asrConfigured, false);
});

test("DS-09 credential rollback preserves the original reference identity", async () => {
  await config.upsertProfile("rollback", { model: "rollback", baseURL: "https://rollback.test", apiKey: "old-secret" });
  const previous = config.getConfigSnapshot();
  const oldReference = previous.profiles.rollback.credentialRef;
  assert.match(oldReference, /^cred_[a-f0-9]{32}$/u);
  await config.upsertProfile("rollback", { apiKey: "new-secret" }, true);
  const stagedReference = config.getConfigSnapshot().profiles.rollback.credentialRef;
  assert.notEqual(stagedReference, oldReference);
  await config.commitConfigSnapshot(previous, true);
  await config.finalizeCredentialChanges();
  assert.equal(config.getConfigSnapshot().profiles.rollback.credentialRef, oldReference);
  const vault = JSON.parse(await fs.readFile(path.join(fixture, "credentials.vault.json"), "utf8"));
  assert.equal(Object.hasOwn(vault.entries, oldReference), true);
  assert.equal(Object.hasOwn(vault.entries, stagedReference), false);
  await config.deleteProfile("rollback");
});

test("DS-09 credential vault bounds writes and reconciles its persistent cleanup ledger", async () => {
  const vaultPath = path.join(fixture, "credentials.vault.json");
  const original = await fs.readFile(vaultPath).catch(() => null);
  try {
    const reference = await credentialStore.storeCredential("ledger-secret");
    let vault = JSON.parse(await fs.readFile(vaultPath, "utf8"));
    assert.equal(vault.schemaVersion, 2);
    assert.equal(vault.pendingDeletes.includes(reference), true);
    await credentialStore.reconcileCredentialRetirements([reference]);
    vault = JSON.parse(await fs.readFile(vaultPath, "utf8"));
    assert.equal(Object.hasOwn(vault.entries, reference), true);
    assert.deepEqual(vault.pendingDeletes, []);
    await credentialStore.stageCredentialRetirements([reference]);
    await credentialStore.reconcileCredentialRetirements([]);
    vault = JSON.parse(await fs.readFile(vaultPath, "utf8"));
    assert.equal(Object.hasOwn(vault.entries, reference), false);

    const fullEntries = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`cred_${index.toString(16).padStart(32, "0")}`, "AA=="]));
    await fs.writeFile(vaultPath, JSON.stringify({ schemaVersion: 2, entries: fullEntries, pendingDeletes: [] }));
    await assert.rejects(() => credentialStore.storeCredential("must-not-be-encrypted"), /capacity exceeded/u);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(vaultPath, "utf8")).entries).length, 1024);
  } finally {
    if (original) await fs.writeFile(vaultPath, original);
    else await fs.rm(vaultPath, { force: true });
  }
});
