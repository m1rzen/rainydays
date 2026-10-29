import { randomUUID } from "node:crypto";
import type { CapabilityBroker, RuntimeAuthority, ToolPolicy } from "../capability-broker.js";
import { getConfigSnapshot } from "../config.js";
import { isDeveloperModeEnabled } from "../developer-execution.js";
import { registerOwnedResource, type ResourceOwner } from "../resource-owner.js";
import { createToolOutcome } from "../tool-pipeline.js";
import type { ToolDefinition, ToolExecutionOutcome, ToolInvocationServices } from "../types.js";
import type { McpConnection, McpCallResult } from "./client.js";
import { mcpConfigurationKey, mcpToolName, type McpServerSetting } from "./settings.js";

const MCP_POLICY: ToolPolicy = { minimumPermissionLevel: "full", riskClasses: ["read", "write", "network", "process", "control"], approval: "user", effects: ["filesystem", "network", "process", "control"], pathOperations: ["initial-cwd"], executionRootAccess: "read-write" };
const connections = new WeakMap<ResourceOwner, Map<string, McpConnection>>();
const connectedCounts = new Map<string, number>();
export function mcpConnectedCount(server: McpServerSetting): number { return connectedCounts.get(mcpConfigurationKey(server)) ?? 0; }
const results = new WeakMap<ResourceOwner, Map<string, string>>();
const PAGE_CHARS = 12000;
function pageEnd(content: string, offset: number): number {
  const end = Math.min(offset + PAGE_CHARS, content.length);
  return end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1]) ? end - 1 : end;
}
export function mcpRuntimeToolNames(): string[] {
  if (!isDeveloperModeEnabled()) return [];
  const names = getConfigSnapshot().domains.mcp.servers.filter(server => server.enabled && server.transport === "stdio").flatMap(server => server.tools.map(tool => mcpToolName(server.name, tool.name)));
  return names.length ? [...names, "mcp_read_result"] : [];
}
function envelope(result: McpCallResult, invocation: ToolInvocationServices): string {
  const { content, ...metadata } = result;
  let resultId: string | null = null;
  if (content.length > PAGE_CHARS) {
    let retained = results.get(invocation.resourceOwner);
    if (!retained) { retained = new Map(); results.set(invocation.resourceOwner, retained); registerOwnedResource(invocation.resourceOwner, () => { retained!.clear(); }); }
    // Up to eight 1MiB results, with explicit expired IDs after eviction.
    if (retained.size >= 8) retained.delete(retained.keys().next().value!);
    resultId = randomUUID(); retained.set(resultId, content);
  }
  const end = pageEnd(content, 0);
  return JSON.stringify({ mcp: true, ...metadata, content: content.slice(0, end), resultId, offset: 0, nextOffset: resultId ? end : null, totalChars: content.length, paging: resultId ? "Use mcp_read_result in this task; up to eight results retained until task end." : null });
}
export function mcpToolOutcome(serialized: string): ToolExecutionOutcome {
  const value = JSON.parse(serialized) as Record<string, unknown>;
  if (value.mcp !== true || !["success", "error"].includes(String(value.status)) || typeof value.content !== "string" || (value.code !== null && typeof value.code !== "string")) throw new TypeError("Invalid typed MCP result");
  return createToolOutcome(value.status as "success" | "error", serialized, value.code as string | null);
}
function activeServer(snapshot: McpServerSetting): boolean {
  return isDeveloperModeEnabled() && getConfigSnapshot().domains.mcp.servers.some(server => server.enabled && mcpConfigurationKey(server) === mcpConfigurationKey(snapshot) && JSON.stringify(server.tools) === JSON.stringify(snapshot.tools));
}
async function invoke(snapshot: McpServerSetting, tool: string, args: Record<string, unknown>, invocation: ToolInvocationServices): Promise<string> {
  const failure = (code: string, content: string) => JSON.stringify({ mcp: true, status: "error", code, content, server: snapshot.name });
  if (!activeServer(snapshot)) return failure("MCP_DISABLED_OR_STALE", "MCP已停用或设置已变更；请开始新会话。");
  let owned = connections.get(invocation.resourceOwner);
  if (!owned) { owned = new Map(); connections.set(invocation.resourceOwner, owned); }
  const key = mcpConfigurationKey(snapshot);
  let connection = owned.get(key);
  if (!connection) {
    const { McpConnection } = await import("./client.js");
    let counted = false;
    connection = new McpConnection(snapshot, 20000, () => {
      if (!counted) return; counted = false;
      const remaining = (connectedCounts.get(key) ?? 1) - 1;
      if (remaining > 0) connectedCounts.set(key, remaining); else connectedCounts.delete(key);
    }); owned.set(key, connection);
    try {
      await invocation.path.withExecutionRoot(snapshot.cwd || ".", { defaultRootId: invocation.path.rootIdForEnv("WORKSPACE_ROOT") ?? undefined }, cwd => connection!.open(cwd, invocation.resourceOwner, invocation.signal));
      const listed = await connection.listTools(invocation.signal);
      if (JSON.stringify(listed) !== JSON.stringify(snapshot.tools)) { await connection.close(); return failure("MCP_SCHEMA_CHANGED", "MCP工具目录已变更；请在设置刷新后开始新会话。"); }
      if (!connection.connected) throw new Error("MCP connection closed while listing tools");
      counted = true; connectedCounts.set(key, (connectedCounts.get(key) ?? 0) + 1);
    } catch { await connection.close(); return failure("MCP_INITIALIZE_FAILED", "MCP初始化失败、目录不可用或逾时；未执行工具。"); }
  }
  return envelope(await connection.call(tool, args, invocation.signal), invocation);
}
export function registerMcpTools(broker: CapabilityBroker, authority: RuntimeAuthority, allowedNames: readonly string[]): void {
  if (!isDeveloperModeEnabled()) return;
  for (const snapshot of getConfigSnapshot().domains.mcp.servers.filter(server => server.enabled && server.transport === "stdio")) {
    for (const tool of snapshot.tools) {
      const name = mcpToolName(snapshot.name, tool.name);
      if (!allowedNames.includes(name)) continue;
      broker.registerRuntimeTool(authority, { name, definition: { type: "function", function: { name, description: `[MCP · ${snapshot.name}] ${tool.description}`, parameters: { properties: {}, ...tool.inputSchema } as ToolDefinition["function"]["parameters"] } }, policy: MCP_POLICY, mcpServer: { key: mcpConfigurationKey(snapshot), name: snapshot.name },
        executor: async (args, _env, invocation) => { if (!invocation) throw new Error("MCP requires owned invocation"); return invoke(snapshot, tool.name, { ...args }, invocation); } });
    }
  }
  if (allowedNames.includes("mcp_read_result")) broker.registerRuntimeTool(authority, { name: "mcp_read_result", definition: { type: "function", function: { name: "mcp_read_result", description: "Read another page of an MCP result from this task. Offsets count UTF-16 characters; IDs expire at task end or after eight newer results.", parameters: { type: "object", properties: { resultId: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["resultId", "offset"], additionalProperties: false } } }, policy: { riskClasses: ["read"], approval: "none", effects: [] }, executor: async (args, _env, invocation) => {
    const content = invocation && results.get(invocation.resourceOwner)?.get(String(args.resultId));
    if (!content || !Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > content.length) return JSON.stringify({ mcp: true, status: "error", code: "MCP_RESULT_UNAVAILABLE", content: "结果已过期、归属不同或页偏移无效。" });
    const offset = Number(args.offset), end = pageEnd(content, offset);
    return JSON.stringify({ mcp: true, status: "success", code: null, resultId: args.resultId, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalChars: content.length });
  } });
}
