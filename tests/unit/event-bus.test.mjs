import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EVENT_BUS_OPTIONS,
  EventBus,
  EVENT_ENVELOPE_SCHEMA_VERSION,
  EVENT_SOURCES,
  retryDelayMs,
} from "../../dist/event-bus.js";

// ===========================================
// 内存假 store：镜像 SQLite EventStore 语义
// ===========================================
function createFakeStore() {
  const rows = new Map();
  return {
    rows,
    insertEvent(event) {
      for (const row of rows.values()) {
        if (row.source === event.source && row.sourceEventId !== null && row.sourceEventId === event.sourceEventId) {
          return { inserted: false, existingId: row.id };
        }
      }
      rows.set(event.id, {
        ...event,
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      });
      return { inserted: true, existingId: null };
    },
    dueEvents(now, limit) {
      // 与真实 SQLite store 一致：返回快照副本，不暴露活引用
      return [...rows.values()]
        .filter(row => row.status === "pending" && row.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(row => ({ ...row }));
    },
    claimPendingEvent(id, now) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || row.nextAttemptAt > now) return false;
      row.attempts += 1;
      return true;
    },
    recordAttempt(id) {
      const row = rows.get(id);
      if (row?.status === "pending") row.attempts += 1;
    },
    settleEvent(id, status, lastError) {
      const row = rows.get(id);
      if (row) {
        row.status = status;
        row.lastError = lastError;
      }
    },
    scheduleRetry(id, nextAttemptAt, lastError) {
      const row = rows.get(id);
      if (row) {
        row.status = "pending";
        row.nextAttemptAt = nextAttemptAt;
        row.lastError = lastError;
      }
    },
    pruneEvents(now, deliveredCutoffMs, deadCutoffMs) {
      let removed = 0;
      for (const [id, row] of rows) {
        if ((row.status === "delivered" && row.createdAt < now - deliveredCutoffMs)
          || ((row.status === "dead" || row.status === "expired") && row.createdAt < now - deadCutoffMs)) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    countByStatus() {
      const result = { pending: 0, delivered: 0, dead: 0, expired: 0 };
      for (const row of rows.values()) result[row.status] += 1;
      return result;
    },
    pendingEventsForSession(sessionId, limit) {
      return [...rows.values()]
        .filter(row => row.targetSessionId === sessionId && row.status === "pending")
        .slice(0, limit)
        .map(row => ({ ...row }));
    },
  };
}

function quietOptions() {
  return { dispatchIntervalMs: 10_000 }; // 不 start()，手动 dispatchDueEvents
}

// ===========================================
// envelope 校验
// ===========================================
test("publish 校验失败返回 rejected 且永不抛出", async () => {
  const bus = new EventBus(quietOptions());
  const bad = await bus.publish({ type: "cron", source: "cron", payload: {} });
  assert.equal(bad.status, "rejected");
  const badSource = await bus.publish({ type: "cron.triggered", source: "nope", payload: {} });
  assert.equal(badSource.status, "rejected");
  const badPayload = await bus.publish({ type: "cron.triggered", source: "cron", payload: "x".repeat(70_000) });
  assert.equal(badPayload.status, "rejected");
  const badTags = await bus.publish({ type: "cron.triggered", source: "cron", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], payload: {} });
  assert.equal(badTags.status, "rejected");
  const badExpires = await bus.publish({ type: "cron.triggered", source: "cron", payload: {}, expiresAt: 1 });
  assert.equal(badExpires.status, "rejected");
});

test("合法 publish 产出冻结 envelope 且 schemaVersion=1", async () => {
  const bus = new EventBus(quietOptions());
  const seen = [];
  bus.addListener("cron.triggered", event => seen.push(event));
  const result = await bus.publish({
    type: "cron.triggered",
    source: "cron",
    sourceEventId: "job:1:2026",
    targetSessionId: "s1",
    tags: ["t1"],
    payload: { jobId: 1 },
  });
  assert.equal(result.status, "published");
  assert.match(result.id, /^evt_/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].schemaVersion, EVENT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(seen[0].source, "cron");
  assert.ok(Object.isFrozen(seen[0]));
  assert.deepEqual([...EVENT_SOURCES], ["cron", "link", "wire", "poll", "system", "ui"]);
});

// ===========================================
// 无 store 模式（link/wire 单测环境零行为变化）
// ===========================================
test("无 store 时 publish 仅扇出 listener 不持久化不投递", async () => {
  const bus = new EventBus(quietOptions());
  let handlerCalls = 0;
  bus.setSessionDelivery(() => {
    handlerCalls += 1;
    return { outcome: "acked" };
  });
  const seen = [];
  bus.addListener("link.message", event => seen.push(event));
  const result = await bus.publish({ type: "link.message", source: "link", targetSessionId: "s1", payload: { content: "hi" } });
  assert.equal(result.status, "published");
  assert.equal(result.persisted, false);
  assert.equal(seen.length, 1);
  assert.equal(handlerCalls, 0);
  const outcome = await bus.dispatchDueEvents();
  assert.equal(outcome.attempted, 0);
});

// ===========================================
// dedupe
// ===========================================
test("相同 (source, sourceEventId) 重复 publish 返回 duplicate 且不再扇出", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  const seen = [];
  bus.addListener("cron.triggered", event => seen.push(event));
  const first = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:7:t", targetSessionId: "s1", payload: {} });
  const second = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:7:t", targetSessionId: "s1", payload: {} });
  assert.equal(first.status, "published");
  assert.equal(second.status, "duplicate");
  assert.equal(second.id, first.id);
  assert.equal(seen.length, 1);
  assert.equal(store.rows.size, 1);
});

// ===========================================
// session 投递：ack / retry / dead / 退避 / 上限
// ===========================================
test("handler ack → delivered；重复 dispatch 无重复副作用", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  const delivered = [];
  bus.setSessionDelivery(event => {
    delivered.push(event.id);
    return { outcome: "acked" };
  });
  const result = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:1:t", targetSessionId: "s1", payload: { m: 1 } });
  assert.equal((await bus.dispatchDueEvents()).delivered, 1);
  assert.equal((await bus.dispatchDueEvents()).attempted, 0); // 已 delivered 不再调度
  assert.deepEqual(delivered, [result.id]);
  assert.equal(store.rows.get(result.id).status, "delivered");
});

test("RT-11 cancellation after due snapshot wins before Session delivery", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  let deliveries = 0;
  bus.setSessionDelivery(() => { deliveries += 1; return { outcome: "acked" }; });
  const published = await bus.publish({
    type: "cron.triggered",
    source: "cron",
    sourceEventId: "memo:cancel-race",
    targetSessionId: "s1",
    payload: { jobId: 42 },
  });
  const originalClaim = store.claimPendingEvent.bind(store);
  store.claimPendingEvent = (id, now) => {
    store.settleEvent(id, "dead", "memo completed", now);
    return originalClaim(id, now);
  };
  const outcome = await bus.dispatchDueEvents();
  assert.deepEqual(outcome, { attempted: 0, delivered: 0, retried: 0, dead: 0, expired: 0 });
  assert.equal(deliveries, 0);
  assert.equal(store.rows.get(published.id).status, "dead");
});

test("handler retry → 指数退避重排；attempts 达上限 → dead", async () => {
  const store = createFakeStore();
  const bus = new EventBus({ ...quietOptions(), maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 400 });
  bus.attachStore(store);
  let attempts = 0;
  bus.setSessionDelivery(() => {
    attempts += 1;
    return { outcome: "retry", error: "busy" };
  });
  await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:2:t", targetSessionId: "s1", payload: {} });
  let now = 1_000_000;
  let first = await bus.dispatchDueEvents(now);
  assert.equal(first.retried, 1);
  const row = [...store.rows.values()][0];
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAttemptAt, now + 100); // base
  now = row.nextAttemptAt;
  const second = await bus.dispatchDueEvents(now);
  assert.equal(second.retried, 1);
  assert.equal(row.nextAttemptAt, now + 200); // base*2
  now = row.nextAttemptAt;
  const third = await bus.dispatchDueEvents(now);
  assert.equal(third.dead, 1); // attempts=3 = maxAttempts → dead
  assert.equal(row.status, "dead");
  assert.equal(row.lastError, "busy");
  assert.equal(attempts, 3);
});

test("handler 显式 dead → 立即 dead 不再重试", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  bus.setSessionDelivery(() => ({ outcome: "dead", error: "session 不存在" }));
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "gone", payload: {} });
  const outcome = await bus.dispatchDueEvents();
  assert.equal(outcome.dead, 1);
  assert.equal([...store.rows.values()][0].status, "dead");
});

test("handler 抛异常 → 等价 retry；返回无效结果 → retry", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  bus.setSessionDelivery(() => {
    throw new Error("boom");
  });
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s1", payload: {} });
  const first = await bus.dispatchDueEvents();
  assert.equal(first.retried, 1);
  bus.setSessionDelivery(() => "nonsense");
  const row = [...store.rows.values()][0];
  row.nextAttemptAt = 0;
  const second = await bus.dispatchDueEvents();
  assert.equal(second.retried, 1);
});

test("未安装 handler → retry（事件不丢）", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s1", payload: {} });
  const outcome = await bus.dispatchDueEvents();
  assert.equal(outcome.retried, 1);
  const row = [...store.rows.values()][0];
  assert.equal(row.status, "pending");
  assert.match(row.lastError, /未安装/);
});

// ===========================================
// 过期与保留
// ===========================================
test("expiresAt 已过 → expired；不调用 handler", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  let calls = 0;
  bus.setSessionDelivery(() => {
    calls += 1;
    return { outcome: "acked" };
  });
  const base = Date.now();
  await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:3:t", targetSessionId: "s1", payload: {}, expiresAt: base + 1_000 });
  const outcome = await bus.dispatchDueEvents(base + 2_000);
  assert.equal(outcome.expired, 1);
  assert.equal(outcome.attempted, 0);
  assert.equal(calls, 0);
  assert.equal([...store.rows.values()][0].status, "expired");
});

test("prune 按保留期清理 delivered/dead/expired", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  bus.setSessionDelivery(() => ({ outcome: "acked" }));
  const t0 = Date.now();
  const a = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "a", targetSessionId: "s1", payload: {}, expiresAt: t0 + 1_000 });
  const b = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "b", targetSessionId: "s1", payload: {}, expiresAt: t0 + 60_000 });
  await bus.dispatchDueEvents(t0 + 2_000); // a 过期；b 未到期
  assert.equal(store.rows.get(a.id).status, "expired");
  const c = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "c", targetSessionId: "s1", payload: {} });
  await bus.dispatchDueEvents(t0 + 2_001); // c delivered
  store.rows.get(a.id).createdAt = 1; // 人工老化
  store.rows.get(c.id).createdAt = 1;
  store.rows.get(b.id).createdAt = t0 + 2_002; // 人工保鲜：清理时刻刚发生
  const removed = store.pruneEvents(t0 + 2_002, 1_000, 1_000);
  assert.equal(removed, 2);
  assert.equal(store.rows.has(a.id), false);
  assert.equal(store.rows.has(c.id), false);
  assert.equal(store.rows.has(b.id), true); // 未老化保留
});

// ===========================================
// listener 隔离与通配
// ===========================================
test("listener 异常不扩散；通配 listener 收到全部事件", async () => {
  const bus = new EventBus(quietOptions());
  const got = [];
  bus.addListener("cron.triggered", () => {
    throw new Error("listener boom");
  });
  bus.addListener("*", event => got.push(event.type));
  const ok = await bus.publish({ type: "cron.triggered", source: "cron", payload: {} });
  const ok2 = await bus.publish({ type: "link.message", source: "link", payload: {} });
  assert.equal(ok.status, "published");
  assert.equal(ok2.status, "published");
  assert.deepEqual(got, ["cron.triggered", "link.message"]);
});

test("listener 级持久事件（无 target + persist）→ delivered 且不调 handler", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  let calls = 0;
  bus.setSessionDelivery(() => {
    calls += 1;
    return { outcome: "acked" };
  });
  await bus.publish({ type: "wire.file_event", source: "wire", payload: { path: "x" }, persist: true });
  const outcome = await bus.dispatchDueEvents();
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.attempted, 1);
  assert.equal(calls, 0);
});

// ===========================================
// 选项与退避数学
// ===========================================
test("retryDelayMs 指数退避且封顶", () => {
  assert.equal(retryDelayMs(1, DEFAULT_EVENT_BUS_OPTIONS), 1_000);
  assert.equal(retryDelayMs(2, DEFAULT_EVENT_BUS_OPTIONS), 2_000);
  assert.equal(retryDelayMs(3, DEFAULT_EVENT_BUS_OPTIONS), 4_000);
  assert.equal(retryDelayMs(20, DEFAULT_EVENT_BUS_OPTIONS), 60_000);
});

test("EventBus 选项校验拒绝非法值", () => {
  assert.throws(() => new EventBus({ maxAttempts: 0 }), /选项无效/u);
  assert.throws(() => new EventBus({ backoffCapMs: 1, backoffBaseMs: 2_000 }), /backoffCapMs/u);
  assert.throws(() => new EventBus({ dispatchIntervalMs: -1 }), /选项无效/u);
});

test("pendingForSession 与 stats 可观测", async () => {
  const store = createFakeStore();
  const bus = new EventBus(quietOptions());
  bus.attachStore(store);
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s1", payload: {} });
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s2", payload: {} });
  assert.equal(bus.pendingForSession("s1").length, 1);
  assert.equal(bus.stats().pending, 2);
});
