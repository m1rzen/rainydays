import { isDocumentMime } from "./attachment.js";
import { parseDocumentIsolated } from "./document-parser.js";
import { throwIfCancelled } from "./run-cancellation.js";
import { ToolArgumentsError } from "./tool-pipeline.js";
import type { ToolInvocationServices } from "./types.js";
import { documentTextPage, documentWarnings, parsePdfPageRange } from "./document-pagination.js";
import type { ParseResult } from "./tools/parsers.js";
export { documentTextPage } from "./document-pagination.js";

export async function readAttachmentDocument(args: Record<string, unknown>, invocation: ToolInvocationServices): Promise<string> {
  throwIfCancelled(invocation.signal);
  const { readMessageAttachmentForSession } = await import("./attachment-store.js");
  const id = String(args.file_path).slice("attachment:".length);
  const { attachment, bytes } = readMessageAttachmentForSession(invocation.capabilityContext.sessionId, id);
  if (attachment.kind === "image") throw new ToolArgumentsError("图片附件请通过视觉模型读取");
  const pdf = attachment.mime === "application/pdf";
  if (args.pages !== undefined && !pdf) throw new ToolArgumentsError("pages 仅适用于 PDF 文件");
  const pdfPages = pdf ? parsePdfPageRange(args.pages) : null;
  let text: string;
  let parsed: ParseResult | undefined;
  if (isDocumentMime(attachment.mime)) {
    parsed = await parseDocumentIsolated(attachment.name, bytes, invocation.resourceOwner, invocation.signal, { pdfPages, includeEvidence: true });
    if (!parsed.success) throw new ToolArgumentsError(`无法读取 ${attachment.name}: ${parsed.error}`);
    text = parsed.text;
  } else text = bytes.toString("utf8");
  throwIfCancelled(invocation.signal);
  const pages = pdf && parsed?.pageCount ? `\nPDF: ${parsed.pageCount} 页；本次解析页面 ${parsed.renderedPages?.join(", ") || "未知"}，展示范围见下方分页` : "";
  return `来源: ${attachment.name}\n附件: attachment:${id}${pages}${documentWarnings(parsed?.warnings)}\n\n${documentTextPage(text, args.offset as number | undefined, args.limit as number | undefined, parsed?.locations)}`;
}
