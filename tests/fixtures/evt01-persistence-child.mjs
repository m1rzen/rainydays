// EVT-01 持久化子进程：seed（断线前写入）/ drain（重启后投递）
// 用法: node tests/fixtures/evt01-persistence-child.mjs <seed|drain>
// 环境: EVT01_USER_DATA_DIR / EVT01_DATA_DIR

const mode = process.argv[2];
if (mode !== "seed" && mode !== "drain") {
  console.error("usage: evt01-persistence-child.mjs <seed|drain>");
  process.exit(2);
}

const { mkdir } = await import("node:fs/promises");
const path = await import("node:path");

const fixture = process.env.EVT01_USER_DATA_DIR;
const dataDir = process.env.EVT01_DATA_DIR;
if (!fixture || !dataDir) {
  console.error("EVT01_USER_DATA_DIR and EVT01_DATA_DIR are required");
  process.exit(2);
}
await mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."),
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
});

const { createEventStore, closeDb } = await import("../../dist/db.js");
const { EventBus } = await import("../../dist/event-bus.js");

const store = createEventStore();
const bus = new EventBus({ dispatchIntervalMs: 60_000, backoffBaseMs: 10 });

if (mode === "seed") {
  bus.attachStore(store);
  const a = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:1:seed", targetSessionId: "evt01-restart", payload: { m: "wake-1" } });
  const b = await bus.publish({ type: "link.message", source: "link", sourceEventId: null, targetSessionId: "evt01-restart", payload: { m: "wake-2" } });
  const dup = await bus.publish({ type: "cron.triggered", source: "cron", sourceEventId: "job:1:seed", targetSessionId: "evt01-restart", payload: { m: "wake-1" } });
  console.log(JSON.stringify({
    ready: true,
    published: a.status,
    second: b.status,
    duplicate: dup.status,
    schemaVersion: Number((await import("../../dist/db.js")).getDatabaseSchemaVersion()),
  }));
} else {
  const acked = [];
  bus.attachStore(store);
  bus.setSessionDelivery(event => {
    acked.push({ id: event.id, target: event.targetSessionId });
    return { outcome: "acked" };
  });
  const outcome = await bus.dispatchDueEvents();
  await bus.stop();
  console.log(JSON.stringify({ ready: true, drained: outcome, acked, stats: bus.stats() }));
}

closeDb();
