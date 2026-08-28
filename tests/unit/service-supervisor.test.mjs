import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import supervisorModule from "../../electron/service-supervisor.cjs";

const { ServiceSupervisor } = supervisorModule;

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
  }
}

function fakeScheduler() {
  const pending = [];
  return {
    pending,
    setTimer(callback, delay) {
      const handle = { callback, delay, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimer(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    fireNext() {
      const handle = pending.shift();
      assert(handle, "restart timer is missing");
      handle.callback();
      return handle.delay;
    },
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

test("RT-10 supervisor restarts an exited service with bounded exponential backoff", async () => {
  const scheduler = fakeScheduler();
  const children = [];
  const states = [];
  const supervisor = new ServiceSupervisor({
    launch: async ({ generation }) => {
      const child = new FakeChild(10_000 + generation);
      children.push(child);
      return child;
    },
    terminate: async () => undefined,
    onState: state => states.push(state),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 100,
    backoffCapMs: 400,
    crashWindowMs: 10_000,
    maxRestarts: 4,
  });

  assert.equal((await supervisor.start()).phase, "ready");
  children[0].emit("exit", 1, null);
  assert.deepEqual({ phase: supervisor.snapshot().phase, delay: scheduler.pending[0].delay }, { phase: "backoff", delay: 100 });
  assert.equal(scheduler.fireNext(), 100);
  await flush();
  assert.equal(supervisor.snapshot().phase, "ready");
  assert.equal(supervisor.snapshot().generation, 2);

  children[1].emit("exit", 1, null);
  assert.equal(scheduler.fireNext(), 200);
  await flush();
  assert.equal(supervisor.snapshot().generation, 3);
  assert(states.some(state => state.failure === "unexpected-exit"));
  await supervisor.shutdown();
});

test("RT-10 supervisor converts a failed health probe into a supervised restart", async () => {
  const scheduler = fakeScheduler();
  const children = [];
  const reasons = [];
  const supervisor = new ServiceSupervisor({
    launch: async ({ generation }) => {
      const child = new FakeChild(15_000 + generation);
      children.push(child);
      return child;
    },
    terminate: async (child, reason) => {
      reasons.push(reason);
      child.emit("exit", null, "SIGTERM");
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 75,
    backoffCapMs: 300,
    crashWindowMs: 10_000,
    maxRestarts: 3,
  });

  await supervisor.start();
  assert.equal(await supervisor.restart(), true);
  assert.deepEqual(reasons, ["health-check-failed"]);
  assert.equal(supervisor.snapshot().phase, "backoff");
  assert.equal(scheduler.fireNext(), 75);
  await flush();
  assert.equal(supervisor.snapshot().phase, "ready");
  assert.equal(children.length, 2);
  await supervisor.shutdown();
});

test("RT-10 supervisor does not miss an exit that races with readiness", async () => {
  const scheduler = fakeScheduler();
  let attempts = 0;
  const supervisor = new ServiceSupervisor({
    launch: async () => {
      attempts += 1;
      const child = new FakeChild(18_000 + attempts);
      if (attempts === 1) child.exitCode = 1;
      return child;
    },
    terminate: async () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 60,
    backoffCapMs: 240,
    crashWindowMs: 10_000,
    maxRestarts: 3,
  });

  const started = supervisor.start();
  await flush();
  assert.equal(supervisor.snapshot().phase, "backoff");
  assert.equal(scheduler.fireNext(), 60);
  assert.equal((await started).phase, "ready");
  assert.equal(attempts, 2);
  await supervisor.shutdown();
});

test("RT-10 supervisor retries readiness failures and resolves start only after a ready child", async () => {
  const scheduler = fakeScheduler();
  let attempts = 0;
  const supervisor = new ServiceSupervisor({
    launch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("readiness failed");
      return new FakeChild(20_000 + attempts);
    },
    terminate: async () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 50,
    backoffCapMs: 200,
    crashWindowMs: 10_000,
    maxRestarts: 3,
  });

  const started = supervisor.start();
  await flush();
  assert.equal(supervisor.snapshot().phase, "backoff");
  assert.equal(scheduler.fireNext(), 50);
  assert.equal((await started).phase, "ready");
  assert.equal(attempts, 2);
  await supervisor.shutdown();
});

test("RT-10 supervisor enters crash-loop after the bounded restart budget", async () => {
  const scheduler = fakeScheduler();
  const children = [];
  const supervisor = new ServiceSupervisor({
    launch: async ({ generation }) => {
      const child = new FakeChild(30_000 + generation);
      children.push(child);
      return child;
    },
    terminate: async () => undefined,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 25,
    backoffCapMs: 100,
    crashWindowMs: 10_000,
    maxRestarts: 2,
  });

  await supervisor.start();
  children[0].emit("exit", 1, null);
  scheduler.fireNext();
  await flush();
  children[1].emit("exit", 1, null);
  scheduler.fireNext();
  await flush();
  children[2].emit("exit", 1, null);

  assert.equal(supervisor.snapshot().phase, "crash-loop");
  assert.equal(supervisor.snapshot().restartCount, 3);
  assert.equal(scheduler.pending.length, 0);
  await supervisor.shutdown();
});

test("RT-10 supervisor shutdown cancels backoff and never relaunches", async () => {
  const scheduler = fakeScheduler();
  const children = [];
  const terminated = [];
  const supervisor = new ServiceSupervisor({
    launch: async ({ generation }) => {
      const child = new FakeChild(40_000 + generation);
      children.push(child);
      return child;
    },
    terminate: async (child, reason) => {
      terminated.push({ child, reason });
      child.emit("exit", 0, null);
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    backoffBaseMs: 100,
    backoffCapMs: 400,
    crashWindowMs: 10_000,
    maxRestarts: 3,
  });

  await supervisor.start();
  children[0].emit("exit", 1, null);
  assert.equal(scheduler.pending.length, 1);
  await supervisor.shutdown();
  assert.equal(supervisor.snapshot().phase, "stopped");
  assert.equal(scheduler.pending.length, 0);
  assert.equal(children.length, 1);
  assert.equal(terminated.length, 0, "already-exited child must not be terminated twice");
});
