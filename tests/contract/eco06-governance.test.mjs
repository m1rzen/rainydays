import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEco06ResolvedManifest, validateEco06ResolvedManifest } from "../../scripts/eco06-governance.mjs";

const text = async relative => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
const staticTools = ["playbook_list", "playbook_create", "playbook_status", "playbook_archive", "playbook_unarchive", "playbook_delete"];
const dynamicTools = ["playbook_execute", "playbook_abort"];

test("ECO-06 registers the complete Playbook lifecycle and persona exposure", async () => {
  const [registry, policies, main, defaultPersona, generalPersona, playbookPersona] = await Promise.all([
    text("src/tools/index.ts"), text("src/tool-policies.ts"), text("src/index.ts"), text("personas/default.md"), text("personas/general.md"), text("personas/playbook.md"),
  ]);
  for (const name of staticTools) {
    assert.match(registry, new RegExp(`name: ["']${name}["']`, "u"), `${name} missing from static registry`);
    assert.match(policies, new RegExp(`\\b${name}: policy\\(`, "u"), `${name} missing from policy`);
  }
  for (const name of dynamicTools) {
    assert.match(main, new RegExp(`name: ["']${name}["']`, "u"), `${name} missing from dynamic registry`);
    assert.match(policies, new RegExp(`\\b${name}: policy\\(`, "u"), `${name} missing from runtime policy`);
  }
  for (const persona of [defaultPersona, generalPersona, playbookPersona]) {
    for (const name of [...staticTools, ...dynamicTools]) assert.match(persona, new RegExp(`^  - ${name}$`, "mu"));
  }
});

test("ECO-06 source provides npm ESM helpers, persistent evidence, singleton, and archive guards", async () => {
  const source = await text("src/playbook.ts");
  assert.match(source, /playbook\.mjs/u);
  assert.match(source, /AsyncLocalStorage/u);
  assert.match(source, /lux\.done may only be called once/u);
  assert.match(source, /runAgent/u);
  assert.match(source, /runParallel/u);
  assert.match(source, /runPipeline/u);
  assert.match(source, /runs.*latest\.json/su);
  assert.match(source, /artifacts/u);
  assert.match(source, /persist/u);
  assert.match(source, /already running/u);
  assert.match(source, /running and cannot be archived/u);
  assert.match(source, /running and cannot be deleted/u);
});

test("ECO-06 governed manifest binds focused runtime and test evidence", async () => {
  const manifest = await buildEco06ResolvedManifest();
  assert.equal(manifest.taskId, "ECO-06");
  assert.equal(manifest.testEntries.length, 3);
  assert.deepEqual(new Set(manifest.testEntries.map(entry => entry.layer)), new Set(["unit", "integration", "contract"]));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/playbook.ts"));
  await validateEco06ResolvedManifest(manifest);
});
