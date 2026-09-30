import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "eco07-unit-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const routine = await import("../../src/routine.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

const inputSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const outputSchema = { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"], additionalProperties: false };

test("ECO-07 creates, searches, and reads a managed npm Routine project", async () => {
  const metadata = await routine.createRoutine({ id: "double", name: "Double", description: "double an integer", inputSchema, outputSchema, timeoutMs: 1000, source: "lux.done({ doubled: lux.input.value * 2 });" });
  assert.equal(metadata.id, "double");
  assert.deepEqual((await routine.searchRoutines("doubl")).map(item => item.id), ["double"]);
  const project = await routine.getRoutine("double");
  assert.match(project.source, /lux\.done/u);
  const packageJson = JSON.parse(await readFile(path.join(root, "routines", "double", "package.json"), "utf8"));
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.lux.routine.id, "double");
});

test("ECO-07 validates input before execution and output after completion", async () => {
  let executions = 0;
  await assert.rejects(
    () => routine.runRoutine("double", { value: "2" }, async () => { executions += 1; return { doubled: 4 }; }),
    /input rejected/u,
  );
  assert.equal(executions, 0);
  assert.deepEqual(await routine.runRoutine("double", { value: 2 }, async () => { executions += 1; return { doubled: 4 }; }), { doubled: 4 });
  assert.equal(executions, 1);
  await assert.rejects(() => routine.runRoutine("double", { value: 2 }, async () => ({ doubled: "4" })), /output rejected/u);
});

test("ECO-07 denies deletion while a Routine is running", async () => {
  let release;
  let markEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { markEntered = resolve; });
  const running = routine.runRoutine("double", { value: 3 }, async () => {
    markEntered();
    await gate;
    return { doubled: 6 };
  });
  await entered;
  assert.equal(routine.isRoutineRunning("double"), true);
  await assert.rejects(() => routine.deleteRoutine("double"), /running/u);
  release();
  assert.deepEqual(await running, { doubled: 6 });
  await routine.deleteRoutine("double");
  await assert.rejects(() => routine.getRoutine("double"));
});
