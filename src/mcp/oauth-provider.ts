import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerSetting } from "./settings.js";
import { mutateMcpOAuthState, readMcpOAuthState } from "./oauth-store.js";
import { McpRemoteRequestError } from "./errors.js";

/** SDK handles OAuth discovery, registration, PKCE, exchange and refresh; this adapter only stores state. */
export async function createMcpOAuthProvider(server: McpServerSetting, options: { redirectUrl?: string; state?: string; redirect?: (url: URL) => Promise<void> } = {}): Promise<OAuthClientProvider> {
  const initial = await readMcpOAuthState(server), redirectUrl = options.redirectUrl ?? initial.redirectUrl;
  if (options.redirectUrl) await mutateMcpOAuthState(server, state => { state.redirectUrl = options.redirectUrl; });
  return {
    redirectUrl,
    clientMetadata: { client_name: "RainyDays", redirect_uris: redirectUrl ? [redirectUrl] : [], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => options.state ?? randomUUID(),
    clientInformation: async () => (await readMcpOAuthState(server)).clientInformation ?? (server.auth.clientId ? { client_id: server.auth.clientId } : undefined),
    saveClientInformation: async (value: OAuthClientInformationMixed) => mutateMcpOAuthState(server, state => { state.clientInformation = value; }),
    tokens: async () => { const value = (await readMcpOAuthState(server)).tokens; return value ? OAuthTokensSchema.parse(value) : undefined; },
    saveTokens: async (value: OAuthTokens) => mutateMcpOAuthState(server, state => { state.tokens = OAuthTokensSchema.parse(value); }),
    saveCodeVerifier: async (value: string) => mutateMcpOAuthState(server, state => { state.verifier = value; }),
    codeVerifier: async () => { const value = (await readMcpOAuthState(server)).verifier; if (!value) throw new Error("MCP OAuth verifier expired"); return value; },
    redirectToAuthorization: async url => { if (!options.redirect) throw new McpRemoteRequestError("MCP_AUTH_REQUIRED", "请在MCP设置中登录，然后开始新任务。"); await options.redirect(url); },
    invalidateCredentials: async scope => mutateMcpOAuthState(server, state => {
      if (scope === "all" || scope === "client") delete state.clientInformation;
      if (scope === "all" || scope === "tokens") delete state.tokens;
      if (scope === "all" || scope === "verifier") delete state.verifier;
    }),
  };
}
