// ===========================================
// cron 工具 —— 创建/列出/取消定时任务
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { insertCronJob, listCronJobs, deactivateCronJob, type CronJobRow } from "../db.js";

/** 解析延迟字符串为未来时间 ISO */
function parseDelayToISO(delay: string): string {
  const match = delay.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`无效的时间格式: ${delay}`);

  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = n * (
    unit === "s" ? 1000 :
    unit === "m" ? 60 * 1000 :
    unit === "h" ? 60 * 60 * 1000 :
    unit === "d" ? 24 * 60 * 60 * 1000 : 0
  );

  return new Date(Date.now() + ms).toISOString();
}

// cron_schedule
export const cronScheduleDef: ToolDefinition = {
  type: "function",
  function: {
    name: "cron_schedule",
    description:
      "创建定时任务。支持一次性延迟触发和周期性触发。到时间后会向用户发送消息。",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "到时间后要发送给用户的消息。如 '提醒你回复客户邮件' 或 '检查政企项目目录'。",
        },
        delay: {
          type: "string",
          description: "首次触发的延迟时间。格式：数字+单位，如 '30s'(30秒)、'5m'(5分钟)、'1h'(1小时)、'1d'(1天)。",
        },
        repeat: {
          type: "string",
          description: "重复间隔（可选）。格式同 delay，如 '1h' 表示每小时重复。不传则为一次性任务。",
        },
        tag: {
          type: "string",
          description: "任务标签（可选），便于管理。如 '日报检查'。",
        },
      },
      required: ["message", "delay"],
    },
  },
};

export function createCronScheduleExec(onSchedule: (job: CronJobRow) => void): ToolExecutor {
  return async (args, env) => {
    const message = args.message as string;
    const delay = args.delay as string;
    const repeat = args.repeat as string | undefined;
    const tag = args.tag as string | undefined;
    const sessionId = env?._SESSION_ID;

    try {
      const fireAt = parseDelayToISO(delay);
      const id = insertCronJob({
        session_id: sessionId || null,
        message,
        fire_at: fireAt,
        interval: repeat || null,
        tag: tag || null,
      });

      // 调度
      const job = {
        id, session_id: sessionId || null, message,
        fire_at: fireAt, interval: repeat || null,
        tag: tag || null, active: 1, last_fired: null,
        created_at: new Date().toISOString(),
      };
      onSchedule(job as CronJobRow);

      return `✅ 定时任务已创建 [ID: ${id}]\n消息: ${message}\n触发时间: ${new Date(fireAt).toLocaleString("zh-CN")}${repeat ? `\n重复间隔: ${repeat}` : " (一次性)"}`;
    } catch (err) {
      return `创建定时任务失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

// cron_list
export const cronListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "cron_list",
    description: "列出所有活跃的定时任务。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const cronListExec: ToolExecutor = async () => {
  const jobs = listCronJobs(true);
  if (jobs.length === 0) {
    return "当前没有活跃的定时任务。";
  }

  const lines = jobs.map((j) => {
    const fireTime = new Date(j.fire_at).toLocaleString("zh-CN");
    const type = j.interval ? `每 ${j.interval}` : "一次性";
    return `[${j.id}] ${type} | 触发: ${fireTime} | ${j.message.slice(0, 50)}${j.tag ? ` | 标签: ${j.tag}` : ""}`;
  });

  return `活跃定时任务 (${jobs.length}):\n\n${lines.join("\n")}`;
};

// cron_cancel
export const cronCancelDef: ToolDefinition = {
  type: "function",
  function: {
    name: "cron_cancel",
    description: "取消指定 ID 的定时任务。通过 tag 取消时取消所有匹配的任务。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "任务ID" },
        tag: { type: "string", description: "任务标签（取消所有匹配此标签的任务）" },
      },
    },
  },
};

export function createCronCancelExec(onCancel: (id: number) => void): ToolExecutor {
  return async (args) => {
    const id = args.id as number | undefined;
    const tag = args.tag as string | undefined;

    if (id) {
      deactivateCronJob(id);
      onCancel(id);
      return `✅ 定时任务 ${id} 已取消`;
    }

    if (tag) {
      const jobs = listCronJobs(true);
      const matching = jobs.filter((j) => j.tag === tag);
      for (const j of matching) {
        deactivateCronJob(j.id);
        onCancel(j.id);
      }
      return `✅ 已取消 ${matching.length} 个标签为 "${tag}" 的定时任务`;
    }

    return "错误：需要提供 id 或 tag";
  };
}
