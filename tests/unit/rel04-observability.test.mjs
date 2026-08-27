import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../../dist/logger.js";
import { LLMClient } from "../../dist/llm.js";
import {
  beginObservation,
  createHealthSnapshot,
  currentObservabilityContext,
  observabilityMetricsSnapshot,
  resetObservabilityForTests,
  runWithObservabilityContext,
  serializeDiagnosticBundle,
  updateObservabilityContext,
} from "../../dist/observability.js";

test.beforeEach(() => resetObservabilityForTests());

test("REL-04 propagates request/session/run correlation into bounded structured logs", async () => {
  const secret = "rel04-secret-must-not-log";
  const calls = [];
  const original = console.log;
  console.log = value => calls.push(String(value));
  try {
    await runWithObservabilityContext({ requestId: "request-1", sessionId: null, runId: null }, async () => {
      updateObservabilityContext({ sessionId: "session-1", runId: "run-1" });
      await Promise.resolve();
      assert.deepEqual(currentObservabilityContext(), {
        requestId: "request-1",
        sessionId: "session-1",
        runId: "run-1",
      });
      logger.error("provider", `authorization=Bearer ${secret}`, {
        prompt: secret,
        nested: { message: secret, safe: "retained" },
      });
    });
  } finally {
    console.log = original;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes(secret), false);
  const entry = JSON.parse(calls[0]);
  assert.deepEqual(entry.correlation, { requestId: "request-1", sessionId: "session-1", runId: "run-1" });
  assert.equal(entry.data.prompt, "[REDACTED]");
  assert.equal(entry.data.nested.message, "[REDACTED]");
  assert.equal(entry.data.nested.safe, "retained");
});

test("REL-04 exposes fixed-cardinality aggregate metrics without labels or payloads", () => {
  const observation = beginObservation("tool");
  observation.retry();
  observation.finish("denied", { bytesIn: 17, bytesOut: 23 });
  observation.finish("success", { bytesIn: 999, bytesOut: 999 });

  const snapshot = observabilityMetricsSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["database", "http", "llm", "pty", "tool"]);
  assert.equal(snapshot.tool.total, 1);
  assert.equal(snapshot.tool.active, 0);
  assert.equal(snapshot.tool.retries, 1);
  assert.equal(snapshot.tool.bytesIn, 17);
  assert.equal(snapshot.tool.bytesOut, 23);
  assert.equal(snapshot.tool.outcomes.denied, 1);
  assert.equal(snapshot.tool.outcomes.success, 0);
  assert.equal(snapshot.tool.durationMs.count, 1);
  assert.deepEqual(Object.keys(snapshot.tool.durationMs.buckets), ["le10", "le50", "le100", "le500", "le1000", "le5000", "le30000"]);
  assert.equal(JSON.stringify(snapshot).includes("arguments"), false);
});

test("REL-04 LLM client records aggregate outcomes without retaining Provider payloads", async () => {
  const client = new LLMClient({
    apiKey: "rel04-test-key",
    baseURL: "https://provider.invalid/v1",
    model: "rel04-model",
    providerType: "openai-compatible",
  });
  client.client = {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: "provider-result", tool_calls: [] } }] };
        },
      },
    },
  };
  const response = await client.chat([{ role: "user", content: "private-prompt" }]);
  assert.equal(response.content, "provider-result");
  const metric = observabilityMetricsSnapshot().llm;
  assert.equal(metric.total, 1);
  assert.equal(metric.outcomes.success, 1);
  assert.equal(metric.bytesOut, Buffer.byteLength("provider-result"));
  assert.equal(JSON.stringify(metric).includes("private-prompt"), false);
  assert.equal(JSON.stringify(metric).includes("provider-result"), false);
});

test("REL-04 health contract distinguishes live, ready and degraded states", () => {
  const base = {
    shuttingDown: false,
    databaseSchemaVersion: 11,
    expectedDatabaseSchemaVersion: 11,
    securityAuditIntegrity: "verified",
    runtimeRegistryAvailable: true,
    providerConfigured: true,
    buildId: "0.1.0+local.rel04",
    uptimeSeconds: 12.9,
  };
  const ready = createHealthSnapshot(base);
  assert.deepEqual({ status: ready.status, live: ready.live, ready: ready.ready, degraded: ready.degraded, reasons: ready.reasons }, {
    status: "ready", live: true, ready: true, degraded: false, reasons: [],
  });

  const degraded = createHealthSnapshot({ ...base, providerConfigured: false });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.live, true);
  assert.equal(degraded.ready, true);
  assert.deepEqual(degraded.reasons, ["provider_unconfigured"]);

  const liveOnly = createHealthSnapshot({ ...base, databaseSchemaVersion: null });
  assert.equal(liveOnly.status, "live");
  assert.equal(liveOnly.live, true);
  assert.equal(liveOnly.ready, false);
  assert.deepEqual(liveOnly.reasons, ["database_schema_unavailable"]);

  const stopping = createHealthSnapshot({ ...base, shuttingDown: true });
  assert.equal(stopping.status, "degraded");
  assert.equal(stopping.live, false);
  assert.equal(stopping.ready, false);
});

test("REL-04 diagnostic serialization is bounded and rejects sensitive field names", () => {
  const safe = serializeDiagnosticBundle({ schemaVersion: 1, metrics: observabilityMetricsSnapshot() }, 64 * 1024);
  assert.equal(JSON.parse(safe).schemaVersion, 1);
  assert.throws(() => serializeDiagnosticBundle({ apiKey: "forbidden" }), /forbidden field/u);
  assert.throws(() => serializeDiagnosticBundle({ nested: { prompt: "forbidden" } }), /forbidden field/u);
  assert.throws(() => serializeDiagnosticBundle({ payload: "x".repeat(1024) }, 128), /byte limit/u);
});
