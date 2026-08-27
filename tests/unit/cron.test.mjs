import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture, waitFor } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-evt02-cron-");
const dataDir = path.join(fixture, "data");
await mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
});

const cronModule = await import("../../dist/cron.js");
const db = await import("../../dist/db.js");
const cronTools = await import("../../dist/tools/cron-tools.js");
const memoTools = await import("../../dist/tools/phase1-tools.js");
const link = await import("../../dist/link.js");

const managers = new Set();
after(async () => {
  for (const manager of managers) manager.dispose();
  link.unregisterSession("owner-session");
  link.unregisterSession("target-session");
  db.closeDb();
  await removeFixture(fixture);
});

test("EVT-02 compound duration accepts canonical d/h/m/s and rejects ambiguity", () => {
  assert.equal(cronModule.parseCronDurationMs("30m"), 30 * 60_000);
  assert.equal(cronModule.parseCronDurationMs("2h30m"), 9_000_000);
  assert.equal(cronModule.parseCronDurationMs("1d6h30m15s"), 109_815_000);
  assert.equal(cronModule.parseCronDurationMs("365d"), cronModule.MAX_CRON_DURATION_MS);
  for (const invalid of ["", "0s", "1m2h", "1h1h", "1.5h", "366d", "1h-", "abc", "1ms"]) {
    assert.throws(() => cronModule.parseCronDurationMs(invalid), /无效|至少|范围/u, invalid);
  }
});

test("EVT-02 fixed-rate progression skips missed ticks without drift", () => {
  const scheduled = 1_000_000;
  assert.equal(cronModule.nextFixedRateFireAt(scheduled, 60_000, scheduled), scheduled + 60_000);
  assert.equal(cronModule.nextFixedRateFireAt(scheduled, 60_000, scheduled + 1), scheduled + 60_000);
  assert.equal(cronModule.nextFixedRateFireAt(scheduled, 60_000, scheduled + 60_000), scheduled + 120_000);
  assert.equal(cronModule.nextFixedRateFireAt(scheduled, 60_000, scheduled + 190_000), scheduled + 240_000);
  assert.throws(() => cronModule.nextFixedRateFireAt(scheduled, 0, scheduled), /参数无效/u);
});

test("RT-11 monthly reminder progression preserves the UTC day anchor across short months", () => {
  const january30 = "2024-01-30T10:15:20.000Z";
  const january31 = "2024-01-31T10:15:20.000Z";
  assert.equal(cronModule.createMonthlyCronInterval(january30), "calendar:monthly:30");
  assert.equal(new Date(cronModule.nextMonthlyFireAt(Date.parse(january30), 30, Date.parse(january30))).toISOString(), "2024-02-29T10:15:20.000Z");
  assert.equal(new Date(cronModule.nextMonthlyFireAt(Date.parse("2024-02-29T10:15:20.000Z"), 30, Date.parse("2024-02-29T10:15:20.000Z"))).toISOString(), "2024-03-30T10:15:20.000Z");
  assert.equal(new Date(cronModule.nextMonthlyFireAt(Date.parse(january31), 31, Date.parse("2024-02-29T10:15:20.000Z"))).toISOString(), "2024-03-31T10:15:20.000Z");
  assert.equal(new Date(cronModule.nextMonthlyFireAt(Date.parse(january30), 30, Date.parse("2024-05-01T00:00:00.000Z"))).toISOString(), "2024-05-30T10:15:20.000Z");
  assert.throws(() => cronModule.createMonthlyCronInterval("not-a-date"), /无效/u);
  assert.throws(() => cronModule.nextMonthlyFireAt(Date.parse(january30), 0, Date.now()), /参数无效/u);
});

test("EVT-02 target resolution supports self, broadcast, exact id and unique exact name", () => {
  const sessions = [
    { id: "owner", name: "Owner", status: "idle", lastActivity: 2 },
    { id: "target", name: "Target", status: "running", lastActivity: 1 },
  ];
  assert.deepEqual(cronTools.resolveCronTarget(undefined, "owner", sessions), { targetSessionId: "owner", broadcast: false, label: "owner" });
  assert.deepEqual(cronTools.resolveCronTarget("*", "owner", sessions), { targetSessionId: null, broadcast: true, label: "*" });
  assert.equal(cronTools.resolveCronTarget("target", "owner", sessions).targetSessionId, "target");
  assert.equal(cronTools.resolveCronTarget("Target", "owner", sessions).targetSessionId, "target");
  assert.throws(() => cronTools.resolveCronTarget("missing", "owner", sessions), /不存在/u);
  assert.throws(() => cronTools.resolveCronTarget("Same", "owner", [
    { ...sessions[0], name: "Same" },
    { ...sessions[1], name: "Same" },
  ]), /不唯一/u);
});

test("EVT-02 overdue one-shot is recovered and deactivated only after publish succeeds", async () => {
  const id = db.insertCronJob({
    session_id: "owner",
    target_session_id: "owner",
    broadcast: 0,
    message: "recover-one-shot",
    fire_at: new Date(Date.now() - 10_000).toISOString(),
    interval: null,
    tag: null,
  });
  const fired = [];
  const manager = new cronModule.CronManager((job, scheduledAt) => {
    fired.push({ id: job.id, scheduledAt });
    return true;
  });
  managers.add(manager);
  manager.loadFromDb();
  await waitFor(() => fired.length === 1 && db.getCronJob(id)?.active === 0, { timeoutMs: 5_000, label: "overdue one-shot" });
  assert.equal(fired[0].id, id);
  assert.equal(fired[0].scheduledAt, db.getCronJob(id).fire_at);
  manager.dispose();
  managers.delete(manager);
});

test("EVT-02 repeat recovery coalesces overdue ticks and advances on fixed-rate anchor", async () => {
  const anchor = Date.now() - 25_500;
  const id = db.insertCronJob({
    session_id: "owner",
    target_session_id: "owner",
    broadcast: 0,
    message: "recover-repeat",
    fire_at: new Date(anchor).toISOString(),
    interval: "10s",
    tag: null,
  });
  let calls = 0;
  const manager = new cronModule.CronManager(() => {
    calls += 1;
    return true;
  });
  managers.add(manager);
  manager.loadFromDb();
  await waitFor(() => calls === 1 && Date.parse(db.getCronJob(id)?.fire_at || "") > Date.now(), { timeoutMs: 5_000, label: "repeat recovery" });
  const next = Date.parse(db.getCronJob(id).fire_at);
  assert.equal((next - anchor) % 10_000, 0);
  assert.ok(next > Date.now());
  manager.dispose();
  managers.delete(manager);
});

test("RT-11 overdue monthly reminder coalesces to the next anchored calendar slot", async () => {
  const id = db.insertCronJob({
    session_id: "owner",
    target_session_id: "owner",
    broadcast: 0,
    message: "recover-monthly",
    fire_at: "2024-01-30T10:15:20.000Z",
    interval: "calendar:monthly:30",
    tag: "memo:fixture",
  });
  let calls = 0;
  const manager = new cronModule.CronManager(() => { calls += 1; return true; });
  managers.add(manager);
  manager.scheduleJob(db.getCronJob(id));
  await waitFor(() => calls === 1 && Date.parse(db.getCronJob(id)?.fire_at || "") > Date.now(), { timeoutMs: 5_000, label: "monthly recovery" });
  const next = new Date(db.getCronJob(id).fire_at);
  assert.equal(next.getUTCDate(), 30);
  assert.equal(next.getUTCHours(), 10);
  assert.equal(next.getUTCMinutes(), 15);
  manager.dispose();
  managers.delete(manager);
});

test("EVT-02 publish failure retries the same slot before deactivation", async () => {
  const scheduled = new Date(Date.now() + 20).toISOString();
  const id = db.insertCronJob({
    session_id: "owner",
    target_session_id: "owner",
    broadcast: 0,
    message: "retry-publish",
    fire_at: scheduled,
    interval: null,
    tag: null,
  });
  const observedSlots = [];
  const manager = new cronModule.CronManager((_job, scheduledAt) => {
    observedSlots.push(scheduledAt);
    return observedSlots.length >= 2;
  });
  managers.add(manager);
  manager.scheduleJob(db.getCronJob(id));
  await waitFor(() => observedSlots.length === 2 && db.getCronJob(id)?.active === 0, { timeoutMs: 5_000, label: "publish retry" });
  assert.deepEqual(observedSlots, [scheduled, scheduled]);
  manager.dispose();
  managers.delete(manager);
});

test("EVT-02 cron tools persist canonical target and isolate list/cancel by owner", async () => {
  assert.equal(link.registerSession("owner-session", "Owner Session", Symbol("owner")), true);
  assert.equal(link.registerSession("target-session", "Target Session", Symbol("target")), true);
  let scheduled = null;
  const executeSchedule = cronTools.createCronScheduleExec(job => { scheduled = job; });
  const result = await executeSchedule({ message: "targeted", delay: "2h30m", repeat: "1d6h", target: "Target Session", tag: "owned" }, { _SESSION_ID: "owner-session" });
  assert.match(result, /目标: Target Session/u);
  assert.equal(scheduled.session_id, "owner-session");
  assert.equal(scheduled.target_session_id, "target-session");
  assert.equal(scheduled.broadcast, 0);
  assert.equal(scheduled.interval, "1d6h");

  db.insertCronJob({ session_id: "other-session", target_session_id: "other-session", broadcast: 0, message: "foreign", fire_at: new Date(Date.now() + 60_000).toISOString(), interval: null, tag: "owned" });
  const ownerList = await cronTools.cronListExec({}, { _SESSION_ID: "owner-session" });
  assert.match(ownerList, /targeted/u);
  assert.doesNotMatch(ownerList, /foreign/u);

  const cancelled = [];
  const executeCancel = cronTools.createCronCancelExec(id => cancelled.push(id));
  const cancelResult = await executeCancel({ tag: "owned" }, { _SESSION_ID: "owner-session" });
  assert.match(cancelResult, /已取消 1 个/u);
  assert.deepEqual(cancelled, [scheduled.id]);
  assert.equal(db.getCronJob(scheduled.id).active, 0);
  assert.equal(db.listCronJobs(true).some(job => job.session_id === "other-session"), true);
});

test("RT-11 Memo reminders are Session-scoped Cron jobs and completion cancels delivery", async () => {
  const now = new Date().toISOString();
  db.insertSession({ id: "memo-owner", persona_name: "developer", title: "Memo Owner", created_at: now, updated_at: now });
  db.insertSession({ id: "memo-other", persona_name: "developer", title: "Memo Other", created_at: now, updated_at: now });
  db.db.prepare(
    `INSERT INTO memos (content, remind_at, repeat_rule, status, tags, created_at, session_id)
     VALUES ('legacy reminder', NULL, NULL, 'active', NULL, ?, NULL)`
  ).run(now);
  const scheduled = [];
  const cancelled = [];
  memoTools.setMemoCronCallbacks({ schedule: job => scheduled.push(job), cancel: id => cancelled.push(id) });

  const remindAt = "2026-09-30T08:00:00.000Z";
  const added = await memoTools.memoAddExec(
    { content: "owner reminder", remind_at: remindAt, repeat_rule: "monthly", tags: "work" },
    { _SESSION_ID: "memo-owner" },
  );
  assert.match(added, /备忘已添加/u);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].session_id, "memo-owner");
  assert.equal(scheduled[0].target_session_id, "memo-owner");
  assert.equal(scheduled[0].broadcast, 0);
  assert.equal(scheduled[0].interval, "calendar:monthly:30");
  assert.match(scheduled[0].tag, /^memo:\d+$/u);

  await memoTools.memoAddExec({ content: "other reminder" }, { _SESSION_ID: "memo-other" });
  const ownerList = await memoTools.memoListExec({ filter: "all" }, { _SESSION_ID: "memo-owner" });
  assert.match(ownerList, /owner reminder/u);
  assert.match(ownerList, /legacy reminder/u);
  assert.doesNotMatch(ownerList, /other reminder/u);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM memos WHERE session_id IS NULL").get().count, 0);
  const id = Number(/^\[(\d+)\]/u.exec(ownerList)?.[1]);
  assert.ok(Number.isSafeInteger(id));

  db.markMemoRemindedByCronJob(scheduled[0].id, remindAt);
  assert.equal(db.getMemoBySessionAndId("memo-owner", id).last_reminded_at, remindAt);
  assert.equal(db.getMemoBySessionAndId("memo-other", id), undefined);
  const eventStore = db.createEventStore();
  assert.equal(eventStore.insertEvent({
    schemaVersion: 1,
    id: "evt_rt11_pending_memo",
    type: "cron.triggered",
    source: "cron",
    sourceEventId: "rt11-pending-memo",
    targetSessionId: "memo-owner",
    tags: [],
    payload: { jobId: scheduled[0].id, message: "owner reminder" },
    createdAt: Date.now(),
    expiresAt: null,
  }).inserted, true);

  const foreignDone = await memoTools.memoDoneExec({ id }, { _SESSION_ID: "memo-other" });
  assert.match(foreignDone, /不存在或已完成/u);
  assert.equal(db.getCronJob(scheduled[0].id).active, 1);

  const done = await memoTools.memoDoneExec({ id }, { _SESSION_ID: "memo-owner" });
  assert.match(done, /已标记完成/u);
  assert.deepEqual(cancelled, [scheduled[0].id]);
  assert.equal(db.getCronJob(scheduled[0].id).active, 0);
  assert.equal(db.getMemoBySessionAndId("memo-owner", id).status, "done");
  assert.equal(eventStore.countByStatus().dead, 1);
  assert.equal(eventStore.pendingEventsForSession("memo-owner", 10).length, 0);

  const cancelAdded = await memoTools.memoAddExec(
    { content: "cancel through cron", remind_at: "2026-10-01T08:00:00.000Z", repeat_rule: "daily" },
    { _SESSION_ID: "memo-owner" },
  );
  const cancelMemoId = Number(/\[ID: (\d+)\]/u.exec(cancelAdded)?.[1]);
  const cancelMemo = db.getMemoBySessionAndId("memo-owner", cancelMemoId);
  const cancelExec = cronTools.createCronCancelExec(() => undefined);
  await cancelExec({ id: cancelMemo.cron_job_id }, { _SESSION_ID: "memo-owner" });
  const detachedMemo = db.getMemoBySessionAndId("memo-owner", cancelMemoId);
  assert.equal(detachedMemo.remind_at, null);
  assert.equal(detachedMemo.repeat_rule, null);
  assert.equal(detachedMemo.cron_job_id, null);

  db.insertSession({ id: "memo-delete", persona_name: "developer", title: "Memo Delete", created_at: now, updated_at: now });
  const deleteAdded = await memoTools.memoAddExec(
    { content: "delete session reminder", remind_at: "2026-10-02T08:00:00.000Z", repeat_rule: "weekly" },
    { _SESSION_ID: "memo-delete" },
  );
  const deleteMemoId = Number(/\[ID: (\d+)\]/u.exec(deleteAdded)?.[1]);
  const deleteCronId = db.getMemoBySessionAndId("memo-delete", deleteMemoId).cron_job_id;
  eventStore.insertEvent({
    schemaVersion: 1,
    id: "evt_rt11_deleted_session",
    type: "cron.triggered",
    source: "cron",
    sourceEventId: "rt11-deleted-session",
    targetSessionId: "memo-delete",
    tags: [],
    payload: { jobId: deleteCronId, message: "delete session reminder" },
    createdAt: Date.now(),
    expiresAt: null,
  });
  db.deleteSession("memo-delete");
  assert.equal(db.getCronJob(deleteCronId).active, 0);
  assert.equal(eventStore.pendingEventsForSession("memo-delete", 10).length, 0);

  await assert.rejects(
    () => memoTools.memoAddExec({ content: "invalid repeat", repeat_rule: "daily" }, { _SESSION_ID: "memo-owner" }),
    /需要 remind_at/u,
  );
  await assert.rejects(() => memoTools.memoListExec({}, {}), /当前 Session/u);
});
