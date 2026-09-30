import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEco08ResolvedManifest, validateEco08ResolvedManifest } from "../../scripts/eco08-governance.mjs";

const text = relative => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
const browserTools = [
  "browser_open", "browser_close", "browser_tabs", "browser_new_tab", "browser_close_tab", "browser_snapshot",
  "browser_click", "browser_fill", "browser_type", "browser_press", "browser_scroll", "browser_screenshot",
  "browser_eval", "browser_back", "browser_forward", "browser_fetch",
];

test("ECO-08 registers exact browser tools, policies, and default/general persona access", async () => {
  const [registry, policies, definitions, defaultPersona, generalPersona] = await Promise.all([
    text("src/tools/index.ts"), text("src/tool-policies.ts"), text("src/tools/browser-tools.ts"), text("personas/default.md"), text("personas/general.md"),
  ]);
  for (const name of browserTools) {
    assert.match(registry, new RegExp(`name: ["']${name}["']`, "u"), `${name} missing from registry`);
    assert.match(definitions, new RegExp(`name: ["']${name}["']`, "u"), `${name} missing definition`);
    assert.match(policies, new RegExp(`\\b${name}: policy\\(`, "u"), `${name} missing policy`);
    assert.match(defaultPersona, new RegExp(`^  - ${name}$`, "mu"));
    assert.match(generalPersona, new RegExp(`^  - ${name}$`, "mu"));
  }
  for (const highRisk of ["browser_open", "browser_eval", "browser_fetch", "browser_click", "browser_fill", "browser_type"]) {
    assert.match(policies, new RegExp(`\\b${highRisk}: policy\\([^\\n]+"user"`, "u"), `${highRisk} must require approval`);
  }
});

test("ECO-08 binds real CDP, Extension RPC, ref invalidation, session isolation, and screenshot persistence", async () => {
  const source = await text("src/browser.ts");
  assert.match(source, /class CdpConnection/u);
  assert.match(source, /class ExtensionRpc/u);
  assert.match(source, /class CdpBrowserBackend/u);
  assert.match(source, /class ExtensionBrowserBackend/u);
  assert.match(source, /#sessions = new Map/u);
  assert.match(source, /Browser ref is stale or unknown/u);
  assert.match(source, /Page\.captureScreenshot/u);
  assert.match(source, /credentials:'include'/u);
  assert.match(source, /data-rainydays-ref/u);
});

test("ECO-08 governed manifest binds runtime and three focused evidence layers", async () => {
  const manifest = await buildEco08ResolvedManifest();
  assert.equal(manifest.taskId, "ECO-08");
  assert.equal(manifest.runtimeEntries.length, 11);
  assert.equal(manifest.testEntries.length, 3);
  assert.deepEqual(new Set(manifest.testEntries.map(entry => entry.layer)), new Set(["unit", "integration", "contract"]));
  await validateEco08ResolvedManifest(manifest);
});
