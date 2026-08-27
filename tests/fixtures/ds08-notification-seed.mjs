import assert from "node:assert/strict";
import path from "node:path";

const [fixture, mode = "seed"] = process.argv.slice(2);
assert(path.isAbsolute(fixture));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
const db = await import("../../dist/db.js");
try {
  assert.equal(db.getDatabaseSchemaVersion(), 11);
  const now = Date.now();
  if (mode === "seed") {
    db.insertSession({ id: "ds08-session-a", persona_name: "general", title: "Session A", created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    db.insertSession({ id: "ds08-session-b", persona_name: "general", title: "Session B", created_at: new Date(now + 1).toISOString(), updated_at: new Date(now + 1).toISOString() });
    const first = db.insertDesktopNotification({ sourceKey: "seed:first", sessionId: "ds08-session-a", kind: "info", title: "First", body: "First body", createdAt: now });
    const duplicate = db.insertDesktopNotification({ sourceKey: "seed:first", sessionId: "ds08-session-a", kind: "error", title: "Changed", body: "Changed body", createdAt: now + 1 });
    const second = db.insertDesktopNotification({ sourceKey: "seed:second", sessionId: "ds08-session-b", kind: "error", title: "Second", body: "Second body", targetTab: "terminal", createdAt: now + 2 });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.notification.id, first.notification.id);
    assert.equal(second.inserted, true);
    console.log(JSON.stringify({ schemaVersion: 11, firstId: first.notification.id, secondId: second.notification.id }));
  } else if (mode === "backfill") {
    db.db.prepare(
      `INSERT INTO events
       (id, schema_version, type, source, source_event_id, target_session_id, tags_json, payload_json, created_at, expires_at, status, attempts, next_attempt_at, last_error)
       VALUES (?, 1, 'wire.message', 'wire', ?, ?, '[]', ?, ?, NULL, 'pending', 0, 0, NULL)`
    ).run("evt_ds08backfill00000000000000000001", "ds08-backfill", "ds08-session-a", JSON.stringify({ message: "Backfilled" }), now);
    assert.equal(db.backfillDesktopNotificationsFromEvents(), 1);
    assert.equal(db.getDesktopNotificationBySourceKey("event:evt_ds08backfill00000000000000000001").body, "Backfilled");
    const store = db.createEventStore();
    store.insertEvent({
      id: "evt_ds08atomic0000000000000000000001", schemaVersion: 1, type: "poll.message", source: "poll",
      sourceEventId: "ds08-atomic", targetSessionId: "ds08-session-a", tags: [], payload: { message: "Atomic persisted" },
      createdAt: now + 1, expiresAt: null,
    });
    assert.equal(db.getDesktopNotificationBySourceKey("event:evt_ds08atomic0000000000000000000001").body, "Atomic persisted");
    assert.equal(db.backfillDesktopNotificationsFromEvents(), 0);
    console.log(JSON.stringify({ schemaVersion: 11, count: db.listDesktopNotifications().length }));
  } else if (mode === "cap") {
    db.withTransaction(() => {
      const insert = db.db.prepare(
        `INSERT INTO events
         (id, schema_version, type, source, source_event_id, target_session_id, tags_json, payload_json, created_at, expires_at, status, attempts, next_attempt_at, last_error)
         VALUES (?, 1, 'wire.message', 'wire', ?, 'ds08-session-a', '[]', ?, ?, NULL, 'pending', 0, 0, NULL)`
      );
      for (let index = 0; index < 510; index += 1) {
        const suffix = String(index).padStart(4, "0");
        insert.run(`evt_ds08cap_${suffix}`, `ds08-cap-${suffix}`, JSON.stringify({ message: `Cap ${suffix}` }), now + index);
      }
    });
    assert.equal(db.backfillDesktopNotificationsFromEvents(), 510);
    assert.equal(db.listDesktopNotifications(500).length, 500);
    assert.equal(db.desktopNotificationUnreadCounts().reduce((sum, entry) => sum + entry.count, 0), 500);
    console.log(JSON.stringify({ schemaVersion: 11, capped: db.listDesktopNotifications(500).length }));
  } else {
    const notifications = db.listDesktopNotifications();
    const counts = db.desktopNotificationUnreadCounts();
    console.log(JSON.stringify({ schemaVersion: 11, notifications, counts }));
  }
} finally {
  await db.closeDb();
}
