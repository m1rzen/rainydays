// ===========================================
// PollManager — external source subscriptions (EVT-03)
// Session-owned rules / durable debounce batches / EventBus wake delivery
// ===========================================

import { randomUUID } from "node:crypto";
import { getDefaultEventBus, type EventBus } from "./event-bus.js";
import { assertResourceOwner, type ResourceOwner } from "./resource-owner.js";

export const POLL_MODE = "wake" as const;
export const MAX_POLL_SUBSCRIPTIONS_PER_SESSION = 100;
export const MAX_POLL_SUBSCRIPTIONS_GLOBAL = 1_000;
export const MAX_POLL_DEBOUNCE_MS = 60_000;
export const MAX_POLL_BATCH_EVENTS = 100;
export const MAX_POLL_BATCH_BYTES = 60 * 1024;
export const MAX_POLL_STORED_BYTES_PER_SESSION = 8 * 1024 * 1024;
export const MAX_POLL_STORED_BYTES_GLOBAL = 64 * 1024 * 1024;
const MAX_EXTERNAL_PAYLOAD_BYTES = 32 * 1024;
const POLL_DISPATCH_INTERVAL_MS = 250;
const POLL_RETRY_MS = 1_000;
const POLL_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SOURCE_PATTERN = /^[A-Za-z0-9_.:*-]{1,128}$/u;
const SOURCE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/u;
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,64}$/u;

export interface ExternalEventInput {
  readonly sourceEventId: string;
  readonly source: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly createdAt?: number;
}

export interface ExternalEvent {
  readonly sourceEventId: string;
  readonly source: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface PollSubscriptionInput {
  readonly source: string;
  readonly tagFilters?: Readonly<Record<string, string>>;
  readonly mode?: "wake";
  readonly persistent?: boolean;
  readonly debounceMs?: number;
}

export interface PollSubscription {
  readonly id: string;
  readonly sessionId: string;
  readonly sourcePattern: string;
  readonly tagFilters: Readonly<Record<string, string>>;
  readonly mode: "wake";
  readonly persistent: boolean;
  readonly debounceMs: number;
  readonly createdAt: number;
}

export interface PollBatchDelivery {
  readonly id: string;
  readonly subscription: PollSubscription;
  readonly events: readonly ExternalEvent[];
}

export interface PollStore {
  recoverInterruptedBatches(): void;
  createSubscription(subscription: PollSubscription, maxPerSession: number, maxGlobal: number): { created: boolean; subscription: PollSubscription };
  listSubscriptions(sessionId: string): PollSubscription[];
  listActiveSubscriptions(): PollSubscription[];
  deleteSubscriptions(sessionId: string, selector: string | null): number;
  enqueueEvent(
    subscription: PollSubscription,
    event: ExternalEvent,
    options: Readonly<{ maxEvents: number; maxBytes: number; maxSessionBytes: number; maxGlobalBytes: number }>
  ): { status: "enqueued" | "duplicate"; batchId: string | null };
  claimDueBatches(now: number, limit: number): PollBatchDelivery[];
  settleBatch(batchId: string, deactivateSubscription: boolean): void;
  retryBatch(batchId: string, nextAttemptAt: number, error: string): void;
  pruneDeliveredBatches(cutoff: number): number;
}

export interface PollIngestResult {
  readonly matched: number;
  readonly enqueued: number;
  readonly duplicates: number;
}

function serialized(value: unknown, maxBytes: number, field: string): { value: unknown; text: string } {
  let text: string;
  try { text = JSON.stringify(value); }
  catch { throw new Error(`${field} 无法序列化`); }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${field} 超过大小限制`);
  return { value: JSON.parse(text), text };
}

function validateGlob(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} 无效`);
  }
  return value;
}

export function globMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let wildcardIndex = -1;
  let wildcardValueIndex = -1;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      wildcardIndex = patternIndex;
      wildcardValueIndex = valueIndex;
      patternIndex += 1;
    } else if (wildcardIndex >= 0) {
      patternIndex = wildcardIndex + 1;
      wildcardValueIndex += 1;
      valueIndex = wildcardValueIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function normalizeTags(input: unknown, field: string, patterns: boolean): Readonly<Record<string, string>> {
  if (input === undefined) return Object.freeze({});
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${field} 必须是对象`);
  const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 16) throw new Error(`${field} 数量超过 16`);
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!TAG_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${field} key 无效: ${key}`);
    }
    const value = validateGlob(rawValue, `${field}.${key}`, patterns ? 128 : 256);
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

export function normalizePollSubscriptionInput(input: PollSubscriptionInput): Readonly<Omit<PollSubscription, "id" | "sessionId" | "createdAt">> {
  if (!input || typeof input !== "object") throw new Error("Poll 订阅参数必须是对象");
  const sourcePattern = validateGlob(input.source, "source", 128);
  if (!SOURCE_PATTERN.test(sourcePattern)) throw new Error("source pattern 无效");
  if (input.mode !== undefined && input.mode !== POLL_MODE) throw new Error("仅支持 wake mode");
  if (input.persistent !== undefined && typeof input.persistent !== "boolean") throw new Error("persistent 必须是 boolean");
  const debounceMs = input.debounceMs ?? 0;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > MAX_POLL_DEBOUNCE_MS) {
    throw new Error(`debounceMs 必须在 0..${MAX_POLL_DEBOUNCE_MS}`);
  }
  return Object.freeze({
    sourcePattern,
    tagFilters: normalizeTags(input.tagFilters, "tagFilters", true),
    mode: POLL_MODE,
    persistent: input.persistent ?? true,
    debounceMs,
  });
}

export function normalizeExternalEvent(input: ExternalEventInput): ExternalEvent {
  if (!input || typeof input !== "object") throw new Error("external event 必须是对象");
  const sourceEventId = validateGlob(input.sourceEventId, "sourceEventId", 128);
  const source = validateGlob(input.source, "source", 128);
  if (!SOURCE_VALUE.test(source)) throw new Error("external event source 无效");
  const tags = normalizeTags(input.tags, "tags", false);
  const payload = serialized(input.payload, MAX_EXTERNAL_PAYLOAD_BYTES, "payload").value;
  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > Date.now() + 60_000) throw new Error("createdAt 无效");
  return Object.freeze({ sourceEventId, source, tags, payload, createdAt });
}

export function subscriptionMatches(subscription: PollSubscription, event: ExternalEvent): boolean {
  if (!globMatches(subscription.sourcePattern, event.source)) return false;
  return Object.entries(subscription.tagFilters).every(([key, pattern]) => {
    const value = event.tags[key];
    return typeof value === "string" && globMatches(pattern, value);
  });
}

export class PollManager {
  private readonly eventBus: EventBus;
  private store: PollStore | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private dispatchRequested = false;
  private stopped = true;
  private lastPruneAt = 0;

  constructor(eventBus: EventBus = getDefaultEventBus()) {
    this.eventBus = eventBus;
  }

  attachStore(store: PollStore): void {
    store.recoverInterruptedBatches();
    store.pruneDeliveredBatches(Date.now() - POLL_RECEIPT_RETENTION_MS);
    this.store = store;
  }

  subscribe(owner: ResourceOwner, input: PollSubscriptionInput): { created: boolean; subscription: PollSubscription } {
    const metadata = assertResourceOwner(owner);
    const normalized = normalizePollSubscriptionInput(input);
    const subscription: PollSubscription = Object.freeze({
      id: `p_${randomUUID().slice(0, 8)}`,
      sessionId: metadata.sessionId,
      ...normalized,
      createdAt: Date.now(),
    });
    if (!this.store) throw new Error("Poll store 尚未接入");
    return this.store.createSubscription(subscription, MAX_POLL_SUBSCRIPTIONS_PER_SESSION, MAX_POLL_SUBSCRIPTIONS_GLOBAL);
  }

  unsubscribe(owner: ResourceOwner, selector?: string): number {
    const metadata = assertResourceOwner(owner);
    if (selector !== undefined) validateGlob(selector, "subscription id/source", 128);
    if (!this.store) throw new Error("Poll store 尚未接入");
    return this.store.deleteSubscriptions(metadata.sessionId, selector ?? null);
  }

  list(owner: ResourceOwner): PollSubscription[] {
    const metadata = assertResourceOwner(owner);
    if (!this.store) return [];
    return this.store.listSubscriptions(metadata.sessionId);
  }

  async ingest(input: ExternalEventInput): Promise<PollIngestResult> {
    const event = normalizeExternalEvent(input);
    const store = this.store;
    if (!store) return Object.freeze({ matched: 0, enqueued: 0, duplicates: 0 });
    let matched = 0;
    let enqueued = 0;
    let duplicates = 0;
    for (const subscription of store.listActiveSubscriptions()) {
      if (!subscriptionMatches(subscription, event)) continue;
      matched += 1;
      const result = store.enqueueEvent(subscription, event, {
        maxEvents: MAX_POLL_BATCH_EVENTS,
        maxBytes: MAX_POLL_BATCH_BYTES,
        maxSessionBytes: MAX_POLL_STORED_BYTES_PER_SESSION,
        maxGlobalBytes: MAX_POLL_STORED_BYTES_GLOBAL,
      });
      if (result.status === "enqueued") enqueued += 1;
      else duplicates += 1;
    }
    if (!this.stopped && enqueued > 0) void this.requestDispatch();
    return Object.freeze({ matched, enqueued, duplicates });
  }

  private async requestDispatch(): Promise<void> {
    this.dispatchRequested = true;
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.dispatchRequested) {
        this.dispatchRequested = false;
        await this.dispatchDueBatches();
      }
    } finally {
      this.dispatching = false;
    }
  }

  async dispatchDueBatches(now = Date.now()): Promise<{ delivered: number; retried: number }> {
    const store = this.store;
    if (!store) return { delivered: 0, retried: 0 };
    let delivered = 0;
    let retried = 0;
    for (const batch of store.claimDueBatches(now, 16)) {
      let result;
      try {
        result = await this.eventBus.publish({
          type: "poll.external_event",
          source: "poll",
          sourceEventId: `poll:${batch.subscription.id}:${batch.id}`,
          targetSessionId: batch.subscription.sessionId,
          tags: [],
          payload: {
            subscriptionId: batch.subscription.id,
            sourcePattern: batch.subscription.sourcePattern,
            mode: batch.subscription.mode,
            events: batch.events,
          },
        });
      } catch (error) {
        result = { status: "rejected" as const, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.status === "duplicate" || (result.status === "published" && result.persisted)) {
        store.settleBatch(batch.id, !batch.subscription.persistent);
        delivered += 1;
      } else {
        const error = result.status === "rejected" ? result.error : "EventBus 未持久化 Poll batch";
        store.retryBatch(batch.id, now + POLL_RETRY_MS, error);
        retried += 1;
      }
    }
    if (now - this.lastPruneAt >= 60_000) {
      this.lastPruneAt = now;
      store.pruneDeliveredBatches(now - POLL_RECEIPT_RETENTION_MS);
    }
    return { delivered, retried };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.requestDispatch().catch(() => undefined); }, POLL_DISPATCH_INTERVAL_MS);
    this.timer.unref?.();
    void this.requestDispatch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.dispatching) await new Promise(resolve => setImmediate(resolve));
  }
}

let defaultManager: PollManager | null = null;

export function getDefaultPollManager(): PollManager {
  if (!defaultManager) defaultManager = new PollManager();
  return defaultManager;
}
