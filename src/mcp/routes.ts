import type { Express } from "express";
import { getConfigRevisionDigest, getConfigSnapshot, getPublicConfig, updateSettingsDomain } from "../config.js";
import { isDeveloperModeEnabled } from "../developer-execution.js";
import { mcpConfigurationKey, type McpServerSetting, type McpToolSetting } from "./settings.js";
import { mcpConnectedCount } from "./runtime.js";

export function registerMcpRoutes(app: Express, dependencies: {
  busy: () => boolean;
  mutate: (action: () => Promise<void>) => Promise<void>;
  probe: (name: string, signal: AbortSignal) => Promise<{ tools: McpToolSetting[]; protocolVersion: string }>;
}): void {
  const status = new Map<string, { key: string; state: string; error?: string }>();
  const currentStatus = (server: McpServerSetting) => { const state = status.get(server.name); return state?.key === mcpConfigurationKey(server) ? state : undefined; };
  app.get("/api/mcp/status", (_req, res) => res.json({ available: isDeveloperModeEnabled(), servers: getConfigSnapshot().domains.mcp.servers.map(server => ({ name: server.name, enabled: server.enabled, toolCount: server.tools.length, protocolVersion: server.protocolVersion, connections: mcpConnectedCount(server), state: !isDeveloperModeEnabled() ? "colleague-disabled" : !server.enabled ? "disabled" : mcpConnectedCount(server) ? "connected" : currentStatus(server)?.state ?? (server.protocolVersion ? "tested-on-demand" : "untested"), error: currentStatus(server)?.error })) }));
  app.post("/api/mcp/test", async (req, res) => {
    if (dependencies.busy()) { res.status(409).json({ error: "请等待正在运行的任务结束" }); return; }
    if (!isDeveloperModeEnabled()) { res.status(403).json({ error: "同事模式尚无隔离stdio通道；请在开发模式中明确测试MCP。" }); return; }
    const { name, expectedRevision } = req.body ?? {};
    if (typeof name !== "string" || typeof expectedRevision !== "string" || Object.keys(req.body).sort().join(",") !== "expectedRevision,name") { res.status(400).json({ error: "MCP测试请求无效" }); return; }
    const servers = getConfigSnapshot().domains.mcp.servers, configured = servers.find(server => server.name === name);
    if (!configured) { res.status(404).json({ error: "MCP服务器不存在" }); return; }
    for (const key of status.keys()) if (!servers.some(server => server.name === key)) status.delete(key);
    const key = mcpConfigurationKey(configured);
    if (expectedRevision !== getConfigRevisionDigest()) { res.status(409).json({ error: "设置已变化，请重新载入" }); return; }
    if (status.get(name)?.state === "connecting") { res.status(409).json({ error: "此服务器正在测试" }); return; }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", abort);
    try {
      status.set(name, { key, state: "connecting" });
      const result = await dependencies.probe(name, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
      await dependencies.mutate(async () => {
        if (expectedRevision !== getConfigRevisionDigest()) throw new Error("测试期间设置已变化，请重新测试");
        const servers = getConfigSnapshot().domains.mcp.servers;
        const server = servers.find(item => item.name === name); if (!server) throw new Error("MCP服务器不存在");
        server.tools = result.tools; server.protocolVersion = result.protocolVersion;
        await updateSettingsDomain("mcp", { servers });
      });
      status.set(name, { key, state: "tested-on-demand" });
      res.json({ success: true, toolCount: result.tools.length, settings: getPublicConfig() });
    } catch { status.set(name, { key, state: "error", error: "连接、协议或目录检查失败；请检查已保存的命令与工作目录。" }); res.status(400).json({ error: status.get(name)!.error }); }
    finally { res.off("close", abort); }
  });
}
