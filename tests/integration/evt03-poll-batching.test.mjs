import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-evt03-batching-");
await fs.mkdir(path.join(fixture, "data"), { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
});
const [{ createPollStore, insertSession, deleteSession, closeDb }, { PollManager }, { issueResourceOwner }] = await Promise.all([
  import("../../dist/db.js"),
  import("../../dist/poll.js"),
  import("../../dist/resource-owner.js"),
]);
const sessionId = "evt03-batch-session";
const nowIso = new Date().toISOString();
insertSession({ id: sessionId, persona_name: "general", title: "EVT-03 batches", created_at: nowIso, updated_at: nowIso });
const owner = issueResourceOwner({ authorityId: "evt03-batch-authority", authorityEpoch: 1, sessionId, principal: "agent", rootIds: [] });

after(async () => {
  closeDb();
  await removeFixture(fixture);
});

test("EVT-03 SQLite batches enforce trailing debounce, cap sealing and Session cascade", async () => {
  const published = [];
  const manager = new PollManager({
    publish: async input => {
      published.push(input);
      return { status: "published", id: `evt_${published.length}`, persisted: true };
    },
  });
  manager.attachStore(createPollStore());
  manager.subscribe(owner, { source: "burst:*", debounceMs: 60_000 });
  for (let index = 0; index < 101; index += 1) {
    const result = await manager.ingest({ sourceEventId: `burst-${index}`, source: "burst:event", payload: { index } });
    assert.equal(result.enqueued, 1);
  }
  const sealed = await manager.dispatchDueBatches(Date.now());
  assert.deepEqual(sealed, { delivered: 1, retried: 0 });
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.events.length, 100);
  const deliveredDuplicate = await manager.ingest({ sourceEventId: "burst-0", source: "burst:event", payload: { index: 0 } });
  assert.deepEqual(deliveredDuplicate, { matched: 1, enqueued: 0, duplicates: 1 });
  assert.equal(
    JSON.stringify(published[0].payload.events.map(event => event.payload.index)),
    JSON.stringify(Array.from({ length: 100 }, (_, index) => index)),
  );

  const trailing = await manager.dispatchDueBatches(Date.now());
  assert.deepEqual(trailing, { delivered: 0, retried: 0 });
  const final = await manager.dispatchDueBatches(Date.now() + 61_000);
  assert.deepEqual(final, { delivered: 1, retried: 0 });
  assert.equal(published[1].payload.events.length, 1);
  assert.equal(published[1].payload.events[0].payload.index, 100);

  manager.subscribe(owner, { source: "debounce:*", debounceMs: 1_000 });
  await manager.ingest({ sourceEventId: "debounce-1", source: "debounce:event", payload: {} });
  assert.deepEqual(await manager.dispatchDueBatches(Date.now()), { delivered: 0, retried: 0 });
  assert.deepEqual(await manager.dispatchDueBatches(Date.now() + 1_100), { delivered: 1, retried: 0 });

  const oneShot = manager.subscribe(owner, { source: "once:*", persistent: false, debounceMs: 1_000 }).subscription;
  assert.equal((await manager.ingest({ sourceEventId: "once-1", source: "once:event", payload: { index: 1 } })).enqueued, 1);
  assert.deepEqual(
    await manager.ingest({ sourceEventId: "once-2", source: "once:event", payload: { index: 2 } }),
    { matched: 0, enqueued: 0, duplicates: 0 },
  );
  assert.equal(manager.list(owner).length, 3); // one-shot remains visible while its first batch is pending
  assert.deepEqual(await manager.dispatchDueBatches(Date.now() + 1_100), { delivered: 1, retried: 0 });
  assert.equal(manager.list(owner).length, 2); // inactive after successful EventBus persistence

  const reactivated = manager.subscribe(owner, { source: "once:*", persistent: false, debounceMs: 1_000 });
  assert.equal(reactivated.created, true);
  assert.equal(reactivated.subscription.id, oneShot.id);
  assert.deepEqual(
    await manager.ingest({ sourceEventId: "once-1", source: "once:event", payload: { index: 1 } }),
    { matched: 1, enqueued: 0, duplicates: 1 },
  );
  assert.deepEqual(
    await manager.ingest({ sourceEventId: "once-2", source: "once:event", payload: { index: 2 } }),
    { matched: 1, enqueued: 1, duplicates: 0 },
  );

  deleteSession(sessionId);
  assert.equal(manager.list(owner).length, 0);
});
