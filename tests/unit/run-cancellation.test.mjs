import assert from "node:assert/strict";
import test from "node:test";
import {
  RunCancellationError,
  abortableDelay,
  cancellationError,
  cancellationFailure,
  isRunCancellation,
  isRunSettlementFailure,
  RunSettlementError,
  linkAbortSignals,
  throwIfCancelled,
  timeoutSignal,
} from "../../dist/run-cancellation.js";

test("RT-04 linked cancellation preserves the first exact reason and removes parent listeners on dispose", () => {
  const first = new AbortController();
  const second = new AbortController();
  const linked = linkAbortSignals([first.signal, second.signal, first.signal]);
  const reason = new RunCancellationError("RUN_CANCELLED", "first reason");
  second.abort(reason);
  first.abort(new RunCancellationError("RUN_CANCELLED", "later reason"));
  assert.equal(linked.signal.aborted, true);
  assert.equal(linked.signal.reason, reason);
  assert.equal(cancellationError(linked.signal), reason);
  linked.dispose();
  linked.dispose();
});

test("RT-04 abortable delay settles promptly with typed cancellation and does not leave its timer authoritative", async () => {
  const controller = new AbortController();
  const delayed = abortableDelay(60_000, controller.signal);
  controller.abort(new RunCancellationError("RUN_CANCELLED", "delay cancelled"));
  await assert.rejects(() => delayed, error => error instanceof RunCancellationError
    && error.code === "RUN_CANCELLED"
    && error.message === "delay cancelled");

  const registrationRace = new AbortController();
  const originalAddEventListener = registrationRace.signal.addEventListener.bind(registrationRace.signal);
  registrationRace.signal.addEventListener = (...args) => {
    originalAddEventListener(...args);
    registrationRace.abort(new RunCancellationError("RUN_CANCELLED", "registration race"));
  };
  await assert.rejects(
    () => abortableDelay(60_000, registrationRace.signal),
    error => error instanceof RunCancellationError && error.message === "registration race",
  );
});

test("RT-04 child deadline does not abort its parent and parent cancellation wins when it arrives first", async () => {
  const parent = new AbortController();
  const deadline = timeoutSignal(parent.signal, 10, "fixture operation");
  await assert.rejects(() => abortableDelay(60_000, deadline.signal), error => error instanceof RunCancellationError
    && error.code === "RUN_TIMEOUT"
    && /fixture operation timed out/u.test(error.message));
  assert.equal(parent.signal.aborted, false);
  deadline.dispose();

  const parentFirst = new AbortController();
  const child = timeoutSignal(parentFirst.signal, 60_000, "late deadline");
  const reason = new RunCancellationError("RUN_CANCELLED", "parent first");
  parentFirst.abort(reason);
  await assert.rejects(Promise.resolve().then(() => abortableDelay(1, child.signal)), error => error === reason);
  child.dispose();
});

test("RT-04 cancellation primitives classify reasons and reject invalid composition without ambiguity", async () => {
  const timeoutController = new AbortController();
  timeoutController.abort(new DOMException("deadline", "TimeoutError"));
  const timeout = cancellationError(timeoutController.signal);
  assert.equal(timeout.code, "RUN_TIMEOUT");
  assert.equal(timeout.message, "deadline");
  assert.equal(isRunCancellation(timeout), true);
  assert.equal(isRunCancellation(new Error("ordinary")), false);

  const ordinaryController = new AbortController();
  ordinaryController.abort(new Error("ordinary cancellation"));
  assert.equal(cancellationError(ordinaryController.signal).message, "ordinary cancellation");
  const emptyTimeoutController = new AbortController();
  emptyTimeoutController.abort(new DOMException("", "TimeoutError"));
  assert.equal(cancellationError(emptyTimeoutController.signal).message, "Run operation timed out");
  const emptyErrorController = new AbortController();
  emptyErrorController.abort(new Error(""));
  assert.equal(cancellationError(emptyErrorController.signal, "empty error fallback").message, "empty error fallback");

  const primitiveController = new AbortController();
  primitiveController.abort("primitive");
  assert.equal(cancellationError(primitiveController.signal, "fallback reason").message, "fallback reason");
  assert.throws(() => throwIfCancelled(primitiveController.signal), error => error.code === "RUN_CANCELLED");
  assert.equal(cancellationFailure(primitiveController.signal, "primitive", "primitive fallback").message, "primitive fallback");

  assert.throws(() => linkAbortSignals([]), /At least one AbortSignal/u);
  assert.throws(() => linkAbortSignals([null, {}, "not-a-signal"]), /At least one AbortSignal/u);
  const only = new AbortController();
  const single = linkAbortSignals([only.signal]);
  assert.equal(single.signal, only.signal);
  single.dispose();

  const already = new AbortController();
  const later = new AbortController();
  const reason = new RunCancellationError("RUN_CANCELLED", "already cancelled");
  already.abort(reason);
  const linked = linkAbortSignals([already.signal, later.signal]);
  assert.equal(linked.signal.reason, reason);
  linked.dispose();

  assert.throws(() => timeoutSignal(only.signal, 0, "invalid"), /timeout is invalid/u);
  assert.throws(() => abortableDelay(-1, only.signal), /Delay is invalid/u);
  await abortableDelay(0, only.signal);
  const disposed = timeoutSignal(only.signal, 60_000, "disposed");
  disposed.dispose();
  disposed.dispose();
  assert.equal(disposed.signal.aborted, false);
});

test("RT-04 cancellation failure distinguishes cooperative abort from failed resource settlement", () => {
  const defaultSettlement = new RunSettlementError(new Error("primary"), [new Error("cleanup")]);
  assert.equal(defaultSettlement.message, "Run cancellation cleanup failed");

  const cooperative = new AbortController();
  const reason = new RunCancellationError("RUN_CANCELLED", "cooperative cancellation");
  cooperative.abort(reason);
  assert.equal(cancellationFailure(cooperative.signal, reason), reason);
  const ambiguousAbort = cancellationFailure(cooperative.signal, new DOMException("aborted", "AbortError"));
  assert(ambiguousAbort instanceof RunSettlementError);
  assert.equal(ambiguousAbort.cause, reason);

  const cleanup = new Error("cleanup failed after cancellation");
  const failed = cancellationFailure(cooperative.signal, cleanup, "fixture operation");
  assert(failed instanceof RunSettlementError);
  assert.equal(isRunSettlementFailure(failed), true);
  assert.equal(failed.code, "RUN_SETTLEMENT_FAILED");
  assert.equal(failed.cause, reason);
  assert.deepEqual(failed.errors, [reason, cleanup]);
});
