import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeTempDir, removeFixture, runProcess } from "../helpers.mjs";

test("EVT-03 Poll subscription and debounce batch survive restart without duplicate delivery", async () => {
  const fixture = await makeTempDir("mini-lux-evt03-poll-restart-");
  const childEnv = {
    ...process.env,
    EVT03_USER_DATA_DIR: fixture,
    EVT03_DATA_DIR: path.join(fixture, "data"),
  };
  try {
    const seed = await runProcess(process.execPath, ["tests/fixtures/evt03-poll-persistence-child.mjs", "seed"], {
      env: childEnv,
      timeoutMs: 60_000,
    });
    assert.equal(seed.code, 0, seed.stderr);
    const seeded = JSON.parse(seed.stdout.trim().split("\n").pop());
    assert.equal(seeded.first.enqueued, 1);
    assert.equal(seeded.second.enqueued, 1);
    assert.equal(seeded.duplicate.duplicates, 1);

    const drain = await runProcess(process.execPath, ["tests/fixtures/evt03-poll-persistence-child.mjs", "drain"], {
      env: childEnv,
      timeoutMs: 60_000,
    });
    assert.equal(drain.code, 0, drain.stderr);
    const drained = JSON.parse(drain.stdout.trim().split("\n").pop());
    assert.equal(drained.before.length, 1);
    assert.deepEqual(drained.dispatched, { delivered: 1, retried: 0 });
    assert.equal(drained.after.length, 1); // persistent rule survives restart and successful delivery
    assert.equal(drained.published.length, 1);
    assert.equal(drained.published[0].sourceEventId.startsWith(`poll:${seeded.subscriptionId}:pb_`), true);
    assert.equal(drained.published[0].targetSessionId, "evt03-restart-session");
    assert.deepEqual(drained.published[0].payload.events.map(event => event.payload.index), [1, 2]);
  } finally {
    await removeFixture(fixture);
  }
});
