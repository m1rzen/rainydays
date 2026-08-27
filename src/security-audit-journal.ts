import { randomBytes } from "node:crypto";
import { createSecurityAuditKeyWrapper, type SecurityAuditKeyWrapper } from "./credential-store.js";
import {
  getSecurityAuditHead,
  getSecurityAuditState,
  insertSecurityAuditEvent,
  insertSecurityAuditHead,
  insertSecurityAuditState,
  listSecurityAuditEvents,
  updateSecurityAuditHead,
  withTransaction,
} from "./db.js";
import {
  appendSecurityAuditEvent,
  createSecurityAuditCheckpoint,
  createSecurityAuditCommitment,
  makeAuthorizationAuditPayload,
  makeExecutionAuditPayload,
  makeResultAuditPayload,
  verifySecurityAuditChain,
  verifySecurityAuditCheckpoint,
  type AppendSecurityAuditEventInput,
  type AuthorizationAuditPayload,
  type SecurityAuditCheckpoint,
  type SecurityAuditEvent,
} from "./security-audit.js";

export interface SecurityAuditJournalSummary {
  readonly schemaVersion: 1;
  readonly integrity: "verified";
  readonly eventCount: number;
  readonly headHash: string;
}

export interface SecurityAuditJournal {
  readonly append: (input: AppendSecurityAuditEventInput) => Promise<SecurityAuditEvent>;
  readonly commit: (value: unknown) => string;
  readonly verify: () => Promise<SecurityAuditJournalSummary>;
  readonly close: () => void;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function assertPersistedState(state: NonNullable<ReturnType<typeof getSecurityAuditState>>, wrapper: SecurityAuditKeyWrapper): void {
  if (state.schemaVersion !== 1
    || state.algorithm !== wrapper.algorithm
    || state.scope !== wrapper.scope
    || !Buffer.isBuffer(state.wrappedKey)
    || state.wrappedKey.length < 1
    || state.wrappedKey.length > 64 * 1024
    || !timestampPattern.test(state.createdAt)
    || new Date(state.createdAt).toISOString() !== state.createdAt) {
    throw new Error("Security audit state is invalid");
  }
}

function verifyPersistedAudit(masterKey: Uint8Array): Readonly<{
  events: SecurityAuditEvent[];
  head: SecurityAuditCheckpoint;
  summary: Readonly<{ eventCount: number; headHash: string }>;
}> {
  const events = [...listSecurityAuditEvents()];
  const summary = verifySecurityAuditChain(events, masterKey);
  const head = getSecurityAuditHead();
  if (!head) throw new Error("Security audit checkpoint is missing");
  verifySecurityAuditCheckpoint(head, summary, masterKey);
  return Object.freeze({ events, head, summary });
}

function persistSecurityAuditEvent(
  events: SecurityAuditEvent[],
  head: SecurityAuditCheckpoint,
  event: SecurityAuditEvent,
  masterKey: Uint8Array
): SecurityAuditCheckpoint {
  insertSecurityAuditEvent(event);
  const next = createSecurityAuditCheckpoint(masterKey, { eventCount: event.sequence, headHash: event.eventHash });
  updateSecurityAuditHead(head, next);
  events.push(event);
  return next;
}

function recoverIncompleteAuditRequests(masterKey: Uint8Array): void {
  withTransaction(() => {
    const persisted = verifyPersistedAudit(masterKey);
    let events = persisted.events;
    let head = persisted.head;
    const requestIds = [...new Set(events.map(event => event.correlation.requestId))];
    for (const requestId of requestIds) {
      let related = events.filter(event => event.correlation.requestId === requestId);
      if (related.length === 4) continue;
      const request = related[0];
      if (!request || request.phase !== "request") throw new Error("Security audit recovery found an invalid request prefix");
      const common = {
        principal: request.principal,
        operationKind: request.operationKind,
        operationName: request.operationName,
        requestCommitment: request.requestCommitment,
      } as const;
      if (related.length === 1) {
        const authorization = appendSecurityAuditEvent(events, {
          ...common,
          phase: "authorization",
          correlation: request.correlation,
          outcome: "denied",
          code: "SEC06_RECOVERED_INCOMPLETE_REQUEST",
          safePayload: makeAuthorizationAuditPayload({
            decision: "denied",
            policyDigest: null,
            personaDigest: null,
            approvalKind: "none",
          }),
        }, masterKey);
        head = persistSecurityAuditEvent(events, head, authorization, masterKey);
        related = [...related, authorization];
      }
      const authorization = related[1];
      if (!authorization || authorization.phase !== "authorization") throw new Error("Security audit recovery found an invalid authorization prefix");
      if (related.length === 2) {
        const execution = appendSecurityAuditEvent(events, {
          ...common,
          phase: "execution",
          correlation: authorization.correlation,
          outcome: "not_started",
          code: "SEC06_RECOVERED_INCOMPLETE_REQUEST",
          safePayload: makeExecutionAuditPayload({ state: "not_started", executor: "none", profile: null, proofDigest: null }),
        }, masterKey);
        head = persistSecurityAuditEvent(events, head, execution, masterKey);
        related = [...related, execution];
      }
      const execution = related[2];
      if (!execution || execution.phase !== "execution") throw new Error("Security audit recovery found an invalid execution prefix");
      if (related.length === 3) {
        const decision = (authorization.safePayload as AuthorizationAuditPayload).decision;
        const status = decision === "denied" ? "denied" : "interrupted";
        const result = appendSecurityAuditEvent(events, {
          ...common,
          phase: "result",
          correlation: execution.correlation,
          outcome: status,
          code: "SEC06_RECOVERED_INCOMPLETE_REQUEST",
          safePayload: makeResultAuditPayload({
            status,
            durationMs: 0,
            outputBytes: 0,
            truncated: false,
            resultCommitment: null,
          }),
        }, masterKey);
        head = persistSecurityAuditEvent(events, head, result, masterKey);
      }
    }
    const verified = verifyPersistedAudit(masterKey);
    if (verified.summary.eventCount !== events.length || verified.head.checkpointMac !== head.checkpointMac) {
      throw new Error("Security audit recovery checkpoint differs");
    }
  });
}

async function loadOrCreateMasterKey(wrapper: SecurityAuditKeyWrapper): Promise<Buffer> {
  let state = getSecurityAuditState();
  if (!state) {
    if (listSecurityAuditEvents().length !== 0 || getSecurityAuditHead()) throw new Error("Security audit key is missing for an existing chain");
    const generated = randomBytes(32);
    let wrapped: Buffer | null = null;
    try {
      wrapped = await wrapper.wrapKey(generated);
      if (!Buffer.isBuffer(wrapped) || wrapped.length < 1 || wrapped.length > 64 * 1024) throw new Error("Security audit key wrapping failed");
      const genesis = createSecurityAuditCheckpoint(generated, verifySecurityAuditChain([], generated));
      withTransaction(() => {
        if (getSecurityAuditState() || getSecurityAuditHead() || listSecurityAuditEvents().length !== 0) {
          throw new Error("Security audit state was initialized concurrently");
        }
        insertSecurityAuditState(Object.freeze({
          schemaVersion: 1,
          algorithm: wrapper.algorithm,
          scope: wrapper.scope,
          wrappedKey: Buffer.from(wrapped as Buffer),
          createdAt: new Date().toISOString(),
        }));
        insertSecurityAuditHead(genesis);
      });
      return Buffer.from(generated);
    } finally {
      generated.fill(0);
      wrapped?.fill(0);
    }
  }
  assertPersistedState(state, wrapper);
  const masterKey = await wrapper.unwrapKey(state.wrappedKey);
  state.wrappedKey.fill(0);
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    if (Buffer.isBuffer(masterKey)) masterKey.fill(0);
    throw new Error("Security audit key is unavailable");
  }
  return masterKey;
}

export async function openSecurityAuditJournal(
  wrapper: SecurityAuditKeyWrapper = createSecurityAuditKeyWrapper()
): Promise<SecurityAuditJournal> {
  if (!wrapper || wrapper.algorithm !== "electron-safe-storage"
    || wrapper.scope !== "windows-dpapi-current-user-v1"
    || typeof wrapper.wrapKey !== "function"
    || typeof wrapper.unwrapKey !== "function") {
    throw new TypeError("Security audit key wrapper is invalid");
  }
  const masterKey = await loadOrCreateMasterKey(wrapper);
  let closed = false;
  let poisoned = false;
  let tail = Promise.resolve();
  try {
    verifyPersistedAudit(masterKey);
    recoverIncompleteAuditRequests(masterKey);
  } catch (error) {
    masterKey.fill(0);
    throw error;
  }

  const requireOpen = (): void => {
    if (closed) throw new Error("Security audit journal is closed");
    if (poisoned) throw new Error("Security audit journal is poisoned");
  };
  const enqueue = <T>(action: () => T): Promise<T> => {
    requireOpen();
    const operation = tail.then(() => {
      requireOpen();
      try { return action(); }
      catch (error) {
        poisoned = true;
        throw error;
      }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    append: (input: AppendSecurityAuditEventInput) => enqueue(() => withTransaction(() => {
      const persisted = verifyPersistedAudit(masterKey);
      const event = appendSecurityAuditEvent(persisted.events, input, masterKey);
      const head = persistSecurityAuditEvent(persisted.events, persisted.head, event, masterKey);
      const verified = verifyPersistedAudit(masterKey);
      if (verified.summary.eventCount !== event.sequence || verified.summary.headHash !== event.eventHash
        || verified.head.checkpointMac !== head.checkpointMac) {
        throw new Error("Security audit append verification failed");
      }
      return event;
    })),
    commit: (value: unknown) => {
      requireOpen();
      return createSecurityAuditCommitment(masterKey, value);
    },
    verify: () => enqueue(() => {
      const { summary } = verifyPersistedAudit(masterKey);
      return Object.freeze({ schemaVersion: 1 as const, integrity: "verified" as const, ...summary });
    }),
    close: () => {
      if (closed) return;
      closed = true;
      masterKey.fill(0);
    },
  });
}
