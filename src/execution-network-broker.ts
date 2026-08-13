import { createHash } from "node:crypto";
import { once } from "node:events";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { CapabilityContext } from "./capability-broker.js";

export type FiniteHttpsBrokerCode =
  | "OBS_BROKER_ALLOWED"
  | "EXEC_BROKER_SCHEME_DENIED"
  | "EXEC_BROKER_HOST_DENIED"
  | "EXEC_BROKER_PORT_DENIED"
  | "EXEC_BROKER_PRIVATE_ADDRESS_DENIED"
  | "EXEC_BROKER_DNS_REBIND_DENIED"
  | "EXEC_BROKER_REDIRECT_DENIED"
  | "EXEC_BROKER_REQUEST_LIMIT"
  | "EXEC_BROKER_RESPONSE_LIMIT"
  | "EXEC_BROKER_TIMEOUT";

export type FiniteHttpsMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FiniteHttpsHeader {
  readonly name: string;
  readonly value: string;
}

export interface FiniteHttpsLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly deadlineMs: number;
  readonly maxRedirects: number;
}

export interface FiniteHttpsOperationDefinition {
  readonly version: 1;
  readonly operationId: string;
  readonly method: FiniteHttpsMethod;
  readonly url: string;
  readonly headers: readonly FiniteHttpsHeader[];
  readonly bodyBytes: number;
  readonly bodySha256: string;
  /** Exact canonical URLs accepted, in redirect order. Any other redirect is denied. */
  readonly redirects: readonly string[];
  readonly limits: FiniteHttpsLimits;
}

export interface FiniteHttpsInvocation {
  readonly operationId: string;
  readonly method: FiniteHttpsMethod;
  readonly url: string;
  readonly headers: readonly FiniteHttpsHeader[];
  readonly body: Uint8Array;
}

export interface FiniteHttpsBrokerObservation {
  readonly code: FiniteHttpsBrokerCode;
  readonly authorityDigest: string;
  readonly operationsDigest: string;
  readonly operationIdDigest: string;
  readonly operationDigest: string;
  readonly attemptCount: number;
  readonly dnsResolutionCount: number;
  readonly redirectCount: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly destinationSetDigest: string;
  readonly responseHeadersDigest: string;
  readonly responseBodySha256: string;
  readonly statusCode: number | null;
}

export interface FiniteHttpsBrokerResult extends FiniteHttpsBrokerObservation {
  readonly code: "OBS_BROKER_ALLOWED";
}

export class FiniteHttpsBrokerError extends Error {
  readonly code: Exclude<FiniteHttpsBrokerCode, "OBS_BROKER_ALLOWED">;
  readonly observation: FiniteHttpsBrokerObservation;

  constructor(code: Exclude<FiniteHttpsBrokerCode, "OBS_BROKER_ALLOWED">, observation: FiniteHttpsBrokerObservation) {
    super(code);
    this.name = "FiniteHttpsBrokerError";
    this.code = code;
    this.observation = observation;
  }
}

export interface FiniteHttpsBroker {
  readonly authorityDigest: string;
  readonly operationsDigest: string;
  readonly execute: (context: CapabilityContext, invocation: FiniteHttpsInvocation) => Promise<FiniteHttpsBrokerResult>;
}

export type FiniteHttpsDnsResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface FiniteHttpsTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface FiniteHttpsTransportRequest {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly method: FiniteHttpsMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly pinnedAddress: string;
  readonly pinnedFamily: 4 | 6;
  readonly deadlineMs: number;
}

export type FiniteHttpsTransport = (request: FiniteHttpsTransportRequest) => Promise<FiniteHttpsTransportResponse>;

export interface FiniteHttpsBrokerOptions {
  /** Resolver injection is intended for a trusted composition root; every returned address is still independently filtered. */
  readonly resolve?: FiniteHttpsDnsResolver;
  /** Deterministic transport for isolated core tests. Production composition must omit it. */
  readonly transport?: FiniteHttpsTransport;
}

interface CanonicalUrl {
  readonly serialized: string;
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly path: string;
}

interface CompiledOperation extends FiniteHttpsOperationDefinition {
  readonly headers: readonly FiniteHttpsHeader[];
  readonly redirects: readonly string[];
  readonly limits: FiniteHttpsLimits;
  readonly destination: CanonicalUrl;
  readonly redirectDestinations: readonly CanonicalUrl[];
  readonly digest: string;
}

interface MutableObservation {
  operationIdDigest: string;
  operationDigest: string;
  attemptCount: number;
  dnsResolutionCount: number;
  redirectCount: number;
  requestBytes: number;
  responseBytes: number;
  destinationSetDigests: string[];
  responseHeaderDigests: string[];
  responseBodyDigests: string[];
  statusCode: number | null;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/u;
const METHODS = new Set<FiniteHttpsMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_URL_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DEADLINE_MS = 120_000;
const MAX_REDIRECTS = 8;
const BODY_CHUNK_BYTES = 64 * 1024;
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const FORBIDDEN_HEADERS = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate", "www-authenticate", "authentication-info",
  "cookie", "cookie2", "set-cookie", "host", "content-length", "transfer-encoding", "connection",
  "proxy-connection", "upgrade", "te", "trailer", "keep-alive", "expect", "via", "forwarded",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-api-key", "api-key", "x-auth-token", "x-access-token",
]);
const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".invalid"] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0`).update(JSON.stringify(canonicalize(value))).digest("hex");
}

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new TypeError(`${label} keys differ`);
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function canonicalUrl(input: unknown, label: string, deniedCode?: FiniteHttpsBrokerCode): CanonicalUrl {
  if (typeof input !== "string" || !input || Buffer.byteLength(input) > MAX_URL_BYTES) {
    if (deniedCode) throw deniedCode;
    throw new TypeError(`${label} is invalid`);
  }
  let parsed: URL;
  try { parsed = new URL(input); }
  catch {
    if (deniedCode) throw deniedCode;
    throw new TypeError(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:") {
    if (deniedCode) throw "EXEC_BROKER_SCHEME_DENIED" satisfies FiniteHttpsBrokerCode;
    throw new TypeError(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    if (deniedCode) throw "EXEC_BROKER_HOST_DENIED" satisfies FiniteHttpsBrokerCode;
    throw new TypeError(`${label} contains credentials or a fragment`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.endsWith(".") || hostname !== parsed.hostname || isIP(hostname) !== 0
    || domainToASCII(hostname) !== hostname || hostname.length > 253
    || hostname === "localhost" || FORBIDDEN_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
    || hostname.split(".").some(labelValue => !labelValue || labelValue.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(labelValue))) {
    if (deniedCode) throw "EXEC_BROKER_HOST_DENIED" satisfies FiniteHttpsBrokerCode;
    throw new TypeError(`${label} hostname is not canonical ASCII/punycode`);
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (deniedCode) throw "EXEC_BROKER_PORT_DENIED" satisfies FiniteHttpsBrokerCode;
    throw new TypeError(`${label} port is invalid`);
  }
  if (parsed.toString() !== input || parsed.pathname.includes("\\") || /%(?:00|0a|0d|2f|5c)/iu.test(parsed.pathname)) {
    if (deniedCode) throw "EXEC_BROKER_HOST_DENIED" satisfies FiniteHttpsBrokerCode;
    throw new TypeError(`${label} is not canonical`);
  }
  return Object.freeze({ serialized: input, hostname, port, origin: parsed.origin, path: `${parsed.pathname}${parsed.search}` });
}

function canonicalHeaders(input: unknown, label: string): readonly FiniteHttpsHeader[] {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  let bytes = 0;
  let previous = "";
  const result = input.map((entry, index) => {
    exactKeys(entry, ["name", "value"], `${label}[${index}]`);
    const name = entry.name;
    const value = entry.value;
    if (typeof name !== "string" || name !== name.toLowerCase() || !HEADER_NAME.test(name)
      || FORBIDDEN_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")
      || typeof value !== "string" || value !== value.trim() || Buffer.byteLength(value) > 8 * 1024 || !/^[\x20-\x7e]*$/u.test(value)) {
      throw new TypeError(`${label}[${index}] is forbidden`);
    }
    if (name <= previous) throw new TypeError(`${label} must be uniquely sorted by name`);
    previous = name;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    return Object.freeze({ name, value });
  });
  if (bytes > MAX_HEADER_BYTES) throw new TypeError(`${label} exceeds its bound`);
  return Object.freeze(result);
}

function canonicalLimits(input: unknown): FiniteHttpsLimits {
  exactKeys(input, ["deadlineMs", "maxRedirects", "maxRequestBytes", "maxResponseBytes"], "broker limits");
  return Object.freeze({
    maxRequestBytes: safeInteger(input.maxRequestBytes, 1, MAX_REQUEST_BYTES, "maxRequestBytes"),
    maxResponseBytes: safeInteger(input.maxResponseBytes, 1, MAX_RESPONSE_BYTES, "maxResponseBytes"),
    deadlineMs: safeInteger(input.deadlineMs, 1, MAX_DEADLINE_MS, "deadlineMs"),
    maxRedirects: safeInteger(input.maxRedirects, 0, MAX_REDIRECTS, "maxRedirects"),
  });
}

function canonicalOrigin(input: unknown, label: string): CanonicalUrl {
  if (typeof input !== "string" || !input || input.endsWith("/")) throw new TypeError(`${label} is invalid`);
  const destination = canonicalUrl(`${input}/`, label);
  if (destination.origin !== input) throw new TypeError(`${label} is not a canonical HTTPS origin`);
  return destination;
}

function compileOperation(input: unknown, allowedOrigins: ReadonlySet<string>): CompiledOperation {
  exactKeys(input, ["bodyBytes", "bodySha256", "headers", "limits", "method", "operationId", "redirects", "url", "version"], "finite HTTPS operation");
  if (input.version !== 1 || typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId)
    || typeof input.method !== "string" || !METHODS.has(input.method as FiniteHttpsMethod)
    || typeof input.bodySha256 !== "string" || !SHA256.test(input.bodySha256)) {
    throw new TypeError("finite HTTPS operation identity is invalid");
  }
  const method = input.method as FiniteHttpsMethod;
  const bodyBytes = safeInteger(input.bodyBytes, 0, MAX_REQUEST_BYTES, "bodyBytes");
  if ((method === "GET" || method === "HEAD") && (bodyBytes !== 0 || input.bodySha256 !== EMPTY_SHA256)) {
    throw new TypeError("GET and HEAD operations cannot carry a body");
  }
  const headers = canonicalHeaders(input.headers, "operation headers");
  const limits = canonicalLimits(input.limits);
  const destination = canonicalUrl(input.url, "operation URL");
  if (!allowedOrigins.has(destination.origin)) throw new TypeError("operation origin is outside the capability allowlist");
  if (!Array.isArray(input.redirects) || input.redirects.length > limits.maxRedirects) throw new TypeError("operation redirects are invalid");
  const redirectDestinations = input.redirects.map((value, index) => canonicalUrl(value, `operation redirect ${index}`));
  if (redirectDestinations.some(value => !allowedOrigins.has(value.origin))) throw new TypeError("operation redirect is outside the capability allowlist");
  const redirects = Object.freeze(redirectDestinations.map(value => value.serialized));
  const canonical = Object.freeze({
    version: 1 as const,
    operationId: input.operationId,
    method,
    url: destination.serialized,
    headers,
    bodyBytes,
    bodySha256: input.bodySha256,
    redirects,
    limits,
  });
  return Object.freeze({ ...canonical, destination, redirectDestinations: Object.freeze(redirectDestinations), digest: digest("mini-lux/sec03/finite-https-operation/v1", canonical) });
}

function authorityValue(context: CapabilityContext): unknown {
  return {
    contextId: context.contextId,
    executionDomainId: context.executionDomainId,
    sessionId: context.sessionId,
    runId: context.runId,
    principal: context.principal,
    persona: context.persona,
    authorityEpoch: context.authorityEpoch,
    networkPolicy: context.networkPolicy,
  };
}

function validateAuthority(context: CapabilityContext): readonly CanonicalUrl[] {
  if (!context || typeof context.contextId !== "string" || !context.contextId
    || typeof context.executionDomainId !== "string" || !context.executionDomainId
    || typeof context.sessionId !== "string" || !context.sessionId
    || typeof context.runId !== "string" || !context.runId
    || !Number.isSafeInteger(context.authorityEpoch) || context.authorityEpoch < 1
    || !context.persona || typeof context.persona.name !== "string" || !context.persona.name
    || typeof context.persona.digest !== "string" || !SHA256.test(context.persona.digest)
    || context.networkPolicy?.mode !== "allowlist") {
    throw new TypeError("finite HTTPS broker authority is invalid");
  }
  const origins = context.networkPolicy.origins;
  if (!Array.isArray(origins) || origins.length === 0 || new Set(origins).size !== origins.length) throw new TypeError("finite HTTPS broker allowlist is invalid");
  return Object.freeze(origins.map((origin, index) => canonicalOrigin(origin, `network origin ${index}`)));
}

const forbiddenIpv4Addresses = new BlockList();
const forbiddenIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbiddenIpv4Addresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28], ["2001:db8::", 32],
  ["2002::", 16], ["3ffe::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) forbiddenIpv6Addresses.addSubnet(network, prefix, "ipv6");

function canonicalAddress(address: unknown, family: unknown): Readonly<{ address: string; family: 4 | 6 }> {
  if (typeof address !== "string" || (family !== 4 && family !== 6) || isIP(address) !== family) throw "EXEC_BROKER_PRIVATE_ADDRESS_DENIED" satisfies FiniteHttpsBrokerCode;
  let normalized = address.toLowerCase();
  if (family === 6) {
    try { normalized = new URL(`https://[${normalized}]/`).hostname.slice(1, -1); }
    catch { throw "EXEC_BROKER_PRIVATE_ADDRESS_DENIED" satisfies FiniteHttpsBrokerCode; }
  }
  const forbidden = family === 4
    ? forbiddenIpv4Addresses.check(normalized, "ipv4")
    : forbiddenIpv6Addresses.check(normalized, "ipv6");
  if (forbidden) throw "EXEC_BROKER_PRIVATE_ADDRESS_DENIED" satisfies FiniteHttpsBrokerCode;
  return Object.freeze({ address: normalized, family });
}

function canonicalAddressSet(input: readonly LookupAddress[]): readonly Readonly<{ address: string; family: 4 | 6 }>[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw "EXEC_BROKER_HOST_DENIED" satisfies FiniteHttpsBrokerCode;
  const values = input.map(value => canonicalAddress(value?.address, value?.family));
  const byKey = new Map(values.map(value => [`${value.family}:${value.address}`, value]));
  return Object.freeze([...byKey.values()].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address)));
}

function sameAddressSet(left: readonly Readonly<{ address: string; family: 4 | 6 }>[], right: readonly Readonly<{ address: string; family: 4 | 6 }>[]): boolean {
  return left.length === right.length && left.every((value, index) => value.family === right[index]!.family && value.address === right[index]!.address);
}

function defaultResolver(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

type DenialCode = Exclude<FiniteHttpsBrokerCode, "OBS_BROKER_ALLOWED">;

class BrokerFailure extends Error {
  constructor(readonly code: DenialCode) { super(code); }
}

const DENIAL_CODES = new Set<DenialCode>([
  "EXEC_BROKER_SCHEME_DENIED", "EXEC_BROKER_HOST_DENIED", "EXEC_BROKER_PORT_DENIED",
  "EXEC_BROKER_PRIVATE_ADDRESS_DENIED", "EXEC_BROKER_DNS_REBIND_DENIED", "EXEC_BROKER_REDIRECT_DENIED",
  "EXEC_BROKER_REQUEST_LIMIT", "EXEC_BROKER_RESPONSE_LIMIT", "EXEC_BROKER_TIMEOUT",
]);

function failureCode(error: unknown): DenialCode {
  if (error instanceof BrokerFailure) return error.code;
  if (typeof error === "string" && DENIAL_CODES.has(error as DenialCode)) return error as DenialCode;
  return "EXEC_BROKER_HOST_DENIED";
}

function ensureDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new BrokerFailure("EXEC_BROKER_TIMEOUT");
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BrokerFailure("EXEC_BROKER_TIMEOUT");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrokerFailure("EXEC_BROKER_TIMEOUT")), remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function setDigest(values: readonly Readonly<{ address: string; family: 4 | 6 }>[]): string {
  return digest("mini-lux/sec03/finite-https-destination-set/v1", values);
}

async function resolvePinned(
  hostname: string,
  resolver: FiniteHttpsDnsResolver,
  deadline: number,
  observation: MutableObservation,
): Promise<Readonly<{ address: string; family: 4 | 6 }>> {
  let first: readonly Readonly<{ address: string; family: 4 | 6 }>[];
  let second: readonly Readonly<{ address: string; family: 4 | 6 }>[];
  try {
    observation.dnsResolutionCount += 1;
    const firstRaw = await beforeDeadline(Promise.resolve().then(() => resolver(hostname)), deadline);
    first = canonicalAddressSet(firstRaw);
    observation.dnsResolutionCount += 1;
    const secondRaw = await beforeDeadline(Promise.resolve().then(() => resolver(hostname)), deadline);
    second = canonicalAddressSet(secondRaw);
  } catch (error) {
    throw new BrokerFailure(failureCode(error));
  }
  if (!sameAddressSet(first, second)) throw new BrokerFailure("EXEC_BROKER_DNS_REBIND_DENIED");
  observation.destinationSetDigests.push(setDigest(first));
  return first[0]!;
}

function responseHeadersDigest(headers: Readonly<Record<string, string | readonly string[] | undefined>>): string {
  const canonical: Record<string, string | readonly string[]> = {};
  for (const name of Object.keys(headers).sort()) {
    const value = headers[name];
    if (typeof value === "string") canonical[name] = value;
    else if (Array.isArray(value)) canonical[name] = Object.freeze([...value]);
  }
  return digest("mini-lux/sec03/finite-https-response-headers/v1", canonical);
}

function requestHeaders(headers: readonly FiniteHttpsHeader[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(headers.map(header => [header.name, header.value])));
}

interface HopResult {
  readonly statusCode: number;
  readonly location: string | null;
}

async function requestHop(
  destination: CanonicalUrl,
  method: FiniteHttpsMethod,
  headers: readonly FiniteHttpsHeader[],
  body: Buffer,
  pinned: Readonly<{ address: string; family: 4 | 6 }>,
  limits: FiniteHttpsLimits,
  deadline: number,
  observation: MutableObservation,
  transport?: FiniteHttpsTransport,
): Promise<HopResult> {
  ensureDeadline(deadline);
  observation.attemptCount += 1;
  if (transport) {
    for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) {
      ensureDeadline(deadline);
      const chunk = body.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, body.length));
      if (observation.requestBytes + chunk.length > limits.maxRequestBytes) throw new BrokerFailure("EXEC_BROKER_REQUEST_LIMIT");
      observation.requestBytes += chunk.length;
    }
    const response = await beforeDeadline(transport(Object.freeze({
      hostname: destination.hostname,
      port: destination.port,
      path: destination.path,
      method,
      headers: requestHeaders(headers),
      body: Buffer.from(body),
      pinnedAddress: pinned.address,
      pinnedFamily: pinned.family,
      deadlineMs: deadline,
    })), deadline);
    if (!response || !Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599
      || !response.headers || typeof response.headers !== "object" || !response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
      throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    }
    observation.statusCode = response.statusCode;
    observation.responseHeaderDigests.push(responseHeadersDigest(response.headers));
    const bodyHash = createHash("sha256");
    const iterator = response.body[Symbol.asyncIterator]();
    for (;;) {
      const next = await beforeDeadline(iterator.next(), deadline);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      if (observation.responseBytes + chunk.length > limits.maxResponseBytes) throw new BrokerFailure("EXEC_BROKER_RESPONSE_LIMIT");
      observation.responseBytes += chunk.length;
      bodyHash.update(chunk);
    }
    observation.responseBodyDigests.push(bodyHash.digest("hex"));
    const rawLocation = response.headers.location;
    return Object.freeze({ statusCode: response.statusCode, location: typeof rawLocation === "string" ? rawLocation : null });
  }
  const options: RequestOptions = {
    protocol: "https:",
    hostname: destination.hostname,
    port: destination.port,
    path: destination.path,
    method,
    headers: requestHeaders(headers),
    agent: false,
    rejectUnauthorized: true,
    servername: destination.hostname,
    maxHeaderSize: MAX_HEADER_BYTES,
    family: pinned.family,
    lookup: (_hostname, lookupOptions, callback) => {
      const requestedFamily = typeof lookupOptions === "number" ? lookupOptions : lookupOptions?.family;
      if (requestedFamily && requestedFamily !== pinned.family) {
        callback(Object.assign(new Error("pinned address family mismatch"), { code: "EAI_FAIL" }), pinned.address, pinned.family);
        return;
      }
      if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    },
  };

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: HopResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new BrokerFailure("EXEC_BROKER_TIMEOUT")); return; }
    const request = https.request(options);
    const timer = setTimeout(() => request.destroy(new BrokerFailure("EXEC_BROKER_TIMEOUT")), remaining);
    const writePromise = (async () => {
      for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) {
        ensureDeadline(deadline);
        const chunk = body.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, body.length));
        if (observation.requestBytes + chunk.length > limits.maxRequestBytes) throw new BrokerFailure("EXEC_BROKER_REQUEST_LIMIT");
        observation.requestBytes += chunk.length;
        if (!request.write(chunk)) await once(request, "drain");
      }
      request.end();
    })();
    void writePromise.catch(error => request.destroy(error instanceof Error ? error : new BrokerFailure(failureCode(error))));
    request.once("error", error => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      finish(code === "HPE_HEADER_OVERFLOW" ? new BrokerFailure("EXEC_BROKER_RESPONSE_LIMIT") : error);
    });
    request.once("response", response => {
      void (async () => {
        const statusCode = response.statusCode;
        if (!Number.isInteger(statusCode) || statusCode! < 100 || statusCode! > 599) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
        observation.statusCode = statusCode!;
        observation.responseHeaderDigests.push(responseHeadersDigest(response.headers));
        const bodyHash = createHash("sha256");
        for await (const value of response) {
          ensureDeadline(deadline);
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          if (observation.responseBytes + chunk.length > limits.maxResponseBytes) {
            response.destroy();
            throw new BrokerFailure("EXEC_BROKER_RESPONSE_LIMIT");
          }
          observation.responseBytes += chunk.length;
          bodyHash.update(chunk);
        }
        await writePromise;
        observation.responseBodyDigests.push(bodyHash.digest("hex"));
        const rawLocation = response.headers.location;
        const location = typeof rawLocation === "string" ? rawLocation : null;
        finish(null, Object.freeze({ statusCode: statusCode!, location }));
      })().catch(error => {
        response.destroy();
        request.destroy();
        finish(error);
      });
    });
  });
}

function operationValue(operation: CompiledOperation): FiniteHttpsOperationDefinition {
  return Object.freeze({
    version: operation.version,
    operationId: operation.operationId,
    method: operation.method,
    url: operation.url,
    headers: operation.headers,
    bodyBytes: operation.bodyBytes,
    bodySha256: operation.bodySha256,
    redirects: operation.redirects,
    limits: operation.limits,
  });
}

function freezeObservation(
  code: FiniteHttpsBrokerCode,
  authorityDigest: string,
  operationsDigest: string,
  mutable: MutableObservation,
): FiniteHttpsBrokerObservation {
  return Object.freeze({
    code,
    authorityDigest,
    operationsDigest,
    operationIdDigest: mutable.operationIdDigest,
    operationDigest: mutable.operationDigest,
    attemptCount: mutable.attemptCount,
    dnsResolutionCount: mutable.dnsResolutionCount,
    redirectCount: mutable.redirectCount,
    requestBytes: mutable.requestBytes,
    responseBytes: mutable.responseBytes,
    destinationSetDigest: digest("mini-lux/sec03/finite-https-destination-chain/v1", mutable.destinationSetDigests),
    responseHeadersDigest: digest("mini-lux/sec03/finite-https-response-header-chain/v1", mutable.responseHeaderDigests),
    responseBodySha256: digest("mini-lux/sec03/finite-https-response-body-chain/v1", mutable.responseBodyDigests),
    statusCode: mutable.statusCode,
  });
}

function denied(
  code: DenialCode,
  authorityDigest: string,
  operationsDigest: string,
  mutable: MutableObservation,
): never {
  throw new FiniteHttpsBrokerError(code, freezeObservation(code, authorityDigest, operationsDigest, mutable));
}

function invocationBody(input: unknown): Buffer {
  if (!(input instanceof Uint8Array)) throw new BrokerFailure("EXEC_BROKER_REQUEST_LIMIT");
  return Buffer.from(input);
}

function validateInvocation(invocation: unknown, operation: CompiledOperation | undefined): Readonly<{ operation: CompiledOperation; body: Buffer }> {
  try {
    exactKeys(invocation, ["body", "headers", "method", "operationId", "url"], "finite HTTPS invocation");
    if (!operation || invocation.operationId !== operation.operationId) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    if (typeof invocation.method !== "string" || !METHODS.has(invocation.method as FiniteHttpsMethod) || invocation.method !== operation.method) {
      throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    }
    let destination: CanonicalUrl;
    try { destination = canonicalUrl(invocation.url, "invocation URL", "EXEC_BROKER_HOST_DENIED"); }
    catch (error) { throw new BrokerFailure(failureCode(error)); }
    if (destination.hostname !== operation.destination.hostname) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    if (destination.port !== operation.destination.port) throw new BrokerFailure("EXEC_BROKER_PORT_DENIED");
    if (destination.serialized !== operation.destination.serialized) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    let headers: readonly FiniteHttpsHeader[];
    try { headers = canonicalHeaders(invocation.headers, "invocation headers"); }
    catch { throw new BrokerFailure("EXEC_BROKER_HOST_DENIED"); }
    if (JSON.stringify(headers) !== JSON.stringify(operation.headers)) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    const body = invocationBody(invocation.body);
    if (body.length > operation.limits.maxRequestBytes) throw new BrokerFailure("EXEC_BROKER_REQUEST_LIMIT");
    const bodyDigest = createHash("sha256").update(body).digest("hex");
    if (body.length !== operation.bodyBytes || bodyDigest !== operation.bodySha256) throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
    return Object.freeze({ operation, body });
  } catch (error) {
    if (error instanceof BrokerFailure) throw error;
    throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
  }
}

function redirectDestination(current: CanonicalUrl, location: string | null): CanonicalUrl {
  if (!location || Buffer.byteLength(location) > MAX_URL_BYTES) throw new BrokerFailure("EXEC_BROKER_REDIRECT_DENIED");
  try {
    const resolved = new URL(location, current.serialized).toString();
    return canonicalUrl(resolved, "redirect URL");
  } catch {
    throw new BrokerFailure("EXEC_BROKER_REDIRECT_DENIED");
  }
}

function redirectedRequest(statusCode: number, method: FiniteHttpsMethod, body: Buffer): Readonly<{ method: FiniteHttpsMethod; body: Buffer }> {
  if (statusCode === 303 && method !== "HEAD") return Object.freeze({ method: "GET", body: Buffer.alloc(0) });
  if ((statusCode === 301 || statusCode === 302) && method === "POST") return Object.freeze({ method: "GET", body: Buffer.alloc(0) });
  return Object.freeze({ method, body });
}

export function createFiniteHttpsBroker(
  authority: CapabilityContext,
  definitions: readonly FiniteHttpsOperationDefinition[],
  options: FiniteHttpsBrokerOptions = {},
): FiniteHttpsBroker {
  const origins = validateAuthority(authority);
  const allowedOrigins = new Set(origins.map(value => value.origin));
  if (!Array.isArray(definitions) || definitions.length === 0 || definitions.length > 256) throw new TypeError("finite HTTPS operations are invalid");
  const operations = definitions.map(definition => compileOperation(definition, allowedOrigins));
  if (operations.some((operation, index) => index > 0 && operation.operationId <= operations[index - 1]!.operationId)) {
    throw new TypeError("finite HTTPS operations must have unique sorted IDs");
  }
  if (options.resolve !== undefined && typeof options.resolve !== "function") throw new TypeError("finite HTTPS resolver is invalid");
  if (options.transport !== undefined && typeof options.transport !== "function") throw new TypeError("finite HTTPS transport is invalid");
  const resolver = options.resolve ?? defaultResolver;
  const transport = options.transport;
  const authorityDigest = digest("mini-lux/sec03/finite-https-authority/v1", authorityValue(authority));
  const operationsDigest = digest("mini-lux/sec03/finite-https-operations/v1", operations.map(operationValue));
  const byId = new Map(operations.map(operation => [operation.operationId, operation]));

  const execute = async (currentAuthority: CapabilityContext, invocation: FiniteHttpsInvocation): Promise<FiniteHttpsBrokerResult> => {
    const operationId = invocation && typeof invocation === "object" && typeof invocation.operationId === "string" ? invocation.operationId : "invalid";
    const mutable: MutableObservation = {
      operationIdDigest: digest("mini-lux/sec03/finite-https-operation-id/v1", operationId),
      operationDigest: EMPTY_SHA256,
      attemptCount: 0,
      dnsResolutionCount: 0,
      redirectCount: 0,
      requestBytes: 0,
      responseBytes: 0,
      destinationSetDigests: [],
      responseHeaderDigests: [],
      responseBodyDigests: [],
      statusCode: null,
    };
    const selected = byId.get(operationId);
    if (selected) mutable.operationDigest = selected.digest;
    try {
      validateAuthority(currentAuthority);
      if (currentAuthority !== authority
        || digest("mini-lux/sec03/finite-https-authority/v1", authorityValue(currentAuthority)) !== authorityDigest) {
        throw new BrokerFailure("EXEC_BROKER_HOST_DENIED");
      }
      const validated = validateInvocation(invocation, selected);
      const deadline = Date.now() + validated.operation.limits.deadlineMs;
      let destination = validated.operation.destination;
      let method = validated.operation.method;
      let body = validated.body;
      let redirectIndex = 0;
      for (;;) {
        ensureDeadline(deadline);
        const pinned = await resolvePinned(destination.hostname, resolver, deadline, mutable);
        const response = await requestHop(destination, method, validated.operation.headers, body, pinned, validated.operation.limits, deadline, mutable, transport);
        if (!REDIRECT_CODES.has(response.statusCode)) {
          if (redirectIndex !== validated.operation.redirectDestinations.length) throw new BrokerFailure("EXEC_BROKER_REDIRECT_DENIED");
          const result = freezeObservation("OBS_BROKER_ALLOWED", authorityDigest, operationsDigest, mutable);
          return result as FiniteHttpsBrokerResult;
        }
        if (redirectIndex >= validated.operation.limits.maxRedirects || redirectIndex >= validated.operation.redirectDestinations.length) {
          throw new BrokerFailure("EXEC_BROKER_REDIRECT_DENIED");
        }
        const next = redirectDestination(destination, response.location);
        const expected = validated.operation.redirectDestinations[redirectIndex]!;
        if (next.serialized !== expected.serialized) throw new BrokerFailure("EXEC_BROKER_REDIRECT_DENIED");
        const redirected = redirectedRequest(response.statusCode, method, body);
        destination = expected;
        method = redirected.method;
        body = redirected.body;
        redirectIndex += 1;
        mutable.redirectCount = redirectIndex;
      }
    } catch (error) {
      if (error instanceof FiniteHttpsBrokerError) throw error;
      denied(failureCode(error), authorityDigest, operationsDigest, mutable);
    }
  };

  return Object.freeze({ authorityDigest, operationsDigest, execute });
}
