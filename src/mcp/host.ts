import type { Express } from "express";
import type { CapabilityBroker, CapabilityContext, RuntimeAuthority } from "../capability-broker.js";
import type { ResourceOwner } from "../resource-owner.js";
import { getConfigSnapshot } from "../config.js";
import { isDeveloperModeEnabled } from "../developer-execution.js";
import { registerMcpRoutes } from "./routes.js";
import { registerMcpOAuthRoutes } from "./oauth-routes.js";
import { McpOAuthManager, type McpOAuthNetworkRunner } from "./oauth-manager.js";
import { openMcpOAuthBrowser } from "./oauth-browser.js";
type DirectRunner<Target> = <T>(operation: string, args: Record<string, unknown>, action: (args: Readonly<Record<string, unknown>>, owner: ResourceOwner, authority: RuntimeAuthority, context: CapabilityContext) => T | Promise<T>, target?: Target, auditResult?: (result: T) => unknown) => Promise<T>;

export function registerMcpHost<Target>(app: Express, input: { broker: CapabilityBroker; direct: DirectRunner<Target>; resolve: (sessionId: string) => Promise<Target>; busy: () => boolean; mutate: (action: () => Promise<void>) => Promise<void>; redirectUrl: string }): void {
  const runNetwork: McpOAuthNetworkRunner = async (name, sessionId, signal, use) => input.direct("mcp:auth", { name }, async (_args, owner, _authority, context) => {
    if (!isDeveloperModeEnabled()) throw new Error("MCP developer mode is disabled");
    const network = input.broker.issueDirectNetworkGateway(context, "mcp:auth", signal);
    return use({ owner, sessionId: context.sessionId, fetch: (url, init) => network.fetch(url instanceof Request ? url.url : String(url), init) });
  }, sessionId ? await input.resolve(sessionId) : undefined, () => ({ completed: true }));
  registerMcpOAuthRoutes(app, new McpOAuthManager({ runNetwork, openBrowser: openMcpOAuthBrowser, redirectUrl: input.redirectUrl }), input.busy);
  registerMcpRoutes(app, { busy: input.busy, mutate: input.mutate, probe: (name, signal) => input.direct("mcp:test", { name }, async (_args, owner, _authority, context) => {
    const server = getConfigSnapshot().domains.mcp.servers.find(item => item.name === name);
    if (!server || !isDeveloperModeEnabled()) throw new Error("MCP server is unavailable");
    const { McpConnection } = await import("./client.js"), connection = new McpConnection(server);
    const test = async (cwd: string) => {
      try {
        const network = input.broker.issueDirectNetworkGateway(context, "mcp:test", signal);
        await connection.open(cwd, owner, signal, { fetch: (url, init) => network.fetch(url instanceof Request ? url.url : String(url), init) });
        return { tools: await connection.listTools(signal), protocolVersion: connection.protocolVersion, resources: connection.hasResources };
      } finally { await connection.close(); }
    };
    return server.transport === "stdio" ? input.broker.withDirectExecutionRoot(context, "mcp:test", server.cwd || ".", "WORKSPACE_ROOT", test) : test("");
  }, undefined, result => ({ toolCount: result.tools.length, resources: result.resources })) });
}
