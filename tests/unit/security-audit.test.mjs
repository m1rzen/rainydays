import assert from "node:assert/strict";
import test from "node:test";

const {
  appendSecurityAuditEvent: appendSecurityAuditEventWithKey,
  canonicalSecurityAuditJson,
  createSecurityAuditCheckpoint,
  createSecurityAuditCommitment,
  makeAuthorizationAuditPayload,
  makeExecutionAuditPayload,
  makeRequestAuditPayload,
  makeResultAuditPayload,
  verifySecurityAuditChain,
  verifySecurityAuditCheckpoint,
} = await import("../../dist/security-audit.js");

const key = Buffer.alloc(32, 0x5a);
const appendSecurityAuditEvent = (events, input) => appendSecurityAuditEventWithKey(events, input, key);
const verifySecurityAuditChainWithKey = events => verifySecurityAuditChain(events, key);
const requestCommitment = createSecurityAuditCommitment(key, { command: "echo super-secret-value", token: "token-should-not-persist" });
const argumentCommitment = createSecurityAuditCommitment(key, { command: "echo super-secret-value" });
const resultCommitment = createSecurityAuditCommitment(key, { stdout: "sensitive-output" });

function correlation(overrides = {}) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    requestId: "request-1",
    parentRequestId: null,
    toolCallId: "call-1",
    contextId: "context-1",
    executionId: null,
    ...overrides,
  };
}

function base(phase, safePayload, overrides = {}) {
  return {
    eventId: `event-${phase}`,
    recordedAt: `2026-08-13T00:00:0${["request", "authorization", "execution", "result"].indexOf(phase)}.000Z`,
    phase,
    correlation: correlation(),
    principal: "agent",
    operationKind: "tool",
    operationName: "execute_command",
    outcome: phase === "authorization" ? "allowed" : phase === "result" ? "success" : phase === "execution" ? "started" : "received",
    code: null,
    requestCommitment,
    safePayload,
    ...overrides,
  };
}

function allowedChain() {
  const events = [];
  events.push(appendSecurityAuditEvent(events, base("request", makeRequestAuditPayload({
    ingress: "agent-tool",
    argumentBytes: 51,
    argumentsCommitment: argumentCommitment,
  }))));
  events.push(appendSecurityAuditEvent(events, base("authorization", makeAuthorizationAuditPayload({
    decision: "allowed",
    policyDigest: "a".repeat(64),
    personaDigest: "b".repeat(64),
    approvalKind: "user",
  }))));
  events.push(appendSecurityAuditEvent(events, base("execution", makeExecutionAuditPayload({
    state: "started",
    executor: "native-host",
    profile: "e1",
    proofDigest: "c".repeat(64),
  }), { correlation: correlation({ executionId: "execution-1" }) })));
  events.push(appendSecurityAuditEvent(events, base("result", makeResultAuditPayload({
    status: "success",
    durationMs: 42,
    outputBytes: 16,
    truncated: false,
    resultCommitment,
  }), { correlation: correlation({ executionId: "execution-1" }) })));
  return events;
}

function deniedChain() {
  const events = [];
  events.push(appendSecurityAuditEvent(events, base("request", makeRequestAuditPayload({
    ingress: "agent-tool",
    argumentBytes: 51,
    argumentsCommitment: argumentCommitment,
  }))));
  events.push(appendSecurityAuditEvent(events, base("authorization", makeAuthorizationAuditPayload({
    decision: "denied",
    policyDigest: "a".repeat(64),
    personaDigest: "b".repeat(64),
    approvalKind: "supervisor",
  }), { outcome: "denied", code: "CAPABILITY_DENIED" })));
  events.push(appendSecurityAuditEvent(events, base("execution", makeExecutionAuditPayload({
    state: "not_started",
    executor: "none",
    profile: null,
    proofDigest: null,
  }), { outcome: "not_started" })));
  events.push(appendSecurityAuditEvent(events, base("result", makeResultAuditPayload({
    status: "denied",
    durationMs: 1,
    outputBytes: 0,
    truncated: false,
    resultCommitment: null,
  }), { outcome: "denied", code: "CAPABILITY_DENIED" })));
  return events;
}

function clone(value) {
  return structuredClone(value);
}

test("SEC-06 canonical commitments are deterministic, keyed and never persist raw sensitive values", () => {
  assert.equal(createSecurityAuditCommitment(key, { b: 2, a: 1 }), createSecurityAuditCommitment(key, { a: 1, b: 2 }));
  assert.notEqual(createSecurityAuditCommitment(key, "low-entropy"), createSecurityAuditCommitment(Buffer.alloc(32, 0x5b), "low-entropy"));
  assert.match(requestCommitment, /^hmac-sha256:[a-f0-9]{64}$/u);
  const bytes = Buffer.from(JSON.stringify(allowedChain()), "utf8");
  for (const secret of ["super-secret-value", "token-should-not-persist", "sensitive-output"]) {
    assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `audit chain leaked ${secret}`);
  }
  assert.throws(() => createSecurityAuditCommitment(Buffer.alloc(31), "x"), /32 bytes/u);
  assert.throws(() => createSecurityAuditCommitment(key, { value: "x".repeat(1024 * 1024) }), /too large/u);
  assert.throws(() => canonicalSecurityAuditJson({ value: Number.NaN }), /number is invalid/u);
  const circular = {}; circular.self = circular;
  assert.throws(() => canonicalSecurityAuditJson(circular), /circular/u);
  assert.equal(canonicalSecurityAuditJson([true, null, 1]), "[true,null,1]");
  assert.throws(() => canonicalSecurityAuditJson(undefined), /value is invalid/u);
  assert.throws(() => canonicalSecurityAuditJson(new Uint8Array([1])), /value is invalid/u);
  assert.throws(() => canonicalSecurityAuditJson(new (class AuditValue {})()), /prototype is invalid/u);
  let deep = {};
  for (let index = 0; index < 34; index += 1) deep = { nested: deep };
  assert.throws(() => canonicalSecurityAuditJson(deep), /too deep/u);
});

test("SEC-06 verifier accepts exact allow and deny four-phase chains", () => {
  const allowed = allowedChain();
  assert.deepEqual(allowed.map(event => event.phase), ["request", "authorization", "execution", "result"]);
  assert.deepEqual(allowed.map(event => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(verifySecurityAuditChainWithKey(allowed), { eventCount: 4, headHash: allowed.at(-1).eventHash });
  assert.throws(() => verifySecurityAuditChain(allowed, Buffer.alloc(32, 0x5b)), /event hash differs/u);
  const denied = deniedChain();
  assert.equal(denied[2].safePayload.state, "not_started");
  assert.equal(denied[3].safePayload.status, "denied");
  assert.deepEqual(verifySecurityAuditChainWithKey(denied), { eventCount: 4, headHash: denied.at(-1).eventHash });
});

test("SEC-06 hash chain rejects payload, identity, sequence, deletion, reorder and duplication attacks", () => {
  const attacks = [];
  const payload = clone(allowedChain()); payload[3].safePayload.outputBytes += 1; attacks.push(payload);
  const identity = clone(allowedChain()); identity[2].correlation.executionId = "execution-2"; attacks.push(identity);
  const sequence = clone(allowedChain()); sequence[2].sequence = 9; attacks.push(sequence);
  const previous = clone(allowedChain()); previous[2].previousEventHash = "f".repeat(64); attacks.push(previous);
  const eventId = clone(allowedChain()); eventId[2].eventId = eventId[1].eventId; attacks.push(eventId);
  const deleted = clone(allowedChain()); deleted.splice(1, 1); attacks.push(deleted);
  const reordered = clone(allowedChain()); [reordered[1], reordered[2]] = [reordered[2], reordered[1]]; attacks.push(reordered);
  const duplicated = clone(allowedChain()); duplicated.splice(2, 0, clone(duplicated[1])); attacks.push(duplicated);
  for (const attack of attacks) assert.throws(() => verifySecurityAuditChainWithKey(attack), /Security audit/u);
});

test("SEC-06 authenticated checkpoint rejects every valid tail truncation and checkpoint substitution", () => {
  const events = allowedChain();
  const summary = verifySecurityAuditChainWithKey(events);
  const checkpoint = createSecurityAuditCheckpoint(key, summary);
  verifySecurityAuditCheckpoint(checkpoint, summary, key);
  for (const removed of [1, 2, 3, 4]) {
    const truncated = events.slice(0, -removed);
    const truncatedSummary = verifySecurityAuditChainWithKey(truncated);
    assert.throws(() => verifySecurityAuditCheckpoint(checkpoint, truncatedSummary, key), /checkpoint differs/u);
  }
  assert.throws(() => verifySecurityAuditCheckpoint({ ...checkpoint, eventCount: 3 }, summary, key), /checkpoint differs/u);
  assert.throws(() => verifySecurityAuditCheckpoint({ ...checkpoint, headHash: "f".repeat(64) }, summary, key), /checkpoint differs/u);
  assert.throws(() => verifySecurityAuditCheckpoint({ ...checkpoint, checkpointMac: `hmac-sha256:${"f".repeat(64)}` }, summary, key), /checkpoint differs/u);
});

test("SEC-06 append state machine rejects skipped phases, correlation substitution and execution after denial", () => {
  const request = allowedChain()[0];
  assert.throws(() => appendSecurityAuditEvent([], base("authorization", makeAuthorizationAuditPayload({
    decision: "allowed", policyDigest: null, personaDigest: null, approvalKind: "none",
  }))), /phase order/u);
  assert.throws(() => appendSecurityAuditEvent([request], base("authorization", makeAuthorizationAuditPayload({
    decision: "allowed", policyDigest: null, personaDigest: null, approvalKind: "none",
  }), { correlation: correlation({ runId: "run-2" }) })), /identity changed/u);

  const denied = deniedChain().slice(0, 2);
  assert.throws(() => appendSecurityAuditEvent(denied, base("execution", makeExecutionAuditPayload({
    state: "started", executor: "native-host", profile: "e1", proofDigest: null,
  }), { correlation: correlation({ executionId: "execution-1" }) })), /cannot start execution/u);

  const allowed = allowedChain().slice(0, 3);
  assert.throws(() => appendSecurityAuditEvent(allowed, base("result", makeResultAuditPayload({
    status: "success", durationMs: 1, outputBytes: 0, truncated: false, resultCommitment: null,
  }), { correlation: correlation({ executionId: "execution-2" }) })), /execution identity differs/u);
});

test("SEC-06 safe payload builders reject unknown fields and inconsistent values", () => {
  assert.throws(() => makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1, argumentsCommitment: argumentCommitment, raw: "secret" }), /fields are invalid/u);
  assert.throws(() => makeAuthorizationAuditPayload({ decision: "maybe", policyDigest: null, personaDigest: null, approvalKind: "none" }), /decision is invalid/u);
  assert.throws(() => makeExecutionAuditPayload({ state: "not_started", executor: "native-host", profile: null, proofDigest: null }), /none executor/u);
  assert.throws(() => makeResultAuditPayload({ status: "success", durationMs: -1, outputBytes: 0, truncated: false, resultCommitment: null }), /durationMs is invalid/u);
  const event = base("request", makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1, argumentsCommitment: argumentCommitment }), { arbitrary: true });
  assert.throws(() => appendSecurityAuditEvent([], event), /fields are invalid/u);
  const orphan = base("request", makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1, argumentsCommitment: argumentCommitment }), {
    correlation: correlation({ requestId: "nested-request", parentRequestId: "missing-parent" }),
  });
  assert.throws(() => appendSecurityAuditEvent([], orphan), /parent request identity/u);
  const parent = allowedChain()[0];
  const substituted = { ...orphan, correlation: correlation({ requestId: "nested-request", parentRequestId: parent.correlation.requestId, runId: "other-run" }) };
  assert.throws(() => appendSecurityAuditEvent([parent], substituted), /parent request identity/u);
});

test("SEC-06 public validators fail closed across malformed identities, payloads and phase bindings", () => {
  const requestPayload = makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1, argumentsCommitment: argumentCommitment });
  const authorizationPayload = makeAuthorizationAuditPayload({ decision: "allowed", policyDigest: null, personaDigest: null, approvalKind: "none" });
  const startedPayload = makeExecutionAuditPayload({ state: "started", executor: "tool-dispatcher", profile: null, proofDigest: null });
  const stoppedPayload = makeExecutionAuditPayload({ state: "not_started", executor: "none", profile: null, proofDigest: null });
  const successPayload = makeResultAuditPayload({ status: "success", durationMs: 0, outputBytes: 0, truncated: false, resultCommitment: null });

  assert.throws(() => makeRequestAuditPayload(null), /must be an object/u);
  assert.throws(() => makeRequestAuditPayload({ ingress: "browser", argumentBytes: 1, argumentsCommitment: argumentCommitment }), /ingress is invalid/u);
  assert.throws(() => makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1024 * 1024 * 1024 + 1, argumentsCommitment: argumentCommitment }), /argumentBytes is invalid/u);
  assert.throws(() => makeRequestAuditPayload({ ingress: "agent-tool", argumentBytes: 1, argumentsCommitment: "bad" }), /argumentsCommitment is invalid/u);
  assert.throws(() => makeAuthorizationAuditPayload({ decision: "allowed", policyDigest: null, personaDigest: null, approvalKind: "browser" }), /approvalKind is invalid/u);
  assert.throws(() => makeExecutionAuditPayload({ state: "running", executor: "none", profile: null, proofDigest: null }), /state is invalid/u);
  assert.throws(() => makeExecutionAuditPayload({ state: "started", executor: "browser", profile: null, proofDigest: null }), /executor is invalid/u);
  assert.throws(() => makeExecutionAuditPayload({ state: "started", executor: "tool-dispatcher", profile: "UPPER", proofDigest: null }), /profile is invalid/u);
  assert.throws(() => makeResultAuditPayload({ status: "unknown", durationMs: 0, outputBytes: 0, truncated: false, resultCommitment: null }), /status is invalid/u);
  assert.throws(() => makeResultAuditPayload({ status: "success", durationMs: 0, outputBytes: 0, truncated: "no", resultCommitment: null }), /truncated is invalid/u);

  const emptySummary = verifySecurityAuditChainWithKey([]);
  const checkpoint = createSecurityAuditCheckpoint(key, emptySummary);
  assert.throws(() => createSecurityAuditCheckpoint(key, { eventCount: -1, headHash: emptySummary.headHash }), /eventCount is invalid/u);
  assert.throws(() => createSecurityAuditCheckpoint(key, { eventCount: 0, headHash: "bad" }), /headHash is invalid/u);
  assert.throws(() => verifySecurityAuditCheckpoint({ ...checkpoint, schemaVersion: 2 }, emptySummary, key), /Schema is invalid/u);

  const malformedRequests = [
    base("request", requestPayload, { correlation: correlation({ runId: "" }) }),
    base("request", requestPayload, { correlation: correlation({ parentRequestId: "request-1" }) }),
    base("request", requestPayload, { principal: "browser" }),
    base("request", requestPayload, { operationKind: "browser" }),
    base("request", requestPayload, { operationName: "UPPER" }),
    base("request", requestPayload, { outcome: "UPPER" }),
    base("request", requestPayload, { code: "bad-code" }),
    base("invalid", requestPayload),
  ];
  for (const input of malformedRequests) assert.throws(() => appendSecurityAuditEvent([], input), /Security audit/u);
  assert.throws(() => appendSecurityAuditEventWithKey(null, base("request", requestPayload), key), /history is invalid/u);
  assert.throws(() => verifySecurityAuditChain(null, key), /history is invalid/u);
  assert.throws(() => appendSecurityAuditEvent([], base("request", requestPayload, { recordedAt: "2026-08-13" })), /timestamp is invalid/u);
  assert.throws(() => appendSecurityAuditEvent([], base("request", requestPayload, { correlation: correlation({ executionId: "execution-1" }) })), /Request phase cannot bind/u);

  const request = appendSecurityAuditEvent([], base("request", requestPayload));
  assert.throws(() => appendSecurityAuditEvent([request], base("authorization", authorizationPayload, { correlation: correlation({ executionId: "execution-1" }) })), /Authorization phase cannot bind/u);
  const authorization = appendSecurityAuditEvent([request], base("authorization", authorizationPayload));
  assert.throws(() => appendSecurityAuditEvent([request, authorization], base("execution", startedPayload)), /requires an execution identity/u);
  assert.throws(() => appendSecurityAuditEvent([request, authorization], base("execution", stoppedPayload, { correlation: correlation({ executionId: "execution-1" }) })), /cannot bind an execution identity/u);
  assert.throws(() => appendSecurityAuditEvent(allowedChain(), base("result", successPayload, { correlation: correlation({ executionId: "execution-1" }) })), /no further phase/u);

  const denied = deniedChain().slice(0, 3);
  assert.throws(() => appendSecurityAuditEvent(denied, base("result", successPayload, {
    correlation: correlation(), outcome: "success", code: null,
  })), /requires a denied result/u);
});
