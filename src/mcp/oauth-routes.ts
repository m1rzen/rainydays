import type { Express } from "express";
import { getConfigRevisionDigest, getPublicConfig } from "../config.js";
import { isDeveloperModeEnabled } from "../developer-execution.js";
import type { McpOAuthManager } from "./oauth-manager.js";

export function registerMcpOAuthRoutes(app: Express, manager: McpOAuthManager, busy: () => boolean): void {
  app.get("/api/mcp/oauth/status", async (req, res) => {
    if (typeof req.query.name !== "string") { res.sendStatus(400); return; }
    res.json({ state: await manager.status(req.query.name) });
  });
  for (const action of ["start", "disconnect"] as const) app.post(`/api/mcp/oauth/${action}`, async (req, res) => {
    if (!isDeveloperModeEnabled()) { res.status(403).json({ error: "MCP仅在开发模式可用" }); return; }
    if (busy()) { res.status(409).json({ error: "请等待任务结束再登录或断开MCP" }); return; }
    const { name, expectedRevision } = req.body ?? {};
    if (typeof name !== "string" || typeof expectedRevision !== "string" || Object.keys(req.body).sort().join(",") !== "expectedRevision,name") { res.sendStatus(400); return; }
    if (expectedRevision !== getConfigRevisionDigest()) { res.status(409).json({ error: "设置已变化，请重新载入" }); return; }
    const controller = new AbortController(); const abort = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", abort);
    try { const result = action === "start" ? await manager.start(name, controller.signal) : (await manager.disconnect(name), { pending: false }); res.json({ ...result, settings: getPublicConfig() }); }
    catch { res.status(400).json({ error: "MCP登录失败。请检查服务器的OAuth支持、客户端ID与网络；也可使用服务提供的token。" }); }
    finally { res.off("close", abort); }
  });
  // A system-browser redirect has no app token. A short-lived, owned, one-use nonce is the only entrance.
  app.get("/mcp/oauth/callback", async (req, res) => {
    const nonce = typeof req.query.state === "string" ? req.query.state : "", code = typeof req.query.code === "string" ? req.query.code : "";
    const success = /^[a-f0-9]{64}$/u.test(nonce) && await manager.finish(nonce, code, req.query.error !== undefined);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.status(success ? 200 : 400).type("text/plain").send(success ? "MCP登录已完成。请返回RainyDays，测试服务器后开始新会话。" : "MCP登录未完成或已过期。请返回RainyDays重新登录。");
  });
}
