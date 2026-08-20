import type { ToolDefinition, ToolExecutor } from "../types.js";
import {
  clearTasks,
  createTask,
  getTask,
  getTasksBySession,
  removeTask,
  updateTask,
  type TaskCreateInput,
  type TaskUpdateInput,
} from "../task.js";

function getSessionId(env?: Readonly<Record<string, string>>): string {
  const sessionId = env?._SESSION_ID;
  if (!sessionId) throw new Error("无法确定当前会话");
  return sessionId;
}

const taskIdSchema = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
  description: "Session 内唯一的短任务 ID。",
};

export const taskCreateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "task_create",
    description: "创建一个 Task DAG 节点。blocked_by 中的任务必须已存在。",
    parameters: {
      type: "object",
      properties: {
        id: taskIdSchema,
        subject: { type: "string", minLength: 1, maxLength: 500, description: "简短任务标题。" },
        description: { type: "string", minLength: 1, maxLength: 4000, description: "可选详细说明。" },
        blocked_by: { type: "array", maxItems: 128, uniqueItems: true, items: taskIdSchema, description: "开始前必须完成的任务 ID。" },
        owner: { type: "string", minLength: 1, maxLength: 128, description: "可选 owner。" },
        metadata: { type: "object", additionalProperties: true, description: "可选 JSON metadata。" },
        active_form: { type: "string", minLength: 1, maxLength: 500, description: "可选当前动作描述。" },
      },
      required: ["id", "subject"],
    },
  },
};

export const taskCreateExec: ToolExecutor = async (args, env) => {
  const input: TaskCreateInput = {
    id: args.id as string,
    subject: args.subject as string,
    ...(args.description === undefined ? {} : { description: args.description as string }),
    ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by as string[] }),
    ...(args.owner === undefined ? {} : { owner: args.owner as string }),
    ...(args.metadata === undefined ? {} : { metadata: args.metadata as Record<string, unknown> }),
    ...(args.active_form === undefined ? {} : { activeForm: args.active_form as string }),
  };
  const task = createTask(getSessionId(env), input);
  return `任务已创建: [${task.status}] ${task.id} — ${task.subject}${task.blocked ? ` [B:${task.blockedBy.join(",")}]` : ""}`;
};

export const taskUpdateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "task_update",
    description: "更新一个任务；依赖边只可追加，循环会被事务性拒绝。status=deleted 会删除任务并清理依赖。",
    parameters: {
      type: "object",
      properties: {
        task_id: taskIdSchema,
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "新状态。" },
        subject: { type: "string", minLength: 1, maxLength: 500, description: "新标题。" },
        description: { type: "string", minLength: 1, maxLength: 4000, description: "新说明。" },
        active_form: { type: "string", minLength: 1, maxLength: 500, description: "当前动作描述。" },
        owner: { type: "string", minLength: 1, maxLength: 128, description: "任务 owner。" },
        metadata: { type: "object", additionalProperties: true, description: "浅合并 metadata；值为 null 的 key 被删除。" },
        add_blocked_by: { type: "array", maxItems: 128, uniqueItems: true, items: taskIdSchema, description: "追加 blocker。" },
        add_blocks: { type: "array", maxItems: 128, uniqueItems: true, items: taskIdSchema, description: "让当前任务阻塞这些任务。" },
      },
      required: ["task_id"],
    },
  },
};

export const taskUpdateExec: ToolExecutor = async (args, env) => {
  const sessionId = getSessionId(env);
  const id = args.task_id as string;
  const input: TaskUpdateInput = {
    ...(args.status === undefined ? {} : { status: args.status as TaskUpdateInput["status"] }),
    ...(args.subject === undefined ? {} : { subject: args.subject as string }),
    ...(args.description === undefined ? {} : { description: args.description as string }),
    ...(args.active_form === undefined ? {} : { activeForm: args.active_form as string }),
    ...(args.owner === undefined ? {} : { owner: args.owner as string }),
    ...(args.metadata === undefined ? {} : { metadata: args.metadata as Record<string, unknown> }),
    ...(args.add_blocked_by === undefined ? {} : { addBlockedBy: args.add_blocked_by as string[] }),
    ...(args.add_blocks === undefined ? {} : { addBlocks: args.add_blocks as string[] }),
  };
  const task = updateTask(sessionId, id, input);
  if (!task) return `任务已删除: ${id}`;
  return `任务已更新: [${task.status}] ${task.id} — ${task.subject}${task.blocked ? ` [B:${task.blockedBy.join(",")}]` : ""}`;
};

export const taskListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "task_list",
    description: "列出当前 Session 的任务；显示 blocker 与 owner。",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["pending", "in_progress", "completed", "all"], description: "状态过滤，默认 all。" },
      },
    },
  },
};

export const taskListExec: ToolExecutor = async (args, env) => {
  const tasks = getTasksBySession(getSessionId(env), (args.filter as "pending" | "in_progress" | "completed" | "all" | undefined) ?? "all");
  if (tasks.length === 0) return "当前会话没有匹配的任务。";
  const icon = { pending: "⏳", in_progress: "🔄", completed: "✅" } as const;
  return tasks.map(task => `${icon[task.status]} ${task.blocked ? "[B] " : ""}${task.owner ? `[O:${task.owner}] ` : ""}${task.id} — ${task.subject}`).join("\n");
};

export const taskGetDef: ToolDefinition = {
  type: "function",
  function: {
    name: "task_get",
    description: "读取当前 Session 中一个任务的完整 DAG 详情。",
    parameters: { type: "object", properties: { task_id: taskIdSchema }, required: ["task_id"] },
  },
};

export const taskGetExec: ToolExecutor = async (args, env) => JSON.stringify(getTask(getSessionId(env), args.task_id as string), null, 2);

export const taskDeleteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "task_delete",
    description: "删除当前 Session 的一个任务，或清空当前 Session 的全部任务；依赖引用会级联清理。",
    parameters: {
      type: "object",
      properties: {
        task_id: taskIdSchema,
        all: { type: "boolean", description: "true 时清空当前 Session。" },
      },
    },
  },
};

export const taskDeleteExec: ToolExecutor = async (args, env) => {
  const sessionId = getSessionId(env);
  const id = args.task_id as string | undefined;
  const all = args.all === true;
  if ((id ? 1 : 0) + (all ? 1 : 0) !== 1) throw new Error("task_delete 必须且只能指定 task_id 或 all=true");
  if (all) return `已清空 ${clearTasks(sessionId)} 个任务`;
  removeTask(sessionId, id!);
  return `任务已删除: ${id}`;
};
