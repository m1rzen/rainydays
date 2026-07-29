import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { terminateProcessTree } from "../../dist/process-tree.js";

// A non-existent PID forces taskkill to return non-zero without touching a real process.
test("SEC-02 an already-exited process root cannot claim descendant cleanup", async () => {
  const fakeChild = new EventEmitter();
  Object.assign(fakeChild, {
    pid: 42_424,
    exitCode: 0,
    signalCode: null,
    killCalls: 0,
    kill() { this.killCalls += 1; return true; },
  });
  await assert.rejects(
    () => terminateProcessTree(fakeChild, 5_000),
    error => error?.code === "PATH_LIFECYCLE_FAILED"
  );
  assert.equal(fakeChild.killCalls, 0);
});

test("SEC-02 process-tree rejects invalid deadlines and unverifiable process roots", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 0, exitCode: null, signalCode: null, kill() { return true; } });
  for (const timeout of [0, 60_001, Number.NaN]) await assert.rejects(() => terminateProcessTree(child, timeout), TypeError);
  await assert.rejects(() => terminateProcessTree(child, 100), error => error?.code === "PATH_LIFECYCLE_FAILED");
});

test("SEC-02 Windows process-tree termination fails closed on taskkill failure", { skip: process.platform !== "win32" }, async () => {
  const fakeChild = new EventEmitter();
  Object.assign(fakeChild, {
    pid: 2_147_483_646,
    exitCode: null,
    signalCode: null,
    killCalls: 0,
    kill() { this.killCalls += 1; return true; },
  });
  await assert.rejects(
    () => terminateProcessTree(fakeChild, 5_000),
    error => error?.code === "PATH_LIFECYCLE_FAILED"
  );
  assert.equal(fakeChild.killCalls, 1, "failure path did not attempt best-effort direct-child cleanup");
});
