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
  updateSessionTitle,
  getMessagesBySession,
  getMessagesUpTo,
  insertMessage,
  searchAcrossSessions,
  type SessionRow,
  type MessageRow,
  type SearchResultRow,
  withTransaction,
} from "./db.js";
import { APP_VERSION, BUILD_ID, SESSION_EXPORT_VERSION } from "./version.js";
import { registerSession, unregisterSession, postFromSession, type LinkIdentity } from "./link.js";

const linkIdentities = new Map<string, LinkIdentity>();

/** 将持久 Session 绑定到本进程私有的 Link 投递能力。 */
export function ensureSessionLinkRegistration(id: string, title: string): void {
  const identity = linkIdentities.get(id) || Object.freeze({ sessionId: id, capability: Symbol(`mini-lux-link:${id}`) });
  if (!registerSession(id, title, identity.capability)) throw new Error(`Link Session 身份冲突: ${id}`);
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
  const session: SessionRow = {
    id: crypto.randomUUID(),
    persona_name: persona.name,
    title: title || "新对话",
    created_at: now,
    updated_at: now,
  };

  insertSession(session);
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
export function loadSessionMessages(sessionId: string): Message[] {
  const rows = getMessagesBySession(sessionId);

  return rows.map((row) => {
    const msg: Message = {
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
    renameSession(sessionId, title + (firstUserMessage.length > 30 ? "..." : ""));
  }
  return title;
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
  let registeredSessionId: string | null = null;
  try {
    return withTransaction(() => {
      const newSession = createSession(persona, `${sourceSession.title} (fork)`);
      registeredSessionId = newSession.id;
      for (const msg of messages) {
        insertMessage({
          session_id: newSession.id,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          created_at: msg.created_at,
        });
      }
      touchSession(newSession.id);
      return newSession;
    });
  } catch (error) {
    if (registeredSessionId) unregisterSession(registeredSessionId);
    throw error;
  }
}

// ===========================================
// 导出 / 导入
// ===========================================

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
}

interface NormalizedImport {
  title: string;
  messages: Array<{
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    created_at: string;
    declaredToolCallIds: string[];
  }>;
}

export class SessionImportError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly foundVersion?: unknown,
  ) {
    super(message);
    this.name = "SessionImportError";
  }
}

const MAX_IMPORT_MESSAGES = 10_000;
const MAX_TITLE_LENGTH = 500;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_TOOL_CALLS_LENGTH = 1_000_000;
const MAX_TOOL_CALLS_PER_MESSAGE = 100;
const MAX_TOOL_CALL_ID_LENGTH = 500;
const ALLOWED_ROLES = new Set(["user", "assistant", "tool"]);
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
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
  if (Number.isNaN(Date.parse(timestamp))) throw new SessionImportError(`导入时间无效: ${field}`, "INVALID_SESSION_EXPORT");
  return timestamp;
}

function validateToolCalls(value: string, field: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new SessionImportError(`导入工具调用 JSON 无效: ${field}`, "INVALID_SESSION_EXPORT"); }
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
    if (ids.includes(id)) throw new SessionImportError(`导入工具调用 ID 重复: ${field}[${index}]`, "INVALID_SESSION_EXPORT");
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

function normalizeMessages(value: unknown, exportedSessionId: string): NormalizedImport["messages"] {
  if (!Array.isArray(value) || value.length > MAX_IMPORT_MESSAGES) {
    throw new SessionImportError(`导入消息数量无效，最多支持 ${MAX_IMPORT_MESSAGES} 条`, "INVALID_SESSION_EXPORT");
  }
  const messages = value.map((raw, index) => {
    if (!isRecord(raw)) throw new SessionImportError(`导入消息无效: messages[${index}]`, "INVALID_SESSION_EXPORT");
    requireExactKeys(raw, ["id", "session_id", "role", "content", "tool_calls", "tool_call_id", "created_at"], `messages[${index}]`);
    if (!Number.isInteger(raw.id) || Number(raw.id) < 1) throw new SessionImportError(`导入消息 ID 无效: messages[${index}].id`, "INVALID_SESSION_EXPORT");
    const messageSessionId = requireString(raw.session_id, `messages[${index}].session_id`, 200);
    if (messageSessionId !== exportedSessionId) throw new SessionImportError(`导入消息会话 ID 不匹配: messages[${index}]`, "INVALID_SESSION_EXPORT");
    const role = requireString(raw.role, `messages[${index}].role`, 32);
    if (!ALLOWED_ROLES.has(role)) throw new SessionImportError(`导入消息角色无效: ${role}`, "INVALID_SESSION_EXPORT");
    const content = requireString(raw.content, `messages[${index}].content`, MAX_CONTENT_LENGTH, true);
    let toolCalls: string | null = null;
    let declaredToolCallIds: string[] = [];
    if (raw.tool_calls !== null && raw.tool_calls !== undefined) {
      if (role !== "assistant") throw new SessionImportError(`只有 assistant 消息可包含 tool_calls: messages[${index}]`, "INVALID_SESSION_EXPORT");
      toolCalls = requireString(raw.tool_calls, `messages[${index}].tool_calls`, MAX_TOOL_CALLS_LENGTH);
      declaredToolCallIds = validateToolCalls(toolCalls, `messages[${index}].tool_calls`);
    }
    const toolCallId = raw.tool_call_id === null || raw.tool_call_id === undefined
      ? null
      : requireString(raw.tool_call_id, `messages[${index}].tool_call_id`, MAX_TOOL_CALL_ID_LENGTH);
    if (toolCallId !== null && role !== "tool") throw new SessionImportError(`只有 tool 消息可包含 tool_call_id: messages[${index}]`, "INVALID_SESSION_EXPORT");
    if (role === "tool" && toolCallId === null) throw new SessionImportError(`tool 消息缺少 tool_call_id: messages[${index}]`, "INVALID_SESSION_EXPORT");
    return {
      role,
      content,
      tool_calls: toolCalls,
      tool_call_id: toolCallId,
      created_at: requireTimestamp(raw.created_at, `messages[${index}].created_at`),
      declaredToolCallIds,
    };
  });
  const declared = new Set<string>();
  const consumed = new Set<string>();
  for (const [index, message] of messages.entries()) {
    for (const id of message.declaredToolCallIds) {
      if (declared.has(id)) throw new SessionImportError(`导入工具调用 ID 跨消息重复: messages[${index}]`, "INVALID_SESSION_EXPORT");
      declared.add(id);
    }
    if (message.tool_call_id !== null) {
      if (!declared.has(message.tool_call_id) || consumed.has(message.tool_call_id)) {
        throw new SessionImportError(`导入 tool_call_id 未引用此前 assistant 调用: messages[${index}]`, "INVALID_SESSION_EXPORT");
      }
      consumed.add(message.tool_call_id);
    }
  }
  if (declared.size !== consumed.size) {
    throw new SessionImportError("导入 assistant 工具调用缺少 tool 结果", "INVALID_SESSION_EXPORT");
  }
  return messages;
}

/** 验证并将当前或旧版导出格式归一化到 formatVersion 1。 */
export function normalizeSessionImport(data: unknown): NormalizedImport {
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
  if (isCurrent && data.formatVersion !== SESSION_EXPORT_VERSION) {
    throw new SessionImportError(
      `会话导出版本不兼容: 当前 ${String(data.formatVersion)}，支持 ${SESSION_EXPORT_VERSION}`,
      "UNSUPPORTED_SESSION_EXPORT",
      data.formatVersion,
    );
  }
  requireExactKeys(
    data,
    isCurrent
      ? ["format", "formatVersion", "producer", "exportedAt", "session", "messages"]
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
  return {
    title,
    messages: normalizeMessages(data.messages, exportedSessionId),
  };
}

/** 导出会话为当前可序列化格式。 */
export function exportSession(sessionId: string): ExportData | null {
  const session = getSession(sessionId);
  if (!session) return null;
  return {
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
  };
}

/** 验证完整导入数据后，在单一事务中创建新会话和消息。 */
export function importSession(data: unknown, persona: PersonaDefinition): SessionRow {
  const normalized = normalizeSessionImport(data);
  let registeredSessionId: string | null = null;
  try {
    return withTransaction(() => {
      const newSession = createSession(persona, normalized.title || "导入的对话");
      registeredSessionId = newSession.id;
      for (const msg of normalized.messages) {
        insertMessage({
          session_id: newSession.id,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          created_at: msg.created_at,
        });
      }
      touchSession(newSession.id);
      return newSession;
    });
  } catch (error) {
    if (registeredSessionId) unregisterSession(registeredSessionId);
    throw error;
  }
}

// ===========================================
// 跨会话搜索
// ===========================================

export function searchSessions(query: string, limit: number = 50): SearchResultRow[] {
  return searchAcrossSessions(query, limit);
}
