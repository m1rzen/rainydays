// ===========================================
// 任务管理 —— 创建/更新/查询任务
// 任务属于会话，按 sort_order 排序
// ===========================================

import {
  insertTasks,
  getTasksBySessionId,
  getTask,
  updateTaskStatusInDb,
  updateTaskSubject,
  deleteTask,
  type TaskRow,
} from "./db.js";
import type { TaskSnapshot, TaskStatus } from "./types.js";

/** TaskRow → TaskSnapshot 转换（给前端/agent 用） */
function toSnapshot(row: TaskRow): TaskSnapshot {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status as TaskStatus,
    activeForm: row.active_form,
  };
}

/** 批量创建任务，返回快照列表 */
export function createTasks(sessionId: string, subjects: string[]): TaskSnapshot[] {
  const ids = insertTasks(sessionId, subjects);
  return ids.map((id, i) => ({
    id,
    subject: subjects[i],
    status: "pending" as TaskStatus,
    activeForm: null,
  }));
}

/** 标记任务为进行中 */
export function startTask(id: number, activeForm?: string): TaskSnapshot | null {
  updateTaskStatusInDb(id, "in_progress", activeForm);
  const row = getTask(id);
  return row ? toSnapshot(row) : null;
}

/** 标记任务为已完成 */
export function completeTask(id: number): TaskSnapshot | null {
  updateTaskStatusInDb(id, "completed", undefined);
  const row = getTask(id);
  return row ? toSnapshot(row) : null;
}

/** 标记任务为失败 */
export function failTask(id: number, reason?: string): TaskSnapshot | null {
  updateTaskStatusInDb(id, "failed", reason);
  const row = getTask(id);
  return row ? toSnapshot(row) : null;
}

/** 更新任务标题 */
export function renameTask(id: number, subject: string): void {
  updateTaskSubject(id, subject);
}

/** 删除任务 */
export function removeTask(id: number): void {
  deleteTask(id);
}

/** 获取会话的所有任务快照 */
export function getTasksBySession(sessionId: string): TaskSnapshot[] {
  return getTasksBySessionId(sessionId).map(toSnapshot);
}

/** 获取下一个待处理的任务 */
export function getNextPendingTask(sessionId: string): TaskSnapshot | null {
  const tasks = getTasksBySessionId(sessionId);
  const next = tasks.find((t) => t.status === "pending");
  return next ? toSnapshot(next) : null;
}

/** 检查会话是否所有任务都已完成 */
export function allTasksCompleted(sessionId: string): boolean {
  const tasks = getTasksBySessionId(sessionId);
  if (tasks.length === 0) return true;
  return tasks.every((t) => t.status === "completed" || t.status === "failed");
}
