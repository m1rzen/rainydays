// ===========================================
// CronManager —— 定时任务调度
// 使用 setTimeout/setInterval，重启后从数据库恢复
// ===========================================

import {
  listCronJobs,
  deactivateCronJob,
  updateCronJobLastFired,
  type CronJobRow,
} from "./db.js";

/** 触发回调类型 */
export type CronCallback = (job: CronJobRow) => void;

/** 解析时间间隔字符串为毫秒 */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 0;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

export class CronManager {
  private timers = new Map<number, NodeJS.Timeout>();
  private callback: CronCallback;

  constructor(callback: CronCallback) {
    this.callback = callback;
  }

  /** 启动时加载所有活跃的定时任务 */
  loadFromDb(): void {
    const jobs = listCronJobs(true);
    for (const job of jobs) {
      this.scheduleJob(job);
    }
    if (jobs.length > 0) {
      console.log(`✅ 已恢复 ${jobs.length} 个定时任务`);
    }
  }

  /** 调度一个任务 */
  scheduleJob(job: CronJobRow): void {
    // 如果已有定时器，先清除
    this.clearTimer(job.id);

    const fireAt = new Date(job.fire_at).getTime();
    const now = Date.now();
    const delay = fireAt - now;

    if (job.interval) {
      // 周期任务
      const intervalMs = parseInterval(job.interval);
      if (intervalMs <= 0) return;

      // 如果首次触发时间已过，立即触发
      const firstDelay = Math.max(0, delay);

      const timer = setTimeout(() => {
        this.fireJob(job);

        // 设置周期触发
        const intervalTimer = setInterval(() => {
          this.fireJob(job);
        }, intervalMs);

        // 替换为周期定时器
        this.timers.set(job.id, intervalTimer);
      }, firstDelay);

      this.timers.set(job.id, timer);
    } else {
      // 一次性任务
      if (delay < 0) {
        // 已过期，标记为不活跃
        deactivateCronJob(job.id);
        return;
      }

      const timer = setTimeout(() => {
        this.fireJob(job);
        this.timers.delete(job.id);
      }, delay);

      this.timers.set(job.id, timer);
    }
  }

  /** 触发任务 */
  private fireJob(job: CronJobRow): void {
    console.log(`⏰ 定时任务触发: [${job.id}] ${job.message.slice(0, 50)}`);
    updateCronJobLastFired(job.id, new Date().toISOString());
    this.callback(job);
  }

  /** 取消任务 */
  cancelJob(id: number): void {
    this.clearTimer(id);
    deactivateCronJob(id);
  }

  /** 清除定时器 */
  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  /** 列出所有活跃任务 */
  listActive(): CronJobRow[] {
    return listCronJobs(true);
  }

  /** 清理所有定时器（关闭时调用） */
  dispose(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
