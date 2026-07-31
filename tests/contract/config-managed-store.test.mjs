import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-config-"));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
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
  assert.match(config.getConfigRevisionDigest(), /^[a-f0-9]{64}$/u);
});

test("SEC-02 provider mutations publish memory only after atomic persistence", async () => {
  await assert.rejects(() => config.upsertProfile("bad/name", { model: "m", baseURL: "https://example.test" }), /Profile 名称/);
  await assert.rejects(() => config.upsertProfile("missing-model", { baseURL: "https://example.test" }), /缺少 model/);
  await assert.rejects(() => config.upsertProfile("bad-url", { model: "m", baseURL: "file:///tmp/model" }), /只允许 http 或 https/);

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
  assert.equal(profile.apiKeyHint, "sec••••3456");
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
  });
  assert.equal(normalized.defaultProfile, "broken");
  assert.equal(typeof normalized.settings.defaultPersona, "string");
  assert.equal(path.isAbsolute(normalized.settings.workspaceRoot), true);

  await assert.rejects(() => config.upsertProfile("missing-base", { model: "m" }), /缺少 baseURL/);
  await assert.rejects(() => config.upsertProfile("invalid-url", { model: "m", baseURL: "not a url" }), /有效的 URL/);
  await config.upsertProfile("short-key", { model: "m", baseURL: "https://example.test", apiKey: "short", providerType: "" });
  const short = config.listProfiles().find(profile => profile.name === "short-key");
  assert.equal(short.apiKeyHint, "••••••••");
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
