import assert from "node:assert/strict";
import test from "node:test";
import { prepareAppSettingsUpdate, validateAppSettingsPaths, validatePersistedConfigBytes } from "../../dist/config.js";

const legacy = { defaultProfile: "default", profiles: { default: { model: "fixture", apiKey: "", baseURL: "https://provider.invalid" } },
  settings: { defaultPersona: "general", workspaceRoot: "C:\\本地 资料", departmentDataRoot: "Z:\\部门资料", outputDir: "C:\\本地 成果" } };

test("D05 old configuration retains its company path without enabling that source", () => {
  assert.deepEqual(validatePersistedConfigBytes(Buffer.from(JSON.stringify(legacy)), { allowLegacyPlaintext: true }), []);
  const candidate = prepareAppSettingsUpdate({}, legacy);
  assert.equal(candidate.settings.departmentDataRoot, "Z:\\部门资料");
  assert.equal(candidate.settings.departmentEnabled, false);
});

test("D05 disabled optional source accepts an empty path; enabled source requires a path and a boolean switch", async () => {
  const candidate = prepareAppSettingsUpdate({ departmentEnabled: false, departmentDataRoot: "" }, legacy);
  assert.equal(candidate.settings.departmentDataRoot, "");
  await validateAppSettingsPaths(candidate.settings);
  assert.throws(() => prepareAppSettingsUpdate({ departmentEnabled: true, departmentDataRoot: "" }, legacy), /部门资料.*目录/);
  assert.throws(() => prepareAppSettingsUpdate({ departmentEnabled: "false" }, legacy), /departmentEnabled/);
  const persisted = { ...legacy, settings: { ...candidate.settings } };
  assert.deepEqual(validatePersistedConfigBytes(Buffer.from(JSON.stringify(persisted)), { allowLegacyPlaintext: true }), []);
});
