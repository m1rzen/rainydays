// ===========================================
// 阶段一工具集合 A —— memo / mascot_notify / muse / search_tools
// ===========================================

import type { LLMClient } from "../llm.js";
import type { SubagentRegistry } from "../subagent-registry.js";
import type { PersonaDefinition, ToolDefinition, ToolExecutor } from "../types.js";
import {
  completeMemo,
  createMemoWithCron,
  listMemosBySession,
  type CronJobRow,
  type MemoRow,
} from "../db.js";
import { createMonthlyCronInterval } from "../cron.js";
import { emitRunNotification } from "./ask-user-tool.js";

// ========== memo_add / memo_list / memo_done ==========

let memoScheduleCallback: ((job: CronJobRow) => void) | null = null;
let memoCancelCallback: ((id: number) => void) | null = null;

export function setMemoCronCallbacks(callbacks: Readonly<{
  schedule: (job: CronJobRow) => void;
  cancel: (id: number) => void;
}>): void {
  memoScheduleCallback = callbacks.schedule;
  memoCancelCallback = callbacks.cancel;
}

function memoSessionId(env?: Readonly<Record<string, string>>): string {
  const sessionId = env?._SESSION_ID;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Memo 需要当前 Session 身份");
  return sessionId;
}

function canonicalReminder(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64 || value.includes("\0")) throw new Error("remind_at 无效");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("remind_at 必须是有效 ISO 时间");
  return new Date(timestamp).toISOString();
}

function memoInterval(remindAt: string | null, repeatRule: MemoRow["repeat_rule"]): string | null {
  if (!repeatRule) return null;
  if (!remindAt) throw new Error("repeat_rule 需要 remind_at");
  if (repeatRule === "daily") return "1d";
  if (repeatRule === "weekly") return "7d";
  if (repeatRule === "monthly") return createMonthlyCronInterval(remindAt);
  throw new Error("repeat_rule 无效");
}

// memo_add
export const memoAddDef: ToolDefinition = {
  type: "function",
  function: {
    name: "memo_add",
    description: "为当前 Session 添加备忘录；remind_at 会通过持久 Cron/EventBus 真实唤醒或注入该 Session。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 4000, description: "备忘内容" },
        remind_at: { type: "string", maxLength: 64, description: "提醒时间（有效 ISO 日期时间，可选）" },
        repeat_rule: { type: "string", enum: ["daily", "weekly", "monthly"], description: "重复规则（可选，必须同时提供 remind_at）" },
        tags: { type: "string", maxLength: 500, description: "标签（可选）" },
      },
      required: ["content"],
    },
  },
};
export const memoAddExec: ToolExecutor = async (args, env) => {
  const sessionId = memoSessionId(env);
  const content = args.content as string;
  const remindAt = canonicalReminder(args.remind_at);
  const repeatRule = (args.repeat_rule ?? null) as MemoRow["repeat_rule"];
  const cronInterval = memoInterval(remindAt, repeatRule);
  if (remindAt && !memoScheduleCallback) throw new Error("Memo 调度器尚未启动");
  const created = createMemoWithCron({
    sessionId,
    content,
    remindAt,
    repeatRule,
    cronInterval,
    tags: (args.tags as string | undefined) || null,
  });
  if (created.cronJob) memoScheduleCallback!(created.cronJob);
  return `✅ 备忘已添加 [ID: ${created.memo.id}]: ${content}${remindAt ? `\n提醒: ${remindAt}${repeatRule ? ` (${repeatRule})` : ""}` : ""}`;
};

// memo_list
export const memoListDef: ToolDefinition = {
  type: "function",
  function: { name: "memo_list", description: "列出当前 Session 的备忘录。默认只显示活跃项。", parameters: { type: "object", properties: { filter: { type: "string", enum: ["active", "done", "all"], description: "过滤：active=未完成（默认），done=已完成，all=全部" }, tags: { type: "string", maxLength: 500, description: "按标签过滤（可选）" } } } },
};
export const memoListExec: ToolExecutor = async (args, env) => {
  const filter = (args.filter as "active" | "done" | "all" | undefined) ?? "active";
  const status = filter === "all" ? null : filter;
  const memos = listMemosBySession(memoSessionId(env), status, (args.tags as string | undefined) || null);
  if (memos.length === 0) return "没有备忘录。";
  return memos.map(m => `[${m.id}] ${m.status === "done" ? "✅" : "⏳"} ${m.content}${m.remind_at ? ` (提醒: ${m.remind_at}${m.repeat_rule ? `, ${m.repeat_rule}` : ""})` : ""}${m.tags ? ` [${m.tags}]` : ""}`).join("\n");
};

// memo_done
export const memoDoneDef: ToolDefinition = {
  type: "function",
  function: { name: "memo_done", description: "完成当前 Session 的备忘录，并原子停用其提醒任务。", parameters: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"] } },
};
export const memoDoneExec: ToolExecutor = async (args, env) => {
  const id = args.id as number;
  const completed = completeMemo(memoSessionId(env), id);
  if (completed.cronJobId !== null) memoCancelCallback?.(completed.cronJobId);
  return completed.changed ? `✅ 备忘 ${id} 已标记完成` : `备忘 ${id} 不存在或已完成`;
};

// ========== mascot_notify ==========

export const mascotNotifyDef: ToolDefinition = {
  type: "function",
  function: {
    name: "mascot_notify",
    description: "推送桌面通知。用于重要事件、任务完成、需要用户注意时。",
    parameters: { type: "object", properties: { title: { type: "string", description: "通知标题" }, body: { type: "string", description: "通知内容" } }, required: ["title", "body"] },
  },
};

// 通知回调——由 index.ts 注册
let notifyCallback: ((title: string, body: string) => void) | null = null;
export function setNotifyCallback(cb: (title: string, body: string) => void): void { notifyCallback = cb; }

export const mascotNotifyExec: ToolExecutor = async (args) => {
  const title = args.title as string;
  const body = args.body as string;
  const runDelivery = emitRunNotification(title, body);
  if (runDelivery !== null) {
    if (!runDelivery) throw new Error(`当前运行的通知通道不可用: ${title}`);
    return `✅ 通知已发送: ${title}`;
  }

  // Legacy fallback until the HTTP chat route enters runWithInteractionChannel.
  let delivered = false;
  if (notifyCallback) {
    notifyCallback(title, body);
    delivered = true;
  }
  try {
    const { Notification } = await import("electron");
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
      delivered = true;
    }
  } catch { /* A registered frontend callback can still be authoritative outside Electron. */ }
  if (!delivered) throw new Error(`通知通道不可用: ${title}`);
  return `✅ 通知已发送: ${title}`;
};

// ========== muse ==========

export const museDef: ToolDefinition = {
  type: "function",
  function: {
    name: "muse",
    description: "在当前 Session 启动受限后台 Muse 任务。立即返回 task_id；用 subagent_peek/output/post/stop 管理。最多 10 次迭代、遵循父权限和 Session 关闭，不跨重启自动恢复。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1, maxLength: 8000, description: "思考的主题/问题" },
        perspective: { type: "string", minLength: 1, maxLength: 160, description: "思考视角，如'风险审查'、'替代方案'、'用户视角'" },
      },
      required: ["topic"],
    },
  },
};

const MUSE_TOOL_ALLOWLIST = Object.freeze([
  "read", "glob", "grep", "recall", "inspect", "graph", "search_tools", "fetch_url",
]);

export function createMuseExec(dependencies: Readonly<{
  registry: SubagentRegistry;
  llm: LLMClient;
  persona: PersonaDefinition;
}>): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("Tool invocation services are required");
    const topic = args.topic as string;
    const perspective = (args.perspective as string) || "整体审视";
    const child = await dependencies.registry.spawn({
      description: "muse reflection",
      prompt: [
        `你是当前 Session 的 Muse，从“${perspective}”视角自主审视下面的主题。`,
        "只可使用宿主强制授予的只读工具收集证据；不要派生其他后台 agent。",
        "在十次迭代预算内给出结论、风险和下一步，然后主动结束。",
        `主题：${topic}`,
      ].join("\n"),
      persona: dependencies.persona,
      llm: dependencies.llm,
      parentContext: invocation.capabilityContext,
      parentInvocation: invocation,
      inheritCanvas: false,
      toolAllowlist: MUSE_TOOL_ALLOWLIST,
    });
    return JSON.stringify({
      task_id: child.taskId,
      session_id: invocation.capabilityContext.sessionId,
      status: child.status,
      perspective,
      limits: { maxIterations: 10, permissions: "read-only-attenuated-parent", restart: "abort-no-auto-resume" },
      controls: { inspect: "subagent_peek/subagent_output", guide: "subagent_post", stop: "subagent_stop" },
    }, null, 2);
  };
}

// ========== search_tools ==========

export const searchToolsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      "搜索 agent 自身可用的工具列表（不是搜索文件系统）。当你不确定当前有哪些工具可用、或想找某个功能的工具时使用。例如搜 'image' 会返回 image_helper，搜 'memory' 会返回 remember/recall。",
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "string",
          description: "搜索关键词，可以多个词用空格分隔。会匹配工具名和工具描述。",
        },
      },
      required: ["keywords"],
    },
  },
};
export const searchToolsExec: ToolExecutor = async (args, _env, invocation) => {
  const keywords = (args.keywords as string).toLowerCase();
  // 拆分成多个关键词，每个独立匹配
  const terms = keywords.split(/[\s,，、]+/).filter(t => t.length > 0);
  // 只搜索当前 authentic capability snapshot 中真正可执行的工具。
  if (!invocation) throw new Error("缺少受控工具调用服务");
  const allDefs = invocation.listCurrentToolDefinitions();
  const all = allDefs.map((definition) => definition.function.name);
  const descMap = new Map<string, string>();
  for (const def of allDefs) {
    const name = def.function.name;
    const desc = def.function.description || "";
    descMap.set(name, desc.toLowerCase());
  }

  // 每个工具：检查工具名或描述是否包含任一关键词
  const matched = all.filter(name => {
    const nameLower = name.toLowerCase();
    const desc = descMap.get(name) || "";
    return terms.some(term => nameLower.includes(term) || desc.includes(term));
  });

  if (matched.length === 0) return `未找到匹配 "${keywords}" 的工具。`;
  return `匹配的工具 (${matched.length}):\n${matched.map(t => `  • ${t}`).join("\n")}`;
};
