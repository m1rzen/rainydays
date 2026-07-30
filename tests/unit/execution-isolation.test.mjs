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
import { NativeBridgeError } from "../../dist/execution-native.js";
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

function inputRequest(lease, resourceOwner, now, overrides = {}) {
  return {
    lease, resourceOwner, contextId: "context-a", sessionId: "session-a", runId: "run-a",
    principal: "agent", authorityEpoch: 1, payload: Buffer.from("dir"), appendNewline: true,
    expiresAtMs: now + 1000, ...overrides,
  };
}

function fakeBridge(options = {}) {
  const state = { launches: 0, writes: 0, terminations: [], requests: [], writeGate: options.writeGate, terminateGate: options.terminateGate };
  const completion = options.completion ?? Promise.resolve({ exitCode: 0, reason: "completed" });
  const bridge = {
    async launch(nativeRequest, onFrame) {
      state.launches += 1;
      state.requests.push(nativeRequest);
      if (options.launchError) throw options.launchError instanceof Error ? options.launchError : new Error("synthetic native failure");
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
        async terminate(reason) {
          state.terminations.push(reason);
          if (state.terminateGate) await state.terminateGate.promise;
        },
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

test("SEC-03 A11 ExecutionGrant variants are exact for E1 and E3 with zero denied launches", async (t) => {
  for (const entryPoint of ["E1", "E3"]) await t.test(entryPoint, async () => {
    let now = 1_900_000_000_000;
    const resourceOwner = owner();

    for (const missing of [undefined, null]) {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const invocation = request(resourceOwner, now, entryPoint);
      await assert.rejects(() => service.launchOneShot(missing, resourceOwner, invocation), error => code(error, "EXEC_GRANT_REQUIRED"));
      assert.equal(fake.state.launches, 0);
    }
    {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      await assert.rejects(() => service.launchOneShot(), error => code(error, "EXEC_GRANT_REQUIRED"));
      assert.equal(fake.state.launches, 0);
    }
    {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      await assert.rejects(() => service.launchOneShot({ grantId: "forged" }, resourceOwner, request(resourceOwner, now, entryPoint)), error => code(error, "EXEC_GRANT_FORGED"));
      assert.equal(fake.state.launches, 0);
    }
    for (const [overrides, expected] of [
      [{ payload: Buffer.from("altered") }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
      [{ roots: [{ rootId: "other", access: "read-write", identity: { volumeSerial: "volume-1", fileId: "file-1", type: "directory" } }] }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
      [{ network: { mode: "brokered", operationsDigest: HASH } }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
      [{ limits: limits(entryPoint, { wallTimeMs: 999 }) }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
      [{ runId: "run-b" }, "EXEC_GRANT_CROSS_RUN"],
      [{ sessionId: "session-b" }, "EXEC_GRANT_CROSS_SESSION"],
    ]) {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint);
      const grant = service.issueExecutionGrant(approved);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, { ...approved, ...overrides }), error => code(error, expected));
      assert.equal(fake.state.launches, 0);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
    }
    {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint, { expiresAtMs: now + 10 });
      const grant = service.issueExecutionGrant(approved);
      now += 11;
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_EXPIRED"));
      assert.equal(fake.state.launches, 0);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
    }
    {
      const fake = fakeBridge();
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint);
      const grant = service.issueExecutionGrant(approved);
      await service.launchOneShot(grant, resourceOwner, approved);
      const launches = fake.state.launches;
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
      assert.equal(fake.state.launches, launches);
    }
    {
      const fake = fakeBridge({ launchError: true });
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint);
      const grant = service.issueExecutionGrant(approved);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_NATIVE_FAILED"));
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
      assert.equal(fake.state.launches, 1);
    }
    {
      const fake = fakeBridge({ launchError: new NativeBridgeError("EXEC_NATIVE_IDENTITY_INVALID", "fixture identity drift") });
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint);
      const grant = service.issueExecutionGrant(approved);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_NATIVE_IDENTITY_INVALID"));
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
      assert.equal(fake.state.launches, 1);
    }
    {
      const completion = deferred();
      const fake = fakeBridge({ completion: completion.promise });
      const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
      const approved = request(resourceOwner, now, entryPoint);
      const grant = service.issueExecutionGrant(approved);
      const first = service.launchOneShot(grant, resourceOwner, approved);
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_CONCURRENT_REUSE"));
      assert.equal(fake.state.launches, 1);
      completion.resolve({ exitCode: 0, reason: "completed" });
      await first;
      await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
    }
  });
});

test("SEC-03 A11 E2 InputGrant variants are exact and denied writes never reach native", async () => {
  let now = 1_900_000_200_000;
  const resourceOwner = owner();
  const otherOwner = owner("session-b");
  const completion = deferred();
  const writeGate = deferred();
  const fake = fakeBridge({ completion: completion.promise, writeGate });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const launchRequest = request(resourceOwner, now, "E2");
  const lease = await service.launchPersistent(service.issueExecutionGrant(launchRequest), resourceOwner, launchRequest);
  assert.throws(() => service.issueInputGrant(inputRequest(lease, resourceOwner, now, { sessionId: "session-b" })), error => code(error, "EXEC_GRANT_CROSS_SESSION"));
  assert.throws(() => service.issueInputGrant(inputRequest(lease, resourceOwner, now, { contextId: "context-b" })), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.issueInputGrant(inputRequest(lease, resourceOwner, now, { runId: "run-b" })), error => code(error, "EXEC_GRANT_CROSS_RUN"));
  assert.throws(() => service.readOutput(lease, otherOwner), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.readOutput({ ...lease }, resourceOwner), error => code(error, "EXEC_GRANT_FORGED"));

  const exact = inputRequest(lease, resourceOwner, now);
  for (const missing of [undefined, null]) {
    await assert.rejects(() => service.write(lease, missing, resourceOwner, exact), error => code(error, "EXEC_GRANT_REQUIRED"));
  }
  await assert.rejects(() => service.write(lease), error => code(error, "EXEC_GRANT_REQUIRED"));
  await assert.rejects(() => service.write(lease, { grantId: "forged" }, resourceOwner, exact), error => code(error, "EXEC_GRANT_FORGED"));
  assert.equal(fake.state.writes, 0);

  for (const [overrides, expected] of [
    [{ payload: Buffer.from("altered") }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
    [{ runId: "run-b" }, "EXEC_GRANT_CROSS_RUN"],
    [{ sessionId: "session-b" }, "EXEC_GRANT_CROSS_SESSION"],
  ]) {
    const approved = inputRequest(lease, resourceOwner, now);
    const grant = service.issueInputGrant(approved);
    await assert.rejects(() => service.write(lease, grant, resourceOwner, { ...approved, ...overrides }), error => code(error, expected));
    assert.equal(fake.state.writes, 0);
    await assert.rejects(() => service.write(lease, grant, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
  }

  const expiredRequest = inputRequest(lease, resourceOwner, now, { expiresAtMs: now + 10 });
  const expired = service.issueInputGrant(expiredRequest);
  now += 11;
  await assert.rejects(() => service.write(lease, expired, resourceOwner, expiredRequest), error => code(error, "EXEC_GRANT_EXPIRED"));
  assert.equal(fake.state.writes, 0);

  const approved = inputRequest(lease, resourceOwner, now);
  const input = service.issueInputGrant(approved);
  const firstWrite = service.write(lease, input, resourceOwner, approved);
  await assert.rejects(() => service.write(lease, input, resourceOwner, approved), error => code(error, "EXEC_GRANT_CONCURRENT_REUSE"));
  writeGate.resolve();
  await firstWrite;
  await assert.rejects(() => service.write(lease, input, resourceOwner, approved), error => code(error, "EXEC_GRANT_REPLAYED"));
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

test("SEC-03 A19 authenticated grant issuance rejects brokered E4 before native launch", async () => {
  const now = 1_900_000_220_000;
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const fake = fakeBridge();
  const observations = [];
  const proof = Object.freeze({ proof: Buffer.from("authenticated"), mac: HASH, keyId: HASH, channelMarker: HASH });
  fake.bridge.observeServiceDenial = async request => { observations.push(request); return proof; };
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const attempted = request(resourceOwner, now, "E4", {
    principal: "local-user-api",
    network: { mode: "brokered", operationsDigest: HASH },
  });
  let denial = null;
  await assert.rejects(() => service.issueExecutionGrantAuthenticated(attempted), error => {
    denial = error;
    return code(error, "EXEC_NETWORK_PROFILE_UNSUPPORTED");
  });
  assert.equal(denial.nativeObservation, proof);
  assert.equal(fake.state.launches, 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].entryPoint, "E4");
  assert.equal(observations[0].profile, "manual-terminal");
  assert.equal(observations[0].operation, "launch");
  assert.equal(observations[0].decisionState, "network-profile-unsupported");
});

test("SEC-03 E4 limits match the frozen profile maxima", () => {
  const now = 1_900_000_225_000;
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const fake = fakeBridge();
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const maximum = {
    activeProcesses: 64, processMemoryBytes: 2 ** 30, jobMemoryBytes: 2 * 2 ** 30,
    cpuRatePercent: 50, jobUserTimeMs: 3_600_000, wallTimeMs: 28_800_000,
    idleTimeMs: 1_800_000, aggregateOutputBytes: 64 * 2 ** 20,
    retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10,
  };
  assert.doesNotThrow(() => service.issueExecutionGrant(request(resourceOwner, now, "E4", { principal: "local-user-api", limits: maximum })));
  for (const [key, value] of [["activeProcesses", 65], ["processMemoryBytes", 2 ** 30 + 1], ["jobMemoryBytes", 2 * 2 ** 30 + 1], ["cpuRatePercent", 51], ["jobUserTimeMs", 3_600_001], ["wallTimeMs", 28_800_001], ["idleTimeMs", 1_800_001], ["aggregateOutputBytes", 64 * 2 ** 20 + 1], ["retainedOutputBytes", 2 ** 20 + 1], ["inputBytes", 64 * 2 ** 10 + 1]]) {
    assert.throws(() => service.issueExecutionGrant(request(resourceOwner, now, "E4", { principal: "local-user-api", limits: { ...maximum, [key]: value } })), error => code(error, "EXEC_REQUEST_INVALID"), key);
  }
});

test("SEC-03 E4 input accepts a new direct run only inside the launch authority incarnation", async () => {
  const now = 1_900_000_250_000;
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const completion = deferred();
  const fake = fakeBridge({ completion: completion.promise });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const launchRequest = request(resourceOwner, now, "E4", {
    contextId: "authority-domain-a",
    runId: "direct-start-a",
    principal: "local-user-api",
  });
  const lease = await service.launchPersistent(service.issueExecutionGrant(launchRequest), resourceOwner, launchRequest);

  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "authority-domain-b", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 1, payload: Buffer.from("echo denied"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));
  assert.throws(() => service.issueInputGrant({ lease, resourceOwner, contextId: "authority-domain-a", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 2, payload: Buffer.from("echo denied"), appendNewline: true, expiresAtMs: now + 1000 }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const exactInput = { lease, resourceOwner, contextId: "authority-domain-a", sessionId: "session-a", runId: "direct-input-b", principal: "local-user-api", authorityEpoch: 1, payload: Buffer.from("echo exact"), appendNewline: true, expiresAtMs: now + 1000 };
  const input = service.issueInputGrant(exactInput);
  await service.write(lease, input, resourceOwner, exactInput);
  assert.equal(fake.state.writes, 1);
  completion.resolve({ exitCode: 0, reason: "completed" });
  await service.terminate(lease, resourceOwner);
});

test("SEC-03 persistent termination linearizes concurrent cleanup to one native frame", async () => {
  const now = 1_900_000_275_000;
  const resourceOwner = owner();
  const completion = deferred();
  const terminateGate = deferred();
  const fake = fakeBridge({ completion: completion.promise, terminateGate });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const approved = request(resourceOwner, now, "E2");
  const lease = await service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved);

  const first = service.terminate(lease, resourceOwner, "owner-retired");
  const second = service.terminate(lease, resourceOwner, "service-shutdown");
  assert.deepEqual(fake.state.terminations, ["owner-retired"]);
  terminateGate.resolve();
  completion.resolve({ exitCode: 0, reason: "terminated" });
  await Promise.all([first, second]);
  assert.deepEqual(fake.state.terminations, ["owner-retired"]);
});

test("SEC-03 output limit terminates the native host and returns a stable denial", async () => {
  const now = 1_900_000_300_000;
  const resourceOwner = owner();
  const fake = fakeBridge({ frames: [{ stream: "stdout", bytes: Buffer.alloc(65, 65) }] });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const approved = request(resourceOwner, now, "E1", { limits: limits("E1", { aggregateOutputBytes: 64, retainedOutputBytes: 32 }) });
  const grant = service.issueExecutionGrant(approved);
  await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_OUTPUT_LIMIT"));
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

test("SEC-03 A12-01..08 use exact Frozen codes, consume every attempt and never execute", async (t) => {
  const baseNow = 1_900_000_400_000;

  async function deniedCase(name, expectedCode, mutate = value => value, advanceMs = 0, afterAdvance = () => undefined) {
    await t.test(name, async () => {
      let now = baseNow;
      const ledger = new ManualExecutionConsentLedger({ now: () => now });
      const challenge = prepare(ledger);
      let executions = 0;
      now += advanceMs;
      afterAdvance(ledger);
      const exact = {
        challengeId: challenge.challengeId,
        decision: "approve",
        presence: presence(),
        operation: challenge.operation,
        argumentsDigest: challenge.argumentsDigest,
      };
      await assert.rejects(
        () => ledger.decide(mutate(exact), () => { executions += 1; }),
        error => consentCode(error, expectedCode),
      );
      assert.equal(executions, 0, `${name} reached executeStoredRequest`);
      await assert.rejects(
        () => ledger.decide(exact, () => { executions += 1; }),
        error => consentCode(error, "EXEC_CONSENT_REPLAYED"),
      );
      assert.equal(executions, 0, `${name} retry reached executeStoredRequest`);
    });
  }

  await deniedCase("A12-01 deny", "EXEC_CONSENT_DENIED", input => ({ ...input, decision: "deny" }));
  await deniedCase("A12-02 dismiss", "EXEC_CONSENT_DISMISSED", input => ({ ...input, decision: "dismiss" }));
  await deniedCase("A12-03 expiry precedes every binding and decision check", "EXEC_CONSENT_EXPIRED", input => ({
    ...input,
    decision: "deny",
    presence: presence({ windowId: 8, sessionId: "session-b", topFrame: false }),
    argumentsDigest: "0".repeat(64),
  }), 15_001, ledger => { prepare(ledger); });
  for (const [name, override] of [
    ["operation", { operation: "terminal-start" }],
    ["argumentsDigest", { argumentsDigest: "0".repeat(64) }],
  ]) {
    await deniedCase(`A12-04 ${name}`, "EXEC_CONSENT_ARGUMENT_MISMATCH", input => ({ ...input, ...override }));
  }
  for (const key of ["topFrame", "windowVisible", "windowFocused"]) {
    await deniedCase(`A12-06 ${key}=false`, "EXEC_CONSENT_SYNTHETIC", input => ({ ...input, presence: presence({ [key]: false }) }));
  }
  await deniedCase("A12-06 malformed decision presence", "EXEC_CONSENT_SYNTHETIC", input => ({ ...input, presence: presence({ authorityEpoch: 0 }) }));
  await deniedCase("A12-06 invalid decision", "EXEC_CONSENT_SYNTHETIC", input => ({ ...input, decision: "synthetic" }));
  for (const [name, override] of [
    ["windowId", { windowId: 8 }],
    ["webContentsId", { webContentsId: 10 }],
  ]) {
    await deniedCase(`A12-07 ${name}`, "EXEC_CONSENT_CROSS_WINDOW", input => ({ ...input, presence: presence(override) }));
  }
  await deniedCase("A12-07 cross-window precedes cross-session, argument mismatch and deny", "EXEC_CONSENT_CROSS_WINDOW", input => ({
    ...input,
    decision: "deny",
    presence: presence({ windowId: 8, sessionId: "session-b" }),
    argumentsDigest: "0".repeat(64),
  }));
  for (const [name, override] of [
    ["sessionId", { sessionId: "session-b" }],
    ["runtimeAuthorityId", { runtimeAuthorityId: "authority-b" }],
    ["authorityEpoch", { authorityEpoch: 2 }],
    ["incarnationId", { incarnationId: "incarnation-b" }],
  ]) {
    await deniedCase(`A12-08 ${name}`, "EXEC_CONSENT_CROSS_SESSION", input => ({ ...input, presence: presence(override) }));
  }
  await deniedCase("A12-08 cross-session precedes argument mismatch and dismiss", "EXEC_CONSENT_CROSS_SESSION", input => ({
    ...input,
    decision: "dismiss",
    presence: presence({ runtimeAuthorityId: "authority-b" }),
    operation: "terminal-start",
  }));

  await t.test("A12-06 unknown synthetic challenge becomes replay", async () => {
    const ledger = new ManualExecutionConsentLedger({ now: () => baseNow });
    let executions = 0;
    const synthetic = {
      challengeId: "unknown-synthetic-challenge",
      decision: "approve",
      presence: presence(),
      operation: "terminal-input",
      argumentsDigest: "0".repeat(64),
      state: "consuming",
    };
    await assert.rejects(() => ledger.decide(synthetic, () => { executions += 1; }), error => consentCode(error, "EXEC_CONSENT_SYNTHETIC"));
    await assert.rejects(() => ledger.decide(synthetic, () => { executions += 1; }), error => consentCode(error, "EXEC_CONSENT_REPLAYED"));
    assert.equal(executions, 0);
  });
});

test("SEC-03 A12 evidence binds the prepared authority and observer failure preserves the denial", async () => {
  const trustedEvidence = Object.freeze({ contextId: "context-trusted", sessionId: "session-a", runId: "run-trusted", authorityEpoch: 1, personaDigest: HASH, policyDigest: HASH });
  const attackerEvidence = Object.freeze({ contextId: "context-attacker", sessionId: "session-b", runId: "run-attacker", authorityEpoch: 2, personaDigest: "a".repeat(64), policyDigest: "b".repeat(64) });
  const proof = Object.freeze({ proof: Buffer.from("authenticated"), mac: HASH, keyId: HASH, channelMarker: HASH });
  let observedRequest = null;
  const ledger = new ManualExecutionConsentLedger({ observeDenial: async request => { observedRequest = request; return proof; } });
  const challenge = prepare(ledger, { evidence: trustedEvidence });
  const decision = { challengeId: challenge.challengeId, decision: "approve", presence: presence({ windowId: 8 }), operation: challenge.operation, argumentsDigest: challenge.argumentsDigest, evidence: attackerEvidence };
  let denial = null;
  await assert.rejects(() => ledger.decide(decision, () => assert.fail("cross-window denial executed")), error => {
    denial = error;
    return consentCode(error, "EXEC_CONSENT_CROSS_WINDOW");
  });
  assert.equal(denial.nativeObservation, proof);
  assert.equal(observedRequest.contextId, trustedEvidence.contextId);
  assert.equal(observedRequest.sessionId, trustedEvidence.sessionId);
  assert.equal(observedRequest.runId, trustedEvidence.runId);
  assert.equal(observedRequest.authorityEpoch, trustedEvidence.authorityEpoch);
  assert.equal(observedRequest.decisionState, "consent-cross-window");

  const unavailable = new ManualExecutionConsentLedger({ observeDenial: async () => { throw new Error("observer unavailable"); } });
  const unavailableChallenge = prepare(unavailable, { evidence: trustedEvidence });
  let unavailableDenial = null;
  await assert.rejects(() => unavailable.decide({ challengeId: unavailableChallenge.challengeId, decision: "deny", presence: presence(), operation: unavailableChallenge.operation, argumentsDigest: unavailableChallenge.argumentsDigest }, () => assert.fail("deny executed")), error => {
    unavailableDenial = error;
    return consentCode(error, "EXEC_CONSENT_DENIED");
  });
  assert.equal(unavailableDenial.nativeObservation, null);
});

test("SEC-03 A12-05/A12-09 preserve exact request and distinguish concurrent reuse from replay", async () => {
  const ledger = new ManualExecutionConsentLedger();
  const challenge = prepare(ledger);
  const exactDecision = { challengeId: challenge.challengeId, decision: "approve", presence: presence(), operation: challenge.operation, argumentsDigest: challenge.argumentsDigest };
  const gate = deferred();
  let executions = 0;
  let observed;
  const approved = ledger.decide(exactDecision, async (_operation, exactRequest) => {
    executions += 1;
    observed = exactRequest;
    await gate.promise;
  });

  await assert.rejects(
    () => ledger.decide(exactDecision, () => { executions += 1; }),
    error => consentCode(error, "EXEC_CONSENT_CONCURRENT_REUSE"),
  );
  assert.equal(executions, 1, "concurrent reuse shared or repeated the first execution");
  gate.resolve();
  await approved;
  assert.deepEqual(observed, { input: "echo exact", terminalId: "term-a" });
  assert.equal(Object.isFrozen(observed), true);
  await assert.rejects(
    () => ledger.decide(exactDecision, () => { executions += 1; }),
    error => consentCode(error, "EXEC_CONSENT_REPLAYED"),
  );
  assert.equal(executions, 1);

  const failed = prepare(ledger);
  const failedDecision = { challengeId: failed.challengeId, decision: "approve", presence: presence(), operation: failed.operation, argumentsDigest: failed.argumentsDigest };
  await assert.rejects(() => ledger.decide(failedDecision, () => {
    executions += 1;
    throw new Error("synthetic execution failure");
  }), /synthetic execution failure/u);
  await assert.rejects(
    () => ledger.decide(failedDecision, () => { executions += 1; }),
    error => consentCode(error, "EXEC_CONSENT_REPLAYED"),
  );
  assert.equal(executions, 2);
});
