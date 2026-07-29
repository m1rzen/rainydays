export interface SettingsEnrollmentAdapter<Base, Plan> {
  readonly captureBase: () => Base;
  readonly prepareCandidate: (base: Base) => Promise<Plan>;
  readonly isBaseCurrent: (base: Base) => boolean;
  readonly retireBase: (base: Base) => Promise<void>;
  readonly persistCandidate: (plan: Plan) => Promise<void>;
  readonly publishCandidate: (plan: Plan) => Promise<void> | void;
  readonly commitCandidate: (plan: Plan) => void;
  readonly discardCandidate: (plan: Plan) => Promise<void>;
  readonly recoverBase: (base: Base) => Promise<void>;
  readonly stopFailClosed: () => void;
}

export class SettingsEnrollmentStaleError extends Error {
  constructor() {
    super("Settings enrollment candidate is stale");
    this.name = "SettingsEnrollmentStaleError";
  }
}

/**
 * Execute one already-serialized root-enrollment transaction. The caller owns the
 * Broker-private mutex; this state machine owns retirement, persistence and recovery ordering.
 */
export async function executeSettingsEnrollment<Base, Plan>(adapter: SettingsEnrollmentAdapter<Base, Plan>): Promise<void> {
  const base = adapter.captureBase();
  const plan = await adapter.prepareCandidate(base);
  let finalized = false;
  const discard = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await adapter.discardCandidate(plan);
  };

  if (!adapter.isBaseCurrent(base)) {
    await discard();
    throw new SettingsEnrollmentStaleError();
  }

  try {
    await adapter.retireBase(base);
  } catch (retirementError) {
    try { await discard(); }
    finally { adapter.stopFailClosed(); }
    throw retirementError;
  }

  try {
    await adapter.persistCandidate(plan);
  } catch (persistenceError) {
    try {
      await discard();
      await adapter.recoverBase(base);
    } catch (recoveryError) {
      adapter.stopFailClosed();
      throw new AggregateError([persistenceError, recoveryError], "Settings persistence failed and runtime recovery failed");
    }
    throw persistenceError;
  }

  try {
    await adapter.publishCandidate(plan);
  } catch (publicationError) {
    try {
      await discard();
      await adapter.recoverBase(base);
    } catch (recoveryError) {
      adapter.stopFailClosed();
      throw new AggregateError([publicationError, recoveryError], "Settings publication failed and runtime recovery failed");
    }
    throw publicationError;
  }

  try {
    adapter.commitCandidate(plan);
    finalized = true;
  } catch (commitError) {
    adapter.stopFailClosed();
    throw commitError;
  }
}
