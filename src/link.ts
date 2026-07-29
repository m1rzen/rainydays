// ===========================================
// Link —— 多 Session 通信
// Session 注册表 + 消息队列
// ===========================================

import { PROTOCOL_CAPABILITIES } from "./version.js";

export interface SessionInfo {
  id: string;
  name: string;
  status: "idle" | "running" | "error";
  lastActivity: number;
}

export interface SessionMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

export interface LinkEnvelope {
  protocol: "mini-lux-link";
  version: number;
  message: SessionMessage;
}

const sessions = new Map<string, SessionInfo>();
const messageQueues = new Map<string, SessionMessage[]>();
const messageCallbacks = new Map<string, Set<(msg: SessionMessage) => void>>();
const senderCapabilities = new Map<string, symbol>();

export interface LinkIdentity {
  readonly sessionId: string;
  readonly capability: symbol;
}

/** 注册 session；能力由 Session 生命周期生成并且绝不从 Link 注册表返回。 */
export function registerSession(id: string, name: string, capability: unknown): boolean {
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || typeof capability !== "symbol") return false;
  const existing = sessions.get(id);
  const existingCapability = senderCapabilities.get(id);
  if (existingCapability && existingCapability !== capability) return false;
  sessions.set(id, {
    id,
    name,
    status: existing?.status || "idle",
    lastActivity: Date.now(),
  });
  if (!messageQueues.has(id)) messageQueues.set(id, []);
  senderCapabilities.set(id, capability);
  return true;
}

/** 更新 session 状态 */
export function updateSessionStatus(id: string, status: SessionInfo["status"]): void {
  const s = sessions.get(id);
  if (s) { s.status = status; s.lastActivity = Date.now(); }
}

/** 列出所有 session */
export function discoverSessions(): SessionInfo[] {
  return Array.from(sessions.values()).sort((a, b) => b.lastActivity - a.lastActivity);
}

/** 查看 session 状态 */
export function peekSession(id: string): SessionInfo | undefined {
  return sessions.get(id);
}

/** 验证拥有私有会话能力的内部 envelope 后投递。 */
function deliverLinkEnvelope(identity: unknown, envelope: unknown): boolean {
  const link = PROTOCOL_CAPABILITIES.link;
  if (!identity || typeof identity !== "object" || typeof (identity as Partial<LinkIdentity>).sessionId !== "string"
    || (identity as Partial<LinkIdentity>).sessionId!.length === 0 || typeof (identity as Partial<LinkIdentity>).capability !== "symbol") return false;
  const verifiedIdentity = identity as LinkIdentity;
  if (!envelope || typeof envelope !== "object") return false;
  const candidate = envelope as Partial<LinkEnvelope>;
  if (senderCapabilities.get(verifiedIdentity.sessionId) !== verifiedIdentity.capability) return false;
  if (!link.enabled || link.version === null || candidate.protocol !== "mini-lux-link" || candidate.version !== link.version) return false;
  const msg = candidate.message;
  if (!msg || typeof msg.from !== "string" || msg.from !== verifiedIdentity.sessionId || typeof msg.to !== "string" || typeof msg.content !== "string" || !Number.isFinite(msg.timestamp)) return false;
  const target = sessions.get(msg.to);
  if (!target) return false;
  const queue = messageQueues.get(msg.to);
  if (queue) queue.push(msg);
  const callbacks = messageCallbacks.get(msg.to);
  if (callbacks) for (const cb of callbacks) cb(msg);
  return true;
}

/** 仅接受会话生命周期持有的身份能力，不能通过裸 Session ID 冒充来源。 */
export function postFromSession(identity: unknown, to: string, content: string): boolean {
  const version = PROTOCOL_CAPABILITIES.link.version;
  if (version === null) return false;
  if (!identity || typeof identity !== "object" || typeof (identity as Partial<LinkIdentity>).sessionId !== "string") return false;
  return deliverLinkEnvelope(identity, {
    protocol: "mini-lux-link",
    version,
    message: { from: (identity as LinkIdentity).sessionId, to, content, timestamp: Date.now() },
  });
}

/** 获取 session 的消息队列 */
export function getMessages(sessionId: string): SessionMessage[] {
  const queue = messageQueues.get(sessionId);
  if (!queue) return [];
  const msgs = [...queue];
  queue.length = 0; // 清空队列
  return msgs;
}

/** 注册消息回调 */
export function onMessage(sessionId: string, cb: (msg: SessionMessage) => void): () => void {
  if (!messageCallbacks.has(sessionId)) messageCallbacks.set(sessionId, new Set());
  messageCallbacks.get(sessionId)!.add(cb);
  return () => messageCallbacks.get(sessionId)?.delete(cb);
}

/** 注销 session */
export function unregisterSession(id: string): void {
  sessions.delete(id);
  messageQueues.delete(id);
  messageCallbacks.delete(id);
  senderCapabilities.delete(id);
}
