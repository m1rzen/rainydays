import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ExecutionDeniedError,
  ExecutionIsolationService,
} from "../../dist/execution-isolation.js";
import {
  ManualConsentDeniedError,
  ManualExecutionConsentLedger,
} from "../../dist/manual-execution-consent.js";
import { issueResourceOwner } from "../../dist/resource-owner.js";

const HASH = createHash("sha256").update("fixture").digest("hex");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function owner(sessionId = "session-a", authorityEpoch = 1, principal = "agent") {
  return issueResourceOwner({ authorityId: `authority-${sessionId}`, authorityEpoch, sessionId, principal, rootIds: ["workspace"] });
}

function limits(entry = "E1", overrides = {}) {
  const base = entry === "E3"
    ? { activeProcesses: 1, processMemoryBytes: 2 ** 20, jobMemoryBytes: 2 ** 20, cpuRatePercent: 10, jobUserTimeMs: 1000, wallTimeMs: 1000, idleTimeMs: null, aggregateOutputBytes: 1024, retainedOutputBytes: 1024, inputBytes: 1024 }
    : entry === "E2" || entry === "E4"
      ? { activeProcesses: 2, processMemoryBytes: 2 ** 20, jobMemoryBytes: 2 ** 20, cpuRatePercent: 10, jobUserTimeMs: 1000, wallTimeMs: 1000, idleTimeMs: 500, aggregateOutputBytes: 1024, retainedOutputBytes: 1024, inputBytes: 1024 }
      : { activeProcesses: 2, processMemoryBytes: 2 ** 20, jobMemoryBytes: 2 ** 20, cpuRatePercent: 10, jobUserTimeMs: 1000, wallTimeMs: 1000, idleTimeMs: null, aggregateOutputBytes: 1024, retainedOutputBytes: 1024, inputBytes: 1024 };
  return { ...base, ...overrides };
}

function request(resourceOwner, now, entryPoint = "E1", overrides = {}) {
  const profiles = { E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal" };
  return {
    contextId: "context-a",
    sessionId: "session-a",
    runId: "run-a",
    principal: "agent",
    authorityEpoch: 1,
    personaDigest: HASH,
    policyDigest: HASH,
    resourceOwner,
    entryPoint,
    profile: profiles[entryPoint],
    payload: Buffer.from("echo safe fixture"),
    roots: [{ rootId: "workspace", access: "read-write", identity: { volumeSerial: "volume-1", fileId: "file-1", type: "directory" } }],
    environment: entryPoint === "E3" ? { NODE_DISABLE_COLORS: "1" } : { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    network: { mode: "deny" },
    limits: limits(entryPoint),
    expiresAtMs: now + 1000,
    ...overrides,
  };
}

function fakeBridge(options = {}) {
  const state = { launches: 0, writes: 0, terminations: [], requests: [], writeGate: options.writeGate };
  const completion = options.completion ?? Promise.resolve({ exitCode: 0, reason: "completed" });
  const bridge = {
    async launch(nativeRequest, onFrame) {
      state.launches += 1;
      state.requests.push(nativeRequest);
      if (options.launchError) throw new Error("synthetic native failure");
      for (const frame of options.frames ?? []) onFrame(frame);
      return {
        executionId: nativeRequest.executionId,
        completed: completion,
        async write(frame) {
          state.writes += 1;
          state.lastWrite = frame;
          if (options.writeError) throw new Error("synthetic input failure");
          if (state.writeGate) await state.writeGate.promise;
        },
        async terminate(reason) { state.terminations.push(reason); },
      };
    },
    async shutdown() { state.shutdown = true; },
  };
  return { bridge, state };
}

function code(error, expected) {
  return error instanceof ExecutionDeniedError && error.code === expected;
}

function consentCode(error, expected) {
  return error instanceof ManualConsentDeniedError && error.code === expected;
}

test("SEC-03 opaque ExecutionGrant rejects forgery, replay, expiry and failed-launch restoration", async () => {
  let now = 1_900_000_000_000;
  const resourceOwner = owner();
  const fake = fakeBridge();
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  await assert.rejects(() => service.launchOneShot({ grantId: "forged" }, resourceOwner), error => code(error, "EXEC_GRANT_FORGED"));

  const expired = service.issueExecutionGrant(request(resourceOwner, now, "E1", { expiresAtMs: now + 10 }));
  now += 11;
  await assert.rejects(() => service.launchOneShot(expired, resourceOwner), error => code(error, "EXEC_GRANT_EXPIRED"));
  await assert.rejects(() => service.launchOneShot(expired, resourceOwner), error => code(error, "EXEC_GRANT_REPLAYED"));

  const failing = fakeBridge({ launchError: true });
  const failedService = new ExecutionIsolationService(failing.bridge, { now: () => now });
  const grant = failedService.issueExecutionGrant(request(resourceOwner, now));
  await assert.rejects(() => failedService.launchOneShot(grant, resourceOwner), error => code(error, "EXEC_NATIVE_FAILED"));
  await assert.rejects(() => failedService.launchOneShot(grant, resourceOwner), error => code(error, "EXEC_GRANT_REPLAYED"));
});

test("SEC-03 grant consumption is atomic under concurrent use and cross-owner use fails closed", async () => {
  const now = 1_900_000_100_000;
  const firstOwner = owner();
  const otherOwner = owner("session-b");
  const completion = deferred();
  const fake = fakeBridge({ completion: completion.promise });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const grant = service.issueExecutionGrant(request(firstOwner, now));
  const first = service.launchOneShot(grant, firstOwner);
  await assert.rejects(() => service.launchOneShot(grant, firstOwner), error => code(error, "EXEC_GRANT_REPLAYED"));
  completion.resolve({ exitCode: 0, reason: "completed" });
  await first;
  assert.equal(fake.state.launches, 1);

  const crossOwner = service.issueExecutionGrant(request(firstOwner, now));
  await assert.rejects(() => service.launchOneShot(crossOwner, otherOwner), error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(() => service.launchOneShot(crossOwner, firstOwner), error => code(error, "EXEC_GRANT_REPLAYED"));
});

test("SEC-03 persistent leases bind owner/session and InputGrant is one-shot under concurrency", async () => {
  const now = 1_900_000_200_000;
  const resourceOwner = owner();
  const otherOwner = owner("session-b");
  const completion = deferred();
  const writeGate = deferred();
  const fake = fakeBridge({ completion: completion.promise, writeGate });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const lease = await service.launchPersistent(service.issueExecutionGrant(request(resourceOwner, now, "E2")), resourceOwner);
  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "context-a", sessionId: "session-b", runId: "run-a", principal: "agent", authorityEpoch: 1, payload: Buffer.from("dir"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "context-b", sessionId: "session-a", runId: "run-a", principal: "agent", authorityEpoch: 1, payload: Buffer.from("dir"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "context-a", sessionId: "session-a", runId: "run-b", principal: "agent", authorityEpoch: 1, payload: Buffer.from("dir"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.readOutput(lease, otherOwner), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.readOutput({ ...lease }, resourceOwner), error => code(error, "EXEC_GRANT_FORGED"));

  const input = service.issueInputGrant({ lease, resourceOwner, contextId: "context-a", sessionId: "session-a", runId: "run-a", principal: "agent", authorityEpoch: 1, payload: Buffer.from("dir"), appendNewline: true, expiresAtMs: now + 1000 });
  const firstWrite = service.write(lease, input, resourceOwner);
  await assert.rejects(() => service.write(lease, input, resourceOwner), error => code(error, "EXEC_GRANT_REPLAYED"));
  writeGate.resolve();
  await firstWrite;
  assert.equal(fake.state.writes, 1);
  const shutdown = service.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.state.shutdown, undefined, "bridge shutdown ran before native completion/cleanup");
  assert.ok(fake.state.terminations.includes("service-shutdown"));
  assert.throws(() => service.issueExecutionGrant(request(resourceOwner, now)), error => code(error, "EXEC_SERVICE_SHUTDOWN"));
  completion.resolve({ exitCode: null, reason: "terminated" });
  await shutdown;
  assert.equal(fake.state.shutdown, true);
});

test("SEC-03 E4 input accepts a new direct run only inside the launch authority incarnation", async () => {
  const now = 1_900_000_250_000;
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const completion = deferred();
  const fake = fakeBridge({ completion: completion.promise });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const lease = await service.launchPersistent(service.issueExecutionGrant(request(resourceOwner, now, "E4", {
    contextId: "authority-domain-a",
    runId: "direct-start-a",
    principal: "local-user-api",
  })), resourceOwner);

  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "authority-domain-b", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 1, payload: Buffer.from("echo denied"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "authority-domain-a", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 2, payload: Buffer.from("echo denied"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const input = service.issueInputGrant({ lease, resourceOwner, contextId: "authority-domain-a", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 1, payload: Buffer.from("echo exact"), appendNewline: true, expiresAtMs: now + 1000 });
  await service.write(lease, input, resourceOwner);
  assert.equal(fake.state.writes, 1);
  completion.resolve({ exitCode: 0, reason: "completed" });
  await service.terminate(lease, resourceOwner);
});

test("SEC-03 output limit terminates the native host and returns a stable denial", async () => {
  const now = 1_900_000_300_000;
  const resourceOwner = owner();
  const fake = fakeBridge({ frames: [{ stream: "stdout", bytes: Buffer.alloc(65, 65) }] });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const grant = service.issueExecutionGrant(request(resourceOwner, now, "E1", { limits: limits("E1", { aggregateOutputBytes: 64, retainedOutputBytes: 32 }) }));
  await assert.rejects(() => service.launchOneShot(grant, resourceOwner), error => code(error, "EXEC_OUTPUT_LIMIT"));
  assert.ok(fake.state.terminations.includes("output-limit"));
});

function presence(overrides = {}) {
  return { windowId: 7, webContentsId: 9, sessionId: "session-a", runtimeAuthorityId: "authority-a", authorityEpoch: 1, incarnationId: "incarnation-a", topFrame: true, windowVisible: true, windowFocused: true, ...overrides };
}

function prepare(ledger, overrides = {}) {
  return ledger.prepare({
    operation: "terminal-input",
    presence: presence(),
    request: { terminalId: "term-a", input: "echo exact" },
    display: { operationLabel: "Terminal input", targetLabel: "term-a", rootAlias: "workspace", preview: "echo exact" },
    ...overrides,
  });
}

test("SEC-03 manual consent stores the exact request server-side and atomically rejects replay/concurrent reuse", async () => {
  let now = 1_900_000_400_000;
  const ledger = new ManualExecutionConsentLedger({ now: () => now });
  const challenge = prepare(ledger);
  const gate = deferred();
  let executions = 0;
  let observed;
  const approved = ledger.decide({ challengeId: challenge.challengeId, decision: "approve", presence: presence(), operation: challenge.operation, argumentsDigest: challenge.argumentsDigest }, async (_operation, exactRequest) => {
    executions += 1;
    observed = exactRequest;
    await gate.promise;
  });
  await assert.rejects(() => ledger.decide({ challengeId: challenge.challengeId, decision: "approve", presence: presence(), operation: challenge.operation, argumentsDigest: challenge.argumentsDigest }, () => undefined), error => consentCode(error, "CONSENT_CHALLENGE_REPLAYED"));
  gate.resolve();
  await approved;
  assert.equal(executions, 1);
  assert.deepEqual(observed, { input: "echo exact", terminalId: "term-a" });
  assert.equal(Object.isFrozen(observed), true);

  const crossWindow = prepare(ledger);
  await assert.rejects(() => ledger.decide({ challengeId: crossWindow.challengeId, decision: "approve", presence: presence({ windowId: 8 }), operation: crossWindow.operation, argumentsDigest: crossWindow.argumentsDigest }, () => { executions += 1; }), error => consentCode(error, "CONSENT_BINDING_MISMATCH"));
  assert.equal(executions, 1);

  const expired = prepare(ledger);
  now += 15_001;
  await assert.rejects(() => ledger.decide({ challengeId: expired.challengeId, decision: "approve", presence: presence(), operation: expired.operation, argumentsDigest: expired.argumentsDigest }, () => { executions += 1; }), error => consentCode(error, "CONSENT_CHALLENGE_EXPIRED"));
  assert.equal(executions, 1);
});

test("SEC-03 manual consent deny/dismiss/invalidation/shutdown have zero execution side effects", async () => {
  const ledger = new ManualExecutionConsentLedger();
  let executions = 0;
  for (const decision of ["deny", "dismiss"]) {
    const challenge = prepare(ledger);
    await assert.rejects(() => ledger.decide({ challengeId: challenge.challengeId, decision, presence: presence(), operation: challenge.operation, argumentsDigest: challenge.argumentsDigest }, () => { executions += 1; }), error => consentCode(error, "CONSENT_DENIED"));
  }
  const invalidated = prepare(ledger);
  ledger.invalidateWebContents(9);
  await assert.rejects(() => ledger.decide({ challengeId: invalidated.challengeId, decision: "approve", presence: presence(), operation: invalidated.operation, argumentsDigest: invalidated.argumentsDigest }, () => { executions += 1; }), error => consentCode(error, "CONSENT_CHALLENGE_REPLAYED"));
  ledger.shutdown();
  assert.throws(() => prepare(ledger), error => consentCode(error, "CONSENT_LEDGER_SHUTDOWN"));
  assert.equal(executions, 0);
});
