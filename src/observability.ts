import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type ObservabilityDomain = "http" | "llm" | "tool" | "database" | "pty";
export type ObservabilityOutcome = "success" | "error" | "denied" | "cancelled" | "timeout";
export type HealthStatus = "live" | "ready" | "degraded";

export interface ObservabilityContext {
  requestId: string;
  sessionId: string | null;
  runId: string | null;
}

type MutableObservabilityContext = ObservabilityContext;

interface DomainMetrics {
  total: number;
  active: number;
  retries: number;
  bytesIn: number;
  bytesOut: number;
  outcomes: Record<ObservabilityOutcome, number>;
  durationCount: number;
  durationSum: number;
  durationMax: number;
  durationBuckets: number[];
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DURATION_BUCKETS_MS = Object.freeze([10, 50, 100, 500, 1_000, 5_000, 30_000]);
const domains = Object.freeze<ObservabilityDomain[]>(["http", "llm", "tool", "database", "pty"]);
const contextStorage = new AsyncLocalStorage<MutableObservabilityContext>();

function emptyMetrics(): DomainMetrics {
  return {
    total: 0,
    active: 0,
    retries: 0,
    bytesIn: 0,
    bytesOut: 0,
    outcomes: { success: 0, error: 0, denied: 0, cancelled: 0, timeout: 0 },
    durationCount: 0,
    durationSum: 0,
    durationMax: 0,
    durationBuckets: DURATION_BUCKETS_MS.map(() => 0),
  };
}

const metrics = new Map<ObservabilityDomain, DomainMetrics>(domains.map(domain => [domain, emptyMetrics()]));

function boundedAdd(current: number, increment: number): number {
  const safeIncrement = Number.isFinite(increment) ? Math.max(0, Math.trunc(increment)) : 0;
  return Math.min(MAX_SAFE, current + safeIncrement);
}

function correlationValue(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

export function runWithObservabilityContext<T>(
  context: ObservabilityContext,
  action: () => T,
): T {
  const store: MutableObservabilityContext = {
    requestId: correlationValue(context.requestId, "requestId")!,
    sessionId: correlationValue(context.sessionId, "sessionId"),
    runId: correlationValue(context.runId, "runId"),
  };
  return contextStorage.run(store, action);
}

export function updateObservabilityContext(update: Partial<Omit<ObservabilityContext, "requestId">>): void {
  const store = contextStorage.getStore();
  if (!store) return;
  if (Object.hasOwn(update, "sessionId")) store.sessionId = correlationValue(update.sessionId ?? null, "sessionId");
  if (Object.hasOwn(update, "runId")) store.runId = correlationValue(update.runId ?? null, "runId");
}

export function currentObservabilityContext(): Readonly<ObservabilityContext> | null {
  const store = contextStorage.getStore();
  return store ? Object.freeze({ ...store }) : null;
}

export interface Observation {
  retry(): void;
  finish(outcome: ObservabilityOutcome, details?: Readonly<{ bytesIn?: number; bytesOut?: number }>): void;
}

export function beginObservation(domain: ObservabilityDomain): Observation {
  const target = metrics.get(domain)!;
  const started = performance.now();
  target.active = boundedAdd(target.active, 1);
  let finished = false;
  const observation: Observation = {
    retry(): void {
      if (!finished) target.retries = boundedAdd(target.retries, 1);
    },
    finish(outcome: ObservabilityOutcome, details: Readonly<{ bytesIn?: number; bytesOut?: number }> = {}): void {
      if (finished) return;
      finished = true;
      target.active = Math.max(0, target.active - 1);
      target.total = boundedAdd(target.total, 1);
      target.outcomes[outcome] = boundedAdd(target.outcomes[outcome], 1);
      target.bytesIn = boundedAdd(target.bytesIn, details.bytesIn ?? 0);
      target.bytesOut = boundedAdd(target.bytesOut, details.bytesOut ?? 0);
      const duration = Math.max(0, Math.round(performance.now() - started));
      target.durationCount = boundedAdd(target.durationCount, 1);
      target.durationSum = boundedAdd(target.durationSum, duration);
      target.durationMax = Math.max(target.durationMax, duration);
      DURATION_BUCKETS_MS.forEach((upperBound, index) => {
        if (duration <= upperBound) target.durationBuckets[index] = boundedAdd(target.durationBuckets[index], 1);
      });
    },
  };
  return Object.freeze(observation);
}

export function observabilityMetricsSnapshot(): Readonly<Record<ObservabilityDomain, Readonly<Record<string, unknown>>>> {
  const snapshot = {} as Record<ObservabilityDomain, Readonly<Record<string, unknown>>>;
  for (const domain of domains) {
    const value = metrics.get(domain)!;
    snapshot[domain] = Object.freeze({
      total: value.total,
      active: value.active,
      retries: value.retries,
      bytesIn: value.bytesIn,
      bytesOut: value.bytesOut,
      outcomes: Object.freeze({ ...value.outcomes }),
      durationMs: Object.freeze({
        count: value.durationCount,
        sum: value.durationSum,
        max: value.durationMax,
        buckets: Object.freeze(Object.fromEntries(DURATION_BUCKETS_MS.map((bound, index) => [`le${bound}`, value.durationBuckets[index]]))),
      }),
    });
  }
  return Object.freeze(snapshot);
}

export function resetObservabilityForTests(): void {
  for (const domain of domains) metrics.set(domain, emptyMetrics());
}

export interface HealthInputs {
  shuttingDown: boolean;
  databaseSchemaVersion: number | null;
  expectedDatabaseSchemaVersion: number;
  securityAuditIntegrity: "verified" | "failed" | "unavailable";
  runtimeRegistryAvailable: boolean;
  providerConfigured: boolean;
  buildId: string;
  uptimeSeconds: number;
}

export function createHealthSnapshot(input: HealthInputs): Readonly<Record<string, unknown>> {
  const reasons: string[] = [];
  const live = !input.shuttingDown;
  if (!live) reasons.push("shutting_down");
  if (input.databaseSchemaVersion !== input.expectedDatabaseSchemaVersion) reasons.push("database_schema_unavailable");
  if (input.securityAuditIntegrity !== "verified") reasons.push("security_audit_unavailable");
  if (!input.runtimeRegistryAvailable) reasons.push("runtime_registry_unavailable");
  const ready = live && reasons.length === 0;
  if (!input.providerConfigured) reasons.push("provider_unconfigured");
  const degraded = reasons.length > 0;
  const status: HealthStatus = !live ? "degraded" : !ready ? "live" : degraded ? "degraded" : "ready";
  return Object.freeze({
    schemaVersion: 1,
    status,
    live,
    ready,
    degraded,
    reasons: Object.freeze(reasons),
    buildId: input.buildId,
    uptimeSeconds: Math.max(0, Math.trunc(input.uptimeSeconds)),
  });
}

const forbiddenDiagnosticKey = /(?:api.?key|authorization|credential|password|secret|token|prompt|message)/iu;

function assertDiagnosticShape(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError("Diagnostic bundle contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertDiagnosticShape(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenDiagnosticKey.test(key)) throw new TypeError(`Diagnostic bundle contains a forbidden field: ${key}`);
    assertDiagnosticShape(entry, seen);
  }
}

export function serializeDiagnosticBundle(value: unknown, maxBytes = 256 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Diagnostic byte limit is invalid");
  assertDiagnosticShape(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("Diagnostic bundle exceeds the byte limit");
  return serialized;
}
