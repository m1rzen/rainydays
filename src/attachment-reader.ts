import { isDocumentMime } from "./attachment.js";
import { parseDocumentIsolated } from "./document-parser.js";
import { throwIfCancelled } from "./run-cancellation.js";
import { ToolArgumentsError } from "./tool-pipeline.js";
import type { ToolInvocationServices } from "./types.js";

/** 提取行稳定编号；长单行拆为最多 500 个 Unicode 字符，翻页不会遗漏尾部。 */
export function documentTextPage(text: string, offset = 1, limit = 12): string {
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ToolArgumentsError("offset 和 limit 必须是正整数");
  }
  const lines = text.split(/\r?\n/u).flatMap(line => {
    const chars = Array.from(line);
    const parts: string[] = [];
    for (let start = 0; start < chars.length; start += 500) parts.push(chars.slice(start, start + 500).join(""));
    return parts.length ? parts : [""];
  });
  const start = Math.min(offset - 1, lines.length);
  const end = Math.min(lines.length, start + Math.min(limit, 12));
  const body = lines.slice(start, end).map((line, i) => `${start + i + 1} | ${line}`).join("\n");
  return `${body}\n\n提取文本共 ${lines.length} 行；${end < lines.length ? `下一页 offset=${end + 1}` : "已到末尾"}。行号指提取文本，长行按 500 字符分段。`;
}

export async function readAttachmentDocument(args: Record<string, unknown>, invocation: ToolInvocationServices): Promise<string> {
  throwIfCancelled(invocation.signal);
  const { readMessageAttachmentForSession } = await import("./attachment-store.js");
  const id = String(args.file_path).slice("attachment:".length);
  const { attachment, bytes } = readMessageAttachmentForSession(invocation.capabilityContext.sessionId, id);
  if (attachment.kind === "image") throw new ToolArgumentsError("图片附件请通过视觉模型读取");
  if (args.pages !== undefined) throw new ToolArgumentsError("附件使用 offset/limit 分段读取，PDF 页码在提取内容中标明");
  let text: string;
  if (isDocumentMime(attachment.mime)) {
    const parsed = await parseDocumentIsolated(attachment.name, bytes, invocation.resourceOwner, invocation.signal);
    if (!parsed.success) throw new ToolArgumentsError(`无法读取 ${attachment.name}: ${parsed.error}`);
    text = parsed.text;
  } else text = bytes.toString("utf8");
  throwIfCancelled(invocation.signal);
  return `来源: ${attachment.name}\n附件: attachment:${id}\n\n${documentTextPage(text, args.offset as number | undefined, args.limit as number | undefined)}`;
}
