// ===========================================
// 任务工具 —— 让 agent 能拆解和管理复杂任务
// create_tasks: 创建一批子任务
// update_task: 更新任务状态
// list_tasks: 列出当前会话的任务
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import {
  createTasks,
  startTask,
  completeTask,
  failTask,
  renameTask,
  getTasksBySession,
} from "../task.js";

/**
 * 工具执行器需要访问当前 session_id，
 * 通过 env._SESSION_ID 传入（由 agent 在执行工具时注入）
 */
function getSessionId(env?: Record<string, string>): string | null {
  return env?._SESSION_ID || null;
}

// ===========================================
// create_tasks
// ===========================================
export const createTasksDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_tasks",
    description:
      "将复杂任务拆解为多个子任务。用于需要多步骤完成的工作，如'整理所有项目并生成报告'、'对比三个方案'等。创建后你会逐个执行这些任务。",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "任务标题列表，按执行顺序排列。每个任务应该是清晰可执行的步骤。如 ['搜索医院相关项目','读取每个项目的关键文件','汇总信息生成Excel']",
        },
      },
      required: ["tasks"],
    },
  },
};

export const createTasksExec: ToolExecutor = async (args, env) => {
  const sessionId = getSessionId(env);
  if (!sessionId) return "错误：无法确定当前会话";

  const subjects = args.tasks as string[];
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return "错误：tasks 必须是非空数组";
  }

  const tasks = createTasks(sessionId, subjects);

  const lines = tasks.map((t, i) => `  ${i + 1}. [${t.status}] ${t.subject}`);
  return `已创建 ${tasks.length} 个任务:\n${lines.join("\n")}\n\n现在请逐个执行这些任务。每完成一个用 update_task 标记状态。`;
};

// ===========================================
// update_task
// ===========================================
export const updateTaskDef: ToolDefinition = {
  type: "function",
  function: {
    name: "update_task",
    description:
      "更新任务状态。开始执行时标记 in_progress，完成时标记 completed，失败时标记 failed。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "任务ID" },
        status: {
          type: "string",
          enum: ["in_progress", "completed", "failed"],
          description: "新状态",
        },
        active_form: {
          type: "string",
          description: "当前正在做什么的简短描述（仅 in_progress 时需要）",
        },
        subject: {
          type: "string",
          description: "更新任务标题（可选）",
        },
      },
      required: ["id", "status"],
    },
  },
};

export const updateTaskExec: ToolExecutor = async (args, env) => {
  const id = args.id as number;
  const status = args.status as string;
  const activeForm = args.active_form as string | undefined;
  const subject = args.subject as string | undefined;

  // 更新标题（如果提供）
  if (subject) {
    renameTask(id, subject);
  }

  let result;
  switch (status) {
    case "in_progress":
      result = startTask(id, activeForm);
      break;
    case "completed":
      result = completeTask(id);
      break;
    case "failed":
      result = failTask(id, activeForm);
      break;
    default:
      return `错误：未知状态 ${status}`;
  }

  if (!result) return `错误：任务 ${id} 不存在`;
  return `任务 ${id} 已更新: [${result.status}] ${result.subject}${result.activeForm ? ` — ${result.activeForm}` : ""}`;
};

// ===========================================
// list_tasks
// ===========================================
export const listTasksDef: ToolDefinition = {
  type: "function",
  function: {
    name: "list_tasks",
    description: "列出当前会话的所有任务及其状态。用于查看任务进度。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const listTasksExec: ToolExecutor = async (_args, env) => {
  const sessionId = getSessionId(env);
  if (!sessionId) return "错误：无法确定当前会话";

  const tasks = getTasksBySession(sessionId);
  if (tasks.length === 0) return "当前会话没有任务。";

  const statusIcon: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    failed: "❌",
  };

  const lines = tasks.map((t) => `  ${statusIcon[t.status] || "?"} [${t.id}] ${t.subject}${t.activeForm ? ` — ${t.activeForm}` : ""}`);
  const completed = tasks.filter((t) => t.status === "completed").length;
  return `任务进度: ${completed}/${tasks.length}\n${lines.join("\n")}`;
};
