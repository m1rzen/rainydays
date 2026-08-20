// ===========================================
// EventBus —— 统一事件总线 (EVT-01)
// envelope / 持久队列 / ack / 重试 / dedupe / wake 策略
//
// 合同（冻结）：
// - envelope schemaVersion=1；不可变形状
// - at-least-once 投递 + at-most-once 副作用：
//   ack = 事件被接受进 session 输入（run 已 claim），不是 run 完成
// - 入队级 dedupe：(source, sourceEventId) 唯一，重复 publish 不再扇出
// - listener 是投影：best-effort 扇出，不参与 ack，单 listener 异常不扩散
// - 仅有 targetSessionId（或显式 persist）的事件进持久队列
// - 运行中的目标 session → retry 退避（运行中注入属 EVT-02）
// ===========================================

import { randomUUID } from "node:crypto";

export const EVENT_ENVELOPE_SCHEMA_VERSION = 1;

export const EVENT_SOURCES = Object.freeze(["cron", "link", "wire", "poll", "system", "ui"] as const);
export type EventSource = (typeof EVENT_SOURCES)[number];

export type EventStatus = "pending" | "delivered" | "dead" | "expired";

export interface EventEnvelope {
  readonly schemaVersion: typeof EVENT_ENVELOPE_SCHEMA_VERSION;
  readonly id: string;
  readonly type: string;
  readonly source: EventSource;
  readonly sourceEventId: string | null;
  readonly targetSessionId: string | null;
  readonly tags: readonly string[];
  readonly payload: unknown;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface StoredEvent extends EventEnvelope {
  readonly status: EventStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
}

/** 持久层接口。真实实现在 db.ts；测试可注入假实现。dueEvents 必须返回快照副本（不可暴露活引用）。 */
export interface EventStore {
  insertEvent(event: EventEnvelope): { inserted: boolean; existingId: string | null };
  dueEvents(now: number, limit: number): StoredEvent[];
  recordAttempt(id: string, now: number): void;
  settleEvent(id: string, status: "delivered" | "dead" | "expired", lastError: string | null, now: number): void;
  scheduleRetry(id: string, nextAttemptAt: number, lastError: string | null): void;
  pruneEvents(now: number, deliveredCutoffMs: number, deadCutoffMs: number): number;
  countByStatus(): Record<EventStatus, number>;
  pendingEventsForSession(sessionId: string, limit: number): StoredEvent[];
}

export type EventListener = (event: EventEnvelope) => void | Promise<void>;

export type SessionDeliveryOutcome =
  | { readonly outcome: "acked" }
  | { readonly outcome: "retry"; readonly error?: string }
  | { readonly outcome: "dead"; readonly error?: string };

export type SessionDeliveryHandler = (event: EventEnvelope) => Promise<SessionDeliveryOutcome> | SessionDeliveryOutcome;

export interface PublishInput {
  readonly type: string;
  readonly source: EventSource;
  readonly sourceEventId?: string | null;
  readonly targetSessionId?: string | null;
  readonly tags?: readonly string[];
  readonly payload: unknown;
  readonly expiresAt?: number | null;
  /** 强制持久化（默认：有 targetSessionId 才持久）。 */
  readonly persist?: boolean;
}

export type PublishResult =
  | { readonly status: "published"; readonly id: string; readonly persisted: boolean }
  | { readonly status: "duplicate"; readonly id: string }
  | { readonly status: "rejected"; readonly error: string };

export interface DispatchOutcome {
  readonly attempted: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  readonly expired: number;
}

type DispatchCounters = { -readonly [K in keyof DispatchOutcome]: number };

export interface EventBusOptions {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly dispatchIntervalMs: number;
  readonly maxPayloadBytes: number;
  readonly maxTags: number;
  readonly deliveredRetentionMs: number;
  readonly deadRetentionMs: number;
  readonly dispatchBatchLimit: number;
}

export const DEFAULT_EVENT_BUS_OPTIONS: Readonly<EventBusOptions> = Object.freeze({
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
  dispatchIntervalMs: 500,
  maxPayloadBytes: 65_536,
  maxTags: 8,
  deliveredRetentionMs: 24 * 60 * 60 * 1_000,
  deadRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  dispatchBatchLimit: 16,
});

const EVENT_ID_PREFIX = "evt_";
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;
const EVENT_TAG_PATTERN = /^[\w:.*?-]{1,64}$/u;
const MAX_SOURCE_EVENT_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_EVENT_TYPE_LENGTH = 64;

function rejection(error: string): PublishResult {
  return { status: "rejected", error };
}

function serializePayload(payload: unknown, maxBytes: number): string | null {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (typeof text !== "string" || text.length > maxBytes) return null;
  return text;
}

export function retryDelayMs(attempts: number, options: Readonly<EventBusOptions>): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = options.backoffBaseMs * 2 ** Math.min(exponent, 30);
  return Math.min(raw, options.backoffCapMs);
}

export class EventBus {
  private readonly options: Readonly<EventBusOptions>;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private store: EventStore | null = null;
  private sessionHandler: SessionDeliveryHandler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private dispatchRequested = false;
  private stopped = true;
  private lastPruneAt = 0;

  constructor(options: Partial<EventBusOptions> = {}) {
    const merged = { ...DEFAULT_EVENT_BUS_OPTIONS, ...options };
    for (const key of Object.keys(merged) as (keyof EventBusOptions)[]) {
      const value = merged[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`EventBus 选项无效: ${key}`);
      if (key === "backoffBaseMs" && value < 1) throw new Error("EventBus 选项无效: backoffBaseMs");
    }
    if (merged.backoffCapMs < merged.backoffBaseMs) throw new Error("EventBus backoffCapMs 不能小于 backoffBaseMs");
    this.options = Object.freeze(merged);
  }

  /** 接入持久层。接入前 publish 仅扇出 listener。 */
  attachStore(store: EventStore): void {
    this.store = store;
  }

  /** 安装 session 投递策略（wake/inject）。单 handler，由宿主安装。 */
  setSessionDelivery(handler: SessionDeliveryHandler): void {
    this.sessionHandler = handler;
  }

  addListener(typePattern: string, listener: EventListener): () => void {
    if (typePattern !== "*" && !EVENT_TYPE_PATTERN.test(typePattern)) throw new Error(`事件类型模式无效: ${typePattern}`);
    if (typeof listener !== "function") throw new Error("listener 必须是函数");
    let set = this.listeners.get(typePattern);
    if (!set) {
      set = new Set();
      this.listeners.set(typePattern, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(typePattern);
    };
  }

  /** 发布事件。永不抛出：校验失败/序列化失败返回 rejected。 */
  async publish(input: PublishInput): Promise<PublishResult> {
    if (!input || typeof input !== "object") return rejection("input 必须是对象");
    if (typeof input.type !== "string" || !EVENT_TYPE_PATTERN.test(input.type) || input.type.length > MAX_EVENT_TYPE_LENGTH) {
      return rejection(`事件类型无效: ${String(input.type)}`);
    }
    if (!EVENT_SOURCES.includes(input.source)) return rejection(`事件 source 无效: ${String(input.source)}`);
    const sourceEventId = input.sourceEventId ?? null;
    if (sourceEventId !== null && (typeof sourceEventId !== "string" || sourceEventId.length === 0 || sourceEventId.length > MAX_SOURCE_EVENT_ID_LENGTH)) {
      return rejection("sourceEventId 必须是 1-128 字符或 null");
    }
    const targetSessionId = input.targetSessionId ?? null;
    if (targetSessionId !== null && (typeof targetSessionId !== "string" || targetSessionId.length === 0 || targetSessionId.length > MAX_SESSION_ID_LENGTH)) {
      return rejection("targetSessionId 必须是 1-128 字符或 null");
    }
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.length > this.options.maxTags) return rejection(`tags 数量超限 (max ${this.options.maxTags})`);
    for (const tag of tags) {
      if (typeof tag !== "string" || !EVENT_TAG_PATTERN.test(tag)) return rejection(`tag 无效: ${String(tag)}`);
    }
    const createdAt = Date.now();
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= createdAt)) return rejection("expiresAt 必须大于 createdAt 或为 null");
    const payloadJson = serializePayload(input.payload, this.options.maxPayloadBytes);
    if (payloadJson === null) return rejection("payload 无法序列化或超过大小限制");
    const parsed = JSON.parse(payloadJson); // round-trip：保证读取时字节一致

    const envelope: EventEnvelope = Object.freeze({
      schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
      id: `${EVENT_ID_PREFIX}${randomUUID()}`,
      type: input.type,
      source: input.source,
      sourceEventId,
      targetSessionId,
      tags: Object.freeze([...tags]),
      payload: parsed,
      createdAt,
      expiresAt,
    });

    const persist = input.persist === true || targetSessionId !== null;
    if (persist && this.store) {
      let inserted: { inserted: boolean; existingId: string | null };
      try {
        inserted = this.store.insertEvent(envelope);
      } catch (error) {
        return rejection(`事件写入失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!inserted.inserted) {
        const existingId = inserted.existingId ?? envelope.id;
        return { status: "duplicate", id: existingId };
      }
    }

    this.fanout(envelope);

    if (persist && this.store && !this.stopped) void this.requestDispatch();
    return { status: "published", id: envelope.id, persisted: persist && this.store !== null };
  }

  /** listener 扇出：同步回调、异常隔离、不等待。 */
  private fanout(envelope: EventEnvelope): void {
    const exact = this.listeners.get(envelope.type);
    const wildcard = this.listeners.get("*");
    const targets = [...(exact ?? []), ...(wildcard ?? [])];
    for (const listener of targets) {
      try {
        const returned = listener(envelope);
        if (returned && typeof (returned as Promise<void>).then === "function") {
          void (returned as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* 单 listener 异常不得影响其他 listener 或投递 */
      }
    }
  }

  private async requestDispatch(): Promise<void> {
    this.dispatchRequested = true;
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.dispatchRequested) {
        this.dispatchRequested = false;
        await this.dispatchDueEvents();
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** 到期事件调度。批处理 pending → handler → ack/retry/dead；过期 → expired。 */
  async dispatchDueEvents(now = Date.now()): Promise<DispatchOutcome> {
    const store = this.store;
    if (!store) return Object.freeze({ attempted: 0, delivered: 0, retried: 0, dead: 0, expired: 0 });
    const counts: DispatchCounters = { attempted: 0, delivered: 0, retried: 0, dead: 0, expired: 0 };
    const due = store.dueEvents(now, this.options.dispatchBatchLimit);
    for (const event of due) {
      if (event.expiresAt !== null && event.expiresAt <= now) {
        store.settleEvent(event.id, "expired", null, now);
        counts.expired += 1;
        continue;
      }
      counts.attempted += 1;
      store.recordAttempt(event.id, now);
      if (event.targetSessionId === null) {
        // 仅持久化的 listener 级事件：入队即视为完成投递
        store.settleEvent(event.id, "delivered", null, now);
        counts.delivered += 1;
        continue;
      }
      const handler = this.sessionHandler;
      if (!handler) {
        this.settleRetry(store, event, now, "未安装 session 投递策略", counts);
        continue;
      }
      let result: SessionDeliveryOutcome;
      try {
        result = await handler(event);
      } catch (error) {
        result = { outcome: "retry", error: error instanceof Error ? error.message : String(error) };
      }
      if (!result || (result.outcome !== "acked" && result.outcome !== "retry" && result.outcome !== "dead")) {
        result = { outcome: "retry", error: "session 投递策略返回了无效结果" };
      }
      if (result.outcome === "acked") {
        store.settleEvent(event.id, "delivered", null, now);
        counts.delivered += 1;
      } else if (result.outcome === "dead") {
        store.settleEvent(event.id, "dead", result.error ?? "session 投递策略判定不可投递", now);
        counts.dead += 1;
      } else {
        this.settleRetry(store, event, now, result.error ?? "session 投递策略要求重试", counts);
      }
    }
    this.maybePrune(store, now);
    return Object.freeze(counts);
  }

  private settleRetry(store: EventStore, event: StoredEvent, now: number, error: string, counts: DispatchCounters): void {
    const attempts = event.attempts + 1; // recordAttempt 已 +1
    if (attempts >= this.options.maxAttempts) {
      store.settleEvent(event.id, "dead", error, now);
      counts.dead += 1;
      return;
    }
    store.scheduleRetry(event.id, now + retryDelayMs(attempts, this.options), error);
    counts.retried += 1;
  }

  private maybePrune(store: EventStore, now: number): void {
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    try {
      store.pruneEvents(now, this.options.deliveredRetentionMs, this.options.deadRetentionMs);
    } catch {
      /* 清理失败不影响投递 */
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.requestDispatch().catch(() => undefined);
    }, this.options.dispatchIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等待在途调度完成
    while (this.dispatching) await new Promise(resolve => setImmediate(resolve));
  }

  pendingForSession(sessionId: string, limit = 50): StoredEvent[] {
    if (!this.store) return [];
    return this.store.pendingEventsForSession(sessionId, limit);
  }

  stats(): Record<EventStatus, number> {
    if (!this.store) return { pending: 0, delivered: 0, dead: 0, expired: 0 };
    return this.store.countByStatus();
  }
}

// ===========================================
// 惰性默认实例：未 attachStore 时 publish 仅扇出 listener。
// link/wire 等模块在无宿主环境（单测）下零行为变化。
// ===========================================
let defaultBus: EventBus | null = null;

export function getDefaultEventBus(): EventBus {
  if (!defaultBus) defaultBus = new EventBus();
  return defaultBus;
}
