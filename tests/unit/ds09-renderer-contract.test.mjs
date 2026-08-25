import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const [html, renderer, css] = await Promise.all([
  fs.readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
  fs.readFile(path.join(projectRoot, "public", "renderer.js"), "utf8"),
  fs.readFile(path.join(projectRoot, "public", "renderer.css"), "utf8"),
]);
const domains = ["common", "profiles", "mcp", "wire", "animas", "nous", "tts", "asr", "shell", "relay", "update"];

function ordered(source, snippets, label) {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = source.indexOf(snippet, cursor + 1);
    assert(next > cursor, `${label} is missing or reordered: ${snippet}`);
    cursor = next;
  }
}

test("DS-09 renderer exposes every frozen Settings tab and delegated action", () => {
  for (const domain of domains) assert.match(html, new RegExp(`data-settings-domain=["']${domain}["']`, "u"));
  for (const action of ["select-settings-domain", "save-settings-domain", "choose-settings-directory", "export-settings", "choose-settings-import", "import-settings"]) {
    assert.match(renderer, new RegExp(`"${action}"\\s*:`, "u"));
  }
  assert.match(renderer, /settingsState\.domainManifest/u);
  assert.match(renderer, /switchSettingsDomain\(activeSettingsDomain\)/u);
  assert.match(css, /\.settings-domain-tab\.active/u);
});

test("DS-09 renderer applies only real immediate adapters and never repopulates secrets", () => {
  ordered(renderer, [
    "function applyImmediateSettings(domains)",
    "ttsPreferences =",
    "asrPreferences =",
  ], "immediate Settings adapters");
  assert.match(renderer, /ttsUtterance\.lang = ttsPreferences\.language/u);
  assert.match(renderer, /asrRecognition\.lang = asrPreferences\.language/u);
  assert.match(renderer, /document\.getElementById\("provider-api-key"\)\.value = ""/u);
  assert.match(renderer, /setSettingsControl\("setting-asr-api-key", ""\)/u);
  assert.match(renderer, /setSettingsControl\("setting-relay-token", ""\)/u);
  assert.doesNotMatch(renderer, /apiKeyHint/u);
  assert.match(html, /id="setting-asr-provider"[^>]*disabled/u);
  assert.match(html, /id="setting-asr-endpoint"[^>]*disabled/u);
  assert.match(html, /id="setting-asr-api-key"[^>]*disabled/u);
});

test("DS-09 Common and import use revision-bound atomic server operations", () => {
  const common = renderer.slice(renderer.indexOf("async function saveGeneralSettings"), renderer.indexOf("async function saveProvider"));
  assert.match(common, /expectedRevision: settingsState\.revision/u);
  assert.match(common, /common: readSettingsDomain\("common"\)/u);
  assert.match(renderer, /\/api\/settings\/domains\/\$\{encodeURIComponent\(domainId\)\}/u);
  assert.match(renderer, /\/api\/settings\/import/u);
  assert.match(renderer, /file\.size > 1024 \* 1024/u);
  assert.match(renderer, /敏感凭据保持本机原值/u);
  assert.match(renderer, /electronAPI\?\.selectDirectory/u);
});

test("DS-09 renderer rejects stale Settings responses and preserves unsaved domain drafts", () => {
  assert.match(renderer, /let settingsRequestGeneration = 0/u);
  assert.match(renderer, /const settingsDirtyDomains = new Set\(\)/u);
  assert.match(renderer, /generation !== settingsRequestGeneration/u);
  assert.match(renderer, /function captureDirtySettingsControls\(\)/u);
  assert.match(renderer, /function renderSettingsPreservingDirty\(\)/u);
  assert.match(renderer, /settingsDirtyDomains\.delete\(domainId\)/u);
  assert.match(renderer, /settingsModal\.addEventListener\("input", markSettingsDirty\)/u);
});
