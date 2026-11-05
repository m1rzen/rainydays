/** MCP content remains typed data. Resource URIs are references, never local host file reads. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };
export class McpContentError extends Error {
  constructor(readonly code: "MCP_OUTPUT_LIMIT" | "MCP_UNSUPPORTED_CONTENT", message: string) { super(message); this.name = "McpContentError"; }
}
export function serializeMcpContent(value: unknown): string {
  if (!value || typeof value !== "object" || !Array.isArray((value as { content?: unknown }).content)) throw new McpContentError("MCP_UNSUPPORTED_CONTENT", "MCP结果缺少可识别的内容列表。");
  for (const block of (value as { content: McpContentBlock[] }).content) {
    if (!block || !["text", "image", "audio", "resource_link", "resource"].includes(block.type)) throw new McpContentError("MCP_UNSUPPORTED_CONTENT", "MCP结果包含未支持的内容类型。");
    if ((block.type === "image" || block.type === "audio") && (typeof block.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(block.data))) throw new McpContentError("MCP_UNSUPPORTED_CONTENT", "MCP媒体载荷不是有效base64。");
    if (block.type === "image" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)) throw new McpContentError("MCP_UNSUPPORTED_CONTENT", "MCP图片格式不可供当前视觉适配使用。");
  }
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > 1024 * 1024) throw new McpContentError("MCP_OUTPUT_LIMIT", "MCP结果超过1MiB保留上限；结果未作为完整成功返回。");
  return content;
}
