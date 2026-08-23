// ===========================================
// CronManager —— Lux 语义定时调度 (EVT-02)
// 固定频率锚点 / 持久恢复 / overdue 合并补发 / 长 timeout 分段 re-arm
// ===========================================

import {
  advanceCronJob,
  deactivateCronJob,
  getCronJob,
  listCronJobs,
  type CronJobRow,
} from "./db.js";

export const MAX_CRON_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PUBLISH_RETRY_MS = 1_000;
const DURATION_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u;
const DURATION_FACTORS = [24 * 60 * 60 * 1_000, 60 * 60 * 1_000, 60 * 1_000, 1_000] as const;
const MONTHLY_INTERVAL_PATTERN = /^calendar:monthly:(\d{1,2})$/u;

/** 复合 duration：单位必须按 d→h→m→s 降序且每种至多一次。 */
export function parseCronDurationMs(value: string): number {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) throw new Error(`无效的时间格式: ${String(value)}`);
  const match = DURATION_PATTERN.exec(value);
  if (!match || match.slice(1).every(part => part === undefined)) throw new Error(`无效的时间格式: ${value}`);
  let total = 0;
  for (let index = 0; index < DURATION_FACTORS.length; index += 1) {
    const raw = match[index + 1];
    if (raw === undefined) continue;
    const amount = Number(raw);
    if (!Number.isSafeInteger(amount)) throw new Error(`时间超出范围: ${value}`);
    total += amount * DURATION_FACTORS[index];
    if (!Number.isSafeInteger(total) || total > MAX_CRON_DURATION_MS) throw new Error(`时间超出范围: ${value}`);
  }
  if (total < 1_000) throw new Error(`时间必须至少为 1s: ${value}`);
  return total;
}

/** Memo 内部月历间隔；锚定初始 UTC 日，月底按当月最后一天收敛但下月恢复锚点。 */
export function createMonthlyCronInterval(scheduledAt: string): string {
  const timestamp = Date.parse(scheduledAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== scheduledAt) throw new Error("月度提醒时间无效");
  return `calendar:monthly:${new Date(timestamp).getUTCDate()}`;
}

function parseCronInterval(value: string): Readonly<{ kind: "fixed"; milliseconds: number } | { kind: "monthly"; anchorDay: number }> {
  const monthly = MONTHLY_INTERVAL_PATTERN.exec(value);
  if (!monthly) return Object.freeze({ kind: "fixed", milliseconds: parseCronDurationMs(value) });
  const anchorDay = Number(monthly[1]);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new Error(`月度 Cron 锚点无效: ${value}`);
  return Object.freeze({ kind: "monthly", anchorDay });
}

/** 从已触发的月历 slot 推进到严格晚于 now 的最小 UTC 月 slot。 */
export function nextMonthlyFireAt(scheduledAt: number, anchorDay: number, now: number): number {
  if (![scheduledAt, now].every(Number.isFinite) || !Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error("Cron 月历参数无效");
  }
  const scheduled = new Date(scheduledAt);
  const current = new Date(now);
  let months = Math.max(1,
    (current.getUTCFullYear() - scheduled.getUTCFullYear()) * 12
      + current.getUTCMonth() - scheduled.getUTCMonth(),
  );
  const candidate = (offset: number): number => {
    const first = new Date(Date.UTC(
      scheduled.getUTCFullYear(), scheduled.getUTCMonth() + offset, 1,
      scheduled.getUTCHours(), scheduled.getUTCMinutes(), scheduled.getUTCSeconds(), scheduled.getUTCMilliseconds(),
    ));
    const finalDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(anchorDay, finalDay));
    return first.getTime();
  };
  let next = candidate(months);
  if (next <= now) next = candidate(++months);
  if (!Number.isSafeInteger(next)) throw new Error("Cron 下一月历触发时间溢出");
  return next;
}

/** 从已触发的固定频率 slot 推进到严格晚于 now 的最小 slot。 */
export function nextFixedRateFireAt(scheduledAt: number, intervalMs: number, now: number): number {
  if (![scheduledAt, intervalMs, now].every(Number.isFinite) || intervalMs < 1) throw new Error("Cron 固定频率参数无效");
  const steps = Math.max(1, Math.floor((now - scheduledAt) / intervalMs) + 1);
  const next = scheduledAt + steps * intervalMs;
  if (!Number.isSafeInteger(next)) throw new Error("Cron 下一触发时间溢出");
  return next;
}

/** 返回 true 表示本 slot 的全部 EventBus 事件已持久化，可推进任务。 */
export type CronCallback = (job: CronJobRow, scheduledAt: string) => boolean | Promise<boolean>;

export class CronManager {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly callback: CronCallback;
  private disposed = false;

  constructor(callback: CronCallback) {
    if (typeof callback !== "function") throw new TypeError("Cron callback 必须是函数");
    this.callback = callback;
  }

  /** 启动时恢复所有活跃任务。overdue one-shot/repeat 都补发一个 slot。 */
  loadFromDb(): void {
    const jobs = listCronJobs(true);
    for (const job of jobs) this.scheduleJob(job);
    if (jobs.length > 0) console.log(`✅ 已恢复 ${jobs.length} 个定时任务`);
  }

  scheduleJob(job: CronJobRow): void {
    if (this.disposed) return;
    this.clearTimer(job.id);
    const scheduledAt = Date.parse(job.fire_at);
    if (!Number.isFinite(scheduledAt)) {
      deactivateCronJob(job.id);
      return;
    }
    if (job.interval) {
      try { parseCronInterval(job.interval); }
      catch {
        deactivateCronJob(job.id);
        return;
      }
    }
    this.arm(job, scheduledAt);
  }

  private arm(job: CronJobRow, scheduledAt: number): void {
    if (this.disposed) return;
    const remaining = scheduledAt - Date.now();
    if (remaining > MAX_TIMEOUT_MS) {
      const timer = setTimeout(() => this.arm(job, scheduledAt), MAX_TIMEOUT_MS);
      timer.unref?.();
      this.timers.set(job.id, timer);
      return;
    }
    const timer = setTimeout(() => {
      void this.fireJob(job, scheduledAt);
    }, Math.max(0, remaining));
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private retrySameSlot(job: CronJobRow, scheduledAt: number): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      void this.fireJob(job, scheduledAt);
    }, PUBLISH_RETRY_MS);
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private async fireJob(job: CronJobRow, scheduledAt: number): Promise<void> {
    if (this.disposed) return;
    const current = getCronJob(job.id);
    if (!current || current.active !== 1) {
      this.timers.delete(job.id);
      return;
    }
    const scheduledIso = new Date(scheduledAt).toISOString();
    console.log(`⏰ 定时任务触发: [${job.id}] ${job.message.slice(0, 50)}`);
    let published = false;
    try { published = await this.callback({ ...current, fire_at: scheduledIso }, scheduledIso); }
    catch { published = false; }
    if (!published) {
      this.retrySameSlot({ ...current, fire_at: scheduledIso }, scheduledAt);
      return;
    }
    if (this.disposed || getCronJob(job.id)?.active !== 1) return;

    const firedAt = new Date().toISOString();
    if (!current.interval) {
      advanceCronJob(job.id, firedAt, null);
      this.timers.delete(job.id);
      return;
    }
    const interval = parseCronInterval(current.interval);
    const nextAt = interval.kind === "fixed"
      ? nextFixedRateFireAt(scheduledAt, interval.milliseconds, Date.now())
      : nextMonthlyFireAt(scheduledAt, interval.anchorDay, Date.now());
    const nextIso = new Date(nextAt).toISOString();
    advanceCronJob(job.id, firedAt, nextIso);
    this.scheduleJob({ ...current, fire_at: nextIso, last_fired: firedAt });
  }

  cancelJob(id: number): void {
    this.clearTimer(id);
    deactivateCronJob(id);
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  listActive(): CronJobRow[] {
    return listCronJobs(true);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
