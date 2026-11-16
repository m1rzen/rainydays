import path from "node:path";
import type { Message } from "./types.js";

export interface DocumentOutput {
  readonly path: string;
  readonly name: string;
  readonly format: string;
  readonly createdAt: string;
  /** document = create_docx/create_xlsx；deliverable/intermediate/source = register_output 显式登记的类别。 */
  readonly kind: "document" | "deliverable" | "intermediate" | "source";
  readonly bytes?: number;
  readonly sha256?: string;
}

function outputKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

/** Derive the list from persisted, successful document/registration tool receipts, never assistant prose. */
export function collectDocumentOutputs(messages: readonly (Message & { created_at?: string })[]): DocumentOutput[] {
  const pending = new Map<string, string>();
  const outputs = new Map<string, DocumentOutput>();
  for (const message of messages) {
    if (message.role === "assistant") {
      pending.clear();
      for (const call of message.tool_calls ?? []) pending.set(call.id, call.function.name);
    }
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const tool = pending.get(message.tool_call_id);
    pending.delete(message.tool_call_id);
    try {
      const outcome = JSON.parse(message.content);
      if (outcome.status !== "success" || outcome.truncated) continue;
      const receipt = JSON.parse(outcome.content);
      const createdAt = message.created_at ?? "";
      if ((tool === "create_docx" || tool === "create_xlsx") && receipt.type === "document_output") {
        const format = tool === "create_docx" ? "docx" : "xlsx";
        if (receipt.format !== format || typeof receipt.path !== "string"
          || !path.isAbsolute(receipt.path) || path.extname(receipt.path).toLowerCase() !== `.${format}`) continue;
        const key = outputKey(receipt.path);
        outputs.delete(key);
        outputs.set(key, { path: receipt.path, name: path.basename(receipt.path), format, createdAt, kind: "document" });
        continue;
      }
      if (receipt.type === "artifact_registration" && typeof receipt.path === "string" && path.isAbsolute(receipt.path)
        && (receipt.kind === "deliverable" || receipt.kind === "intermediate" || receipt.kind === "source")) {
        const key = outputKey(receipt.path);
        outputs.delete(key);
        outputs.set(key, {
          path: receipt.path,
          name: path.basename(receipt.path),
          format: typeof receipt.format === "string" ? receipt.format : "unknown",
          createdAt,
          kind: receipt.kind,
          ...(Number.isSafeInteger(receipt.bytes) ? { bytes: receipt.bytes } : {}),
          ...(typeof receipt.sha256 === "string" ? { sha256: receipt.sha256 } : {}),
        });
      }
    } catch {
      // Older tool responses and malformed receipts are not document outputs.
    }
  }
  return [...outputs.values()].reverse();
}
