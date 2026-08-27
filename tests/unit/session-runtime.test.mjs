import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionRuntimeLifecycleError,
  SessionRuntimeRegistry,
} from "../../dist/session-runtime.js";
import { RunCancellationError, RunSettlementError } from "../../dist/run-cancellation.js";

function deferred() {
  return Promise.withResolvers();
}

function lifecycleCode(code) {
  return error => error instanceof SessionRuntimeLifecycleError && error.code === code;
}

test("RT-01 SessionRuntimeRegistry deduplicates one Session create while different Sessions prepare concurrently", async () => {
  const gates = new Map();
  const starts = [];
  const registry = new SessionRuntimeRegistry(async identity => {
    starts.push(identity);
    const gate = deferred();
    gates.set(identity.sessionId, gate);
    await gate.promise;
    return { identity, marker: identity.sessionId };
  }, async () => undefined);

  const firstA = registry.ensure("session-a");
  const secondA = registry.ensure("session-a");
  const firstB = registry.ensure("session-b");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts.map(entry => entry.sessionId).sort(), ["session-a", "session-b"]);
  gates.get("session-b").resolve();
  const runtimeB = await firstB;
  assert.equal(runtimeB.marker, "session-b");
  gates.get("session-a").resolve();
  const [runtimeA, duplicateA] = await Promise.all([firstA, secondA]);
  assert.equal(runtimeA, duplicateA);
  assert.equal(await registry.ensure("session-a"), runtimeA);
  assert.equal(registry.size, 2);
  await registry.shutdown();
});

test("RT-01 SessionRuntimeRegistry run claims are authentic and single-flight per Session", async () => {
  const retired = [];
  const registry = new SessionRuntimeRegistry(
    identity => ({ identity }),
    async runtime => { retired.push(runtime); },
  );
  const runtimeA = await registry.ensure("session-a");
  const runtimeB = await registry.ensure("session-b");
  assert.equal(registry.get("session-a"), runtimeA);
  assert.equal(registry.get("missing"), undefined);
  assert.deepEqual(new Set(registry.loadedSessionIds()), new Set(["session-a", "session-b"]));
  assert.equal(registry.hasRunningSessions(), false);
  const claimA = registry.claimRun("session-a", "run-a");
  const claimB = registry.claimRun("session-b", "run-b");
  assert.equal(claimA.runtime, runtimeA);
  assert.equal(claimB.runtime, runtimeB);
  assert.equal(registry.isRunning("session-a"), true);
  assert.equal(registry.hasRunningSessions(), true);
  assert.throws(() => registry.claimRun("session-a", "run-a-next"), lifecycleCode("SESSION_RUNTIME_BUSY"));
  assert.throws(() => registry.releaseRun({ ...claimA }), lifecycleCode("SESSION_RUNTIME_CLAIM_FORGED"));
  await assert.rejects(() => registry.retire("session-a"), lifecycleCode("SESSION_RUNTIME_BUSY"));
  await assert.rejects(() => registry.replace("session-b"), lifecycleCode("SESSION_RUNTIME_BUSY"));
  registry.releaseRun(claimA);
  assert.throws(() => registry.releaseRun(claimA), lifecycleCode("SESSION_RUNTIME_CLAIM_STALE"));
  assert.equal(await registry.retire("session-a"), true);
  assert.equal(await registry.retire("session-a"), false);
  const replacementA = await registry.ensure("session-a");
  assert.notEqual(replacementA, runtimeA);
  assert.equal(replacementA.identity.generation, 2);
  registry.releaseRun(claimB);
  await registry.shutdown();
  assert.deepEqual(new Set(retired), new Set([runtimeA, runtimeB, replacementA]));
});

test("RT-01 replacement invalidates an in-flight prepare and never publishes its stale runtime", async () => {
  const creates = [];
  const retired = [];
  const gates = [];
  const registry = new SessionRuntimeRegistry(async identity => {
    creates.push(identity);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return { identity, ordinal: creates.length };
  }, async (runtime, identity) => { retired.push({ runtime, identity }); });

  const staleEnsure = registry.ensure("session-a");
  await new Promise(resolve => setImmediate(resolve));
  const replacement = registry.replace("session-a");
  gates[0].resolve();
  await assert.rejects(() => staleEnsure, lifecycleCode("SESSION_RUNTIME_STALE"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates.length, 2);
  gates[1].resolve();
  const current = await replacement;
  assert.equal(current.identity.generation, 2);
  assert.equal(await registry.ensure("session-a"), current);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].runtime.identity.generation, 1);
  assert.deepEqual(retired[0].identity, { sessionId: "session-a", generation: 1 });
  await registry.shutdown();
  assert.equal(retired.length, 2);
});

test("RT-01 same-Session lifecycle mutations serialize without blocking another Session", async () => {
  const retireGate = deferred();
  const retireStarted = deferred();
  const registry = new SessionRuntimeRegistry(
    identity => ({ identity }),
    async (_runtime, identity) => {
      if (identity.sessionId === "session-a" && identity.generation === 1) {
        retireStarted.resolve();
        await retireGate.promise;
      }
    },
  );
  const originalA = await registry.ensure("session-a");
  const originalB = await registry.ensure("session-b");
  const firstReplace = registry.replace("session-a");
  const secondReplace = registry.replace("session-a");
  await retireStarted.promise;
  assert.equal(await registry.ensure("session-b"), originalB);
  let firstSettled = false;
  void firstReplace.then(() => { firstSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstSettled, false);
  retireGate.resolve();
  const first = await firstReplace;
  const second = await secondReplace;
  assert.notEqual(first, originalA);
  assert.notEqual(second, first);
  assert.equal(second.identity.generation, 3);
  assert.equal(await registry.ensure("session-a"), second);
  await registry.shutdown();
});

test("RT-01 shutdown closes ingress, invalidates claims, and drains pending stale prepares", async () => {
  const createGate = deferred();
  const retired = [];
  const registry = new SessionRuntimeRegistry(async identity => {
    await createGate.promise;
    return { identity };
  }, async runtime => { retired.push(runtime); });
  const pending = registry.ensure("session-a");
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = registry.shutdown();
  assert.equal(registry.closed, true);
  await assert.rejects(() => registry.ensure("session-a"), lifecycleCode("SESSION_RUNTIME_CLOSED"));
  assert.throws(() => registry.claimRun("session-a", "run-a"), lifecycleCode("SESSION_RUNTIME_CLOSED"));
  assert.throws(() => registry.retire("session-a"), lifecycleCode("SESSION_RUNTIME_CLOSED"));
  createGate.resolve();
  await assert.rejects(() => pending, lifecycleCode("SESSION_RUNTIME_STALE"));
  await shutdown;
  assert.equal(retired.length, 1);
  assert.equal(registry.size, 0);
  assert.equal(registry.shutdown(), shutdown);
});

test("RT-01 shutdown waits for active run settlement before retiring its runtime", async () => {
  const retireCounts = new Map();
  const registry = new SessionRuntimeRegistry(
    identity => ({ identity }),
    async runtime => retireCounts.set(runtime, (retireCounts.get(runtime) ?? 0) + 1),
  );
  const runtime = await registry.ensure("session-a");
  const claim = registry.claimRun("session-a", "run-a");
  const shutdown = registry.shutdown();
  let settled = false;
  void shutdown.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(retireCounts.has(runtime), false);
  registry.releaseRun(claim);
  await shutdown;
  assert.equal(retireCounts.get(runtime), 1);
  assert.throws(() => registry.releaseRun(claim), lifecycleCode("SESSION_RUNTIME_CLAIM_STALE"));
  await registry.shutdown();
  assert.equal(retireCounts.get(runtime), 1);
});

test("RT-01 shutdown cancels queued lifecycle changes without hiding real retirement failures", async () => {
  const retired = [];
  const registry = new SessionRuntimeRegistry(
    identity => ({ identity }),
    async runtime => { retired.push(runtime); },
  );
  const runtime = await registry.ensure("session-a");
  const replacement = registry.replace("session-a");
  const shutdown = registry.shutdown();
  await assert.rejects(() => replacement, lifecycleCode("SESSION_RUNTIME_CLOSED"));
  await shutdown;
  assert.deepEqual(retired, [runtime]);

  const failing = new SessionRuntimeRegistry(
    identity => ({ identity }),
    async () => { throw new Error("synthetic retirement failure"); },
  );
  await failing.ensure("session-b");
  await assert.rejects(() => failing.shutdown(), /synthetic retirement failure/u);
});

test("RT-01 failed retirement poisons the Session until the same runtime is fully retired", async () => {
  let creates = 0;
  let retirementAttempts = 0;
  const registry = new SessionRuntimeRegistry(
    identity => ({ identity, ordinal: ++creates }),
    async () => {
      retirementAttempts += 1;
      if (retirementAttempts === 1) throw new Error("synthetic incomplete retirement");
    },
  );
  const original = await registry.ensure("session-a");
  await assert.rejects(() => registry.retire("session-a"), /synthetic incomplete retirement/u);
  assert.equal(registry.get("session-a"), undefined);
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.loadedSessionIds(), []);
  await assert.rejects(() => registry.ensure("session-a"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.throws(() => registry.claimRun("session-a", "run-a"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.equal(creates, 1);
  assert.equal(await registry.retire("session-a"), true);
  assert.equal(retirementAttempts, 2);
  const replacement = await registry.ensure("session-a");
  assert.notEqual(replacement, original);
  assert.equal(replacement.identity.generation, 2);
  assert.equal(creates, 2);
  await registry.shutdown();
});

test("RT-01 failed stale candidate cleanup permanently blocks a replacement authority", async () => {
  const gate = deferred();
  let creates = 0;
  const registry = new SessionRuntimeRegistry(async identity => {
    creates += 1;
    await gate.promise;
    return { identity };
  }, async () => { throw new Error("synthetic stale cleanup failure"); });
  const pending = registry.ensure("session-a");
  await new Promise(resolve => setImmediate(resolve));
  const replacement = registry.replace("session-a");
  gate.resolve();
  await assert.rejects(() => pending, /synthetic stale cleanup failure/u);
  await assert.rejects(() => replacement, /synthetic stale cleanup failure/u);
  await assert.rejects(() => registry.ensure("session-a"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  await assert.rejects(() => registry.replace("session-a"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.equal(creates, 1);
  await registry.shutdown();
});

test("RT-01 failed prepare remains unpublished and a later ensure can retry", async () => {
  let attempts = 0;
  const registry = new SessionRuntimeRegistry(async identity => {
    attempts += 1;
    if (attempts === 1) throw new Error("synthetic prepare failure");
    return { identity };
  }, async () => undefined);
  await assert.rejects(() => registry.ensure("session-a"), /synthetic prepare failure/u);
  assert.equal(registry.size, 0);
  const runtime = await registry.ensure("session-a");
  assert.equal(runtime.identity.generation, 1);
  assert.equal(attempts, 2);
  for (const invalid of ["", " session-a", "session-a ", "bad\0session"]) {
    await assert.rejects(() => registry.ensure(invalid), lifecycleCode("SESSION_RUNTIME_INVALID_SESSION"));
  }
  await registry.shutdown();
});

test("RT-04 exact run cancellation aborts once and settles only after the coroutine releases its authentic claim", async () => {
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async () => undefined);
  await registry.ensure("session-a");
  const claim = registry.claimRun("session-a", "run-a");
  let aborts = 0;
  claim.signal.addEventListener("abort", () => { aborts += 1; });

  const first = registry.cancelRun("session-a", "run-a", "user-stop");
  const second = registry.cancelRun("session-a", "run-a", "client-disconnect");
  assert.equal(first, second);
  assert.equal(claim.signal.aborted, true);
  assert.equal(claim.signal.reason?.code, "RUN_CANCELLED");
  assert.match(claim.signal.reason?.message ?? "", /local user/u);
  assert.equal(aborts, 1);

  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  registry.releaseRun(claim);
  await first;
  assert.equal(settled, true);
  await registry.shutdown();
});

test("RT-04 cancellation settlement rejects cleanup failure instead of reporting a clean stop", async () => {
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async () => undefined);
  await registry.ensure("session-a");
  const claim = registry.claimRun("session-a", "run-a");
  const cancelled = registry.cancelRun("session-a", "run-a", "user-stop");
  const cancellation = new RunCancellationError("RUN_CANCELLED", "synthetic cancellation");
  const cleanupFailure = new RunSettlementError(cancellation, [new Error("synthetic cancellation cleanup failure")]);
  registry.releaseRun(claim, cleanupFailure);
  await assert.rejects(() => cancelled, error => error === cleanupFailure);
  assert.equal(registry.get("session-a"), undefined);
  assert.throws(() => registry.claimRun("session-a", "run-after-failed-settlement"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.equal(await registry.retire("session-a"), true);
  assert((await registry.ensure("session-a")).identity);
  await registry.shutdown();
});

test("RT-04 any failed settlement after cancellation poisons the Session until retirement", async () => {
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async () => undefined);
  await registry.ensure("session-a");
  const claim = registry.claimRun("session-a", "run-a");
  const cancelled = registry.cancelRun("session-a", "run-a", "user-stop");
  const cleanupFailure = new Error("ordinary resource retirement failure");
  registry.releaseRun(claim, cleanupFailure);
  await assert.rejects(() => cancelled, error => error === cleanupFailure);
  assert.equal(registry.get("session-a"), undefined);
  assert.throws(() => registry.claimRun("session-a", "next-run"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.equal(await registry.retire("session-a"), true);
  await registry.shutdown();
});

test("RT-04 internal tool timeout settlement poisons a Session without aborting the root claim", async () => {
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async () => undefined);
  await registry.ensure("session-a");
  const claim = registry.claimRun("session-a", "run-a");
  const timeout = new RunCancellationError("RUN_TIMEOUT", "tool timeout");
  const settlement = new RunSettlementError(timeout, [new Error("non-cooperative tool")]);
  assert.equal(claim.signal.aborted, false);
  registry.releaseRun(claim, settlement);
  assert.equal(registry.get("session-a"), undefined);
  assert.throws(() => registry.claimRun("session-a", "next-run"), lifecycleCode("SESSION_RUNTIME_POISONED"));
  assert.equal(await registry.retire("session-a"), true);
  await registry.shutdown();
});

test("RT-04 cancellation identity cannot cross Session or cancel a later run", async () => {
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async () => undefined);
  await Promise.all([registry.ensure("session-a"), registry.ensure("session-b")]);
  const claimA = registry.claimRun("session-a", "run-a");
  const claimB = registry.claimRun("session-b", "run-b");
  assert.throws(() => registry.cancelRun("session-a", "run-b", "user-stop"), lifecycleCode("SESSION_RUNTIME_CLAIM_STALE"));
  assert.throws(() => registry.cancelRun("session-b", "run-a", "user-stop"), lifecycleCode("SESSION_RUNTIME_CLAIM_STALE"));
  assert.equal(claimA.signal.aborted, false);
  assert.equal(claimB.signal.aborted, false);

  registry.releaseRun(claimA);
  const nextA = registry.claimRun("session-a", "run-a-next");
  assert.throws(() => registry.cancelRun("session-a", "run-a", "user-stop"), lifecycleCode("SESSION_RUNTIME_CLAIM_STALE"));
  assert.equal(nextA.signal.aborted, false);
  registry.releaseRun(nextA);
  registry.releaseRun(claimB);
  await registry.shutdown();
});

test("RT-04 shutdown aborts every active run before waiting for their settlement", async () => {
  const retired = [];
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async runtime => { retired.push(runtime); });
  const [runtimeA, runtimeB] = await Promise.all([registry.ensure("session-a"), registry.ensure("session-b")]);
  const claimA = registry.claimRun("session-a", "run-a");
  const claimB = registry.claimRun("session-b", "run-b");
  const shutdown = registry.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(claimA.signal.aborted, true);
  assert.equal(claimB.signal.aborted, true);
  assert.match(claimA.signal.reason?.message ?? "", /shutting down/u);
  assert.deepEqual(retired, []);

  registry.releaseRun(claimA);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(retired, []);
  registry.releaseRun(claimB);
  await shutdown;
  assert.deepEqual(new Set(retired), new Set([runtimeA, runtimeB]));
});

test("RT-04 shutdown waits for every run after one cleanup failure and retires no runtime", async () => {
  const retired = [];
  const registry = new SessionRuntimeRegistry(identity => ({ identity }), async runtime => { retired.push(runtime); });
  await Promise.all([registry.ensure("session-a"), registry.ensure("session-b")]);
  const claimA = registry.claimRun("session-a", "run-a");
  const claimB = registry.claimRun("session-b", "run-b");
  const shutdown = registry.shutdown();
  let settled = false;
  void shutdown.catch(() => { settled = true; });
  registry.releaseRun(claimA, new Error("synthetic run cleanup failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "shutdown returned before the other active run settled");
  assert.deepEqual(retired, []);
  registry.releaseRun(claimB);
  await assert.rejects(() => shutdown, /synthetic run cleanup failure/u);
  assert.deepEqual(retired, []);
});
