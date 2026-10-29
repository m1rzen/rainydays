import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { readCredential } from "../credential-store.js";
import type { ResourceOwner } from "../resource-owner.js";
import { OwnedStdioTransport } from "./stdio.js";
import { parseMcpTools, type McpServerSetting, type McpToolSetting } from "./settings.js";

export type McpResultCode = "MCP_TOOL_ERROR" | "MCP_TIMEOUT" | "MCP_CANCELLED" | "MCP_CONNECTION_LOST" | "MCP_SCHEMA_CHANGED" | "MCP_OUTPUT_LIMIT";
export type McpCallResult = { status: "success" | "error"; server: string; content: string; code: McpResultCode | null };
export class McpConnection {
  private readonly client = new Client({ name: "RainyDays", version: "0.1.0" });
  private transport?: OwnedStdioTransport;
  private changed = false;
  private closed = false;
  private notified = false;
  constructor(readonly server: McpServerSetting, private readonly timeoutMs = 20_000, private readonly onClose: () => void = () => {}) {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.changed = true; });
    this.client.onclose = () => { this.closed = true; this.notifyClosed(); };
  }
  get connected(): boolean { return !!this.transport && !this.closed; }
  get protocolVersion(): string { return this.transport?.protocolVersion ?? ""; }
  async open(cwd: string, owner: ResourceOwner, signal: AbortSignal): Promise<void> {
    if (this.server.transport !== "stdio") throw new Error("Remote MCP is not enabled by A05");
    signal.throwIfAborted();
    const env = getDefaultEnvironment();
    for (const [key, reference] of Object.entries(this.server.env)) if (reference) env[key] = await readCredential(reference);
    this.transport = new OwnedStdioTransport({ command: this.server.command, args: [...this.server.args], cwd, owner, env });
    try { await this.client.connect(this.transport, { signal, timeout: Math.max(this.timeoutMs, 10000) }); }
    catch { await this.close(); throw new Error("MCP initialize failed, timed out or was cancelled"); }
  }
  async listTools(signal: AbortSignal): Promise<McpToolSetting[]> {
    const entries: unknown[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: this.timeoutMs });
      entries.push(...page.tools);
      parseMcpTools(entries);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP tools/list repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.changed = false;
    return parseMcpTools(entries);
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const failure = (code: McpResultCode, content: string): McpCallResult => ({ status: "error", code, content, server: this.server.name });
    if (this.changed) return failure("MCP_SCHEMA_CHANGED", "MCP工具目录已变更；请在设置刷新后开始新任务。");
    if (this.closed) return failure("MCP_CONNECTION_LOST", "MCP连接已关闭；未自动重放调用。");
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: this.timeoutMs });
      const content = JSON.stringify(result);
      if (Buffer.byteLength(content) > 1024 * 1024) return failure("MCP_OUTPUT_LIMIT", "MCP结果超过1MiB保留上限；结果未作为完整成功返回。");
      return { status: result.isError ? "error" : "success", code: result.isError ? "MCP_TOOL_ERROR" : null, content, server: this.server.name };
    } catch (error) {
      if (!signal.aborted && error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) return failure("MCP_TOOL_ERROR", "MCP服务器返回工具协议错误；未自动重放。");
      const code = signal.aborted ? "MCP_CANCELLED" : error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "MCP_TIMEOUT" : "MCP_CONNECTION_LOST";
      await this.close();
      return failure(code, code === "MCP_TIMEOUT" ? "MCP调用逾时，结果未知；未自动重放。" : code === "MCP_CANCELLED" ? "MCP调用已取消，结果未知。" : "MCP连接或协议失败，结果未知；未自动重放。");
    }
  }
  private notifyClosed(): void { if (!this.notified) { this.notified = true; this.onClose(); } }
  async close(): Promise<void> { this.closed = true; try { await this.client.close(); await this.transport?.close(); } finally { this.notifyClosed(); } }
}
