import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerSetting } from "./settings.js";
import { readCredential } from "../credential-store.js";
import { McpRemoteRequestError } from "./errors.js";

export interface McpNetworkOptions { fetch: typeof fetch; authProvider?: OAuthClientProvider }
/** SDK owns HTTP and SSE framing. Lost tool responses never trigger a reconnect/replay. */
export async function createRemoteTransport(server: McpServerSetting, network: McpNetworkOptions): Promise<Transport> {
  const authProvider = network.authProvider ?? (server.auth.mode === "oauth" ? await (await import("./oauth-provider.js")).createMcpOAuthProvider(server) : undefined);
  const headers = new Headers();
  if (server.auth.mode === "token") {
    if (!server.auth.credentialRef) throw new Error("MCP token is not configured");
    headers.set("Authorization", `Bearer ${await readCredential(server.auth.credentialRef)}`);
  }
  const guardedFetch: typeof fetch = async (url, init) => {
    let toolCall = false;
    try { toolCall = typeof init?.body === "string" && JSON.parse(init.body)?.method === "tools/call"; } catch { /* SDK owns message validation. */ }
    const response = await network.fetch(url, init);
    if (toolCall && ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400))) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpRemoteRequestError([401, 403].includes(response.status) ? "MCP_AUTH_REQUIRED" : "MCP_CONNECTION_LOST", "MCP调用的结果未知；身份或重导响应不会自动重放工具。请检查服务状态后，在设置重新连接。");
    }
    return response;
  };
  if (server.transport === "sse") return new SSEClientTransport(new URL(server.url), { fetch: guardedFetch, authProvider, requestInit: { headers }, redirectPolicy: "same-origin" });
  return new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: guardedFetch,
    authProvider,
    requestInit: { headers },
    redirectPolicy: "same-origin",
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
}
