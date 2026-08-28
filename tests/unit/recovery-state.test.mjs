import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { link, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { makeTempDir, removeFixture } from "../helpers.mjs";

const require = createRequire(import.meta.url);
const { createRecoveryStateStore, normalizeState } = require("../../electron/recovery-state.cjs");

function openStore(root, now = () => 1_000) {
  return createRecoveryStateStore({ root, io: fs, path, randomBytes, now });
}

test("REL-03 enters safe mode after three bounded unclean main-process launches", async () => {
  const root = await makeTempDir("mini-lux-rel03-main-loop-");
  try {
    let store = openStore(root);
    assert.equal(store.beginLaunch({ time: 1_000 }).safeMode, false);
    store.close();
    store = openStore(root);
    assert.equal(store.beginLaunch({ time: 2_000 }).safeMode, false);
    store.close();
    store = openStore(root);
    assert.equal(store.beginLaunch({ time: 3_000 }).safeMode, false);
    store.close();
    store = openStore(root);
    const safe = store.beginLaunch({ time: 4_000 });
    assert.equal(safe.safeMode, true);
    assert.equal(safe.safeModeReason, "main-crash-loop");
    assert.equal(safe.uncleanLaunches.length, 3);
    assert.deepEqual(store.diagnostics(), {
      schemaVersion: 1,
      safeMode: true,
      reason: "main-crash-loop",
      uncleanLaunches: 3,
      serviceCrashLoops: 0,
      rendererCrashLoops: 0,
      electronChildCrashes: 0,
      normalRetryAvailable: true,
    });
    store.close();
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 grants one persisted normal retry and re-enters safe mode on another crash", async () => {
  const root = await makeTempDir("mini-lux-rel03-retry-");
  try {
    let store = openStore(root);
    store.beginLaunch({ time: 1_000 });
    store.close();
    store = openStore(root); store.beginLaunch({ time: 2_000 }); store.close();
    store = openStore(root); store.beginLaunch({ time: 3_000 }); store.close();
    store = openStore(root); assert.equal(store.beginLaunch({ time: 4_000 }).safeMode, true);
    const retry = store.requestNormalRetry(4_100);
    assert.equal(retry.safeMode, false);
    assert.equal(retry.normalRetry, true);
    store.close();

    store = openStore(root);
    const allowed = store.beginLaunch({ time: 5_000, normalRetry: true });
    assert.equal(allowed.safeMode, false);
    assert.equal(allowed.normalRetry, false);
    store.close();

    store = openStore(root);
    const repeated = store.beginLaunch({ time: 6_000 });
    assert.equal(repeated.safeMode, true);
    assert.equal(repeated.safeModeReason, "main-crash-loop");
    store.close();
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 clean exit resets normal crash counters but preserves an active safe mode", async () => {
  const root = await makeTempDir("mini-lux-rel03-clean-");
  try {
    let store = openStore(root);
    store.beginLaunch({ time: 1_000 });
    const clean = store.markCleanExit(2_000);
    assert.equal(clean.activeLaunch, false);
    assert.deepEqual(clean.uncleanLaunches, []);
    store.close();

    store = openStore(root);
    assert.equal(store.beginLaunch({ time: 3_000 }).safeMode, false);
    const safe = store.enterSafeMode("service-crash-loop", 3_100);
    assert.equal(safe.serviceCrashLoops, 1);
    const safeExit = store.markCleanExit(3_200);
    assert.equal(safeExit.safeMode, true);
    assert.equal(safeExit.safeModeReason, "service-crash-loop");
    store.close();
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 invalid or hardlinked ledgers fail into integrity safe mode", async () => {
  const root = await makeTempDir("mini-lux-rel03-integrity-");
  try {
    await writeFile(path.join(root, "recovery-state.json"), "{invalid-json", "utf8");
    let store = openStore(root);
    const invalid = store.beginLaunch({ time: 1_000 });
    assert.equal(invalid.safeMode, true);
    assert.equal(invalid.safeModeReason, "integrity-failure");
    store.close();

    await link(path.join(root, "recovery-state.json"), path.join(root, "recovery-state.alias.json"));
    store = openStore(root);
    const hardlinked = store.beginLaunch({ time: 2_000 });
    assert.equal(hardlinked.safeMode, true);
    assert.equal(hardlinked.safeModeReason, "integrity-failure");
    store.close();
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 ledger validation rejects unknown or sensitive-shaped payloads", () => {
  const valid = {
    schemaVersion: 1,
    activeLaunch: false,
    launchStartedAt: null,
    uncleanLaunches: [],
    safeMode: false,
    safeModeReason: null,
    serviceCrashLoops: 0,
    rendererCrashLoops: 0,
    electronChildCrashes: 0,
    normalRetry: false,
  };
  assert.deepEqual(normalizeState(valid), valid);
  assert.equal(normalizeState({ ...valid, token: "forbidden" }), null);
  assert.equal(normalizeState({ ...valid, safeMode: true }), null);
  assert.equal(normalizeState({ ...valid, uncleanLaunches: [2, 1] }), null);
});
