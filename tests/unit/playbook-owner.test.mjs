import assert from "node:assert/strict";
import test from "node:test";
import {
  abortRun,
  createPlaybookExecuteExec,
  createRun,
  getRunStatus,
  listActiveRuns,
} from "../../dist/playbook.js";
import { RunCancellationError } from "../../dist/run-cancellation.js";
import { assertSec01Probe } from "../sec01-probe.mjs";

const ownerA = Object.freeze({ sessionId: "session-a", runId: "agent-run-a" });
const ownerB = Object.freeze({ sessionId: "session-b", runId: "agent-run-b" });
const laterRunA = Object.freeze({ sessionId: "session-a", runId: "agent-run-later" });

test("SEC-01 Playbook status and abort are bound to Session/run lineage", () => {
  const run = createRun("owner-probe", 3, ownerA);
  assert.equal(getRunStatus(run.id, ownerA)?.id, run.id);
  assert.equal(getRunStatus(run.id, ownerB), undefined);
  assert.equal(getRunStatus(run.id, laterRunA), undefined);
  assert.deepEqual(listActiveRuns(ownerB), []);
  assert.deepEqual(listActiveRuns(laterRunA), []);
  assert.equal(abortRun(run.id, ownerB), false);
  assert.equal(abortRun(run.id, laterRunA), false);
  assert.equal(getRunStatus(run.id, ownerA)?.status, "running");
  assertSec01Probe("SEC01-A19", "playbook-run-state", [getRunStatus(run.id, ownerB) ?? null, getRunStatus(run.id, ownerA)?.status ?? null], [null, "running"]);
  assert.equal(abortRun(run.id, ownerA), true);
  assert.equal(getRunStatus(run.id, ownerA)?.status, "aborted");
});

test("RT-04 pre-cancelled playbook performs no file or LLM work and finishes its child context once", async () => {
  const reason = new RunCancellationError("RUN_CANCELLED", "playbook cancelled");
  const preCancelled = new AbortController();
  preCancelled.abort(reason);
  const child = { sessionId: "session-a", runId: "run-a" };
  let finishes = 0;
  const invocation = {
    signal: preCancelled.signal,
    deriveChild: () => child,
    finishChild: candidate => { assert.equal(candidate, child); finishes += 1; },
    getToolDefinitions: () => [],
    executeTool: async () => "unreachable",
  };
  const playbookExecutor = createPlaybookExecuteExec({ chat: async () => { throw new Error("LLM must not run"); } }, { systemPrompt: "playbook fixture" });
  await assert.rejects(
    () => playbookExecutor({ name: "must-not-read" }, undefined, invocation),
    error => error === reason,
  );
  assert.equal(finishes, 1);
});
