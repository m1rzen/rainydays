import { randomBytes } from "node:crypto";
import type { ResourceOwner } from "../resource-owner.js";
import { registerOwnedResource } from "../resource-owner.js";
import { getConfigSnapshot } from "../config.js";
import type { McpServerSetting } from "./settings.js";
import { resetMcpOAuth, readMcpOAuthState } from "./oauth-store.js";
import { validateOAuthBrowserUrl } from "./oauth-browser.js";

export interface McpOAuthNetworkScope { fetch: typeof fetch; owner: ResourceOwner; sessionId: string }
export type McpOAuthNetworkRunner = <T>(name: string, sessionId: string | undefined, signal: AbortSignal, use: (scope: McpOAuthNetworkScope) => Promise<T>) => Promise<T>;
interface PendingLogin { server: McpServerSetting; sessionId: string; controller: AbortController; expires: number; dispose: () => void }
export class McpOAuthManager {
  private readonly pending = new Map<string, PendingLogin>();
  constructor(private readonly input: { redirectUrl: string; runNetwork: McpOAuthNetworkRunner; openBrowser: (url: URL) => Promise<void> }) {}
  private cancel(name: string): void { for (const [nonce, login] of this.pending) if (login.server.name === name || login.expires <= Date.now()) { login.controller.abort(); login.dispose(); this.pending.delete(nonce); } }
  async start(name: string, signal: AbortSignal): Promise<{ pending: boolean }> {
    this.cancel(name);
    if (this.pending.size >= 32) throw new Error("Too many pending MCP logins");
    const server = await resetMcpOAuth(name), nonce = randomBytes(32).toString("hex"), controller = new AbortController();
    const login: PendingLogin = { server, sessionId: "", controller, expires: Date.now() + 300000, dispose: () => {} };
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.input.runNetwork(name, undefined, AbortSignal.any([signal, controller.signal]), async scope => {
        login.sessionId = scope.sessionId;
        const unregister = registerOwnedResource(scope.owner, () => { controller.abort(); this.pending.delete(nonce); login.dispose(); });
        const timer = setTimeout(() => { controller.abort(); this.pending.delete(nonce); unregister(); }, 300000); timer.unref?.();
        login.dispose = () => { clearTimeout(timer); unregister(); };
        this.pending.set(nonce, login);
        const [{ auth }, { createMcpOAuthProvider }] = await Promise.all([import("@modelcontextprotocol/sdk/client/auth.js"), import("./oauth-provider.js")]);
        const provider = await createMcpOAuthProvider(server, { redirectUrl: this.input.redirectUrl, state: nonce, redirect: async url => { validateOAuthBrowserUrl(url); controller.signal.throwIfAborted(); await this.input.openBrowser(url); } });
        const result = await auth(provider, { serverUrl: server.url, fetchFn: scope.fetch });
        if (result === "AUTHORIZED") { this.pending.delete(nonce); login.dispose(); }
        return { pending: result !== "AUTHORIZED" };
      });
    } catch (error) { this.pending.delete(nonce); login.dispose(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  async finish(nonce: string, code: string, denied: boolean): Promise<boolean> {
    const login = this.pending.get(nonce);
    if (!login || login.expires <= Date.now()) return false;
    this.pending.delete(nonce); // Consume before any exchange: callbacks are single-use.
    try {
      if (denied || !code || code.length > 4096) return false;
      return await this.input.runNetwork(login.server.name, login.sessionId, login.controller.signal, async scope => {
        const [{ auth }, { createMcpOAuthProvider }] = await Promise.all([import("@modelcontextprotocol/sdk/client/auth.js"), import("./oauth-provider.js")]);
        const provider = await createMcpOAuthProvider(login.server, { redirectUrl: this.input.redirectUrl });
        return await auth(provider, { serverUrl: login.server.url, authorizationCode: code, fetchFn: scope.fetch }) === "AUTHORIZED";
      });
    } catch { return false; }
    finally { login.dispose(); }
  }
  async disconnect(name: string): Promise<void> { this.cancel(name); await resetMcpOAuth(name); }
  async status(name: string): Promise<"pending" | "authorized" | "signed-out" | "error"> {
    const server = getConfigSnapshot().domains.mcp.servers.find(item => item.name === name);
    if (!server || server.auth.mode !== "oauth") return "signed-out";
    if ([...this.pending.values()].some(login => login.server.name === name && login.server.auth.authorizationId === server.auth.authorizationId && login.expires > Date.now())) return "pending";
    try { return (await readMcpOAuthState(server)).tokens ? "authorized" : "signed-out"; } catch { return "error"; }
  }
}
