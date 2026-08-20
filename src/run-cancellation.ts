export type RunCancellationCode = "RUN_CANCELLED" | "RUN_TIMEOUT";

export const NEVER_ABORT_SIGNAL: AbortSignal = new AbortController().signal;

export class RunCancellationError extends Error {
  readonly code: RunCancellationCode;

  constructor(code: RunCancellationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunCancellationError";
    this.code = code;
  }
}

export class RunSettlementError extends AggregateError {
  readonly code = "RUN_SETTLEMENT_FAILED" as const;

  constructor(primary: unknown, cleanupFailures: readonly unknown[], message = "Run cancellation cleanup failed") {
    super([primary, ...cleanupFailures], message, { cause: primary });
    this.name = "RunSettlementError";
  }
}

export function isRunSettlementFailure(error: unknown): error is RunSettlementError {
  return error instanceof RunSettlementError;
}

export function cancellationFailure(signal: AbortSignal, error: unknown, fallback = "Run was cancelled"): RunCancellationError | RunSettlementError {
  const cancelled = cancellationError(signal, fallback);
  if (isRunCancellation(error) || error === signal.reason) return cancelled;
  return new RunSettlementError(cancelled, [error], `${fallback} cancellation settlement failed`);
}

export function cancellationError(signal: AbortSignal, fallback = "Run was cancelled"): RunCancellationError {
  const reason = signal.reason;
  if (reason instanceof RunCancellationError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new RunCancellationError("RUN_TIMEOUT", reason.message || "Run operation timed out", { cause: reason });
  }
  if (reason instanceof Error) {
    return new RunCancellationError("RUN_CANCELLED", reason.message || fallback, { cause: reason });
  }
  return new RunCancellationError("RUN_CANCELLED", fallback);
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal);
}

export function isRunCancellation(error: unknown): error is RunCancellationError {
  return error instanceof RunCancellationError;
}

export interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

export function linkAbortSignals(signals: readonly AbortSignal[]): LinkedAbortSignal {
  const active = signals.filter((signal, index) => signal instanceof AbortSignal && signals.indexOf(signal) === index);
  if (active.length === 0) throw new TypeError("At least one AbortSignal is required");
  if (active.length === 1) return Object.freeze({ signal: active[0], dispose: () => undefined });

  const controller = new AbortController();
  let disposed = false;
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
  };
  for (const signal of active) {
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
      dispose();
    };
    listeners.set(signal, listener);
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
  }
  return Object.freeze({ signal: controller.signal, dispose });
}

export function timeoutSignal(parent: AbortSignal, timeoutMs: number, label: string): LinkedAbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new TypeError("Cancellation timeout is invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new RunCancellationError("RUN_TIMEOUT", `${label} timed out`));
  }, timeoutMs);
  timer.unref?.();
  const linked = linkAbortSignals([parent, controller.signal]);
  return Object.freeze({
    signal: linked.signal,
    dispose: () => {
      clearTimeout(timer);
      linked.dispose();
    },
  });
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 86_400_000) throw new TypeError("Delay is invalid");
  throwIfCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: RunCancellationError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(cancellationError(signal));
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
