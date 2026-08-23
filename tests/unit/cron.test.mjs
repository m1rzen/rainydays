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
