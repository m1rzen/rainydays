import { createHash } from "node:crypto";
import {
  attachReadyArtifactsToMessage,
  completeAttachmentUpload,
  deleteDraftAttachment,
  deleteExpiredTerminalAttachments,
  failInterruptedAttachmentUploads,
  finishAttachmentUploadWithError,
  getAttachmentBySession,
  getAttachmentUsageBytes,
  getSession,
  listDraftAttachments,
  listMessageAttachments,
  pruneTerminalAttachments,
  reserveAttachmentUpload,
  withTransaction,
  type AttachmentRow,
} from "./db.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DRAFT_ATTACHMENT_BYTES,
  validateAttachmentContent,
  validateAttachmentId,
  validateAttachmentIds,
  validateAttachmentUploadMetadata,
  type AttachmentState,
} from "./attachment.js";
import type { MessageAttachment } from "./types.js";

const MAX_DRAFT_ROWS = 32;
const TERMINAL_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_GLOBAL_ATTACHMENT_BYTES = 128 * 1024 * 1024;

export class AttachmentStoreError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "AttachmentStoreError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface PublicAttachment extends MessageAttachment {
  readonly state: AttachmentState;
  readonly errorCode: string | null;
  readonly messageId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function publicAttachment(row: AttachmentRow): PublicAttachment {
  return Object.freeze({
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256 ?? "",
    kind: row.kind,
    state: row.state,
    errorCode: row.error_code,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function messageAttachment(row: AttachmentRow): MessageAttachment {
  if (row.state !== "ready" || !row.sha256 || !row.content || row.content.length !== row.size
    || createHash("sha256").update(row.content).digest("hex") !== row.sha256) {
    throw new AttachmentStoreError("ATTACHMENT_NOT_READY", "Attachment content is unavailable", 409);
  }
  try {
    validateAttachmentContent({ name: row.name, mime: row.mime, size: row.size, kind: row.kind }, row.content);
  } catch {
    throw new AttachmentStoreError("ATTACHMENT_CORRUPT", "Attachment content verification failed", 409);
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    kind: row.kind,
  });
}

function requireSession(sessionId: string): void {
  if (typeof sessionId !== "string" || !sessionId || !getSession(sessionId)) {
    throw new AttachmentStoreError("ATTACHMENT_SESSION_NOT_FOUND", "Attachment Session does not exist", 404);
  }
}

function isDuplicateConstraint(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "SQLITE_CONSTRAINT_UNIQUE" || /idx_attachments_draft_duplicate/iu.test(candidate?.message ?? "");
}

export function recoverInterruptedAttachments(): number {
  deleteExpiredTerminalAttachments(Date.now() - TERMINAL_ATTACHMENT_RETENTION_MS);
  return failInterruptedAttachmentUploads();
}

export function assertAttachmentCapacity(sessionId: string, additionalBytes: number): void {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new TypeError("Attachment capacity request is invalid");
  if (getAttachmentUsageBytes(sessionId) + additionalBytes > MAX_SESSION_ATTACHMENT_BYTES) {
    throw new AttachmentStoreError("ATTACHMENT_SESSION_QUOTA", "Session attachment quota exceeded", 413);
  }
  if (getAttachmentUsageBytes() + additionalBytes > MAX_GLOBAL_ATTACHMENT_BYTES) {
    throw new AttachmentStoreError("ATTACHMENT_GLOBAL_QUOTA", "Global attachment quota exceeded", 413);
  }
}

export function reserveAttachment(sessionId: string, input: unknown): PublicAttachment {
  requireSession(sessionId);
  const metadata = validateAttachmentUploadMetadata(input);
  return withTransaction(() => {
    deleteExpiredTerminalAttachments(Date.now() - TERMINAL_ATTACHMENT_RETENTION_MS);
    pruneTerminalAttachments(sessionId, 16);
    const drafts = listDraftAttachments(sessionId);
    const active = drafts.filter(row => row.state === "uploading" || row.state === "ready");
    if (drafts.length >= MAX_DRAFT_ROWS || active.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new AttachmentStoreError("ATTACHMENT_LIMIT_EXCEEDED", "Attachment count limit exceeded", 413);
    }
    const activeBytes = active.reduce((sum, row) => sum + row.size, 0);
    if (activeBytes + metadata.size > MAX_DRAFT_ATTACHMENT_BYTES) {
      throw new AttachmentStoreError("ATTACHMENT_TOTAL_TOO_LARGE", "Attachment draft byte limit exceeded", 413);
    }
    assertAttachmentCapacity(sessionId, metadata.size);
    return publicAttachment(reserveAttachmentUpload({ sessionId, ...metadata }));
  });
}

export function completeAttachment(sessionId: string, idValue: unknown, input: Uint8Array): PublicAttachment {
  requireSession(sessionId);
  const id = validateAttachmentId(idValue);
  const current = getAttachmentBySession(sessionId, id);
  if (!current) throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Attachment does not exist", 404);
  if (current.state !== "uploading" || current.message_id !== null) {
    throw new AttachmentStoreError("ATTACHMENT_STATE_CONFLICT", "Attachment upload state changed", 409);
  }
  let validated;
  try {
    validated = validateAttachmentContent({
      name: current.name,
      mime: current.mime,
      size: current.size,
      kind: current.kind,
    }, input);
  } catch (error) {
    finishAttachmentUploadWithError(sessionId, id, "failed", "INVALID_CONTENT");
    throw new AttachmentStoreError("ATTACHMENT_INVALID_CONTENT", error instanceof Error ? error.message : String(error), 422);
  }
  try {
    return withTransaction(() => {
      if (!completeAttachmentUpload(sessionId, id, validated.sha256, validated.bytes)) {
        throw new AttachmentStoreError("ATTACHMENT_STATE_CONFLICT", "Attachment upload state changed", 409);
      }
      return publicAttachment(getAttachmentBySession(sessionId, id)!);
    });
  } catch (error) {
    if (!isDuplicateConstraint(error)) throw error;
    finishAttachmentUploadWithError(sessionId, id, "failed", "DUPLICATE_ATTACHMENT");
    throw new AttachmentStoreError("ATTACHMENT_DUPLICATE", "An identical draft attachment already exists", 409);
  }
}

export function failAttachmentUpload(sessionId: string, idValue: unknown, errorCode = "UPLOAD_FAILED"): PublicAttachment {
  const id = validateAttachmentId(idValue);
  if (!finishAttachmentUploadWithError(sessionId, id, "failed", errorCode)) {
    throw new AttachmentStoreError("ATTACHMENT_STATE_CONFLICT", "Attachment upload state changed", 409);
  }
  return publicAttachment(getAttachmentBySession(sessionId, id)!);
}

export function cancelAttachmentUpload(sessionId: string, idValue: unknown): PublicAttachment {
  const id = validateAttachmentId(idValue);
  const current = getAttachmentBySession(sessionId, id);
  if (!current) throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Attachment does not exist", 404);
  if (current.state === "cancelled") return publicAttachment(current);
  if (!finishAttachmentUploadWithError(sessionId, id, "cancelled", "UPLOAD_CANCELLED")) {
    throw new AttachmentStoreError("ATTACHMENT_STATE_CONFLICT", "Attachment upload state changed", 409);
  }
  return publicAttachment(getAttachmentBySession(sessionId, id)!);
}

export function removeDraftAttachment(sessionId: string, idValue: unknown): void {
  const id = validateAttachmentId(idValue);
  if (!deleteDraftAttachment(sessionId, id)) {
    throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Draft attachment does not exist", 404);
  }
}

export function getDraftAttachments(sessionId: string): readonly PublicAttachment[] {
  requireSession(sessionId);
  return Object.freeze(listDraftAttachments(sessionId).map(publicAttachment));
}

export function getMessageAttachmentMap(sessionId: string): ReadonlyMap<number, readonly PublicAttachment[]> {
  requireSession(sessionId);
  const grouped = new Map<number, PublicAttachment[]>();
  for (const row of listMessageAttachments(sessionId)) {
    if (row.message_id === null) continue;
    const entries = grouped.get(row.message_id) ?? [];
    entries.push(publicAttachment(row));
    grouped.set(row.message_id, entries);
  }
  return new Map([...grouped].map(([messageId, entries]) => [messageId, Object.freeze(entries)]));
}

export function prepareMessageAttachments(sessionId: string, idsValue: unknown): readonly MessageAttachment[] {
  requireSession(sessionId);
  const ids = validateAttachmentIds(idsValue);
  return Object.freeze(ids.map(id => {
    const row = getAttachmentBySession(sessionId, id);
    if (!row || row.message_id !== null) throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Draft attachment does not exist", 404);
    return messageAttachment(row);
  }));
}

export function bindMessageAttachments(sessionId: string, messageId: number, attachments: readonly MessageAttachment[]): void {
  if (attachments.length === 0) return;
  const ids = validateAttachmentIds(attachments.map(attachment => attachment.id));
  const linked = attachReadyArtifactsToMessage(sessionId, messageId, ids);
  if (linked.length !== attachments.length) throw new AttachmentStoreError("ATTACHMENT_STATE_CONFLICT", "Attachment binding failed", 409);
  for (let index = 0; index < linked.length; index += 1) {
    const expected = attachments[index];
    const actual = messageAttachment(linked[index]);
    if (actual.id !== expected.id || actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.mime !== expected.mime) {
      throw new AttachmentStoreError("ATTACHMENT_IDENTITY_CHANGED", "Attachment identity changed before message binding", 409);
    }
  }
}

export function readMessageAttachmentForSession(
  sessionId: string,
  idValue: unknown,
): Readonly<{ attachment: MessageAttachment; bytes: Buffer }> {
  requireSession(sessionId);
  const id = validateAttachmentId(idValue);
  const row = getAttachmentBySession(sessionId, id);
  if (!row || row.message_id === null) throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Message attachment does not exist", 404);
  return Object.freeze({ attachment: messageAttachment(row), bytes: Buffer.from(row.content!) });
}

export function readAttachmentForSession(sessionId: string, idValue: unknown): Readonly<{ attachment: PublicAttachment; bytes: Buffer }> {
  const id = validateAttachmentId(idValue);
  const row = getAttachmentBySession(sessionId, id);
  if (!row || row.state !== "ready" || !row.content) throw new AttachmentStoreError("ATTACHMENT_NOT_FOUND", "Ready attachment does not exist", 404);
  messageAttachment(row);
  return Object.freeze({ attachment: publicAttachment(row), bytes: Buffer.from(row.content) });
}
