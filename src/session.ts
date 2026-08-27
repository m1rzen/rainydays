// ===========================================
// 会话管理 —— 创建/切换/删除会话
// 每个会话绑定一个 persona，有独立的消息历史
// ===========================================

import crypto from "crypto";
import type { PersonaDefinition, Message } from "./types.js";
import {
  insertSession,
  getSession,
  listSessions,
  deleteSession,
  touchSession,
  getSessionPersonaBinding,
  insertSessionPersonaBinding,
  insertSessionPersonaBindingIfMissing,
  updateSessionPersonaBinding,
  updateSessionTitle,
  getMessagesBySession,
  getMessagesUpTo,
  insertMessage,
  copyMessageAttachments,
  insertImportedAttachment,
  listDraftAttachments,
  listMessageAttachments,
  searchAcrossSessions,
  getPinsBySession,
  insertPin,
  type SessionRow,
  type MessageRow,
  type AttachmentRow,
  type SearchResultRow,
  withTransaction,
} from "./db.js";
import { APP_VERSION, BUILD_ID, SESSION_EXPORT_VERSION } from "./version.js";
import { copyTasksForFork, exportTaskTransfer, normalizeTaskTransfer, restoreTaskTransfer, type TaskTransferSnapshot } from "./task.js";
import { registerSession, unregisterSession, postFromSession, type LinkIdentity } from "./link.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, validateAttachmentContent, validateAttachmentId, validateAttachmentUploadMetadata } from "./attachment.js";
import { assertAttachmentCapacity } from "./attachment-store.js";
import { personaPermissionLevel } from "./persona.js";

const linkIdentities = new Map<string, LinkIdentity>();

/** 将持久 Session 绑定到本进程私有的 Link 投递能力。 */
export function ensureSessionLinkRegistration(id: string, title: string): void {
  const identity = linkIdentities.get(id) || Object.freeze({ sessionId: id, capability: Symbol(`mini-lux-link:${id}`) });
  if (!registerSession(id, title, identity.capability))
    throw new Error(`Link Session 身份冲突: ${id}`);
  linkIdentities.set(id, identity);
}

/** 通过当前会话私有能力投递 Link 消息；裸 ID 永远不能作为来源。 */
export function postSessionLinkMessage(fromSessionId: string, to: string, content: string): boolean {
  const identity = linkIdentities.get(fromSessionId);
  if (!identity) return false;
  return postFromSession(identity, to, content);
}

/** 创建新会话 */
export function createSession(persona: PersonaDefinition, title?: string): SessionRow {
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    persona_name: persona.name,
    title: title || "新对话",
    created_at: now,
    updated_at: now,
  };
  withTransaction(() => {
    insertSession(session);
    insertSessionPersonaBinding({
      session_id: session.id,
      persona_name: persona.name,
      persona_digest: persona.sourceDigest ?? persona.digest,
      permission_level: personaPermissionLevel(persona),
      bound_at: now,
    });
  });
  ensureSessionLinkRegistration(session.id, session.title);
  return session;
}

/** 列出所有会话 */
export function getAllSessions(): SessionRow[] {
  return listSessions();
}

/** 获取会话详情 */
export function getSessionInfo(id: string): SessionRow | undefined {
  return getSession(id);
}

/** 删除会话 */
export function removeSession(id: string): void {
  deleteSession(id);
  linkIdentities.delete(id);
  unregisterSession(id);
}

/** 为 schema 10 迁移来的 Session 建立一次初始定义绑定；已有绑定绝不覆盖。 */
export function initializeSessionPersonaBinding(id: string, persona: PersonaDefinition): boolean {
  const session = getSessionInfo(id);
  if (!session || session.persona_name !== persona.name) return false;
  return insertSessionPersonaBindingIfMissing({
    session_id: id,
    persona_name: persona.name,
    persona_digest: persona.sourceDigest ?? persona.digest,
    permission_level: personaPermissionLevel(persona),
    bound_at: new Date().toISOString(),
  });
}

export function sessionPersonaBinding(id: string) {
  return getSessionPersonaBinding(id);
}

/** CAS 切换一个持久 Session 的 Persona；调用方负责安全替换该 Session runtime。 */
export function rebindSessionPersona(id: string, current: PersonaDefinition, target: PersonaDefinition): boolean {
  return updateSessionPersonaBinding(id, current.name, current.sourceDigest ?? current.digest, {
    name: target.name,
    digest: target.sourceDigest ?? target.digest,
    permissionLevel: personaPermissionLevel(target),
  });
}

/** 更新会话标题 */
export function renameSession(id: string, title: string): boolean {
  const updated = updateSessionTitle(id, title);
  if (updated) ensureSessionLinkRegistration(id, title);
  return updated;
}

/** 标记会话已更新（有新消息时调用） */
export function touch(id: string): void {
  touchSession(id);
}

/**
 * 加载会话的消息历史（用于恢复对话上下文）
 * 注意：不含 system prompt，system prompt 由 persona 提供
 */
export function loadSessionMessages(sessionId: string): Array<Message & { id: number; created_at: string }> {
  const rows = getMessagesBySession(sessionId);
  return rows.map((row) => {
    const msg: Message & { id: number; created_at: string } = {
      id: row.id,
      created_at: row.created_at,
      role: row.role as Message["role"],
      content: row.content,
    };
    if (row.tool_calls) {
      try {
        msg.tool_calls = JSON.parse(row.tool_calls);
      } catch {
        // 忽略
      }
    }
    if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id;
    }
    return msg;
  });
}

/**
 * 自动生成会话标题：取用户第一条消息的前 30 字
 */
export function autoGenerateTitle(sessionId: string, firstUserMessage: string): string {
  const title = firstUserMessage.slice(0, 30).trim();
  if (title && title.length > 0) {
    const stored = title + (firstUserMessage.length > 30 ? "..." : "");
    renameSession(sessionId, stored);
    return stored;
  }
  return title;
}

/**
 * 后台使用 LLM 为首条消息生成语义标题；失败时保留同步回退标题，不影响会话与运行。
 * 仅当当前标题仍是回退标题或默认标题时才会覆盖，不会覆盖用户手动命名。
 */
export async function generateSemanticSessionTitle(
  llm: import("./llm.js").LLMClient,
  sessionId: string,
  firstUserMessage: string,
  fallbackTitle: string,
): Promise<void> {
  try {
    const message = await llm.chat([
      { role: "system", content: "你是会话标题生成器。用不超过 20 个字概括用户请求的主题，只输出标题文本本身：不要引号、不要句号结尾、不要任何解释。" },
      { role: "user", content: firstUserMessage.slice(0, 2000) },
    ]);
    const title = (message.content ?? "").trim().replace(/^["‘“]+|["’”]+$/gu, "").slice(0, 50);
    if (!title) return;
    const current = getSessionInfo(sessionId);
    if (!current) return;
    if (current.title !== fallbackTitle && current.title !== "新对话") return;
    renameSession(sessionId, title);
  } catch {
    // 语义标题生成失败：保留回退标题
  }
}

// ===========================================
// Fork —— 从指定消息处分叉新会话
// ===========================================

/**
 * Fork：从源会话的指定消息处创建新会话，复制到该消息为止的所有消息
 * @param sourceSessionId 源会话 ID
 * @param upToMessageId 分叉点消息 ID（新会话包含此消息及之前的所有消息）
 * @param persona 新会话使用的 persona
 * @returns 新创建的会话
 */
export function forkSession(
  sourceSessionId: string,
  upToMessageId: number | null,
  persona: PersonaDefinition
): SessionRow {
  const sourceSession = getSession(sourceSessionId);
  if (!sourceSession) {
    throw new Error("源会话不存在");
  }

  const messages = upToMessageId
    ? getMessagesUpTo(sourceSessionId, upToMessageId)
    : getMessagesBySession(sourceSessionId);
  const forkMessageIds = new Set(messages.map(message => message.id));
  const attachmentBytes = listMessageAttachments(sourceSessionId)
    .filter(attachment => attachment.message_id !== null && forkMessageIds.has(attachment.message_id))
    .reduce((sum, attachment) => sum + attachment.size, 0);
  let registeredSessionId: string | null = null;
  try {
    return withTransaction(() => {
      const newSession = createSession(persona, `${sourceSession.title} (fork)`);
      registeredSessionId = newSession.id;
      assertAttachmentCapacity(newSession.id, attachmentBytes);
      for (const msg of messages) {
        const messageId = insertMessage({
          session_id: newSession.id,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          created_at: msg.created_at,
        });
        copyMessageAttachments(msg.id, newSession.id, messageId);
      }
      copyTasksForFork(sourceSessionId, newSession.id);
      for (const pin of getPinsBySession(sourceSessionId)) {
        insertPin(newSession.id, pin.content);
      }
      touchSession(newSession.id);
      return newSession;
    });
  } catch (error) {
    if (registeredSessionId) {
      linkIdentities.delete(registeredSessionId);
      unregisterSession(registeredSessionId);
    }
    throw error;
  }
}

export class SessionImportError extends Error {
  readonly code: string;
  readonly foundVersion: unknown;
  constructor(message: string, code: string, foundVersion?: unknown) {
    super(message);
    this.code = code;
    this.foundVersion = foundVersion;
    this.name = "SessionImportError";
  }
}

export class SessionExportError extends Error {
  readonly code = "SESSION_EXPORT_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "SessionExportError";
  }
}

const MAX_IMPORT_BYTES = 96 * 1024 * 1024;
const MAX_IMPORT_MESSAGES = 10_000;
const MAX_IMPORT_ATTACHMENTS = 10_000;
const MAX_IMPORT_PINS = 1_000;
const MAX_TITLE_LENGTH = 500;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_PIN_CONTENT_LENGTH = 100_000;
const MAX_TOOL_CALLS_LENGTH = 1_000_000;
const MAX_TOOL_CALLS_PER_MESSAGE = 100;
const MAX_TOOL_CALL_ID_LENGTH = 500;
const ALLOWED_ROLES = new Set(["user", "assistant", "tool"]);
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const allowedSet = new Set(allowed);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new SessionImportError(`导入对象字段无效: ${field}`, "INVALID_SESSION_EXPORT");
  }
}

function requireString(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new SessionImportError(`导入字段无效: ${field}`, "INVALID_SESSION_EXPORT");
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 100);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp)
    throw new SessionImportError(`导入时间无效: ${field}`, "INVALID_SESSION_EXPORT");
  return timestamp;
}

function validateToolCalls(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SessionImportError(`导入工具调用 JSON 无效: ${field}`, "INVALID_SESSION_EXPORT");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    throw new SessionImportError(`导入工具调用结构无效: ${field}`, "INVALID_SESSION_EXPORT");
  }
  const ids: string[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const call = parsed[index];
    if (!isRecord(call) || call.type !== "function" || !isRecord(call.function)) {
      throw new SessionImportError(`导入工具调用结构无效: ${field}[${index}]`, "INVALID_SESSION_EXPORT");
    }
    requireExactKeys(call, ["id", "type", "function"], `${field}[${index}]`);
    requireExactKeys(call.function, ["name", "arguments"], `${field}[${index}].function`);
    const id = requireString(call.id, `${field}[${index}].id`, MAX_TOOL_CALL_ID_LENGTH);
    if (ids.includes(id))
      throw new SessionImportError(`导入工具调用 ID 重复: ${field}[${index}]`, "INVALID_SESSION_EXPORT");
    ids.push(id);
    requireString(call.function.name, `${field}[${index}].function.name`, 256);
    const argumentsJson = requireString(call.function.arguments, `${field}[${index}].function.arguments`, MAX_TOOL_CALLS_LENGTH, true);
    try {
      const argumentsValue = JSON.parse(argumentsJson);
      if (!isRecord(argumentsValue)) throw new Error("arguments must be an object");
    } catch {
      throw new SessionImportError(`导入工具调用参数 JSON 无效: ${field}[${index}]`, "INVALID_SESSION_EXPORT");
    }
  }
  return ids;
}

function normalizeMessages(value: unknown, exportedSessionId: string) {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_MESSAGES) {
    throw new SessionImportError(`导入消息数量无效，最多支持 ${MAX_IMPORT_MESSAGES} 条`, "INVALID_SESSION_EXPORT");
  }
  const messages = value.map((raw: Record<string, unknown>, index: number) => {
    if (!isRecord(raw)) throw new SessionImportError(`导入消息无效: messages[${index}]`, "INVALID_SESSION_EXPORT");
    requireExactKeys(raw, ["id", "session_id", "role", "content", "tool_calls", "tool_call_id", "created_at"], `messages[${index}]`);
    if (!Number.isInteger(raw.id) || Number(raw.id) < 1)
      throw new SessionImportError(`导入消息 ID 无效: messages[${index}].id`, "INVALID_SESSION_EXPORT");
    const messageSessionId = requireString(raw.session_id, `messages[${index}].session_id`, 200);
    if (messageSessionId !== exportedSessionId)
      throw new SessionImportError(`导入消息会话 ID 不匹配: messages[${index}]`, "INVALID_SESSION_EXPORT");
    const role = requireString(raw.role, `messages[${index}].role`, 32);
    if (!ALLOWED_ROLES.has(role))
      throw new SessionImportError(`导入消息角色无效: ${role}`, "INVALID_SESSION_EXPORT");
    const content = requireString(raw.content, `messages[${index}].content`, MAX_CONTENT_LENGTH, true);
    let toolCalls: string | null = null;
    let declaredToolCallIds: string[] = [];
    if (raw.tool_calls !== null && raw.tool_calls !== undefined) {
      if (role !== "assistant")
        throw new SessionImportError(`只有 assistant 消息可包含 tool_calls: messages[${index}]`, "INVALID_SESSION_EXPORT");
      toolCalls = requireString(raw.tool_calls, `messages[${index}].tool_calls`, MAX_TOOL_CALLS_LENGTH);
      declaredToolCallIds = validateToolCalls(toolCalls, `messages[${index}].tool_calls`);
    }
    const toolCallId = raw.tool_call_id === null || raw.tool_call_id === undefined
      ? null
      : requireString(raw.tool_call_id, `messages[${index}].tool_call_id`, MAX_TOOL_CALL_ID_LENGTH);
    if (toolCallId !== null && role !== "tool")
      throw new SessionImportError(`只有 tool 消息可包含 tool_call_id: messages[${index}]`, "INVALID_SESSION_EXPORT");
    if (role === "tool" && toolCallId === null)
      throw new SessionImportError(`tool 消息缺少 tool_call_id: messages[${index}]`, "INVALID_SESSION_EXPORT");
    return {
      source_id: Number(raw.id),
      role,
      content,
      tool_calls: toolCalls,
      tool_call_id: toolCallId,
      created_at: requireTimestamp(raw.created_at, `messages[${index}].created_at`),
      declaredToolCallIds,
    };
  });
  const declared = new Set<string>();
  let pending = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.tool_call_id !== null) {
      if (!pending.delete(message.tool_call_id)) {
        throw new SessionImportError(`导入 tool_call_id 未引用当前 assistant 调用: messages[${index}]`, "INVALID_SESSION_EXPORT");
      }
      continue;
    }
    if (pending.size > 0) {
      throw new SessionImportError(`导入 assistant 工具调用缺少连续 tool 结果: messages[${index}]`, "INVALID_SESSION_EXPORT");
    }
    for (const id of message.declaredToolCallIds) {
      if (declared.has(id))
        throw new SessionImportError(`导入工具调用 ID 跨消息重复: messages[${index}]`, "INVALID_SESSION_EXPORT");
      declared.add(id);
      pending.add(id);
    }
  }
  if (pending.size > 0) {
    throw new SessionImportError("导入 assistant 工具调用缺少 tool 结果", "INVALID_SESSION_EXPORT");
  }
  return messages;
}

interface AttachmentTransferSnapshot {
  readonly id: string;
  readonly messageId: number | null;
  readonly state: "ready" | "failed" | "cancelled";
  readonly kind: "image" | "text";
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly contentBase64: string | null;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface NormalizedAttachmentTransfer extends Omit<AttachmentTransferSnapshot, "contentBase64"> {
  readonly content: Buffer | null;
}

function normalizeAttachments(
  value: unknown,
  messages: readonly Readonly<{ source_id: number; role: string }>[],
): readonly NormalizedAttachmentTransfer[] {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_ATTACHMENTS) {
    throw new SessionImportError(`导入附件数量无效，最多支持 ${MAX_IMPORT_ATTACHMENTS} 个`, "INVALID_SESSION_EXPORT");
  }
  const messageRoles = new Map(messages.map(message => [message.source_id, message.role]));
  const messageCounts = new Map<number, number>();
  const draftIdentities = new Set<string>();
  const ids = new Set<string>();
  return Object.freeze(value.map((raw, index) => {
    if (!isRecord(raw)) throw new SessionImportError(`导入附件无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    requireExactKeys(raw, ["id", "messageId", "state", "kind", "name", "mime", "size", "sha256", "contentBase64", "errorCode", "createdAt", "updatedAt"], `canvas.attachments[${index}]`);
    let id: string;
    try { id = validateAttachmentId(raw.id); }
    catch { throw new SessionImportError(`导入附件 ID 无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT"); }
    if (ids.has(id)) throw new SessionImportError(`导入附件 ID 重复: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    ids.add(id);
    const state = raw.state;
    if (state !== "ready" && state !== "failed" && state !== "cancelled") {
      throw new SessionImportError(`导入附件状态无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    }
    let metadata;
    try { metadata = validateAttachmentUploadMetadata({ name: raw.name, mime: raw.mime, size: raw.size }); }
    catch (error) { throw new SessionImportError(error instanceof Error ? error.message : String(error), "INVALID_SESSION_EXPORT"); }
    if (raw.kind !== metadata.kind) throw new SessionImportError(`导入附件类型无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    const messageId = raw.messageId === null ? null : Number(raw.messageId);
    if (messageId !== null && (!Number.isSafeInteger(messageId) || messageRoles.get(messageId) !== "user" || state !== "ready")) {
      throw new SessionImportError(`导入附件消息关联无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    }
    if (messageId !== null) {
      const count = (messageCounts.get(messageId) ?? 0) + 1;
      if (count > MAX_ATTACHMENTS_PER_MESSAGE) throw new SessionImportError(`导入消息附件过多: ${messageId}`, "INVALID_SESSION_EXPORT");
      messageCounts.set(messageId, count);
    }
    const createdAt = Number(raw.createdAt);
    const updatedAt = Number(raw.updatedAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt) {
      throw new SessionImportError(`导入附件时间无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    }
    if (state === "ready") {
      const sha256 = requireString(raw.sha256, `canvas.attachments[${index}].sha256`, 64);
      const contentBase64 = requireString(raw.contentBase64, `canvas.attachments[${index}].contentBase64`, 12 * 1024 * 1024);
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(contentBase64)) throw new SessionImportError(`导入附件 Base64 无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
      const content = Buffer.from(contentBase64, "base64");
      if (content.toString("base64") !== contentBase64) throw new SessionImportError(`导入附件 Base64 非 canonical: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
      let validated;
      try { validated = validateAttachmentContent(metadata, content); }
      catch (error) { throw new SessionImportError(error instanceof Error ? error.message : String(error), "INVALID_SESSION_EXPORT"); }
      if (validated.sha256 !== sha256 || raw.errorCode !== null) throw new SessionImportError(`导入附件摘要无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
      if (messageId === null) {
        const identity = `${metadata.name}\0${sha256}`;
        if (draftIdentities.has(identity)) throw new SessionImportError(`导入草稿附件重复: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
        draftIdentities.add(identity);
      }
      return Object.freeze({ id, messageId, state, ...metadata, sha256, content, errorCode: null, createdAt, updatedAt });
    }
    if (messageId !== null || raw.sha256 !== null || raw.contentBase64 !== null
      || typeof raw.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.errorCode)) {
      throw new SessionImportError(`导入终态附件无效: canvas.attachments[${index}]`, "INVALID_SESSION_EXPORT");
    }
    return Object.freeze({ id, messageId: null, state, ...metadata, sha256: null, content: null, errorCode: raw.errorCode, createdAt, updatedAt });
  }));
}

interface PinTransferSnapshot {
  readonly content: string;
  readonly createdAt: string;
}

function normalizeCanvas(
  value: unknown,
  enabled: boolean,
  messages: readonly Readonly<{ source_id: number; role: string }>[],
): {
  readonly pins: readonly PinTransferSnapshot[];
  readonly tasks: readonly TaskTransferSnapshot[];
  readonly attachments: readonly NormalizedAttachmentTransfer[];
} {
  if (!enabled) return { pins: Object.freeze([]), tasks: Object.freeze([]), attachments: Object.freeze([]) };
  if (!isRecord(value)) throw new SessionImportError("导入 Canvas 无效", "INVALID_SESSION_EXPORT");
  requireExactKeys(value, ["pins", "tasks", "attachments"], "canvas");
  if (!Array.isArray(value.pins) || value.pins.length > MAX_IMPORT_PINS) {
    throw new SessionImportError(`导入 Pin 数量无效，最多支持 ${MAX_IMPORT_PINS} 条`, "INVALID_SESSION_EXPORT");
  }
  const pins = value.pins.map((entry, index) => {
    if (!isRecord(entry)) throw new SessionImportError(`导入 Pin 无效: canvas.pins[${index}]`, "INVALID_SESSION_EXPORT");
    requireExactKeys(entry, ["content", "createdAt"], `canvas.pins[${index}]`);
    return Object.freeze({
      content: requireString(entry.content, `canvas.pins[${index}].content`, MAX_PIN_CONTENT_LENGTH),
      createdAt: requireTimestamp(entry.createdAt, `canvas.pins[${index}].createdAt`),
    });
  });
  const attachments = normalizeAttachments(value.attachments, messages);
  let tasks: readonly TaskTransferSnapshot[];
  try {
    tasks = normalizeTaskTransfer(value.tasks);
  } catch (error) {
    throw new SessionImportError(error instanceof Error ? error.message : String(error), "INVALID_SESSION_EXPORT");
  }
  return { pins: Object.freeze(pins), tasks, attachments };
}

/** 验证并将 legacy 1.0、current v1 或 current v2 归一化到当前格式。 */
export function normalizeSessionImport(input: unknown) {
  let serialized: string;
  try {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string") throw new Error("not serializable");
    serialized = encoded;
  } catch { throw new SessionImportError("导入数据不是可序列化 JSON", "INVALID_SESSION_EXPORT"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_IMPORT_BYTES) {
    throw new SessionImportError(`导入数据超过 ${MAX_IMPORT_BYTES} 字节上限`, "INVALID_SESSION_EXPORT");
  }
  let data: unknown;
  try { data = JSON.parse(serialized); }
  catch { throw new SessionImportError("导入数据不是有效 JSON", "INVALID_SESSION_EXPORT"); }
  if (!isRecord(data)) throw new SessionImportError("导入数据必须是对象", "INVALID_SESSION_EXPORT");
  const isCurrent = data.format === "mini-lux-session";
  const isLegacy = data.version === "1.0" && data.format === undefined && data.formatVersion === undefined;
  if (isCurrent && (data.version !== undefined || data.exported_at !== undefined)) {
    throw new SessionImportError("会话导出包含冲突的 current/legacy 标记", "UNSUPPORTED_SESSION_EXPORT", data.version);
  }
  if (!isCurrent && !isLegacy) {
    const found = data.formatVersion ?? data.version ?? data.format;
    throw new SessionImportError("无法识别的会话导出格式", "UNSUPPORTED_SESSION_EXPORT", found);
  }
  const currentVersion = isCurrent ? data.formatVersion : null;
  if (isCurrent && currentVersion !== 1 && currentVersion !== SESSION_EXPORT_VERSION) {
    throw new SessionImportError(`会话导出版本不兼容: 当前 ${String(data.formatVersion)}，支持 1..${SESSION_EXPORT_VERSION}`, "UNSUPPORTED_SESSION_EXPORT", data.formatVersion);
  }
  const hasCanvas = isCurrent && currentVersion === SESSION_EXPORT_VERSION;
  requireExactKeys(
    data,
    isCurrent
      ? hasCanvas
        ? ["format", "formatVersion", "producer", "exportedAt", "session", "messages", "canvas"]
        : ["format", "formatVersion", "producer", "exportedAt", "session", "messages"]
      : ["version", "exported_at", "session", "messages"],
    "root",
  );
  if (!isRecord(data.session)) throw new SessionImportError("导入会话信息无效", "INVALID_SESSION_EXPORT");
  requireExactKeys(data.session, ["id", "persona_name", "title", "created_at", "updated_at"], "session");
  if (isCurrent) {
    if (!isRecord(data.producer)) throw new SessionImportError("导出生产者信息无效", "INVALID_SESSION_EXPORT");
    requireExactKeys(data.producer, ["appVersion", "buildId"], "producer");
    const producerVersion = requireString(data.producer.appVersion, "producer.appVersion", 100);
    const producerBuildId = requireString(data.producer.buildId, "producer.buildId", 128);
    if (!APP_VERSION_PATTERN.test(producerVersion) || !BUILD_ID_PATTERN.test(producerBuildId)) {
      throw new SessionImportError("导出生产者版本信息无效", "INVALID_SESSION_EXPORT");
    }
    requireTimestamp(data.exportedAt, "exportedAt");
  } else {
    requireTimestamp(data.exported_at, "exported_at");
  }
  const exportedSessionId = requireString(data.session.id, "session.id", 200);
  requireString(data.session.persona_name, "session.persona_name", 200);
  const title = requireString(data.session.title, "session.title", MAX_TITLE_LENGTH);
  requireTimestamp(data.session.created_at, "session.created_at");
  requireTimestamp(data.session.updated_at, "session.updated_at");
  const messages = normalizeMessages(data.messages, exportedSessionId);
  const canvas = normalizeCanvas(data.canvas, hasCanvas, messages);
  return {
    title,
    messages,
    pins: canvas.pins,
    tasks: canvas.tasks,
    attachments: canvas.attachments,
  };
}

function exportAttachment(row: AttachmentRow): AttachmentTransferSnapshot {
  if (row.state === "ready") {
    if (!row.sha256 || !row.content) throw new SessionExportError(`附件内容不可用: ${row.id}`);
    let validated;
    try { validated = validateAttachmentContent({ name: row.name, mime: row.mime, size: row.size, kind: row.kind }, row.content); }
    catch (error) { throw new SessionExportError(error instanceof Error ? error.message : `附件内容不可用: ${row.id}`); }
    if (validated.sha256 !== row.sha256) throw new SessionExportError(`附件摘要不匹配: ${row.id}`);
    return Object.freeze({
      id: row.id,
      messageId: row.message_id,
      state: "ready",
      kind: row.kind,
      name: row.name,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      contentBase64: row.content.toString("base64"),
      errorCode: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return Object.freeze({
    id: row.id,
    messageId: null,
    state: row.state === "cancelled" ? "cancelled" : "failed",
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: null,
    contentBase64: null,
    errorCode: row.error_code ?? "UPLOAD_INTERRUPTED",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export interface ExportData {
  format: "mini-lux-session";
  formatVersion: number;
  producer: {
    appVersion: string;
    buildId: string;
  };
  exportedAt: string;
  session: {
    id: string;
    persona_name: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  messages: MessageRow[];
  canvas: {
    pins: PinTransferSnapshot[];
    tasks: readonly TaskTransferSnapshot[];
    attachments: readonly AttachmentTransferSnapshot[];
  };
}

/** Validate a serialized Session snapshot without importing or mutating database state. */
export function validateSessionExportData(value: unknown): void {
  normalizeSessionImport(value);
}

/** 导出会话为当前可序列化格式。 */
export function exportSession(sessionId: string): ExportData | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const exported: ExportData = {
    format: "mini-lux-session",
    formatVersion: SESSION_EXPORT_VERSION,
    producer: { appVersion: APP_VERSION, buildId: BUILD_ID },
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      persona_name: session.persona_name,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
    },
    messages: getMessagesBySession(sessionId),
    canvas: {
      pins: getPinsBySession(sessionId).map(pin => ({ content: pin.content, createdAt: pin.created_at })),
      tasks: exportTaskTransfer(sessionId),
      attachments: [...listDraftAttachments(sessionId), ...listMessageAttachments(sessionId)]
        .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
        .map(exportAttachment),
    },
  };
  try {
    normalizeSessionImport(exported);
  } catch (error) {
    throw new SessionExportError(error instanceof Error ? `会话无法安全导出: ${error.message}` : "会话无法安全导出");
  }
  return exported;
}

/** 验证完整导入数据后，在单一事务中创建新会话和消息。 */
export function importSession(data: unknown, persona: PersonaDefinition): SessionRow {
  const normalized = normalizeSessionImport(data);
  let registeredSessionId: string | null = null;
  try {
    return withTransaction(() => {
      const newSession = createSession(persona, normalized.title || "导入的对话");
      registeredSessionId = newSession.id;
      assertAttachmentCapacity(newSession.id, normalized.attachments.reduce((sum, attachment) =>
        sum + (attachment.state === "ready" ? attachment.size : 0), 0));
      const importedMessageIds = new Map<number, number>();
      for (const msg of normalized.messages) {
        const messageId = insertMessage({
          session_id: newSession.id,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          created_at: msg.created_at,
        });
        importedMessageIds.set(msg.source_id, messageId);
      }
      for (const attachment of normalized.attachments) {
        const messageId = attachment.messageId === null ? null : importedMessageIds.get(attachment.messageId);
        if (attachment.messageId !== null && messageId === undefined) throw new SessionImportError("导入附件消息映射无效", "INVALID_SESSION_EXPORT");
        insertImportedAttachment({
          sessionId: newSession.id,
          messageId: messageId ?? null,
          state: attachment.state,
          kind: attachment.kind,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          sha256: attachment.sha256,
          content: attachment.content,
          errorCode: attachment.errorCode,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        });
      }
      for (const pin of normalized.pins) insertPin(newSession.id, pin.content, pin.createdAt);
      restoreTaskTransfer(newSession.id, normalized.tasks);
      touchSession(newSession.id);
      return newSession;
    });
  } catch (error) {
    if (registeredSessionId) {
      linkIdentities.delete(registeredSessionId);
      unregisterSession(registeredSessionId);
    }
    throw error;
  }
}

// ===========================================
// 跨会话搜索
// ===========================================

export function searchSessions(query: string, limit: number = 50): SearchResultRow[] {
  return searchAcrossSessions(query, limit);
}
