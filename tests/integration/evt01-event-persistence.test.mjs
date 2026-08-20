import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-evt01-events-");
const dataDir = path.join(fixture, "data");
await mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
});

const { createEventStore, closeDb, getDatabaseSchemaVersion } = await import("../../dist/db.js");
const { EventBus } = await import("../../dist/event-bus.js");

after(async () => {
  closeDb();
  await removeFixture(fixture);
});

test("EVT-01 schema v4：events 表就位且 user_version=4", () => {
  assert.equal(getDatabaseSchemaVersion(), 4);
  const store = createEventStore();
  assert.deepEqual(store.countByStatus(), { pending: 0, delivered: 0, dead: 0, expired: 0 });
});

test("EVT-01 SQLite 入队级 dedupe：相同 (source, sourceEventId) 拒绝二次插入", () => {
  const store = createEventStore();
  const envelope = Object.freeze({
    schemaVersion: 1,
    id: "evt_dedupe_probe_1",
    type: "cron.triggered",
    source: "cron",
    sourceEventId: "job:42:t",
    targetSessionId: "s-dedupe",
    tags: Object.freeze([]),
    payload: { probe: true },
    createdAt: Date.now(),
    expiresAt: null,
  });
  const first = store.insertEvent(envelope);
  assert.equal(first.inserted, true);
  const second = store.insertEvent({ ...envelope, id: "evt_dedupe_probe_2" });
  assert.equal(second.inserted, false);
  assert.equal(second.existingId, "evt_dedupe_probe_1");
  // 收敛本用例插入的行，避免污染后续 dispatch（直连 store 不走 bus 生命周期）
  store.settleEvent("evt_dedupe_probe_1", "delivered", null, Date.now());
});

test("EVT-01 按 Session 精确路由：handler 只收到目标 Session 的事件", async () => {
  const bus = new EventBus({ dispatchIntervalMs: 60_000, backoffBaseMs: 10 });
  bus.attachStore(createEventStore());
  const seen = [];
  bus.setSessionDelivery(event => {
    seen.push(event.targetSessionId);
    return { outcome: "acked" };
  });
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s-alpha", payload: { m: 1 } });
  await bus.publish({ type: "link.message", source: "link", targetSessionId: "s-beta", payload: { m: 2 } });
  await bus.publish({ type: "cron.triggered", source: "cron", targetSessionId: "s-alpha", payload: { m: 3 } });
  const outcome = await bus.dispatchDueEvents();
  assert.equal(outcome.delivered, 3);
  assert.deepEqual(seen.sort(), ["s-alpha", "s-alpha", "s-beta"]);
  assert.equal(bus.stats().pending, 0); // 全部投递完毕（delivered 总数含前序用例的探针行）
});

test("EVT-01 真实退避重试后成功投递（retry → ack）", async () => {
  const bus = new EventBus({ dispatchIntervalMs: 60_000, backoffBaseMs: 5 });
  bus.attachStore(createEventStore());
  let attempts = 0;
  bus.setSessionDelivery(() => {
    attempts += 1;
    return attempts >= 2 ? { outcome: "acked" } : { outcome: "retry", error: "Session 正在运行" };
  });
  const published = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:retry:t", targetSessionId: "s-retry", payload: {} });
  assert.equal(published.status, "published");
  const first = await bus.dispatchDueEvents();
  assert.equal(first.retried, 1);
  const store = createEventStore();
  const pending = store.pendingEventsForSession("s-retry", 10);
  assert.equal(pending.length, 1);
  const second = await bus.dispatchDueEvents(pending[0].nextAttemptAt + 1);
  assert.equal(second.delivered, 1);
  assert.equal(attempts, 2);
});

test("EVT-01 断线不丢：seed 子进程写入 → drain 子进程重启后完整投递", async () => {
  const restartFixture = await makeTempDir("mini-lux-evt01-restart-");
  const restartData = path.join(restartFixture, "data");
  const childEnv = {
    ...process.env,
    EVT01_USER_DATA_DIR: restartFixture,
    EVT01_DATA_DIR: restartData,
  };
  try {
    const seed = await runProcess(process.execPath, ["tests/fixtures/evt01-persistence-child.mjs", "seed"], { env: childEnv, timeoutMs: 60_000 });
    assert.equal(seed.code, 0, `seed stderr: ${seed.stderr}`);
    const seedResult = JSON.parse(seed.stdout.trim().split("\n").pop());
    assert.equal(seedResult.published, "published");
    assert.equal(seedResult.duplicate, "duplicate"); // 断线前 dedupe 已生效
    assert.equal(seedResult.schemaVersion, 4);

    const drain = await runProcess(process.execPath, ["tests/fixtures/evt01-persistence-child.mjs", "drain"], { env: childEnv, timeoutMs: 60_000 });
    assert.equal(drain.code, 0, `drain stderr: ${drain.stderr}`);
    const drainResult = JSON.parse(drain.stdout.trim().split("\n").pop());
    // 重启后：两条事件完整投递（无重复副作用），dedupe 的重复发布不产生第三条
    assert.equal(drainResult.drained.delivered, 2);
    assert.equal(drainResult.acked.length, 2);
    assert.ok(drainResult.acked.every(entry => entry.target === "evt01-restart"));
    assert.equal(drainResult.stats.pending, 0);
  } finally {
    await removeFixture(restartFixture);
  }
});
