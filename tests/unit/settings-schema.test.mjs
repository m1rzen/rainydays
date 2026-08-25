import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneSettingsDomains,
  defaultSettingsDomains,
  parseSettingsDomains,
  publicSettingsDomains,
  settingsDomainManifest,
} from "../../dist/settings-schema.js";

const expectedTabs = ["common", "profiles", "mcp", "wire", "animas", "nous", "tts", "asr", "shell", "relay", "update"];

test("DS-09 Settings manifest matches the frozen Lux tab order and effect surface", () => {
  const manifest = settingsDomainManifest();
  assert.deepEqual(manifest.map(domain => domain.id), expectedTabs);
  assert.deepEqual(manifest.map(domain => domain.label), ["Common", "Profiles", "MCP", "Wire", "Animas", "Nous", "TTS", "ASR", "Shell", "Relay", "Update"]);
  assert.equal(manifest.find(domain => domain.id === "profiles").fields.find(field => field.key === "apiKey").sensitive, true);
  const asr = manifest.find(domain => domain.id === "asr");
  assert.equal(asr.fields.find(field => field.key === "apiKey").sensitive, true);
  assert.equal(asr.fields.find(field => field.key === "language").applyMode, "immediate");
  assert.equal(asr.fields.find(field => field.key === "provider").applyMode, "unavailable");
  assert.equal(asr.fields.find(field => field.key === "endpoint").applyMode, "unavailable");
  assert.equal(asr.fields.find(field => field.key === "apiKey").applyMode, "unavailable");
  assert.equal(manifest.find(domain => domain.id === "mcp").available, false);
  assert.equal(manifest.find(domain => domain.id === "tts").applyMode, "immediate");
});

test("DS-09 Settings parser is exact, bounded and URL-safe", () => {
  const defaults = defaultSettingsDomains();
  assert.deepEqual(parseSettingsDomains(defaults), defaults);
  assert.deepEqual(cloneSettingsDomains(defaults), defaults);

  assert.throws(() => parseSettingsDomains({ ...defaults, unknown: {} }), /字段无效/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, common: { ...defaults.common, maxIterations: 0 } }), /maxIterations/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, common: { ...defaults.common, yoloMode: true } }), /不能绕过 SEC-02/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, tts: { ...defaults.tts, rate: 3 } }), /TTS rate/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, relay: { ...defaults.relay, url: "https://relay.example" } }), /Relay URL/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, asr: { ...defaults.asr, endpoint: "https://user:secret@example.test" } }), /ASR endpoint/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, mcp: { servers: [
    { name: "same", enabled: true, transport: "stdio", command: "one", args: [], url: "" },
    { name: "same", enabled: true, transport: "stdio", command: "two", args: [], url: "" },
  ] } }), /重复/u);
  assert.throws(() => parseSettingsDomains({ ...defaults, wire: { sources: [
    { name: "wire", enabled: true, url: "ws://insecure.example", eventPattern: "github:*" },
  ] } }), /Wire URL/u);
});

test("DS-09 public projection strips credential references without mutating state", () => {
  const defaults = defaultSettingsDomains();
  defaults.asr.credentialRef = "cred_asr";
  defaults.relay.credentialRef = "cred_relay";
  const projected = publicSettingsDomains(defaults);
  assert.deepEqual(projected.credentials, { asrConfigured: true, relayConfigured: true });
  assert.equal(Object.hasOwn(projected.asr, "credentialRef"), false);
  assert.equal(Object.hasOwn(projected.relay, "credentialRef"), false);
  assert.equal(defaults.asr.credentialRef, "cred_asr");
  assert.equal(defaults.relay.credentialRef, "cred_relay");
  assert.doesNotMatch(JSON.stringify(projected), /cred_asr|cred_relay/u);
});
