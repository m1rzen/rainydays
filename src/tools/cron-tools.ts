// ===========================================
// cron 工具 —— 创建/列出/取消定时任务
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { insertCronJob, listCronJobs, deactivateCronJob, type CronJobRow } from "../db.js";
import { parseCronDurationMs } from "../cron.js";
import { discoverSessions, type SessionInfo } from "../link.js";
import { truncateCodePoints } from "../tool-pipeline.js";

export interface ResolvedCronTarget {
  readonly targetSessionId: string | null;
  readonly broadcast: boolean;
  readonly label: string;
}

/** target 省略=self；*=触发时广播；命名目标按 exact id 或唯一 exact name 解析。 */
export function resolveCronTarget(
  requested: unknown,
  ownerSessionId: unknown,
  sessions: readonly SessionInfo[] = discoverSessions(),
): ResolvedCronTarget {
  if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0) throw new Error("cron_schedule 需要当前 Session 身份");
  if (requested === undefined || requested === null || requested === "") {
    return Object.freeze({ targetSessionId: ownerSessionId, broadcast: false, label: ownerSessionId });
  }
  if (typeof requested !== "string" || requested.length > 128 || requested.includes("\0")) throw new Error("target 无效");
  if (requested === "*") return Object.freeze({ targetSessionId: null, broadcast: true, label: "*" });
  const exactId = sessions.find(session => session.id === requested);
  if (exactId) return Object.freeze({ targetSessionId: exactId.id, broadcast: false, label: exactId.name });
  const exactNames = sessions.filter(session => session.name === requested);
  if (exactNames.length === 0) throw new Error(`目标 Session 不存在: ${requested}`);
  if (exactNames.length > 1) throw new Error(`目标 Session 名称不唯一: ${requested}`);
  return Object.freeze({ targetSessionId: exactNames[0].id, broadcast: false, label: exactNames[0].name });
}

function parseDelayToISO(delay: string): string {
  return new Date(Date.now() + parseCronDurationMs(delay)).toISOString();
}

// cron_schedule
export const cronScheduleDef: ToolDefinition = {
  type: "function",
  function: {
    name: "cron_schedule",
    description:
      "创建延迟或周期消息。触发时像 link_post 一样启动空闲 Session 或注入运行中的 flow；target 省略为自己，'*' 广播所有 Session。",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "到时间后要发送给用户的消息。如 '提醒你回复客户邮件' 或 '检查政企项目目录'。",
        },
        delay: {
          type: "string",
          pattern: "^(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?(?:\\d+s)?$",
          minLength: 2,
          maxLength: 32,
          description: "首次触发延迟。支持复合 duration，如 '30m'、'2h30m'、'1d6h'。单位顺序 d→h→m→s。",
        },
        repeat: {
          type: "string",
          pattern: "^(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?(?:\\d+s)?$",
          minLength: 2,
          maxLength: 32,
          description: "可选重复间隔，格式同 delay。采用固定频率锚点，不随进程重启漂移。",
        },
        target: {
          type: "string",
          maxLength: 128,
          description: "可选目标 Session ID 或唯一名称。省略为自己；'*' 表示触发时广播所有 Session。",
        },
        tag: {
          type: "string",
          maxLength: 100,
          description: "任务标签（可选），便于按标签取消。",
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
    const target = resolveCronTarget(args.target, sessionId);

    const fireAt = parseDelayToISO(delay);
    if (repeat !== undefined) parseCronDurationMs(repeat);
    const id = insertCronJob({
      session_id: sessionId || null,
      target_session_id: target.targetSessionId,
      broadcast: target.broadcast ? 1 : 0,
      message,
      fire_at: fireAt,
      interval: repeat || null,
      tag: tag || null,
    });

    const job: CronJobRow = {
      id,
      session_id: sessionId || null,
      target_session_id: target.targetSessionId,
      broadcast: target.broadcast ? 1 : 0,
      message,
      fire_at: fireAt,
      interval: repeat || null,
      tag: tag || null,
      active: 1,
      last_fired: null,
      created_at: new Date().toISOString(),
    };
    onSchedule(job);

    return `✅ 定时任务已创建 [ID: ${id}]\n消息: ${message}\n目标: ${target.label}\n触发时间: ${new Date(fireAt).toLocaleString("zh-CN")}${repeat ? `\n重复间隔: ${repeat}` : " (一次性)"}`;
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

export const cronListExec: ToolExecutor = async (_args, env) => {
  const ownerSessionId = env?._SESSION_ID;
  if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0) throw new Error("cron_list 需要当前 Session 身份");
  const jobs = listCronJobs(true).filter(job => job.session_id === ownerSessionId);
  if (jobs.length === 0) return "当前没有活跃的定时任务。";

  const lines = jobs.map((job) => {
    const fireTime = new Date(job.fire_at).toLocaleString("zh-CN");
    const type = job.interval ? `每 ${job.interval}` : "一次性";
    const target = job.broadcast === 1 ? "*" : job.target_session_id ?? job.session_id ?? "未知";
    return `[${job.id}] ${type} | 触发: ${fireTime} | 目标: ${target} | ${truncateCodePoints(job.message, 50)}${job.tag ? ` | 标签: ${job.tag}` : ""}`;
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
        id: { type: "integer", minimum: 1, description: "任务ID" },
        tag: { type: "string", minLength: 1, description: "任务标签（取消所有匹配此标签的任务）" },
      },
      anyOf: [{ required: ["id"] }, { required: ["tag"] }],
    },
  },
};

export function createCronCancelExec(onCancel: (id: number) => void): ToolExecutor {
  return async (args, env) => {
    const id = args.id as number | undefined;
    const tag = args.tag as string | undefined;
    const ownerSessionId = env?._SESSION_ID;
    if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0) throw new Error("cron_cancel 需要当前 Session 身份");
    const owned = listCronJobs(true).filter(job => job.session_id === ownerSessionId);

    if (id) {
      if (!owned.some(job => job.id === id)) return `定时任务 ${id} 不存在`;
      deactivateCronJob(id);
      onCancel(id);
      return `✅ 定时任务 ${id} 已取消`;
    }

    if (tag) {
      const matching = owned.filter(job => job.tag === tag);
      for (const job of matching) {
        deactivateCronJob(job.id);
        onCancel(job.id);
      }
      return `✅ 已取消 ${matching.length} 个标签为 "${tag}" 的定时任务`;
    }

    throw new Error("需要提供 id 或 tag");
  };
}
