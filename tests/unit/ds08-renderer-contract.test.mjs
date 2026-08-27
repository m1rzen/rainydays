import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const [database, server, renderer, preload, main] = await Promise.all([
  fs.readFile(path.join(projectRoot, "src", "db.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "src", "index.ts"), "utf8"),
  fs.readFile(path.join(projectRoot, "public", "renderer.js"), "utf8"),
  fs.readFile(path.join(projectRoot, "electron", "preload.cjs"), "utf8"),
  fs.readFile(path.join(projectRoot, "electron", "main.cjs"), "utf8"),
]);

function ordered(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert(next > cursor, `${label} missing or out of order: ${fragment}`);
    cursor = next;
  }
}

test("DS-08 EventStore commits the event and full notification in one transaction", () => {
  const start = database.indexOf("export function createEventStore");
  const end = database.indexOf("dueEvents(now, limit)", start);
  const insertion = database.slice(start, end);
  ordered(insertion, [
    "return db.transaction(() => {",
    "INSERT OR IGNORE INTO events",
    "eventDesktopNotificationInput(event)",
    "insertDesktopNotificationRecord(notification)",
  ], "EventStore notification transaction");
  const backfill = database.slice(database.indexOf("export function backfillDesktopNotificationsFromEvents"), database.indexOf("// Messages CRUD"));
  ordered(backfill, [
    "const insert = db.prepare(",
    "for (const row of rows)",
    "insert.run(",
    "pruneDesktopNotifications()",
  ], "legacy event backfill cap");
});

test("DS-08 SSE subscribes before snapshot and read routes require transport Session identity", () => {
  const start = server.indexOf('app.get("/api/desktop/events"');
  const end = server.indexOf('// Chat API', start);
  const routes = server.slice(start, end);
  ordered(routes, [
    "desktopNotificationListeners.add(listener)",
    'res.write(`data: ${JSON.stringify({ type: "state"',
  ], "desktop SSE startup");
  assert.equal((routes.match(/requireTransportSessionIdentity\(/gu) || []).length, 2);
  assert.match(server, /listDesktopNotifications\(500\)/u);
});

test("DS-08 renderer reconciles reconnect state and reads only after visible message rendering", () => {
  assert.match(renderer, /handledDesktopNotificationIds/u);
  assert.match(renderer, /applyDesktopState\(message\.state, true\)/u);
  assert.match(renderer, /consumeDesktopNotification\(message\.notification\)/u);
  const selection = renderer.slice(renderer.indexOf("async function selectSessionNow"), renderer.indexOf("async function deleteSession"));
  ordered(selection, [
    "for (const msg of mdata.messages)",
    "generation !== sessionSelectionGeneration || currentSessionId !== id",
    "!document.hidden && document.hasFocus()",
    "markSessionNotificationsRead(id)",
  ], "post-render notification acknowledgement");
  assert.doesNotMatch(renderer.slice(renderer.indexOf("async function markSessionNotificationsRead"), renderer.indexOf("function consumeDesktopNotification")), /applyDesktopState/u);
  const initialization = renderer.slice(renderer.indexOf("async function init()"), renderer.indexOf("async function loadPersonas"));
  ordered(initialization, [
    "const initialSelectionGeneration = sessionSelectionGeneration",
    "await loadSessions()",
    "sessionSelectionGeneration === initialSelectionGeneration",
    "await selectSession(sessionToRestore, true)",
  ], "initial Session restore arbitration");
});

test("DS-08 preload buffers early clicks and Tray accepts only frozen summary state", () => {
  ordered(preload, [
    "pendingNotificationTargets",
    "notificationListeners.size === 0",
    "pendingNotificationTargets.splice(0)",
  ], "preload notification buffering");
  assert.match(main, /parseTrayState\(request\)/u);
  assert.match(main, /打开首个未读会话/u);
  assert.match(main, /sessionId: parsed\.sessionId[\s\S]+targetTab: parsed\.targetTab/u);
});
