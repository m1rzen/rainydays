import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEco07ResolvedManifest, validateEco07ResolvedManifest } from "../../scripts/eco07-governance.mjs";

const text = async relative => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");

const toolNames = ["routine_search", "routine_get", "routine_create", "routine_delete", "routine_run"];

test("ECO-07 statically registers exact Routine tools, policies, and personas", async () => {
  const [registry, policies, defaultPersona, generalPersona, routinePersona] = await Promise.all([
    text("src/tools/index.ts"), text("src/tool-policies.ts"), text("personas/default.md"), text("personas/general.md"), text("personas/routine.md"),
  ]);
  for (const name of toolNames) {
    assert.match(registry, new RegExp(`name: ["']${name}["']`, "u"), `${name} missing from registry`);
    assert.match(policies, new RegExp(`\\b${name}: policy\\(`, "u"), `${name} missing from policy`);
    assert.match(defaultPersona, new RegExp(`^  - ${name}$`, "mu"));
    assert.match(generalPersona, new RegExp(`^  - ${name}$`, "mu"));
    assert.match(routinePersona, new RegExp(`^  - ${name}$`, "mu"));
  }
  assert.match(policies, /routine_run: policy\([^\n]+"process"[^\n]+\["initial-cwd"\], "read-write"\)/u);
});

test("ECO-07 binds managed project storage to finite Routine execution", async () => {
  const [managed, runtimePaths, execution, scriptRuntime, routine] = await Promise.all([
    text("src/managed-path-store.ts"), text("src/runtime-paths.ts"), text("src/execution-runtime.ts"), text("src/script-runtime.ts"), text("src/routine.ts"),
  ]);
  assert.match(runtimePaths, /export const ROUTINES_DIR/u);
  assert.match(managed, /createRoutineProject/u);
  assert.match(managed, /withRoutineExecutionRoot/u);
  assert.match(managed, /removeRoutineProject/u);
  assert.match(execution, /inspected\.name !== "routine_run"/u);
  assert.match(execution, /root\.rootId === "routines"/u);
  assert.match(scriptRuntime, /ROUTINE_DONE_PREFIX/u);
  assert.match(scriptRuntime, /lux\.done may only be called once/u);
  assert.match(routine, /input rejected/u);
  assert.match(routine, /output rejected/u);
  assert.match(routine, /is running and cannot be deleted/u);
});

test("ECO-07 governed manifest binds all focused runtime and test evidence", async () => {
  const manifest = await buildEco07ResolvedManifest();
  assert.equal(manifest.taskId, "ECO-07");
  assert.equal(manifest.testEntries.length, 3);
  assert.deepEqual(new Set(manifest.testEntries.map(entry => entry.layer)), new Set(["unit", "integration", "contract"]));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/routine.ts"));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/tools/routine-tools.ts"));
  await validateEco07ResolvedManifest(manifest);
});
