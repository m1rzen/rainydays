import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "eco07-integration-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const core = await import("../../src/routine.ts");
const tools = await import("../../src/tools/routine-tools.ts");
const scriptRuntime = await import("../../src/script-runtime.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

const inputSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const outputSchema = { type: "object", properties: { result: { type: "integer" } }, required: ["result"], additionalProperties: false };

function runNode(payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", payload], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("ECO-07 routine bridge exposes frozen input and structured lux.done", async () => {
  const completionToken = "0123456789abcdef0123456789abcdef";
  const payload = scriptRuntime.createScriptPayload({
    code: "lux.input.value = 9; lux.done({ result: lux.input.value + 1 });",
    lang: "node",
    mode: "routine",
    routineInput: { value: 2 },
    completionToken,
  });
  const executed = await runNode(payload.payload, root);
  assert.notEqual(executed.code, 0);
  assert.match(executed.stderr, /read only|read-only|Cannot assign/iu);

  const successful = scriptRuntime.createScriptPayload({ code: "lux.done({ result: lux.input.value + 1 });", lang: "node", mode: "routine", routineInput: { value: 2 }, completionToken });
  const result = await runNode(successful.payload, root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${scriptRuntime.ROUTINE_DONE_PREFIX}${completionToken}:{"result":3}`);
  assert.throws(() => scriptRuntime.parseScriptTimeout(10_001), /100-10000/u);
});

test("ECO-07 routine_run binds managed source and validates structured completion", async () => {
  await core.createRoutine({ id: "increment", name: "Increment", description: "", inputSchema, outputSchema, timeoutMs: 750, source: "lux.done({ result: lux.input.value + 1 });" });
  const calls = [];
  const invocation = {
    execution: {
      executeScript: async input => {
        calls.push(input);
        return { stdout: `${scriptRuntime.ROUTINE_DONE_PREFIX}${input.completionToken}:{"result":5}\n`, stderr: "", exitCode: 0, reason: "completed", outputTruncated: false };
      },
    },
  };
  const output = JSON.parse(await tools.routineRunExec({ id: "increment", input: { value: 4 } }, undefined, invocation));
  assert.deepEqual(output, { result: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "routine");
  assert.equal(calls[0].routineId, "increment");
  assert.match(calls[0].completionToken, /^[a-f0-9]{32}$/u);
  assert.equal(calls[0].timeoutMs, 750);
  assert.deepEqual(calls[0].routineInput, { value: 4 });

  const noDone = { execution: { executeScript: async () => ({ stdout: "log only\n", stderr: "", exitCode: 0, reason: "completed", outputTruncated: false }) } };
  await assert.rejects(() => tools.routineRunExec({ id: "increment", input: { value: 4 } }, undefined, noDone), /lux\.done exactly once/u);
  await core.deleteRoutine("increment");
});
