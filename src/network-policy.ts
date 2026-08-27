import type { CapabilityContext, InspectedToolCall, NetworkPolicy } from "./capability-broker.js";
import type { ScopedNetworkGateway } from "./types.js";
import { throwIfCancelled } from "./run-cancellation.js";

const MAX_URL_LENGTH = 8_192;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class NetworkPolicyDeniedError extends Error {
  readonly code = "NETWORK_POLICY_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyDeniedError";
  }
}

function denied(message: string): never {
  throw new NetworkPolicyDeniedError(message);
}

function canonicalUrl(value: string, base?: URL): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH || value.includes("\0")) {
    denied("Network URL is invalid");
  }
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    denied("Network URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    denied("Network URL scheme or credentials are denied");
  }
  return url;
}

function canonicalOrigins(policy: NetworkPolicy): ReadonlySet<string> {
  if (policy.mode !== "allowlist") return new Set();
  const origins = new Set<string>();
  for (const entry of policy.origins) {
    const url = canonicalUrl(entry);
    if (url.href !== `${url.origin}/`) denied("Network allowlist entries must be exact origins");
    origins.add(url.origin);
  }
  return origins;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127);
}

function assertAllowed(url: URL, policy: NetworkPolicy, origins: ReadonlySet<string>): void {
  if (policy.mode === "deny") denied("Network access is denied by the effective Persona");
  if (policy.mode === "loopback" && !isLoopbackHostname(url.hostname)) denied("Network destination is outside the loopback policy");
  if (policy.mode === "allowlist" && !origins.has(url.origin)) denied("Network destination is outside the origin allowlist");
}

function redirectInit(init: RequestInit, status: number): RequestInit {
  const method = String(init.method ?? "GET").toUpperCase();
  if (status !== 303 && !((status === 301 || status === 302) && method === "POST")) return init;
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return { ...init, method: "GET", body: undefined, headers };
}

export function createScopedNetworkGateway(input: Readonly<{
  context: CapabilityContext;
  inspected: InspectedToolCall;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  assertActive?: () => boolean;
}>): ScopedNetworkGateway {
  const { context, inspected, signal, fetchImpl = globalThis.fetch, assertActive = () => true } = input;
  const networkCapable = inspected.policy.riskClasses.includes("network") && inspected.policy.effects.includes("network");
  const origins = canonicalOrigins(context.networkPolicy);
  let requestCount = 0;

  const scopedFetch = async (value: string, requestInit: RequestInit = {}): Promise<Response> => {
    if (!assertActive()) denied("Network capability context is unavailable");
    if (!networkCapable) denied("Tool binding has no network capability");
    let url = canonicalUrl(value);
    let init = { ...requestInit };
    for (let redirects = 0; ; redirects += 1) {
      throwIfCancelled(signal);
      if (!assertActive()) denied("Network capability context is unavailable");
      assertAllowed(url, context.networkPolicy, origins);
      requestCount += 1;
      if (requestCount > MAX_REDIRECTS + 2) denied("Network request count exceeded the invocation limit");
      const requestSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      const response = await fetchImpl(url.href, { ...init, redirect: "manual", signal: requestSignal });
      if (!REDIRECT_STATUS.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= MAX_REDIRECTS) denied("Network redirect limit exceeded");
      url = canonicalUrl(location, url);
      init = redirectInit(init, response.status);
    }
  };

  return Object.freeze({ fetch: scopedFetch });
}
