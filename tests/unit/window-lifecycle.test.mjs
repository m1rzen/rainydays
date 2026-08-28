import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { link, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { makeTempDir, removeFixture } from "../helpers.mjs";

const require = createRequire(import.meta.url);
const {
  createWindowStateStore,
  normalizePersistedState,
  parseLaunchIntent,
  resolveWindowState,
} = require("../../electron/window-lifecycle.cjs");

const displays = [
  { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, primary: false, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
];

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    bounds: { x: 2100, y: 100, width: 1000, height: 800 },
    maximized: false,
    fullscreen: false,
    displayId: "2",
    ...overrides,
  };
}

test("DS-01 restores reachable bounds across display removal and metric changes", () => {
  assert.deepEqual(resolveWindowState(null, displays), {
    schemaVersion: 1,
    bounds: { x: 360, y: 120, width: 1200, height: 800 },
    maximized: false,
    fullscreen: false,
    displayId: "1",
  });
  assert.deepEqual(resolveWindowState(state(), displays), state());

  const removed = resolveWindowState(state(), [displays[0]]);
  assert.deepEqual(removed.bounds, { x: 920, y: 100, width: 1000, height: 800 });
  assert.equal(removed.displayId, "1");

  const smaller = resolveWindowState(state({ bounds: { x: 2500, y: 900, width: 1400, height: 1200 } }), [
    displays[0],
    { id: 2, primary: false, workArea: { x: 1920, y: 0, width: 900, height: 700 } },
  ]);
  assert.deepEqual(smaller.bounds, { x: 1920, y: 0, width: 900, height: 700 });
});

test("DS-01 launch intents accept only one canonical Session target", () => {
  const sessionId = "01234567-89ab-4def-8abc-0123456789ab";
  assert.deepEqual(parseLaunchIntent(["RainyDays.exe", `--session=${sessionId.toUpperCase()}`]), { type: "show", sessionId });
  assert.deepEqual(parseLaunchIntent([`rainydays://session/${sessionId}`]), { type: "show", sessionId });
  assert.deepEqual(parseLaunchIntent([`--session=${sessionId}`, "rainydays://session/11234567-89ab-4def-8abc-0123456789ab"]), { type: "show", sessionId: null });
  assert.deepEqual(parseLaunchIntent(["--session=../../escape", "https://attacker.invalid/"]), { type: "show", sessionId: null });
});

test("DS-01 state validation rejects unknown keys and unsafe geometry", () => {
  assert.equal(normalizePersistedState({ ...state(), extra: true }), null);
  assert.equal(normalizePersistedState(state({ bounds: { x: 0, y: 0, width: 0, height: 800 } })), null);
  assert.equal(normalizePersistedState(state({ displayId: "" })), null);
  assert.deepEqual(normalizePersistedState(state({ maximized: true, fullscreen: true })), state({ maximized: true, fullscreen: true }));
});

test("DS-01 state store atomically flushes a bounded identity and ignores hardlinks", async () => {
  const root = await makeTempDir("mini-lux-ds01-window-state-");
  const events = [];
  try {
    const store = createWindowStateStore({ root, io: fs, path, randomBytes, onEvent: event => events.push(event) });
    assert.equal(store.load(), null);
    store.schedule(state(), 10_000);
    store.flush();
    assert.deepEqual(store.load(), state());
    assert.match(await readFile(path.join(root, "window-state.json"), "utf8"), /"schemaVersion":1/u);
    store.close();
    assert(events.some(event => event.event === "save" && event.outcome === "success"));

    await link(path.join(root, "window-state.json"), path.join(root, "window-state.alias.json"));
    const hardlinked = createWindowStateStore({ root, io: fs, path, randomBytes });
    assert.equal(hardlinked.load(), null);
    hardlinked.close();

    await writeFile(path.join(root, "window-state.json"), "{not-json", "utf8");
    const corrupted = createWindowStateStore({ root, io: fs, path, randomBytes });
    assert.equal(corrupted.load(), null);
    corrupted.close();
  } finally {
    await removeFixture(root);
  }
});
