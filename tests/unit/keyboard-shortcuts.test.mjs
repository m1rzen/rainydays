import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

await import(`../../public/keyboard-shortcuts.js?test=${Date.now()}`);
const keyboard = globalThis.RainyDaysKeyboard;

function storage(initial = null) {
  const values = new Map(initial === null ? [] : [[keyboard.storageKey, initial]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    value: key => values.get(key) ?? null,
  };
}
function event(key, modifiers = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test("DS-07 shortcut chords are canonical, finite and conflict-free", () => {
  assert.equal(keyboard.normalizeChord("shift+primary+f"), "Primary+Shift+F");
  assert.equal(keyboard.normalizeChord("alt+shift+ArrowRight"), "Alt+Shift+ArrowRight");
  assert.throws(() => keyboard.normalizeChord("Primary+Meta+N"), /ambiguous/u);
  assert.throws(() => keyboard.normalizeChord("Alt+Alt+V"), /duplicated/u);
  assert.throws(() => keyboard.normalizeChord("Alt+F+V"), /multiple keys/u);
  assert.throws(() => keyboard.normalizeBindings({ unknown: "Primary+Q" }), /Unknown shortcut action/u);
  assert.throws(() => keyboard.normalizeBindings({ newSession: "Primary+W" }), /Shortcut conflict/u);
  assert.throws(() => keyboard.normalizeBindings({ newSession: "Control+Q", openFile: "Primary+Q" }), /non-darwin/u);
  assert.throws(() => keyboard.normalizeBindings({ newSession: "Meta+Q", openFile: "Primary+Q" }), /darwin/u);
});

test("DS-07 Primary maps to Command on macOS and Control elsewhere", () => {
  const bindings = keyboard.normalizeBindings({});
  assert.equal(keyboard.actionForEvent(event("n", { metaKey: true }), bindings, "darwin"), "newSession");
  assert.equal(keyboard.actionForEvent(event("n", { ctrlKey: true }), bindings, "darwin"), null);
  assert.equal(keyboard.actionForEvent(event("n", { ctrlKey: true }), bindings, "win32"), "newSession");
  assert.equal(keyboard.actionForEvent(event("n", { metaKey: true }), bindings, "win32"), null);
  assert.equal(keyboard.actionForEvent(event("ArrowRight", { altKey: true, shiftKey: true }), bindings, "win32"), "splitHorizontal");
  assert.equal(keyboard.actionForEvent(event("F12"), bindings, "win32"), null);
});

test("DS-07 keymap persistence validates overrides and fails closed to defaults", () => {
  const store = storage();
  const saved = keyboard.saveBindings({ openFile: "Primary+Shift+O" }, store);
  assert.equal(saved.openFile, "Primary+Shift+O");
  assert.equal(keyboard.loadBindings(store).openFile, "Primary+Shift+O");
  assert.deepEqual(Object.keys(JSON.parse(store.value(keyboard.storageKey))).sort(), ["bindings", "schemaVersion"]);

  const malformed = storage('{"schemaVersion":1,"bindings":{"openFile":"Alt+Alt+F"}}');
  assert.equal(keyboard.loadBindings(malformed).openFile, keyboard.defaults.openFile);
  const extra = storage('{"schemaVersion":1,"bindings":{},"extra":true}');
  assert.equal(keyboard.loadBindings(extra).newSession, keyboard.defaults.newSession);
});

test("DS-07 renderer has one context-prioritized keyboard manager and preserves history drafts", async () => {
  const renderer = await fs.readFile(new URL("../../public/renderer.js", import.meta.url), "utf8");
  assert.equal((renderer.match(/document\.addEventListener\("keydown"/gu) || []).length, 1);
  assert.match(renderer, /if \(terminalTarget\) return;/u);
  assert.match(renderer, /if \(isTextEditingTarget\(target\) \|\| settingsVisible\) return;/u);
  assert.match(renderer, /action === "cancelRun"/u);
  assert.match(renderer, /historyDraftBeforeNavigation = inputEl\.value/u);
  assert.match(renderer, /inputEl\.value = historyDraftBeforeNavigation/u);
  assert.match(renderer, /parsed\.filter\(value => typeof value === "string"/u);
});
