import path from "node:path";
import type { Message } from "./types.js";

export interface DocumentOutput {
  readonly path: string;
  readonly name: string;
  readonly format: "docx" | "xlsx";
  readonly createdAt: string;
}

/** Derive the list from persisted, successful document tool receipts, never assistant prose. */
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
    if (tool !== "create_docx" && tool !== "create_xlsx") continue;
    try {
      const outcome = JSON.parse(message.content);
      if (outcome.status !== "success" || outcome.truncated) continue;
      const receipt = JSON.parse(outcome.content);
      const format = tool === "create_docx" ? "docx" : "xlsx";
      if (receipt.type !== "document_output" || receipt.format !== format || typeof receipt.path !== "string"
        || !path.isAbsolute(receipt.path) || path.extname(receipt.path).toLowerCase() !== `.${format}`) continue;
      const key = process.platform === "win32" ? receipt.path.toLowerCase() : receipt.path;
      outputs.delete(key);
      outputs.set(key, { path: receipt.path, name: path.basename(receipt.path), format, createdAt: message.created_at ?? "" });
    } catch {
      // Older tool responses and malformed receipts are not document outputs.
    }
  }
  return [...outputs.values()].reverse();
}
