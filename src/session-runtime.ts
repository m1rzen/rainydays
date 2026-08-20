import { isRunSettlementFailure, RunCancellationError } from "./run-cancellation.js";

export type SessionRuntimeLifecycleCode =
  | "SESSION_RUNTIME_INVALID_SESSION"
  | "SESSION_RUNTIME_INVALID_RUN"
  | "SESSION_RUNTIME_CLOSED"
  | "SESSION_RUNTIME_BUSY"
  | "SESSION_RUNTIME_STALE"
  | "SESSION_RUNTIME_POISONED"
  | "SESSION_RUNTIME_CLAIM_FORGED"
  | "SESSION_RUNTIME_CLAIM_STALE";

export type SessionRuntimeCancellationReason =
  | "user-stop"
  | "client-disconnect"
  | "session-retired"
  | "runtime-replaced"
  | "shutdown";

export class SessionRuntimeLifecycleError extends Error {
  readonly code: SessionRuntimeLifecycleCode;

  constructor(code: SessionRuntimeLifecycleCode, message: string) {
    super(message);
    this.name = "SessionRuntimeLifecycleError";
    this.code = code;
  }
}

export interface SessionRuntimeIdentity {
  readonly sessionId: string;
  readonly generation: number;
}

export interface SessionRuntimeRunClaim<Runtime extends object> extends SessionRuntimeIdentity {
  readonly runId: string;
  readonly runtime: Runtime;
  readonly signal: AbortSignal;
}

export type SessionRuntimeFactory<Runtime extends object> = (
  identity: SessionRuntimeIdentity
) => Runtime | Promise<Runtime>;

export type SessionRuntimeRetire<Runtime extends object> = (
  runtime: Runtime,
  identity: SessionRuntimeIdentity
) => void | Promise<void>;

type RuntimeEntry<Runtime extends object> = Readonly<{
  runtime: Runtime;
  generation: number;
}>;

type PendingCreate<Runtime extends object> = Readonly<{
  generation: number;
  result: Promise<Runtime>;
  cleanup: Promise<void>;
}>;

type RunClaimRecord<Runtime extends object> = {
  readonly token: SessionRuntimeRunClaim<Runtime>;
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: (error?: unknown) => void;
  cancellationReason: SessionRuntimeCancellationReason | null;
  active: boolean;
};

function sessionId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_INVALID_SESSION", "Session runtime identity is invalid");
  }
  return value;
}

function runId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_INVALID_RUN", "Session runtime run identity is invalid");
  }
  return value;
}

function cancellationMessage(reason: SessionRuntimeCancellationReason): string {
  switch (reason) {
    case "user-stop": return "Run cancelled by the local user";
    case "client-disconnect": return "Run cancelled because the response stream closed";
    case "session-retired": return "Run cancelled because its Session was retired";
    case "runtime-replaced": return "Run cancelled because its Session runtime was replaced";
    case "shutdown": return "Run cancelled because the service is shutting down";
  }
}

function lifecycleFailure(failures: readonly unknown[], message: string): Error | null {
  if (failures.length === 0) return null;
  if (failures.length === 1) return failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
  return new AggregateError(failures, message);
}

export class SessionRuntimeRegistry<Runtime extends object> {
  readonly #factory: SessionRuntimeFactory<Runtime>;
  readonly #retire: SessionRuntimeRetire<Runtime>;
  readonly #entries = new Map<string, RuntimeEntry<Runtime>>();
  readonly #pendingCreates = new Map<string, PendingCreate<Runtime>>();
  readonly #generations = new Map<string, number>();
  readonly #poisonedSessions = new Set<string>();
  readonly #mutations = new Map<string, Promise<unknown>>();
  readonly #activeRuns = new Map<string, SessionRuntimeRunClaim<Runtime>>();
  readonly #claims = new WeakMap<SessionRuntimeRunClaim<Runtime>, RunClaimRecord<Runtime>>();
  #closed = false;
  #shutdown: Promise<void> | null = null;

  constructor(factory: SessionRuntimeFactory<Runtime>, retire: SessionRuntimeRetire<Runtime>) {
    if (typeof factory !== "function" || typeof retire !== "function") {
      throw new TypeError("Session runtime lifecycle handlers are invalid");
    }
    this.#factory = factory;
    this.#retire = retire;
  }

  get size(): number {
    let count = 0;
    for (const id of this.#entries.keys()) if (!this.#poisonedSessions.has(id)) count += 1;
    return count;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get(rawSessionId: string): Runtime | undefined {
    const id = sessionId(rawSessionId);
    if (this.#poisonedSessions.has(id)) return undefined;
    return this.#entries.get(id)?.runtime;
  }

  loadedSessionIds(): readonly string[] {
    return Object.freeze([...this.#entries.keys()].filter(id => !this.#poisonedSessions.has(id)));
  }

  isRunning(rawSessionId: string): boolean {
    return this.#activeRuns.has(sessionId(rawSessionId));
  }

  hasRunningSessions(): boolean {
    return this.#activeRuns.size > 0;
  }

  getGeneration(rawSessionId: string): number {
    return this.#generations.get(sessionId(rawSessionId)) ?? 1;
  }

  async ensure(rawSessionId: string): Promise<Runtime> {
    const id = sessionId(rawSessionId);
    this.#assertOpen();
    const mutation = this.#mutations.get(id);
    if (mutation) {
      await mutation.catch(() => undefined);
      this.#assertOpen();
    }
    this.#assertUsable(id);
    return this.#ensureCurrent(id);
  }

  retire(rawSessionId: string): Promise<boolean> {
    const id = sessionId(rawSessionId);
    this.#assertOpen();
    return this.#queueMutation(id, () => this.#retireSession(id));
  }

  replace(rawSessionId: string): Promise<Runtime> {
    const id = sessionId(rawSessionId);
    this.#assertOpen();
    return this.#queueMutation(id, async () => {
      this.#assertOpen();
      this.#assertIdle(id);
      await this.#invalidateAndDrain(id);
      this.#assertOpen();
      return this.#ensureCurrent(id);
    });
  }

  claimRun(rawSessionId: string, rawRunId: string): SessionRuntimeRunClaim<Runtime> {
    const id = sessionId(rawSessionId);
    const exactRunId = runId(rawRunId);
    this.#assertOpen();
    if (this.#mutations.has(id)) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Session runtime lifecycle is changing");
    }
    this.#assertUsable(id);
    const entry = this.#entries.get(id);
    if (!entry) throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_STALE", "Session runtime is unavailable");
    if (this.#activeRuns.has(id)) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Session runtime already has an active run");
    }
    const controller = new AbortController();
    const token = Object.freeze({
      sessionId: id,
      runId: exactRunId,
      generation: entry.generation,
      runtime: entry.runtime,
      signal: controller.signal,
    });
    let settle!: (error?: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      settle = error => { if (error === undefined) resolve(); else reject(error); };
    });
    void settled.catch(() => undefined);
    const record: RunClaimRecord<Runtime> = {
      token,
      sessionId: id,
      runId: exactRunId,
      generation: entry.generation,
      controller,
      settled,
      settle,
      cancellationReason: null,
      active: true,
    };
    this.#claims.set(token, record);
    this.#activeRuns.set(id, token);
    return token;
  }

  cancelRun(rawSessionId: string, rawRunId: string, reason: SessionRuntimeCancellationReason): Promise<void> {
    const id = sessionId(rawSessionId);
    const exactRunId = runId(rawRunId);
    const claim = this.#activeRuns.get(id);
    const record = claim ? this.#claims.get(claim) : undefined;
    if (!record || !record.active || record.runId !== exactRunId) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_CLAIM_STALE", "Session runtime run is no longer active or its identity differs");
    }
    if (record.cancellationReason === null) {
      record.cancellationReason = reason;
      record.controller.abort(new RunCancellationError("RUN_CANCELLED", cancellationMessage(reason)));
    }
    return record.settled;
  }

  releaseRun(claim: SessionRuntimeRunClaim<Runtime>, settlementFailure?: unknown): void {
    const record = claim && this.#claims.get(claim);
    if (!record || record.token !== claim) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_CLAIM_FORGED", "Session runtime run claim is forged");
    }
    if (!record.active || this.#activeRuns.get(record.sessionId) !== claim) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_CLAIM_STALE", "Session runtime run claim is stale");
    }
    record.active = false;
    this.#activeRuns.delete(record.sessionId);
    if (isRunSettlementFailure(settlementFailure)
      || (settlementFailure !== undefined && record.controller.signal.aborted)) {
      this.#poisonedSessions.add(record.sessionId);
    }
    record.settle(settlementFailure);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    this.#shutdown = this.#performShutdown();
    return this.#shutdown;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_CLOSED", "Session runtime registry is closed");
  }

  #assertIdle(id: string): void {
    if (this.#activeRuns.has(id)) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_BUSY", "Session runtime has an active run");
    }
  }

  #assertUsable(id: string): void {
    if (this.#poisonedSessions.has(id)) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_POISONED", "Session runtime retirement did not complete");
    }
  }

  #nextGeneration(id: string): number {
    const current = this.#generations.get(id) ?? 1;
    if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_STALE", "Session runtime generation is exhausted");
    }
    const next = current + 1;
    this.#generations.set(id, next);
    return next;
  }

  #ensureCurrent(id: string): Promise<Runtime> {
    this.#assertOpen();
    const generation = this.#generations.get(id) ?? 1;
    const entry = this.#entries.get(id);
    if (entry?.generation === generation) return Promise.resolve(entry.runtime);
    const pending = this.#pendingCreates.get(id);
    if (pending?.generation === generation) return pending.result;
    return this.#startCreate(id, generation).result;
  }

  #startCreate(id: string, generation: number): PendingCreate<Runtime> {
    let resolveCleanup!: () => void;
    let rejectCleanup!: (error: unknown) => void;
    const cleanup = new Promise<void>((resolve, reject) => {
      resolveCleanup = resolve;
      rejectCleanup = reject;
    });
    void cleanup.catch(() => undefined);

    let pending!: PendingCreate<Runtime>;
    const result = (async () => {
      await Promise.resolve();
      let runtime: Runtime;
      try {
        runtime = await this.#factory(Object.freeze({ sessionId: id, generation }));
      } catch (error) {
        resolveCleanup();
        throw error;
      }
      if (!runtime || typeof runtime !== "object") {
        resolveCleanup();
        throw new TypeError("Session runtime factory returned an invalid runtime");
      }
      const current = this.#generations.get(id) ?? 1;
      if (this.#closed || current !== generation || this.#pendingCreates.get(id) !== pending) {
        try {
          await this.#retireRuntime(runtime, Object.freeze({ sessionId: id, generation }));
          resolveCleanup();
        } catch (error) {
          rejectCleanup(error);
          throw error;
        }
        throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_STALE", "Prepared session runtime became stale before publication");
      }
      this.#entries.set(id, Object.freeze({ runtime, generation }));
      resolveCleanup();
      return runtime;
    })().finally(() => {
      if (this.#pendingCreates.get(id) === pending) this.#pendingCreates.delete(id);
    });
    void result.catch(() => undefined);
    pending = Object.freeze({ generation, result, cleanup });
    this.#pendingCreates.set(id, pending);
    return pending;
  }

  async #retireSession(id: string): Promise<boolean> {
    this.#assertOpen();
    this.#assertIdle(id);
    const entry = this.#entries.get(id);
    const pending = this.#pendingCreates.get(id);
    if (!entry && !pending) {
      this.#assertUsable(id);
      return false;
    }
    await this.#invalidateAndDrain(id);
    return true;
  }

  async #invalidateAndDrain(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    const pending = this.#pendingCreates.get(id);
    const wasPoisoned = this.#poisonedSessions.has(id);
    if (wasPoisoned && !entry && !pending) {
      throw new SessionRuntimeLifecycleError("SESSION_RUNTIME_POISONED", "Stale runtime cleanup failed and cannot be retried");
    }
    if (!wasPoisoned) this.#nextGeneration(id);
    this.#poisonedSessions.add(id);
    const outcomes = await Promise.allSettled([
      ...(entry ? [this.#retireRuntime(entry.runtime, Object.freeze({ sessionId: id, generation: entry.generation }))] : []),
      ...(pending ? [pending.cleanup] : []),
    ]);
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map(outcome => outcome.reason);
    const failure = lifecycleFailure(failures, "Session runtime retirement failed");
    if (failure) throw failure;
    this.#entries.delete(id);
    this.#poisonedSessions.delete(id);
  }

  #queueMutation<Result>(id: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#mutations.get(id) ?? Promise.resolve();
    let current!: Promise<Result>;
    current = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.#mutations.get(id) === current) this.#mutations.delete(id);
    });
    this.#mutations.set(id, current);
    return current;
  }

  async #retireRuntime(runtime: Runtime, identity: SessionRuntimeIdentity): Promise<void> {
    await this.#retire(runtime, identity);
  }

  async #performShutdown(): Promise<void> {
    const active = [...this.#activeRuns.values()]
      .map(claim => this.#claims.get(claim))
      .filter((record): record is RunClaimRecord<Runtime> => Boolean(record));
    for (const record of active) {
      if (record.cancellationReason === null) {
        record.cancellationReason = "shutdown";
        record.controller.abort(new RunCancellationError("RUN_CANCELLED", cancellationMessage("shutdown")));
      }
    }
    const runOutcomes = await Promise.allSettled(active.map(record => record.settled));
    const runFailures = runOutcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map(outcome => outcome.reason);
    const runFailure = lifecycleFailure(runFailures, "Session runtime run cancellation cleanup failed");
    if (runFailure) throw runFailure;

    const mutationOutcomes = await Promise.allSettled([...this.#mutations.values()]);
    const entries = [...this.#entries.entries()];
    const pending = [...this.#pendingCreates.entries()];
    const ids = new Set([...entries.map(([id]) => id), ...pending.map(([id]) => id)]);
    for (const id of ids) this.#nextGeneration(id);
    this.#entries.clear();
    this.#poisonedSessions.clear();

    const resourceOutcomes = await Promise.allSettled([
      ...entries.map(([id, entry]) => this.#retireRuntime(entry.runtime, Object.freeze({ sessionId: id, generation: entry.generation }))),
      ...pending.map(([, create]) => create.cleanup),
    ]);
    const failures = [
      ...resourceOutcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map(outcome => outcome.reason),
      ...mutationOutcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
        && !(outcome.reason instanceof SessionRuntimeLifecycleError)).map(outcome => outcome.reason),
    ];
    const failure = lifecycleFailure(failures, "Session runtime shutdown failed");
    if (failure) throw failure;
  }
}
