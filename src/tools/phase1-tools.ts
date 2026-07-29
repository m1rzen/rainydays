// ===========================================
// 阶段一工具集合 A —— memo / mascot_notify / muse / search_tools
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { db } from "../db.js";

// ========== memo_add / memo_list / memo_done ==========

// memo_add
export const memoAddDef: ToolDefinition = {
  type: "function",
  function: {
    name: "memo_add",
    description: "添加一条备忘录/提醒。支持定时提醒和重复规则。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "备忘内容" },
        remind_at: { type: "string", description: "提醒时间 ISO 格式（可选）" },
        repeat_rule: { type: "string", enum: ["daily", "weekly", "monthly"], description: "重复规则（可选）" },
        tags: { type: "string", description: "标签（可选）" },
      },
      required: ["content"],
    },
  },
};
export const memoAddExec: ToolExecutor = async (args) => {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO memos (content, remind_at, repeat_rule, status, tags, created_at) VALUES (?, ?, ?, 'active', ?, ?)`
  ).run(args.content as string, (args.remind_at as string) || null, (args.repeat_rule as string) || null, (args.tags as string) || null, now);
  return `✅ 备忘已添加 [ID: ${Number(result.lastInsertRowid)}]: ${args.content}`;
};

// memo_list
export const memoListDef: ToolDefinition = {
  type: "function",
  function: { name: "memo_list", description: "列出备忘录。默认只显示活跃的。", parameters: { type: "object", properties: { filter: { type: "string", enum: ["active", "done", "all"], description: "过滤：active=未完成（默认），done=已完成，all=全部" }, tags: { type: "string", description: "按标签过滤（可选）" } } } },
};
export const memoListExec: ToolExecutor = async (args) => {
  const filter = (args.filter as string) || "active";
  const status = filter === "all" ? null : filter;
  let query = `SELECT * FROM memos`;
  const params: unknown[] = [];
  if (status) { query += ` WHERE status = ?`; params.push(status); }
  if (args.tags) { query += status ? ` AND tags LIKE ?` : ` WHERE tags LIKE ?`; params.push(`%${args.tags}%`); }
  query += ` ORDER BY datetime(created_at) DESC LIMIT 50`;
  const memos = db.prepare(query).all(...params) as { id: number; content: string; remind_at: string | null; repeat_rule: string | null; status: string; tags: string | null; created_at: string }[];
  if (memos.length === 0) return "没有备忘录。";
  return memos.map(m => `[${m.id}] ${m.status === "done" ? "✅" : "⏳"} ${m.content}${m.remind_at ? ` (提醒: ${m.remind_at})` : ""}${m.tags ? ` [${m.tags}]` : ""}`).join("\n");
};

// memo_done
export const memoDoneDef: ToolDefinition = {
  type: "function",
  function: { name: "memo_done", description: "标记备忘录为已完成。", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
};
export const memoDoneExec: ToolExecutor = async (args) => {
  db.prepare(`UPDATE memos SET status = 'done' WHERE id = ?`).run(args.id as number);
  return `✅ 备忘 ${args.id} 已标记完成`;
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
  if (notifyCallback) notifyCallback(title, body);
  // Electron 通知
  try {
    const { Notification } = await import("electron");
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch { /* 非 Electron 环境，前端通知 */ }
  return `✅ 通知已发送: ${title}`;
};

// ========== muse ==========

export const museDef: ToolDefinition = {
  type: "function",
  function: {
    name: "muse",
    description: "启动一次短暂的内在思考——以不同视角审视当前工作。不修改画布，只注入洞察。适合复杂决策前的'让我想想'时刻。",
    parameters: { type: "object", properties: { topic: { type: "string", description: "思考的主题/问题" }, perspective: { type: "string", description: "思考视角，如'风险审查'、'替代方案'、'用户视角'" } }, required: ["topic"] },
  },
};

export function createMuseExec(llm: import("../llm.js").LLMClient): ToolExecutor {
  return async (args) => {
    const topic = args.topic as string;
    const perspective = (args.perspective as string) || "整体审视";
    const response = await llm.chat([
      { role: "system", content: `你是 Muse——一个内在思考者。从"${perspective}"的视角审视以下主题。给出洞察、警告或确认。简洁有力，不超过 200 字。` },
      { role: "user", content: topic },
    ]);
    return `🧠 Muse [${perspective}]:\n${response.content}`;
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
