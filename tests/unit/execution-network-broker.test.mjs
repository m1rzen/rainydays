import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createFiniteHttpsBroker,
  FiniteHttpsBrokerError,
} from "../../dist/execution-network-broker.js";
import { ExecutionIsolationService } from "../../dist/execution-isolation.js";

const EMPTY_SHA256 = createHash("sha256").digest("hex");
const BODY = Buffer.from("body");
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");
const PUBLIC_ADDRESS = Object.freeze([{ address: "93.184.216.34", family: 4 }]);

function context(overrides = {}) {
  return Object.freeze({
    contextId: "broker-context",
    executionDomainId: "broker-domain",
    sessionId: "broker-session",
    runId: "broker-run",
    parentContextId: null,
    principal: "agent",
    persona: Object.freeze({ name: "broker-persona", digest: createHash("sha256").update("broker-persona").digest("hex") }),
    authorityEpoch: 1,
    allowedTools: Object.freeze([]),
    allowedRoots: Object.freeze([]),
    networkPolicy: Object.freeze({ mode: "allowlist", origins: Object.freeze(["https://broker.test", "https://redirect.test"]) }),
    allowedRiskClasses: Object.freeze(["network"]),
    approvalGrant: null,
    ...overrides,
  });
}

function limits(overrides = {}) {
  return Object.freeze({ maxRequestBytes: 1024, maxResponseBytes: 1024, deadlineMs: 1000, maxRedirects: 0, ...overrides });
}

function definition(overrides = {}) {
  const { body: overrideBody, ...definitionOverrides } = overrides;
  const method = definitionOverrides.method ?? "GET";
  const body = overrideBody ?? (method === "GET" || method === "HEAD" ? Buffer.alloc(0) : BODY);
  return Object.freeze({
    version: 1,
    operationId: "operation",
    method,
    url: "https://broker.test/ok",
    headers: Object.freeze([]),
    bodyBytes: body.length,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    redirects: Object.freeze([]),
    limits: limits(),
    ...definitionOverrides,
  });
}

function invocation(operation, overrides = {}) {
  const body = overrides.body ?? (operation.method === "GET" || operation.method === "HEAD" ? Buffer.alloc(0) : BODY);
  return Object.freeze({
    operationId: operation.operationId,
    method: operation.method,
    url: operation.url,
    headers: operation.headers,
    body,
    ...overrides,
  });
}

function response(statusCode = 200, chunks = [Buffer.from("ok")], headers = {}) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze(headers),
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  });
}

function broker(operation, options = {}) {
  const authority = context();
  return {
    authority,
    broker: createFiniteHttpsBroker(authority, [operation], {
      resolve: async () => PUBLIC_ADDRESS,
      transport: async () => response(),
      ...options,
    }),
  };
}

async function expectCode(promise, expected) {
  await assert.rejects(promise, error => {
    assert(error instanceof FiniteHttpsBrokerError);
    assert.equal(error.code, expected);
    assert.equal(error.observation.code, expected);
    assert.match(error.observation.authorityDigest, /^[a-f0-9]{64}$/u);
    assert.match(error.observation.operationsDigest, /^[a-f0-9]{64}$/u);
    return true;
  });
}

test("SEC-03 A05-01 finite broker permits only the exact frozen HTTPS operation", async () => {
  const operation = definition();
  let observedRequest;
  const fixture = broker(operation, {
    transport: async request => {
      observedRequest = request;
      return response(200, [Buffer.from("exact-response")], { "content-type": "text/plain" });
    },
  });
  const result = await fixture.broker.execute(fixture.authority, invocation(operation));
  assert.equal(result.code, "OBS_BROKER_ALLOWED");
  assert.equal(result.attemptCount, 1);
  assert.equal(result.dnsResolutionCount, 2);
  assert.equal(result.redirectCount, 0);
  assert.equal(result.requestBytes, 0);
  assert.equal(result.responseBytes, Buffer.byteLength("exact-response"));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(observedRequest, {
    hostname: "broker.test",
    port: 443,
    path: "/ok",
    method: "GET",
    headers: {},
    body: Buffer.alloc(0),
    pinnedAddress: PUBLIC_ADDRESS[0].address,
    pinnedFamily: 4,
    deadlineMs: observedRequest.deadlineMs,
  });
  assert.match(result.operationDigest, /^[a-f0-9]{64}$/u);
  assert.notEqual(result.operationDigest, EMPTY_SHA256);
  assert.equal(Object.isFrozen(result), true);
});

test("SEC-03 A05-01 validates every hop of an exact redirect chain", async () => {
  const operation = definition({
    redirects: Object.freeze(["https://redirect.test/final"]),
    limits: limits({ maxRedirects: 1 }),
  });
  let hop = 0;
  const fixture = broker(operation, {
    transport: async request => {
      hop += 1;
      return hop === 1
        ? response(302, [], { location: "https://redirect.test/final" })
        : response(204, [], {});
    },
  });
  const result = await fixture.broker.execute(fixture.authority, invocation(operation));
  assert.equal(result.code, "OBS_BROKER_ALLOWED");
  assert.equal(result.attemptCount, 2);
  assert.equal(result.dnsResolutionCount, 4);
  assert.equal(result.redirectCount, 1);
  assert.equal(hop, 2);
});

test("SEC-03 A05-02..04 reject scheme, host and effective-port mismatches before transport", async t => {
  const cases = [
    ["A05-02", "EXEC_BROKER_SCHEME_DENIED", "http://broker.test/ok"],
    ["A05-03", "EXEC_BROKER_HOST_DENIED", "https://other.test/ok"],
    ["A05-04", "EXEC_BROKER_PORT_DENIED", "https://broker.test:444/ok"],
  ];
  for (const [id, expected, url] of cases) await t.test(id, async () => {
    const operation = definition();
    let transports = 0;
    const fixture = broker(operation, { transport: async () => { transports += 1; return response(); } });
    await expectCode(fixture.broker.execute(fixture.authority, invocation(operation, { url })), expected);
    assert.equal(transports, 0);
  });
});

test("SEC-03 A05-05 rejects private, loopback and metadata-address resolutions", async t => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"]) await t.test(address, async () => {
    const operation = definition();
    const fixture = broker(operation, {
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });
    await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_PRIVATE_ADDRESS_DENIED");
  });
});

test("SEC-03 A05-06 rejects a DNS answer-set change before connect", async () => {
  const operation = definition();
  let resolution = 0;
  let transports = 0;
  const fixture = broker(operation, {
    resolve: async () => [{ address: ++resolution === 1 ? "93.184.216.34" : "1.1.1.1", family: 4 }],
    transport: async () => { transports += 1; return response(); },
  });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_DNS_REBIND_DENIED");
  assert.equal(transports, 0);
});

test("SEC-03 A05-07 rejects an unfrozen redirect destination", async () => {
  const operation = definition();
  const fixture = broker(operation, { transport: async () => response(302, [], { location: "https://redirect.test/not-frozen" }) });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_REDIRECT_DENIED");
});

test("SEC-03 A05-08 observes the request limit instead of rejecting the frozen definition", async () => {
  const operation = definition({ method: "POST", body: BODY, bodyBytes: BODY.length, bodySha256: BODY_SHA256, limits: limits({ maxRequestBytes: BODY.length - 1 }) });
  let transports = 0;
  const fixture = broker(operation, { transport: async () => { transports += 1; return response(); } });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_REQUEST_LIMIT");
  assert.equal(transports, 0);
});

test("SEC-03 A05-09 applies the response bound while consuming chunks", async () => {
  const operation = definition({ limits: limits({ maxResponseBytes: 3 }) });
  const fixture = broker(operation, { transport: async () => response(200, [Buffer.from("ab"), Buffer.from("cd")]) });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_RESPONSE_LIMIT");
});

test("SEC-03 A05-10 applies one deadline to DNS, connect and response progress", async () => {
  const operation = definition({ limits: limits({ deadlineMs: 15 }) });
  const fixture = broker(operation, { transport: async () => await new Promise(() => {}) });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_TIMEOUT");
});

test("SEC-03 finite broker observations cross the validated native observer boundary", async () => {
  const operation = definition();
  const fixture = broker(operation);
  const observation = await fixture.broker.execute(fixture.authority, invocation(operation));
  let observedRequest;
  const nativeProof = Object.freeze({ proof: Buffer.from("proof"), mac: "1".repeat(64), keyId: "2".repeat(64), channelMarker: "3".repeat(64) });
  const service = new ExecutionIsolationService({
    async launch() { throw new Error("not reached"); },
    async observeBrokerOperation(request) { observedRequest = request; return nativeProof; },
    async shutdown() {},
  });
  const request = Object.freeze({
    executionId: "broker-execution",
    entryPoint: "E2",
    profile: "agent-shell",
    contextId: "broker-domain",
    sessionId: "broker-session",
    runId: "broker-run",
    authorityEpoch: 1,
    personaDigest: fixture.authority.persona.digest,
    policyDigest: createHash("sha256").update("broker-policy").digest("hex"),
    observation,
  });
  assert.equal(await service.observeBrokerOperation(request), nativeProof);
  assert.equal(observedRequest, request);
  await assert.rejects(
    () => service.observeBrokerOperation({ ...request, entryPoint: "E4", profile: "manual-terminal" }),
    error => error?.code === "EXEC_REQUEST_INVALID",
  );
  await service.shutdown();
});

test("SEC-03 finite broker rejects credentials, forbidden headers and authority substitution", async () => {
  assert.throws(() => createFiniteHttpsBroker(context(), [definition({ url: "https://user:password@broker.test/ok" })]), /credentials/u);
  assert.throws(() => createFiniteHttpsBroker(context(), [definition({ headers: [{ name: "authorization", value: "secret" }] })]), /forbidden/u);
  const operation = definition();
  const fixture = broker(operation);
  const substituted = context({ runId: "other-run" });
  await expectCode(fixture.broker.execute(substituted, invocation(operation)), "EXEC_BROKER_HOST_DENIED");
});
