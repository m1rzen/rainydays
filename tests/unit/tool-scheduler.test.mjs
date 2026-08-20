import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolExecutionBatches,
  isParallelReadPolicy,
  toolCallsConflict,
} from "../../dist/tool-scheduler.js";

const parallelFileRead = Object.freeze({
  riskClasses: Object.freeze(["read"]),
  approval: "none",
  effects: Object.freeze(["filesystem"]),
  pathOperations: Object.freeze(["read-file"]),
  concurrency: "parallel-read",
});
const parallelNetworkRead = Object.freeze({
  riskClasses: Object.freeze(["read", "network"]),
  approval: "none",
  effects: Object.freeze(["network"]),
  pathOperations: Object.freeze([]),
  concurrency: "parallel-read",
});
const serialRead = Object.freeze({
  riskClasses: Object.freeze(["read"]),
  approval: "none",
  effects: Object.freeze([]),
  pathOperations: Object.freeze([]),
});
const serialWrite = Object.freeze({
  riskClasses: Object.freeze(["write"]),
  approval: "user",
  effects: Object.freeze(["filesystem"]),
  pathOperations: Object.freeze(["replace-file"]),
});

function call(originalIndex, policy, dependsOn) {
  return Object.freeze({ originalIndex, policy, ...(dependsOn ? { dependsOn: Object.freeze(dependsOn) } : {}) });
}

test("RT-06 scheduler builds stable contiguous read batches around serial barriers", () => {
  const calls = [
    call(0, parallelFileRead),
    call(1, parallelNetworkRead),
    call(2, serialWrite),
    call(3, parallelFileRead),
    call(4, serialRead),
    call(5, parallelNetworkRead),
  ];
  const batches = buildToolExecutionBatches(calls);
  assert.deepEqual(
    batches.map(batch => ({ mode: batch.mode, indices: batch.calls.map(entry => entry.originalIndex) })),
    [
      { mode: "parallel-read", indices: [0, 1] },
      { mode: "serial", indices: [2] },
      { mode: "parallel-read", indices: [3] },
      { mode: "serial", indices: [4] },
      { mode: "parallel-read", indices: [5] },
    ],
  );
  assert(Object.isFrozen(batches));
  assert(batches.every(batch => Object.isFrozen(batch) && Object.isFrozen(batch.calls)));
});

test("RT-06 scheduler turns dependency edges into deterministic barriers", () => {
  const first = call(0, parallelFileRead);
  const dependent = call(1, parallelNetworkRead, [0]);
  const independent = call(2, parallelFileRead);
  assert.equal(toolCallsConflict(first, dependent), true);
  assert.equal(toolCallsConflict(dependent, independent), false);
  assert.deepEqual(
    buildToolExecutionBatches([first, dependent, independent]).map(batch => batch.calls.map(entry => entry.originalIndex)),
    [[0], [1, 2]],
  );
});

test("RT-06 scheduler fails closed on forged parallel metadata and invalid graphs", () => {
  const forged = {
    ...serialWrite,
    concurrency: "parallel-read",
  };
  assert.equal(isParallelReadPolicy(forged), false);
  assert.throws(() => buildToolExecutionBatches([call(0, forged)]), /outside the read-only scheduling envelope/u);
  assert.throws(() => buildToolExecutionBatches([call(0, parallelFileRead), call(0, parallelFileRead)]), /duplicated/u);
  assert.throws(() => buildToolExecutionBatches([call(1, parallelFileRead, [0])]), /dependency is missing/u);
  assert.throws(() => buildToolExecutionBatches([call(0, parallelFileRead, [0])]), /dependency is invalid/u);
});
