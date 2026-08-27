import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
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
  assert(observedRequest.signal instanceof AbortSignal);
  const { signal: _signal, ...requestValue } = observedRequest;
  assert.deepEqual(requestValue, {
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

test("SEC-03 finite broker rejects every malformed transport response and reports iterator cleanup failure", async t => {
  const malformed = [
    null,
    {},
    { statusCode: 99, headers: {}, body: (async function* () {})() },
    { statusCode: 600, headers: {}, body: (async function* () {})() },
    { statusCode: 200, headers: null, body: (async function* () {})() },
    { statusCode: 200, headers: {}, body: null },
    { statusCode: 200, headers: {}, body: {} },
  ];
  for (const [index, candidate] of malformed.entries()) await t.test(`malformed-${index}`, async () => {
    const operation = definition();
    const fixture = broker(operation, { transport: async () => candidate });
    await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_HOST_DENIED");
  });

  const headerOperation = definition();
  const headerFixture = broker(headerOperation, {
    transport: async () => response(200, [Buffer.from("ok")], { ignored: undefined, vary: ["accept", "origin"] }),
  });
  assert.equal((await headerFixture.broker.execute(headerFixture.authority, invocation(headerOperation))).code, "OBS_BROKER_ALLOWED");

  const cleanupOperation = definition({ limits: limits({ maxResponseBytes: 1 }) });
  const cleanupFixture = broker(cleanupOperation, {
    transport: async () => ({
      statusCode: 200,
      headers: {},
      body: {
        [Symbol.asyncIterator]() {
          return {
            async next() { return { done: false, value: Buffer.from("too-large") }; },
            async return() { throw new Error("synthetic iterator cleanup failure"); },
          };
        },
      },
    }),
  });
  await assert.rejects(
    () => cleanupFixture.broker.execute(cleanupFixture.authority, invocation(cleanupOperation)),
    error => error?.code === "RUN_SETTLEMENT_FAILED"
      && error instanceof AggregateError
      && error.errors.some(candidate => /synthetic iterator cleanup failure/u.test(String(candidate))),
  );
});

test("SEC-03 redirect status semantics freeze POST/DELETE body conversion", async t => {
  for (const [statusCode, method] of [[301, "POST"], [303, "DELETE"]]) await t.test(`${statusCode}-${method}`, async () => {
    const operation = definition({
      method,
      redirects: Object.freeze(["https://redirect.test/final"]),
      limits: limits({ maxRedirects: 1 }),
    });
    const requests = [];
    const fixture = broker(operation, {
      transport: async request => {
        requests.push(request);
        return requests.length === 1
          ? response(statusCode, [], { location: "https://redirect.test/final" })
          : response(204, [], {});
      },
    });
    assert.equal((await fixture.broker.execute(fixture.authority, invocation(operation))).code, "OBS_BROKER_ALLOWED");
    assert.equal(requests[1].method, "GET");
    assert.equal(requests[1].body.length, 0);
  });
});

test("SEC-03 A05-10 applies one deadline to DNS, connect and response progress", async () => {
  const operation = definition({ limits: limits({ deadlineMs: 15 }) });
  const fixture = broker(operation, {
    transport: async ({ signal }) => await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  });
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation)), "EXEC_BROKER_TIMEOUT");
});

test("RT-04 finite broker cancellation stops before transport and preserves the typed run outcome", async () => {
  const operation = definition();
  let transports = 0;
  let resolveDns;
  const fixture = broker(operation, {
    resolve: (_hostname, signal) => new Promise((resolve, reject) => {
      resolveDns = resolve;
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
    transport: async () => { transports += 1; return response(); },
  });
  const controller = new AbortController();
  const running = fixture.broker.execute(fixture.authority, invocation(operation), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("broker cancelled"));
  await assert.rejects(() => running, error => error?.code === "RUN_CANCELLED" && /broker cancelled/u.test(error.message));
  assert.equal(transports, 0);
  resolveDns(PUBLIC_ADDRESS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transports, 0);
});

test("RT-04 finite broker waits for DNS cancellation cleanup before settlement", async () => {
  const operation = definition();
  const started = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  let transports = 0;
  const fixture = broker(operation, {
    resolve: async (_hostname, signal) => {
      started.resolve();
      await new Promise((resolve, reject) => {
        const onAbort = async () => {
          try {
            await cleanup.promise;
            reject(signal.reason);
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) void onAbort();
      });
      return PUBLIC_ADDRESS;
    },
    transport: async () => { transports += 1; return response(); },
  });
  const controller = new AbortController();
  const running = fixture.broker.execute(fixture.authority, invocation(operation), controller.signal);
  await started.promise;
  controller.abort(new Error("DNS cleanup cancellation"));
  let settled = false;
  void running.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  cleanup.resolve();
  await assert.rejects(() => running, error => error?.code === "RUN_CANCELLED" && /DNS cleanup cancellation/u.test(error.message));
  assert.equal(transports, 0);
});

test("RT-04 finite broker closes and awaits a response iterator on cancellation", async () => {
  const operation = definition();
  const bodyStarted = Promise.withResolvers();
  let finishNext;
  let returnCalls = 0;
  let transportSignal;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          bodyStarted.resolve();
          return new Promise(resolve => { finishNext = resolve; });
        },
        async return() {
          returnCalls += 1;
          finishNext?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
    },
  };
  const fixture = broker(operation, {
    transport: async request => {
      transportSignal = request.signal;
      return { statusCode: 200, headers: {}, body };
    },
  });
  const controller = new AbortController();
  const running = fixture.broker.execute(fixture.authority, invocation(operation), controller.signal);
  await bodyStarted.promise;
  controller.abort(new Error("response body cancelled"));
  await assert.rejects(() => running, error => error?.code === "RUN_CANCELLED" && /response body cancelled/u.test(error.message));
  assert.equal(transportSignal.aborted, true);
  assert.equal(returnCalls, 1);
});

test("RT-04 production HTTPS cancellation waits for request close before settlement", async t => {
  const originalRequest = https.request;
  const requestCreated = Promise.withResolvers();
  let fakeRequest;
  class FakeRequest extends EventEmitter {
    write() { return true; }
    end() {}
    destroy(error) {
      queueMicrotask(() => this.emit("error", error));
    }
  }
  https.request = () => {
    fakeRequest = new FakeRequest();
    requestCreated.resolve();
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const operation = definition();
  const authority = context();
  const productionBroker = createFiniteHttpsBroker(authority, [operation], {
    resolve: async () => PUBLIC_ADDRESS,
  });
  const controller = new AbortController();
  const running = productionBroker.execute(authority, invocation(operation), controller.signal);
  await requestCreated.promise;
  controller.abort(new Error("production HTTPS cancelled"));
  let settled = false;
  void running.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "production HTTPS cancellation settled before request close");
  fakeRequest.emit("close");
  await assert.rejects(
    () => running,
    error => error?.code === "RUN_CANCELLED" && /production HTTPS cancelled/u.test(error.message),
  );
});

test("RT-04 production HTTPS success waits for request and response close barriers", async t => {
  const originalRequest = https.request;
  const requestCreated = Promise.withResolvers();
  let fakeRequest;
  class FakeRequest extends EventEmitter {
    write() { return true; }
    end() {}
    destroy() {}
  }
  https.request = () => {
    fakeRequest = new FakeRequest();
    requestCreated.resolve();
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const operation = definition();
  const authority = context();
  const productionBroker = createFiniteHttpsBroker(authority, [operation], {
    resolve: async () => PUBLIC_ADDRESS,
  });
  const running = productionBroker.execute(authority, invocation(operation));
  await requestCreated.promise;
  const fakeResponse = new EventEmitter();
  fakeResponse.statusCode = 200;
  fakeResponse.headers = {};
  fakeResponse.destroy = () => {};
  fakeResponse[Symbol.asyncIterator] = async function* () { yield Buffer.from("ok"); };
  fakeRequest.emit("response", fakeResponse);
  let settled = false;
  void running.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "HTTPS success settled before close barriers");
  fakeResponse.emit("close");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "HTTPS success settled before request close");
  fakeRequest.emit("close");
  assert.equal((await running).code, "OBS_BROKER_ALLOWED");
});

test("RT-04 production HTTPS request error cannot be overwritten by response completion", async t => {
  const originalRequest = https.request;
  const requestCreated = Promise.withResolvers();
  let fakeRequest;
  class FakeRequest extends EventEmitter {
    write() { return true; }
    end() {}
    destroy() {}
  }
  https.request = () => {
    fakeRequest = new FakeRequest();
    requestCreated.resolve();
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const operation = definition();
  const authority = context();
  const productionBroker = createFiniteHttpsBroker(authority, [operation], {
    resolve: async () => PUBLIC_ADDRESS,
  });
  const running = productionBroker.execute(authority, invocation(operation));
  await requestCreated.promise;
  const fakeResponse = new EventEmitter();
  fakeResponse.statusCode = 200;
  fakeResponse.headers = {};
  fakeResponse.destroy = () => {};
  fakeResponse[Symbol.asyncIterator] = async function* () {};
  fakeRequest.emit("response", fakeResponse);
  fakeRequest.emit("error", new Error("synthetic request failure"));
  let settled = false;
  void running.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "request error was overwritten by response completion");
  fakeResponse.emit("close");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "request error settled before request close");
  fakeRequest.emit("close");
  await expectCode(running, "EXEC_BROKER_HOST_DENIED");
});

test("RT-04 production HTTPS backpressure close before response settles as failure", async t => {
  const originalRequest = https.request;
  const requestCreated = Promise.withResolvers();
  let fakeRequest;
  class BackpressuredRequest extends EventEmitter {
    write() { return false; }
    end() {}
    destroy() {}
  }
  https.request = () => {
    fakeRequest = new BackpressuredRequest();
    requestCreated.resolve();
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const operation = definition({ method: "POST", body: BODY });
  const authority = context();
  const productionBroker = createFiniteHttpsBroker(authority, [operation], {
    resolve: async () => PUBLIC_ADDRESS,
  });
  const running = productionBroker.execute(authority, invocation(operation));
  await requestCreated.promise;
  fakeRequest.emit("close");
  await expectCode(running, "EXEC_BROKER_HOST_DENIED");
});

test("RT-04 production HTTPS backpressure rejects when request closes before drain", async t => {
  const originalRequest = https.request;
  const requestCreated = Promise.withResolvers();
  let fakeRequest;
  class BackpressuredRequest extends EventEmitter {
    write() { return false; }
    end() {}
    destroy() {}
  }
  https.request = () => {
    fakeRequest = new BackpressuredRequest();
    requestCreated.resolve();
    return fakeRequest;
  };
  t.after(() => { https.request = originalRequest; });

  const operation = definition({ method: "POST", body: BODY });
  const authority = context();
  const productionBroker = createFiniteHttpsBroker(authority, [operation], {
    resolve: async () => PUBLIC_ADDRESS,
  });
  const running = productionBroker.execute(authority, invocation(operation));
  await requestCreated.promise;
  const fakeResponse = new EventEmitter();
  fakeResponse.statusCode = 200;
  fakeResponse.headers = {};
  fakeResponse.destroy = () => {};
  fakeResponse[Symbol.asyncIterator] = async function* () {};
  fakeRequest.emit("response", fakeResponse);
  let settled = false;
  void running.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "backpressured write settled before close");
  fakeResponse.emit("close");
  fakeRequest.emit("close");
  await expectCode(running, "EXEC_BROKER_HOST_DENIED");
});

test("RT-04 production HTTPS backpressure abort and deadline wait for request close", async t => {
  for (const mode of ["abort", "deadline"]) await t.test(mode, async () => {
    const originalRequest = https.request;
    const requestCreated = Promise.withResolvers();
    let fakeRequest;
    class BackpressuredRequest extends EventEmitter {
      write() { return false; }
      end() {}
      destroy() {}
    }
    https.request = () => {
      fakeRequest = new BackpressuredRequest();
      requestCreated.resolve();
      return fakeRequest;
    };
    t.after(() => { https.request = originalRequest; });

    const operation = definition({
      method: "POST",
      body: BODY,
      limits: limits({ deadlineMs: mode === "deadline" ? 15 : 1000 }),
    });
    const authority = context();
    const productionBroker = createFiniteHttpsBroker(authority, [operation], {
      resolve: async () => PUBLIC_ADDRESS,
    });
    const controller = new AbortController();
    const running = productionBroker.execute(authority, invocation(operation), controller.signal);
    await requestCreated.promise;
    if (mode === "abort") controller.abort(new Error("backpressure cancelled"));
    else await new Promise(resolve => setTimeout(resolve, 25));
    let settled = false;
    void running.catch(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, `${mode} settled before request close`);
    fakeRequest.emit("close");
    if (mode === "abort") {
      await assert.rejects(() => running, error => error?.code === "RUN_CANCELLED" && /backpressure cancelled/u.test(error.message));
    } else {
      await expectCode(running, "EXEC_BROKER_TIMEOUT");
    }
  });
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

test("SEC-03 finite broker constructor rejects noncanonical operation definitions", () => {
  const authority = context();
  for (const candidate of [
    definition({ version: 2 }),
    definition({ operationId: "bad id" }),
    definition({ method: "TRACE" }),
    definition({ bodySha256: "bad" }),
    definition({ url: "http://broker.test/ok" }),
    definition({ url: "https://LOCALHOST/ok" }),
    definition({ url: "https://broker.test/a%2fb" }),
    definition({ method: "GET", bodyBytes: 1, bodySha256: BODY_SHA256 }),
  ]) assert.throws(() => createFiniteHttpsBroker(authority, [candidate]), TypeError);
  assert.throws(() => createFiniteHttpsBroker(authority, []), TypeError);
  assert.throws(() => createFiniteHttpsBroker(authority, [definition(), definition()]), /unique sorted/u);
  assert.throws(() => createFiniteHttpsBroker(authority, [definition()], { resolve: true }), TypeError);
  assert.throws(() => createFiniteHttpsBroker(authority, [definition()], { transport: true }), TypeError);
});

test("SEC-03 finite broker constructor closes authority, operation, header, limit, and redirect boundary branches", () => {
  const valid = context();
  const invalidAuthorities = [
    null,
    context({ contextId: "" }),
    context({ executionDomainId: "" }),
    context({ sessionId: "" }),
    context({ runId: "" }),
    context({ authorityEpoch: 0 }),
    context({ authorityEpoch: 1.5 }),
    context({ persona: null }),
    context({ persona: { name: "", digest: valid.persona.digest } }),
    context({ persona: { name: "broker", digest: "bad" } }),
    context({ networkPolicy: { mode: "deny" } }),
    context({ networkPolicy: { mode: "allowlist" } }),
    context({ networkPolicy: { mode: "allowlist", origins: [] } }),
    context({ networkPolicy: { mode: "allowlist", origins: ["https://broker.test", "https://broker.test"] } }),
    context({ networkPolicy: { mode: "allowlist", origins: ["https://broker.test/"] } }),
    context({ networkPolicy: { mode: "allowlist", origins: ["https://broker.test/path"] } }),
  ];
  for (const candidate of invalidAuthorities) {
    assert.throws(() => createFiniteHttpsBroker(candidate, [definition()]), TypeError);
  }

  const largeValue = "x".repeat(8 * 1024 + 1);
  const invalidDefinitions = [
    null,
    definition({ url: null }),
    definition({ url: "not-a-url" }),
    definition({ operationId: 1 }),
    definition({ method: 1 }),
    definition({ bodySha256: 1 }),
    definition({ headers: null }),
    definition({ headers: [null] }),
    definition({ headers: [{ name: "Accept", value: "text/plain" }] }),
    definition({ headers: [{ name: "proxy-test", value: "x" }] }),
    definition({ headers: [{ name: "sec-test", value: "x" }] }),
    definition({ headers: [{ name: "accept", value: 1 }] }),
    definition({ headers: [{ name: "accept", value: " padded " }] }),
    definition({ headers: [{ name: "accept", value: largeValue }] }),
    definition({ headers: [{ name: "b", value: "x" }, { name: "a", value: "x" }] }),
    definition({ limits: limits({ maxRequestBytes: 0 }) }),
    definition({ limits: limits({ maxResponseBytes: 0 }) }),
    definition({ limits: limits({ deadlineMs: 0 }) }),
    definition({ limits: limits({ maxRedirects: -1 }) }),
    definition({ url: "https://outside.test/ok" }),
    definition({ redirects: null }),
    definition({ redirects: ["https://redirect.test/a"], limits: limits({ maxRedirects: 0 }) }),
    definition({ redirects: ["https://outside.test/a"], limits: limits({ maxRedirects: 1 }) }),
  ];
  for (const candidate of invalidDefinitions) {
    assert.throws(() => createFiniteHttpsBroker(valid, [candidate]), TypeError);
  }

  const withHeader = definition({ headers: Object.freeze([{ name: "accept", value: "text/plain" }]) });
  assert.doesNotThrow(() => createFiniteHttpsBroker(valid, [withHeader], {
    resolve: async () => PUBLIC_ADDRESS,
    transport: async () => response(),
  }));
});

test("SEC-03 finite broker invocation rejects every body, identity, method, URL, and header mismatch", async () => {
  const operation = definition({ method: "POST", body: BODY });
  const fixture = broker(operation);
  const candidates = [
    { ...invocation(operation), extra: true },
    { ...invocation(operation), operationId: 1 },
    { ...invocation(operation), operationId: "unknown" },
    { ...invocation(operation), method: 1 },
    { ...invocation(operation), method: "TRACE" },
    { ...invocation(operation), url: "https://broker.test/other" },
    { ...invocation(operation), url: "https://broker.test/ok#fragment" },
    { ...invocation(operation), headers: null },
    { ...invocation(operation), headers: [{ name: "accept", value: "text/plain" }] },
    { ...invocation(operation), body: "body" },
    { ...invocation(operation), body: Buffer.alloc(1025) },
    { ...invocation(operation), body: Buffer.from("different") },
  ];
  for (const candidate of candidates) {
    await assert.rejects(
      () => fixture.broker.execute(fixture.authority, candidate),
      error => error instanceof FiniteHttpsBrokerError
        && (error.code === "EXEC_BROKER_HOST_DENIED" || error.code === "EXEC_BROKER_REQUEST_LIMIT"),
    );
  }
});

test("SEC-03 finite broker rejects credentials, forbidden headers and authority substitution", async () => {
  assert.throws(() => createFiniteHttpsBroker(context(), [definition({ url: "https://user:password@broker.test/ok" })]), /credentials/u);
  assert.throws(() => createFiniteHttpsBroker(context(), [definition({ headers: [{ name: "authorization", value: "secret" }] })]), /forbidden/u);
  const operation = definition();
  const fixture = broker(operation);
  const substituted = context({ runId: "other-run" });
  await expectCode(fixture.broker.execute(substituted, invocation(operation)), "EXEC_BROKER_HOST_DENIED");
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation, { method: "POST" })), "EXEC_BROKER_HOST_DENIED");
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation, { headers: [{ name: "Authorization", value: "secret" }] })), "EXEC_BROKER_HOST_DENIED");
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation, { url: "" })), "EXEC_BROKER_HOST_DENIED");
  await expectCode(fixture.broker.execute(fixture.authority, invocation(operation, { url: "not-a-url" })), "EXEC_BROKER_HOST_DENIED");
  await expectCode(fixture.broker.execute(fixture.authority, null), "EXEC_BROKER_HOST_DENIED");
});
