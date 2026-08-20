import {
  deleteTaskBySessionAndId,
  deleteTasksBySessionId,
  getNextTaskSortOrder,
  getTaskBySessionAndId,
  getTaskDependenciesBySessionId,
  getTasksBySessionId,
  insertTaskDependency,
  insertTaskRow,
  updateTaskRow,
  withTransaction,
  type TaskRow,
} from "./db.js";
import type { TaskSnapshot, TaskStatus } from "./types.js";

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_TASKS_PER_SESSION = 1_024;
const MAX_DEPENDENCIES_PER_TASK = 128;
const MAX_SUBJECT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_ACTIVE_FORM_LENGTH = 500;
const MAX_OWNER_LENGTH = 128;
const MAX_METADATA_BYTES = 65_536;

export type TaskDagErrorCode =
  | "TASK_INVALID"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_EXISTS"
  | "TASK_BLOCKER_NOT_FOUND"
  | "TASK_BLOCKED"
  | "TASK_CYCLE"
  | "TASK_REOPEN_DENIED"
  | "TASK_LIMIT_EXCEEDED";

export class TaskDagError extends Error {
  readonly code: TaskDagErrorCode;
  constructor(code: TaskDagErrorCode, message: string) {
    super(message);
    this.name = "TaskDagError";
    this.code = code;
  }
}

export interface TaskCreateInput {
  readonly id: string;
  readonly subject: string;
  readonly description?: string;
  readonly blockedBy?: readonly string[];
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly activeForm?: string;
}

export interface TaskUpdateInput {
  readonly status?: TaskStatus | "deleted";
  readonly subject?: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly addBlockedBy?: readonly string[];
  readonly addBlocks?: readonly string[];
}

function invalid(message: string): never {
  throw new TaskDagError("TASK_INVALID", message);
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0") || value.trim().length === 0) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function taskId(value: unknown, field = "task_id"): string {
  if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) invalid(`${field} is invalid`);
  return value;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, maximum);
}

function cloneJson(value: unknown, field: string, depth = 0): unknown {
  if (depth > 32) invalid(`${field} exceeds the maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, `${field}[${index}]`, depth + 1));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be plain JSON data`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key.length === 0 || key.length > 128 || key.includes("\0") || ["__proto__", "prototype", "constructor"].includes(key)) {
        invalid(`${field} key is invalid`);
      }
      return [key, cloneJson(entry, `${field}.${key}`, depth + 1)];
    }));
  }
  invalid(`${field} contains unsupported data`);
}

function metadata(value: unknown = {}): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("metadata must be an object");
  const cloned = cloneJson(value, "metadata") as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > MAX_METADATA_BYTES) invalid("metadata exceeds the byte limit");
  return cloned;
}

function parseMetadata(row: TaskRow): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(row.metadata_json); }
  catch { throw new Error(`Task ${row.task_id} metadata is corrupt`); }
  return metadata(parsed);
}

function ids(values: readonly string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_DEPENDENCIES_PER_TASK) invalid(`${field} is invalid`);
  const normalized = values.map((value, index) => taskId(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) invalid(`${field} contains duplicates`);
  return normalized;
}

function dependencyMaps(sessionId: string): {
  readonly blockedBy: Map<string, string[]>;
  readonly blocks: Map<string, string[]>;
} {
  const blockedBy = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  for (const edge of getTaskDependenciesBySessionId(sessionId)) {
    const blockers = blockedBy.get(edge.task_id) ?? [];
    blockers.push(edge.blocker_id);
    blockedBy.set(edge.task_id, blockers);
    const dependents = blocks.get(edge.blocker_id) ?? [];
    dependents.push(edge.task_id);
    blocks.set(edge.blocker_id, dependents);
  }
  for (const values of [...blockedBy.values(), ...blocks.values()]) values.sort();
  return { blockedBy, blocks };
}

function snapshots(sessionId: string): TaskSnapshot[] {
  const rows = getTasksBySessionId(sessionId);
  const status = new Map(rows.map(row => [row.task_id, row.status]));
  const { blockedBy, blocks } = dependencyMaps(sessionId);
  return rows.map(row => {
    const blockers = blockedBy.get(row.task_id) ?? [];
    return Object.freeze({
      id: row.task_id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      activeForm: row.active_form,
      owner: row.owner,
      metadata: Object.freeze(parseMetadata(row)),
      blockedBy: Object.freeze([...blockers]),
      blocks: Object.freeze([...(blocks.get(row.task_id) ?? [])]),
      blocked: blockers.some(blocker => status.get(blocker) !== "completed"),
    });
  });
}

function snapshot(sessionId: string, id: string): TaskSnapshot {
  const found = snapshots(sessionId).find(entry => entry.id === id);
  if (!found) throw new TaskDagError("TASK_NOT_FOUND", `Task ${id} does not exist in this session`);
  return found;
}

function assertAcyclic(taskIds: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): void {
  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string): void => {
    if (state.get(id) === "visiting") throw new TaskDagError("TASK_CYCLE", "Task dependency cycle is denied");
    if (state.get(id) === "visited") return;
    state.set(id, "visiting");
    for (const blocker of edges.get(id) ?? []) visit(blocker);
    state.set(id, "visited");
  };
  for (const id of taskIds) visit(id);
}

export function createTask(sessionId: string, input: TaskCreateInput): TaskSnapshot {
  const id = taskId(input.id, "id");
  const subject = boundedString(input.subject, "subject", MAX_SUBJECT_LENGTH);
  const description = optionalString(input.description, "description", MAX_DESCRIPTION_LENGTH) ?? null;
  const owner = optionalString(input.owner, "owner", MAX_OWNER_LENGTH) ?? null;
  const activeForm = optionalString(input.activeForm, "active_form", MAX_ACTIVE_FORM_LENGTH) ?? null;
  const blockers = ids(input.blockedBy, "blocked_by");
  const metadataJson = JSON.stringify(metadata(input.metadata));
  return withTransaction(() => {
    const current = getTasksBySessionId(sessionId);
    if (current.length >= MAX_TASKS_PER_SESSION) throw new TaskDagError("TASK_LIMIT_EXCEEDED", "Task limit exceeded");
    if (getTaskBySessionAndId(sessionId, id)) throw new TaskDagError("TASK_ALREADY_EXISTS", `Task ${id} already exists`);
    if (blockers.includes(id)) throw new TaskDagError("TASK_CYCLE", "Task cannot block itself");
    for (const blocker of blockers) {
      if (!getTaskBySessionAndId(sessionId, blocker)) throw new TaskDagError("TASK_BLOCKER_NOT_FOUND", `Blocker ${blocker} does not exist`);
    }
    const now = new Date().toISOString();
    insertTaskRow({
      session_id: sessionId,
      task_id: id,
      subject,
      description,
      status: "pending",
      active_form: activeForm,
      owner,
      metadata_json: metadataJson,
      sort_order: getNextTaskSortOrder(sessionId),
      created_at: now,
      updated_at: now,
    });
    for (const blocker of blockers) insertTaskDependency({ session_id: sessionId, task_id: id, blocker_id: blocker, created_at: now });
    return snapshot(sessionId, id);
  });
}

export function updateTask(sessionId: string, idInput: string, input: TaskUpdateInput): TaskSnapshot | null {
  const id = taskId(idInput);
  const requestedStatus = input.status;
  if (requestedStatus === "deleted") {
    removeTask(sessionId, id);
    return null;
  }
  return withTransaction(() => {
    const rows = getTasksBySessionId(sessionId);
    const row = rows.find(candidate => candidate.task_id === id);
    if (!row) throw new TaskDagError("TASK_NOT_FOUND", `Task ${id} does not exist in this session`);
    const rowById = new Map(rows.map(candidate => [candidate.task_id, candidate]));
    const existingEdges = getTaskDependenciesBySessionId(sessionId);
    const graph = new Map(rows.map(candidate => [candidate.task_id, new Set<string>()]));
    for (const edge of existingEdges) graph.get(edge.task_id)!.add(edge.blocker_id);
    const additions: Array<{ taskId: string; blockerId: string }> = [];
    for (const blocker of ids(input.addBlockedBy, "add_blocked_by")) additions.push({ taskId: id, blockerId: blocker });
    for (const dependent of ids(input.addBlocks, "add_blocks")) additions.push({ taskId: dependent, blockerId: id });
    for (const edge of additions) {
      if (!rowById.has(edge.taskId) || !rowById.has(edge.blockerId)) {
        throw new TaskDagError("TASK_BLOCKER_NOT_FOUND", "Task dependency endpoint does not exist in this session");
      }
      graph.get(edge.taskId)!.add(edge.blockerId);
    }
    if ([...graph.values()].some(blockers => blockers.size > MAX_DEPENDENCIES_PER_TASK)) {
      throw new TaskDagError("TASK_LIMIT_EXCEEDED", `A task cannot have more than ${MAX_DEPENDENCIES_PER_TASK} blockers`);
    }
    assertAcyclic([...rowById.keys()], graph);

    const nextStatus: TaskStatus = requestedStatus ?? row.status;
    if (!(["pending", "in_progress", "completed"] as const).includes(nextStatus)) invalid("status is invalid");
    if (row.status === "completed" && nextStatus !== "completed") {
      const activeDependent = [...graph.entries()].some(([task, blockers]) => blockers.has(id) && rowById.get(task)?.status !== "pending");
      if (activeDependent) throw new TaskDagError("TASK_REOPEN_DENIED", `Task ${id} has an active dependent`);
    }
    const prospectiveStatus = new Map(rows.map(candidate => [candidate.task_id, candidate.status]));
    prospectiveStatus.set(id, nextStatus);
    for (const [task, blockers] of graph) {
      if (prospectiveStatus.get(task) === "pending") continue;
      if ([...blockers].some(blocker => prospectiveStatus.get(blocker) !== "completed")) {
        throw new TaskDagError("TASK_BLOCKED", `Task ${task} is blocked`);
      }
    }

    const mergedMetadata = parseMetadata(row);
    if (input.metadata !== undefined) {
      for (const [key, value] of Object.entries(metadata(input.metadata))) {
        if (value === null) delete mergedMetadata[key];
        else mergedMetadata[key] = value;
      }
    }
    const updated = updateTaskRow({
      session_id: sessionId,
      task_id: id,
      subject: optionalString(input.subject, "subject", MAX_SUBJECT_LENGTH) ?? row.subject,
      description: optionalString(input.description, "description", MAX_DESCRIPTION_LENGTH) ?? row.description,
      status: nextStatus,
      active_form: optionalString(input.activeForm, "active_form", MAX_ACTIVE_FORM_LENGTH) ?? row.active_form,
      owner: optionalString(input.owner, "owner", MAX_OWNER_LENGTH) ?? row.owner,
      metadata_json: JSON.stringify(metadata(mergedMetadata)),
      updated_at: new Date().toISOString(),
    });
    if (!updated) throw new TaskDagError("TASK_NOT_FOUND", `Task ${id} disappeared during update`);
    const now = new Date().toISOString();
    for (const edge of additions) {
      if (!existingEdges.some(existing => existing.task_id === edge.taskId && existing.blocker_id === edge.blockerId)) {
        insertTaskDependency({ session_id: sessionId, task_id: edge.taskId, blocker_id: edge.blockerId, created_at: now });
      }
    }
    return snapshot(sessionId, id);
  });
}

export function getTask(sessionId: string, idInput: string): TaskSnapshot {
  return snapshot(sessionId, taskId(idInput));
}

export function getTasksBySession(sessionId: string, filter: TaskStatus | "all" = "all"): TaskSnapshot[] {
  if (!["all", "pending", "in_progress", "completed"].includes(filter)) invalid("filter is invalid");
  const values = snapshots(sessionId);
  return filter === "all" ? values : values.filter(value => value.status === filter);
}

export function removeTask(sessionId: string, idInput: string): void {
  const id = taskId(idInput);
  if (!deleteTaskBySessionAndId(sessionId, id)) throw new TaskDagError("TASK_NOT_FOUND", `Task ${id} does not exist in this session`);
}

export function clearTasks(sessionId: string): number {
  return deleteTasksBySessionId(sessionId);
}

export function getNextPendingTask(sessionId: string): TaskSnapshot | null {
  return snapshots(sessionId).find(value => value.status === "pending" && !value.blocked) ?? null;
}

export function allTasksCompleted(sessionId: string): boolean {
  const values = snapshots(sessionId);
  return values.length === 0 || values.every(value => value.status === "completed");
}

export function copyTasksForFork(sourceSessionId: string, targetSessionId: string): void {
  const rows = getTasksBySessionId(sourceSessionId);
  for (const row of rows) {
    insertTaskRow({
      session_id: targetSessionId,
      task_id: row.task_id,
      subject: row.subject,
      description: row.description,
      status: row.status,
      active_form: row.active_form,
      owner: row.owner,
      metadata_json: row.metadata_json,
      sort_order: row.sort_order,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
  for (const edge of getTaskDependenciesBySessionId(sourceSessionId)) {
    insertTaskDependency({ ...edge, session_id: targetSessionId });
  }
}
