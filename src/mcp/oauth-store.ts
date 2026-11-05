import { randomUUID } from "node:crypto";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getConfigSnapshot, saveConfig, finalizeCredentialChanges } from "../config.js";
import { readCredential, storeCredential, stageCredentialRetirements, deleteCredentials } from "../credential-store.js";
import { mcpConfigurationKey, type McpServerSetting } from "./settings.js";

export interface McpOAuthState {
  version: 1;
  serverKey: string;
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}
let queue: Promise<unknown> = Promise.resolve();
let mutationBoundary: <T>(action: () => Promise<T>, requireIdle: boolean) => Promise<T> = action => action();
export function configureMcpOAuthMutationBoundary(boundary: typeof mutationBoundary): void { mutationBoundary = boundary; }
function serialized<T>(action: () => Promise<T>, requireIdle = false): Promise<T> { const next = queue.catch(() => undefined).then(() => mutationBoundary(action, requireIdle)); queue = next; return next; }
function currentServer(snapshot: McpServerSetting): McpServerSetting {
  const server = getConfigSnapshot().domains.mcp.servers.find(item => item.name === snapshot.name);
  if (!server || server.auth.mode !== "oauth" || !server.auth.authorizationId || mcpConfigurationKey(server) !== mcpConfigurationKey(snapshot)) throw new Error("MCP OAuth connection changed; login again in settings");
  return server;
}
export async function readMcpOAuthState(snapshot: McpServerSetting): Promise<McpOAuthState> {
  const server = currentServer(snapshot), key = mcpConfigurationKey(server);
  if (!server.auth.credentialRef) return { version: 1, serverKey: key };
  const value = JSON.parse(await readCredential(server.auth.credentialRef)) as McpOAuthState;
  if (value.version !== 1 || value.serverKey !== key) throw new Error("MCP OAuth credentials belong to another connection");
  return value;
}
export function mutateMcpOAuthState(snapshot: McpServerSetting, mutate: (state: McpOAuthState) => void): Promise<void> {
  return serialized(async () => {
    const state = await readMcpOAuthState(snapshot); mutate(state);
    const text = JSON.stringify(state); if (Buffer.byteLength(text) > 48000) throw new Error("MCP OAuth credential document is too large");
    const cfg = getConfigSnapshot(), server = cfg.domains.mcp.servers.find(item => item.name === snapshot.name)!;
    currentServer(snapshot);
    const previous = server.auth.credentialRef, reference = await storeCredential(text);
    try {
      server.auth.credentialRef = reference;
      if (previous) await stageCredentialRetirements([previous]);
      await saveConfig(cfg);
    } catch (error) { await deleteCredentials([reference]); await finalizeCredentialChanges(); throw error; }
    await finalizeCredentialChanges();
  });
}
/** Explicit login/logout rotates identity; an old run or callback cannot publish new tokens. */
export function resetMcpOAuth(name: string): Promise<McpServerSetting> {
  return serialized(async () => {
    const cfg = getConfigSnapshot(), server = cfg.domains.mcp.servers.find(item => item.name === name);
    if (!server || server.auth.mode !== "oauth") throw new Error("MCP OAuth is not configured");
    const previous = server.auth.credentialRef;
    server.auth.authorizationId = randomUUID(); server.auth.credentialRef = "";
    server.tools = []; server.protocolVersion = ""; server.resources = false;
    if (previous) await stageCredentialRetirements([previous]);
    try { await saveConfig(cfg); } catch (error) { await finalizeCredentialChanges(); throw error; }
    await finalizeCredentialChanges(); return server;
  }, true);
}
