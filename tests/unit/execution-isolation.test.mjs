import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  ExecutionDeniedError,
  ExecutionIsolationService,
} from "../../dist/execution-isolation.js";
import {
  ManualConsentDeniedError,
  ManualExecutionConsentLedger,
} from "../../dist/manual-execution-consent.js";
import {
  NativeBridgeError,
  bindNativeRootAuthority,
  createProductionNativeExecutionBridge,
} from "../../dist/execution-native.js";
import {
  createManualExecutionGateway,
  createScopedExecutionGateway,
  manualConsentEvidenceBinding,
  observeManualConsentDenial,
  readIsolatedTerminal,
  retireIsolatedTerminal,
  shutdownExecutionRuntime,
  terminateIsolatedTerminal,
} from "../../dist/execution-runtime.js";
import { issueResourceOwner, retireResourceOwner } from "../../dist/resource-owner.js";

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
      if (options.launchErrorRaw !== undefined) throw options.launchErrorRaw;
      if (options.launchError) throw options.launchError instanceof Error ? options.launchError : new Error("synthetic native failure");
      for (const frame of options.frames ?? []) onFrame(frame);
      const handle = {
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
          if (options.terminateError) throw new Error("synthetic termination failure");
          if (state.terminateGate) await state.terminateGate.promise;
        },
      };
      if (options.delayedFrames) setImmediate(() => {
        for (const frame of options.delayedFrames) onFrame(frame);
      });
      return handle;
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

test("SEC-03 input grants fail closed for every malformed binding and lifecycle state", async () => {
  let now = 1_900_000_210_000;
  const resourceOwner = owner();
  const completion = deferred();
  const fake = fakeBridge({ completion: completion.promise });
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const launchRequest = request(resourceOwner, now, "E2");
  const lease = await service.launchPersistent(service.issueExecutionGrant(launchRequest), resourceOwner, launchRequest);
  const valid = inputRequest(lease, resourceOwner, now);

  for (const [label, overrides, expected] of [
    ["context grammar", { contextId: "" }, "EXEC_BINDING_MISMATCH"],
    ["run grammar", { runId: "" }, "EXEC_BINDING_MISMATCH"],
    ["principal", { principal: "local-user-api" }, "EXEC_BINDING_MISMATCH"],
    ["epoch", { authorityEpoch: 2 }, "EXEC_BINDING_MISMATCH"],
    ["payload type", { payload: "dir" }, "EXEC_REQUEST_INVALID"],
    ["payload empty", { payload: Buffer.alloc(0) }, "EXEC_REQUEST_INVALID"],
    ["payload limit", { payload: Buffer.alloc(1025) }, "EXEC_REQUEST_INVALID"],
    ["newline", { appendNewline: "true" }, "EXEC_REQUEST_INVALID"],
    ["expiry type", { expiresAtMs: Number.NaN }, "EXEC_GRANT_EXPIRED"],
    ["expiry past", { expiresAtMs: now }, "EXEC_GRANT_EXPIRED"],
    ["expiry horizon", { expiresAtMs: now + 15_001 }, "EXEC_GRANT_EXPIRED"],
  ]) assert.throws(() => service.issueInputGrant({ ...valid, ...overrides }), error => code(error, expected), label);

  const invocationCases = [
    [null, "EXEC_BINDING_MISMATCH"],
    [{ ...valid, payload: "dir" }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
    [{ ...valid, appendNewline: false }, "EXEC_GRANT_ARGUMENT_MISMATCH"],
    [{ ...valid, contextId: "context-b" }, "EXEC_BINDING_MISMATCH"],
    [{ ...valid, principal: "local-user-api" }, "EXEC_BINDING_MISMATCH"],
    [{ ...valid, authorityEpoch: 2 }, "EXEC_BINDING_MISMATCH"],
  ];
  for (const [invocation, expected] of invocationCases) {
    const grant = service.issueInputGrant(valid);
    await assert.rejects(() => service.write(lease, grant, resourceOwner, invocation), error => code(error, expected));
  }
  {
    const grant = service.issueInputGrant(valid);
    await assert.rejects(() => service.write({ ...lease }, grant, resourceOwner, valid), error => code(error, "EXEC_BINDING_MISMATCH"));
  }
  {
    const grant = service.issueInputGrant(valid);
    await assert.rejects(() => service.write(lease, grant, owner("session-b"), valid), error => code(error, "EXEC_BINDING_MISMATCH"));
  }

  completion.resolve({ exitCode: 0, reason: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => service.issueInputGrant(valid), error => code(error, "EXEC_SESSION_STALE"));
  assert.equal(service.readOutput(lease, resourceOwner).running, false);
  await service.terminate(lease, resourceOwner, "already-closed");
  await assert.rejects(
    () => service.terminateForOwnerRetirement(lease, resourceOwner, "already-retired"),
    error => error?.code === "PATH_AUTHORITY_STALE",
  );
  const shutdown = service.shutdown();
  assert.equal(service.shutdown(), shutdown);
  await shutdown;
  assert.throws(() => service.issueInputGrant(valid), error => code(error, "EXEC_SERVICE_SHUTDOWN"));
  await assert.rejects(() => service.write(lease, null, resourceOwner, valid), error => code(error, "EXEC_SERVICE_SHUTDOWN"));
});

test("SEC-03 native input and termination failures retire the persistent session", async () => {
  const now = 1_900_000_215_000;
  const resourceOwner = owner();
  {
    const completion = deferred();
    const fake = fakeBridge({ completion: completion.promise, writeError: true });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const launchRequest = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(launchRequest), resourceOwner, launchRequest);
    const approved = inputRequest(lease, resourceOwner, now);
    const writing = service.write(lease, service.issueInputGrant(approved), resourceOwner, approved);
    completion.resolve({ exitCode: null, reason: "input-failed" });
    await assert.rejects(writing, error => code(error, "EXEC_NATIVE_FAILED"));
    assert.equal(service.readOutput(lease, resourceOwner).running, false);
  }
  {
    const completion = deferred();
    const fake = fakeBridge({ completion: completion.promise, terminateError: true });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const launchRequest = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(launchRequest), resourceOwner, launchRequest);
    const termination = service.terminate(lease, resourceOwner, "failure-probe");
    completion.reject(new Error("synthetic completion failure"));
    await assert.rejects(termination, /synthetic termination failure/u);
    assert.equal(service.readOutput(lease, resourceOwner).running, false);
  }
});

test("SEC-03 residual service lifecycle branches remain fail-closed and observable", async () => {
  const now = 1_900_000_218_000;
  {
    const resourceOwner = owner();
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    await assert.rejects(
      () => service.issueExecutionGrantAuthenticated(request(resourceOwner, now, "E1", { profile: "script" })),
      error => code(error, "EXEC_PROFILE_INVALID"),
    );
  }
  {
    const resourceOwner = owner();
    const fake = fakeBridge();
    const observations = [];
    fake.bridge.observeServiceDenial = async value => { observations.push(value); return Object.freeze({ proof: Buffer.from("proof") }); };
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const invocation = request(resourceOwner, now, "E1", {
      roots: [{ rootId: "workspace", access: "read-write", identity: null }],
    });
    let denial;
    await assert.rejects(() => service.launchOneShot(null, resourceOwner, invocation), error => {
      denial = error;
      return code(error, "EXEC_GRANT_REQUIRED");
    });
    assert.equal(observations.length, 1);
    assert(denial.nativeObservation);
  }
  {
    const resourceOwner = owner();
    const fake = fakeBridge({ launchError: true });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    await assert.rejects(
      () => service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved),
      error => code(error, "EXEC_NATIVE_FAILED"),
    );
  }
  {
    const resourceOwner = owner();
    const completion = deferred();
    const terminateGate = deferred();
    const fake = fakeBridge({ completion: completion.promise, terminateGate });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved);
    const termination = service.terminate(lease, resourceOwner, "stale-probe");
    assert.throws(() => service.issueInputGrant(inputRequest(lease, resourceOwner, now)), error => code(error, "EXEC_SESSION_STALE"));
    terminateGate.resolve();
    completion.resolve({ exitCode: null, reason: "terminated" });
    await termination;
  }
  {
    const resourceOwner = owner();
    const completion = deferred();
    const fake = fakeBridge({ completion: completion.promise });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved);
    const input = inputRequest(lease, resourceOwner, now);
    const grant = service.issueInputGrant(input);
    const retirement = retireResourceOwner(resourceOwner);
    completion.resolve({ exitCode: null, reason: "owner-retired" });
    await retirement;
    await assert.rejects(
      () => service.write(lease, grant, resourceOwner, input),
      error => error?.code === "PATH_AUTHORITY_STALE",
    );
  }
  {
    const resourceOwner = owner();
    const completion = deferred();
    const fake = fakeBridge({ completion: completion.promise });
    const observations = [];
    fake.bridge.observeServiceDenial = async value => { observations.push(value); return Object.freeze({ proof: Buffer.from("proof") }); };
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved);
    const input = inputRequest(lease, resourceOwner, now);
    const grant = service.issueInputGrant(input);
    await assert.rejects(
      () => service.write(lease, grant, resourceOwner, { ...input, runId: "run-b" }),
      error => code(error, "EXEC_GRANT_CROSS_RUN") && Boolean(error.nativeObservation),
    );
    assert.equal(observations[0]?.operation, "input");
    completion.resolve({ exitCode: 0, reason: "completed" });
  }
  {
    const resourceOwner = owner();
    const fake = fakeBridge({ frames: [{ stream: "stdout", bytes: "not-bytes" }] });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    const result = await service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, approved);
    assert.equal(result.stdout, "");
  }
  {
    const resourceOwner = owner();
    const fake = fakeBridge({ frames: [{ stream: "stdout", bytes: Buffer.alloc(65, 65) }], terminateError: true });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1", { limits: limits("E1", { aggregateOutputBytes: 64, retainedOutputBytes: 32 }) });
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, approved),
      error => code(error, "EXEC_NATIVE_FAILED"),
    );
  }
  {
    const resourceOwner = owner();
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    const grant = service.issueExecutionGrant(approved);
    await assert.rejects(
      () => service.launchPersistent(grant, resourceOwner, { ...approved, sessionId: "session-b" }),
      error => code(error, "EXEC_GRANT_CROSS_SESSION"),
    );
  }
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

test("SEC-03 launch denial observer authenticates only exact E1/E3 invocation bindings", async () => {
  const now = 1_900_000_223_000;
  const resourceOwner = owner();
  const proof = Object.freeze({ proof: Buffer.from("authenticated"), mac: HASH, keyId: HASH, channelMarker: HASH });
  const observed = [];
  const fake = fakeBridge();
  fake.bridge.observeServiceDenial = async request => { observed.push(request); return proof; };
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });

  for (const entryPoint of ["E1", "E3"]) {
    const invocation = request(resourceOwner, now, entryPoint);
    let denial;
    await assert.rejects(() => service.launchOneShot(null, resourceOwner, invocation), error => {
      denial = error;
      return code(error, "EXEC_GRANT_REQUIRED");
    });
    assert.equal(denial.nativeObservation, proof);
    assert.equal(observed.at(-1).entryPoint, entryPoint);
    assert.equal(observed.at(-1).profile, entryPoint === "E1" ? "one-shot-shell" : "script");
  }

  const valid = request(resourceOwner, now, "E1");
  const malformed = [
    null,
    { ...valid, entryPoint: "E2", profile: "agent-shell" },
    { ...valid, contextId: "" },
    { ...valid, sessionId: "" },
    { ...valid, runId: "" },
    { ...valid, principal: "" },
    { ...valid, authorityEpoch: 0 },
    { ...valid, personaDigest: "bad" },
    { ...valid, policyDigest: "bad" },
    { ...valid, payload: "not-bytes" },
    { ...valid, roots: null },
  ];
  for (const invocation of malformed) {
    const before = observed.length;
    let denial;
    await assert.rejects(() => service.launchOneShot(null, resourceOwner, invocation), error => {
      denial = error;
      return code(error, "EXEC_GRANT_REQUIRED");
    });
    assert.equal(denial.nativeObservation, null);
    assert.equal(observed.length, before, "malformed launch denial reached native observer");
  }

  const approved = request(resourceOwner, now, "E1");
  const grant = service.issueExecutionGrant(approved);
  let crossSession;
  await assert.rejects(
    () => service.launchOneShot(grant, resourceOwner, { ...approved, sessionId: "session-b" }),
    error => { crossSession = error; return code(error, "EXEC_GRANT_CROSS_SESSION"); },
  );
  assert.equal(crossSession.nativeObservation, proof);
  assert.equal(observed.at(-1).sessionId, approved.sessionId, "grant authority was not authoritative for observation");

  const failing = fakeBridge();
  failing.bridge.observeServiceDenial = async () => { throw new Error("observer unavailable"); };
  const failingService = new ExecutionIsolationService(failing.bridge, { now: () => now });
  let preserved;
  await assert.rejects(() => failingService.launchOneShot(null, resourceOwner, valid), error => {
    preserved = error;
    return code(error, "EXEC_GRANT_REQUIRED");
  });
  assert.equal(preserved.nativeObservation, null);
});

test("SEC-03 input denial observer requires one exact live E2 session binding", async () => {
  const now = 1_900_000_224_000;
  const resourceOwner = owner();
  const completion = deferred();
  const proof = Object.freeze({ proof: Buffer.from("authenticated"), mac: HASH, keyId: HASH, channelMarker: HASH });
  const observed = [];
  const fake = fakeBridge({ completion: completion.promise });
  fake.bridge.observeServiceDenial = async request => { observed.push(request); return proof; };
  const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
  const launch = request(resourceOwner, now, "E2");
  const lease = await service.launchPersistent(service.issueExecutionGrant(launch), resourceOwner, launch);
  const valid = inputRequest(lease, resourceOwner, now);

  let exactDenial;
  await assert.rejects(() => service.write(lease, null, resourceOwner, valid), error => {
    exactDenial = error;
    return code(error, "EXEC_GRANT_REQUIRED");
  });
  assert.equal(exactDenial.nativeObservation, proof);
  assert.equal(observed.at(-1).operation, "input");

  const malformed = [
    null,
    { ...valid, payload: "not-bytes" },
    { ...valid, contextId: "" },
    { ...valid, sessionId: "" },
    { ...valid, runId: "" },
    { ...valid, principal: "" },
    { ...valid, authorityEpoch: 0 },
    { ...valid, appendNewline: "true" },
  ];
  for (const invocation of malformed) {
    const before = observed.length;
    let denial;
    await assert.rejects(() => service.write(lease, null, resourceOwner, invocation), error => {
      denial = error;
      return code(error, "EXEC_GRANT_REQUIRED");
    });
    assert.equal(denial.nativeObservation, null);
    assert.equal(observed.length, before, "malformed input denial reached native observer");
  }
  const beforeForged = observed.length;
  await assert.rejects(() => service.write({ ...lease }, null, resourceOwner, valid), error => code(error, "EXEC_GRANT_REQUIRED"));
  await assert.rejects(() => service.write(lease, null, owner("session-b"), valid), error => code(error, "EXEC_GRANT_REQUIRED"));
  assert.equal(observed.length, beforeForged);

  completion.resolve({ exitCode: 0, reason: "completed" });
  await service.terminate(lease, resourceOwner);

  const manualOwner = owner("session-a", 1, "local-user-api");
  const manualCompletion = deferred();
  const manualFake = fakeBridge({ completion: manualCompletion.promise });
  manualFake.bridge.observeServiceDenial = async request => { observed.push(request); return proof; };
  const manualService = new ExecutionIsolationService(manualFake.bridge, { now: () => now });
  const manualLaunch = request(manualOwner, now, "E4", { principal: "local-user-api" });
  const manualLease = await manualService.launchPersistent(manualService.issueExecutionGrant(manualLaunch), manualOwner, manualLaunch);
  const manualInput = inputRequest(manualLease, manualOwner, now, { principal: "local-user-api" });
  const beforeManual = observed.length;
  await assert.rejects(() => manualService.write(manualLease, null, manualOwner, manualInput), error => code(error, "EXEC_GRANT_REQUIRED"));
  assert.equal(observed.length, beforeManual, "E4 input denial was misrepresented as E2");
  manualCompletion.resolve({ exitCode: 0, reason: "completed" });
  await manualService.terminate(manualLease, manualOwner);
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

test("SEC-03 execution service closes remaining invocation, native failure and output timing branches", async () => {
  const now = 1_900_000_350_000;
  const resourceOwner = owner();

  {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    await assert.rejects(
      () => service.issueExecutionGrantAuthenticated(request(resourceOwner, now, "E1", { contextId: "" })),
      error => code(error, "EXEC_REQUEST_INVALID"),
    );
  }
  {
    const fake = fakeBridge({ launchErrorRaw: { code: "EXEC_NATIVE_IDENTITY_INVALID" } });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, approved),
      error => code(error, "EXEC_NATIVE_IDENTITY_INVALID"),
    );
  }
  for (const invocationOverride of [
    { roots: null },
    { roots: [] },
    { roots: [null] },
    { environment: null },
    { network: null },
    { limits: null },
    { resourceOwner: owner() },
  ]) {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, { ...approved, ...invocationOverride }),
      error => code(error, invocationOverride.resourceOwner ? "EXEC_BINDING_MISMATCH" : "EXEC_GRANT_ARGUMENT_MISMATCH"),
    );
  }
  {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const persistent = request(resourceOwner, now, "E2");
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(persistent), resourceOwner, persistent),
      error => code(error, "EXEC_PROFILE_INVALID"),
    );
    const oneShot = request(resourceOwner, now, "E1");
    await assert.rejects(
      () => service.launchPersistent(service.issueExecutionGrant(oneShot), resourceOwner, oneShot),
      error => code(error, "EXEC_PROFILE_INVALID"),
    );
  }
  {
    const fake = fakeBridge({ launchError: true });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    await assert.rejects(
      () => service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved),
      error => code(error, "EXEC_NATIVE_FAILED"),
    );
  }
  {
    const completion = deferred();
    const fake = fakeBridge({ completion: completion.promise });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E2");
    const lease = await service.launchPersistent(service.issueExecutionGrant(approved), resourceOwner, approved);
    const exact = inputRequest(lease, resourceOwner, now);
    const grant = service.issueInputGrant(exact);
    const throwingInvocation = new Proxy(exact, {
      get(target, property, receiver) {
        if (property === "sessionId") throw new Error("caller getter failure");
        return Reflect.get(target, property, receiver);
      },
    });
    await assert.rejects(() => service.write(lease, grant, resourceOwner, throwingInvocation), /caller getter failure/u);
    completion.resolve({ exitCode: 0, reason: "completed" });
    await service.terminate(lease, resourceOwner);
  }
  {
    const completion = deferred();
    const fake = fakeBridge({
      completion: completion.promise,
      delayedFrames: [
        { stream: "stdout", bytes: "not-bytes" },
        { stream: "stdout", bytes: Buffer.alloc(65, 65) },
      ],
    });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1", { limits: limits("E1", { aggregateOutputBytes: 64, retainedOutputBytes: 32 }) });
    const launched = service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, approved);
    await new Promise(resolve => setImmediate(resolve));
    completion.resolve({ exitCode: 0, reason: "completed" });
    await assert.rejects(launched, error => code(error, "EXEC_OUTPUT_LIMIT"));
    assert.ok(fake.state.terminations.includes("output-limit"));
  }
});

test("SEC-03 execution service rejects residual owner, authority, shutdown and frame variants", async () => {
  const now = 1_900_000_375_000;
  const resourceOwner = owner();

  {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    const grant = service.issueExecutionGrant(approved);
    await assert.rejects(
      () => service.launchOneShot(grant, owner("session-b"), { ...approved, resourceOwner: owner("session-b") }),
      error => code(error, "EXEC_BINDING_MISMATCH"),
    );
  }
  {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, null),
      error => code(error, "EXEC_BINDING_MISMATCH"),
    );
  }
  for (const overrides of [
    { contextId: "context-b" },
    { principal: "local-user-api" },
    { authorityEpoch: 2 },
    { personaDigest: "a".repeat(64) },
    { policyDigest: "b".repeat(64) },
  ]) {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    await assert.rejects(
      () => service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, { ...approved, ...overrides }),
      error => code(error, "EXEC_BINDING_MISMATCH"),
    );
  }
  {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1");
    const grant = service.issueExecutionGrant(approved);
    await service.shutdown();
    await assert.rejects(() => service.launchOneShot(grant, resourceOwner, approved), error => code(error, "EXEC_SERVICE_SHUTDOWN"));
  }
  {
    const completion = deferred();
    const fake = fakeBridge({
      completion: completion.promise,
      delayedFrames: [
        { stream: "stdout", bytes: "not-a-byte-array" },
        { stream: "stdout", bytes: Buffer.alloc(65, 65) },
      ],
      terminateError: true,
    });
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    const approved = request(resourceOwner, now, "E1", { limits: limits("E1", { aggregateOutputBytes: 64, retainedOutputBytes: 32 }) });
    const launched = service.launchOneShot(service.issueExecutionGrant(approved), resourceOwner, approved);
    await new Promise(resolve => setImmediate(resolve));
    completion.resolve({ exitCode: 0, reason: "completed" });
    await assert.rejects(launched, error => code(error, "EXEC_OUTPUT_LIMIT"));
  }
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

test("SEC-03 native bridge identity and shutdown remain fail-closed without loading an addon", async () => {
  const rootAuthority = {
    rootId: "workspace", access: "read-write", canonicalPath: "C:\\fixture", canonicalCwd: "C:\\fixture",
    identity: { volumeSerial: "volume", fileId: "root", type: "directory" },
    cwdIdentity: { volumeSerial: "volume", fileId: "cwd", type: "directory" },
  };
  for (const invalidRoot of [
    null,
    { ...rootAuthority, canonicalPath: 1 },
    { ...rootAuthority, canonicalPath: "" },
    { ...rootAuthority, canonicalPath: "C:\\bad\0path" },
    { ...rootAuthority, canonicalPath: "relative" },
    { ...rootAuthority, canonicalPath: "\\\\server\\share" },
    { ...rootAuthority, canonicalCwd: 1 },
    { ...rootAuthority, canonicalCwd: "relative" },
    { ...rootAuthority, canonicalCwd: "C:\\bad\0cwd" },
  ]) assert.throws(() => bindNativeRootAuthority(invalidRoot), error => error?.code === "EXEC_NATIVE_PROTOCOL");
  const binding = bindNativeRootAuthority({
    rootId: "workspace",
    access: "read-write",
    canonicalPath: "C:\\fixture",
    canonicalCwd: "C:\\fixture",
    identity: { volumeSerial: "volume", fileId: "root", type: "directory" },
    cwdIdentity: { volumeSerial: "volume", fileId: "cwd", type: "directory" },
  });
  assert.match(binding.nativeAuthorityId, /^[a-f0-9]{64}$/u);
  binding.revoke();

  const artifactIdentity = {
    candidateId: HASH, buildIdSha256: HASH, sourceSha256: HASH,
    launcherSha256: HASH, launcherBytes: 1, hostSha256: HASH, hostBytes: 1,
    machine: "x64", protocolVersion: 1,
  };
  for (const invalidIdentity of [
    null,
    { ...artifactIdentity, machine: "arm64" },
    { ...artifactIdentity, protocolVersion: 2 },
    { ...artifactIdentity, candidateId: "bad" },
    { ...artifactIdentity, buildIdSha256: "bad" },
    { ...artifactIdentity, sourceSha256: "bad" },
    { ...artifactIdentity, launcherSha256: "bad" },
    { ...artifactIdentity, hostSha256: "bad" },
    { ...artifactIdentity, launcherBytes: 0 },
    { ...artifactIdentity, launcherBytes: 1.5 },
    { ...artifactIdentity, hostBytes: 0 },
    { ...artifactIdentity, hostBytes: 1.5 },
  ]) assert.throws(() => createProductionNativeExecutionBridge(invalidIdentity), TypeError);
  const bridge = createProductionNativeExecutionBridge(artifactIdentity);
  await assert.rejects(() => bridge.initialize(), error => error?.code === "EXEC_NATIVE_IDENTITY_INVALID");
  await assert.rejects(() => bridge.initialize(), error => error?.code === "EXEC_NATIVE_IDENTITY_INVALID");
  await bridge.shutdown();
  await bridge.shutdown();
  await assert.rejects(() => bridge.initialize(), error => error?.code === "EXEC_NATIVE_SHUTDOWN");
  await assert.rejects(() => bridge.observeServiceDenial({}), error => error?.code === "EXEC_NATIVE_SHUTDOWN");
  await assert.rejects(() => bridge.launch({}, () => {}), error => error?.code === "EXEC_NATIVE_SHUTDOWN");
});

test("SEC-03 runtime gateways reject mismatched public requests before native authority use", async () => {
  const resourceOwner = owner();
  const context = {
    executionDomainId: "context-a",
    sessionId: "session-a",
    runId: "run-a",
    principal: "agent",
    authorityEpoch: 1,
    persona: { digest: HASH },
    allowedRoots: ["workspace"],
    approvalGrant: { registrationId: "registration-a", argumentsDigest: HASH, toolOrOperation: "execute_command" },
  };
  const inspected = {
    registrationId: "registration-a",
    argumentsDigest: HASH,
    name: "execute_command",
    args: { command: "echo approved" },
    policy: { approval: "user", effects: ["process"] },
  };
  const gateway = createScopedExecutionGateway({ context, inspected, owner: resourceOwner });
  await assert.rejects(() => gateway.executeCommand({ command: "echo changed", rootLease: {} }), error => code(error, "EXEC_GRANT_ARGUMENT_MISMATCH"));
  await assert.rejects(() => gateway.executeScript({ code: "changed", rootLease: {} }), error => code(error, "EXEC_GRANT_ARGUMENT_MISMATCH"));
  await assert.rejects(() => gateway.startShell({ terminalId: "term_12345678", shell: "cmd", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(() => gateway.writeShell({ lease: { leaseId: "forged" }, terminalId: "term_12345678", data: "dir", appendNewline: true }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const mismatched = createScopedExecutionGateway({
    context: { ...context, approvalGrant: { ...context.approvalGrant, argumentsDigest: "a".repeat(64) } },
    inspected,
    owner: resourceOwner,
  });
  await assert.rejects(() => mismatched.executeCommand({ command: "echo approved", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));
});

test("SEC-03 runtime gateway binding matrix rejects each mismatched authority before root or native use", async () => {
  const resourceOwner = owner();
  const context = {
    executionDomainId: "context-a", sessionId: "session-a", runId: "run-a", principal: "agent", authorityEpoch: 1,
    persona: { digest: HASH }, allowedRoots: ["workspace"],
    approvalGrant: { registrationId: "registration-a", argumentsDigest: HASH, toolOrOperation: "execute_command" },
  };
  const inspected = {
    registrationId: "registration-a", argumentsDigest: HASH, name: "execute_command",
    args: { command: "echo approved" }, policy: { approval: "user", effects: ["process"] },
  };
  const mismatchCases = [
    [owner("session-b"), context, inspected],
    [owner("session-a", 2), context, inspected],
    [owner("session-a", 1, "local-user-api"), context, inspected],
    [resourceOwner, { ...context, persona: { digest: "bad" } }, inspected],
    [resourceOwner, { ...context, approvalGrant: undefined }, inspected],
    [resourceOwner, context, { ...inspected, registrationId: "other" }],
    [resourceOwner, context, { ...inspected, argumentsDigest: "f".repeat(64) }],
    [resourceOwner, context, { ...inspected, name: "script" }],
  ];
  for (const [caseOwner, caseContext, caseInspected] of mismatchCases) {
    const gateway = createScopedExecutionGateway({ context: caseContext, inspected: caseInspected, owner: caseOwner });
    await assert.rejects(
      () => gateway.executeCommand({ command: caseInspected.args.command ?? "echo approved", rootLease: {} }),
      error => code(error, caseInspected.name === "execute_command" ? "EXEC_BINDING_MISMATCH" : "EXEC_GRANT_ARGUMENT_MISMATCH"),
    );
  }

  for (const value of [null, "", "x\0y", "x".repeat(128 * 2 ** 10 + 1)]) {
    const current = { ...inspected, args: { command: value } };
    const gateway = createScopedExecutionGateway({ context, inspected: current, owner: resourceOwner });
    await assert.rejects(() => gateway.executeCommand({ command: value, rootLease: {} }), error => code(error, "EXEC_REQUEST_INVALID"));
  }
  const wrongCommandName = createScopedExecutionGateway({ context, inspected: { ...inspected, name: "script" }, owner: resourceOwner });
  await assert.rejects(() => wrongCommandName.executeCommand({ command: "echo approved", rootLease: {} }), error => code(error, "EXEC_GRANT_ARGUMENT_MISMATCH"));
  const wrongScriptName = createScopedExecutionGateway({ context, inspected, owner: resourceOwner });
  await assert.rejects(() => wrongScriptName.executeScript({ code: "echo approved", rootLease: {} }), error => code(error, "EXEC_GRANT_ARGUMENT_MISMATCH"));
  const changedScript = createScopedExecutionGateway({
    context: { ...context, approvalGrant: { ...context.approvalGrant, toolOrOperation: "script" } },
    inspected: { ...inspected, name: "script", args: { code: "approved" } }, owner: resourceOwner,
  });
  await assert.rejects(() => changedScript.executeScript({ code: "changed", rootLease: {} }), error => code(error, "EXEC_GRANT_ARGUMENT_MISMATCH"));

  const inputContext = { ...context, approvalGrant: { ...context.approvalGrant, toolOrOperation: "shell_input" } };
  const inputInspected = { ...inspected, name: "shell_input", args: { terminalId: "term_12345678", input: "dir", appendNewline: true } };
  const inputGateway = createScopedExecutionGateway({ context: inputContext, inspected: inputInspected, owner: resourceOwner });
  const write = () => inputGateway.writeShell({ lease: { leaseId: "forged" }, terminalId: "term_12345678", data: "dir", appendNewline: true });
  await assert.rejects(write, error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(write, error => code(error, "EXEC_BINDING_MISMATCH"));
});

test("SEC-03 manual runtime binding and observation matrices reject every untrusted variant", async () => {
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const context = {
    executionDomainId: "context-a", sessionId: "session-a", runId: "run-a", principal: "local-user-api", authorityEpoch: 1,
    persona: { digest: HASH }, allowedRoots: ["workspace"],
  };
  assert.throws(() => manualConsentEvidenceBinding(null, "terminal-start"), error => code(error, "EXEC_REQUEST_INVALID"));
  assert.equal(manualConsentEvidenceBinding(context, "terminal-input").contextId, "context-a");
  for (const request of [
    null,
    { entryPoint: "E1", profile: "manual-terminal", operation: "consent", decisionState: "consent-denied" },
    { entryPoint: "E4", profile: "agent-shell", operation: "consent", decisionState: "consent-denied" },
    { entryPoint: "E4", profile: "manual-terminal", operation: "launch", decisionState: "consent-denied" },
    { entryPoint: "E4", profile: "manual-terminal", operation: "consent", decisionState: "unknown" },
  ]) await assert.rejects(() => observeManualConsentDenial(request), error => code(error, "EXEC_REQUEST_INVALID"));

  const invalidContexts = [
    { ...context, principal: "agent" },
    { ...context, sessionId: "session-b" },
    { ...context, authorityEpoch: 2 },
  ];
  for (const invalidContext of invalidContexts) {
    const gateway = createManualExecutionGateway({ context: invalidContext, owner: resourceOwner, operation: "terminal-start", exactRequest: { shell: "cmd" } });
    await assert.rejects(() => gateway.startShell({ terminalId: "term_12345678", shell: "cmd", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));
  }
  const wrongOwner = createManualExecutionGateway({ context, owner: owner("session-a", 1, "agent"), operation: "terminal-start", exactRequest: { shell: "cmd" } });
  await assert.rejects(() => wrongOwner.startShell({ terminalId: "term_12345678", shell: "cmd", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const input = createManualExecutionGateway({ context, owner: resourceOwner, operation: "terminal-input", exactRequest: { id: "term_12345678", input: "dir" } });
  const write = () => input.writeShell({ lease: { leaseId: "forged" }, terminalId: "term_12345678", data: "dir", appendNewline: true });
  await assert.rejects(write, error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(write, error => code(error, "EXEC_BINDING_MISMATCH"));
});

test("SEC-03 manual runtime denial observation uses the fixed production identity", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const proof = await observeManualConsentDenial({
    executionId: HASH,
    entryPoint: "E4",
    profile: "manual-terminal",
    contextId: "context-a",
    sessionId: "session-a",
    runId: "run-a",
    authorityEpoch: 1,
    personaDigest: HASH,
    policyDigest: HASH,
    payloadDigest: HASH,
    requestDigest: HASH,
    operation: "consent",
    decisionState: "consent-denied",
  });
  assert.equal(Buffer.isBuffer(proof.proof), true);
  assert.match(proof.mac, /^[a-f0-9]{64}$/u);
  assert.match(proof.keyId, /^[a-f0-9]{64}$/u);
  assert.match(proof.channelMarker, /^[a-f0-9]{64}$/u);
});

test("SEC-03 production runtime rejects every native/build identity drift before observation", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const buildPath = new URL("../../build-info.json", import.meta.url);
  const manifestPath = new URL("../../dist/native/sec03-native-manifest.json", import.meta.url);
  const [buildBytes, manifestBytes] = await Promise.all([readFile(buildPath), readFile(manifestPath)]);
  const build = JSON.parse(buildBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const denialRequest = {
    executionId: HASH, entryPoint: "E4", profile: "manual-terminal", contextId: "context-a", sessionId: "session-a", runId: "run-a",
    authorityEpoch: 1, personaDigest: HASH, policyDigest: HASH, payloadDigest: HASH, requestDigest: HASH,
    operation: "consent", decisionState: "consent-denied",
  };
  const expectRejected = async () => assert.rejects(
    () => observeManualConsentDenial(denialRequest),
    error => code(error, "EXEC_NATIVE_IDENTITY_INVALID"),
  );
  const mutate = (value, apply) => {
    const copy = structuredClone(value);
    apply(copy);
    return copy;
  };
  const manifestMutations = [
    value => { value.schemaVersion = 2; },
    value => { value.architecture = "arm64"; },
    value => { value.signatureStatus = "signed"; },
    value => { value.sourceDigest = "bad"; },
    value => { value.toolchainDigest = "bad"; },
    value => { value.outputs = null; },
    value => { value.outputs = value.outputs.slice(0, 1); },
    value => { value.outputs[0].path = "dist/native/other.exe"; },
    value => { value.outputs[0].bytes = 0; },
    value => { value.outputs[0].sha256 = "bad"; },
    value => { value.outputs[0].machine = "ARM64"; },
    value => { value.outputs[1].path = "dist/native/other.node"; },
    value => { value.outputs[1].bytes = 0; },
    value => { value.outputs[1].sha256 = "bad"; },
    value => { value.outputs[1].machine = "ARM64"; },
  ];
  const buildMutations = [
    value => { value.schemaVersion = 2; },
    value => { value.product = "Other"; },
    value => { value.candidateId = "bad"; },
    value => { value.sourceDigest = "bad"; },
    value => { value.buildId = 1; },
    value => { value.buildId = ""; },
    value => { value.buildId = "x".repeat(129); },
    value => { value.versions = null; },
    value => { value.versions.executionIsolation = null; },
    value => { value.versions.executionIsolation.artifacts = null; },
    value => { value.versions.executionIsolation.artifacts = value.versions.executionIsolation.artifacts.slice(0, 1); },
    value => { value.versions.executionIsolation.architectureSha256 = "bad"; },
    value => { value.versions.executionIsolation.protocolVersion = 2; },
    value => { value.versions.executionIsolation.nativeSourceDigest = "bad"; },
    value => { value.versions.executionIsolation.toolchainDigest = "bad"; },
    value => { value.versions.executionIsolation.signatureStatus = "signed"; },
    value => { value.versions.executionIsolation.artifacts[0].path = "dist/native/other.exe"; },
    value => { value.versions.executionIsolation.artifacts[0].bytes = 0; },
    value => { value.versions.executionIsolation.artifacts[0].sha256 = "bad"; },
    value => { value.versions.executionIsolation.artifacts[0].machine = "ARM64"; },
    value => { value.versions.executionIsolation.artifacts[1].path = "dist/native/other.node"; },
    value => { value.versions.executionIsolation.artifacts[1].bytes = 0; },
    value => { value.versions.executionIsolation.artifacts[1].sha256 = "bad"; },
    value => { value.versions.executionIsolation.artifacts[1].machine = "ARM64"; },
  ];
  try {
    await writeFile(buildPath, "{not-json", "utf8");
    await expectRejected();
    await writeFile(buildPath, buildBytes);
    for (const apply of manifestMutations) {
      await writeFile(manifestPath, JSON.stringify(mutate(manifest, apply)), "utf8");
      await expectRejected();
    }
    await writeFile(manifestPath, manifestBytes);
    for (const apply of buildMutations) {
      await writeFile(buildPath, JSON.stringify(mutate(build, apply)), "utf8");
      await expectRejected();
    }
  } finally {
    await Promise.all([writeFile(buildPath, buildBytes), writeFile(manifestPath, manifestBytes)]);
  }
  assert.deepEqual(await readFile(buildPath), buildBytes);
  assert.deepEqual(await readFile(manifestPath), manifestBytes);
});

test("SEC-03 manual runtime evidence and opaque leases reject invalid public use", async () => {
  const resourceOwner = owner("session-a", 1, "local-user-api");
  const context = {
    executionDomainId: "context-a",
    sessionId: "session-a",
    runId: "run-a",
    principal: "local-user-api",
    authorityEpoch: 1,
    persona: { digest: HASH },
    allowedRoots: ["workspace"],
  };
  const evidence = manualConsentEvidenceBinding(context, "terminal-start");
  assert.equal(evidence.contextId, context.executionDomainId);
  assert.match(evidence.policyDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => manualConsentEvidenceBinding({ ...context, principal: "agent" }, "terminal-start"), error => code(error, "EXEC_REQUEST_INVALID"));
  assert.throws(() => manualConsentEvidenceBinding(context, "invalid"), error => code(error, "EXEC_REQUEST_INVALID"));
  await assert.rejects(() => observeManualConsentDenial({}), error => code(error, "EXEC_REQUEST_INVALID"));

  const start = createManualExecutionGateway({ context, owner: resourceOwner, operation: "terminal-start", exactRequest: { shell: "cmd" } });
  await assert.rejects(() => start.executeCommand({ command: "dir", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(() => start.executeScript({ code: "", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));
  await assert.rejects(() => start.writeShell({ lease: { leaseId: "forged" }, terminalId: "term_12345678", data: "dir", appendNewline: true }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const input = createManualExecutionGateway({ context, owner: resourceOwner, operation: "terminal-input", exactRequest: { id: "term_12345678", input: "dir" } });
  await assert.rejects(() => input.startShell({ terminalId: "term_12345678", shell: "cmd", rootLease: {} }), error => code(error, "EXEC_BINDING_MISMATCH"));

  const forged = { leaseId: "forged" };
  assert.throws(() => readIsolatedTerminal(forged, resourceOwner), error => code(error, "EXEC_GRANT_FORGED"));
  await assert.rejects(() => terminateIsolatedTerminal(forged, resourceOwner), error => code(error, "EXEC_GRANT_FORGED"));
  await assert.rejects(() => retireIsolatedTerminal(forged, resourceOwner, "owner-retired"), error => code(error, "EXEC_GRANT_FORGED"));
  await shutdownExecutionRuntime();
});

test("SEC-03 execution request validation rejects every public boundary variant", async () => {
  const now = 1_900_001_000_000;
  const resourceOwner = owner();
  const make = (entryPoint = "E1", overrides = {}) => request(resourceOwner, now, entryPoint, overrides);
  const expectCode = (label, input, expected = "EXEC_REQUEST_INVALID") => {
    const fake = fakeBridge();
    const service = new ExecutionIsolationService(fake.bridge, { now: () => now });
    assert.throws(() => service.issueExecutionGrant(input), error => code(error, expected), label);
    assert.equal(fake.state.launches, 0, `${label} reached native launch`);
  };

  assert.throws(() => new ExecutionIsolationService(null), TypeError);
  assert.throws(() => new ExecutionIsolationService({ launch() {} }), TypeError);
  for (const [label, overrides, expected] of [
    ["context id", { contextId: "" }],
    ["session id", { sessionId: "" }],
    ["run id", { runId: "" }],
    ["principal", { principal: "" }],
    ["fractional epoch", { authorityEpoch: 1.5 }],
    ["zero epoch", { authorityEpoch: 0 }],
    ["persona digest", { personaDigest: "bad" }],
    ["policy digest", { policyDigest: "bad" }],
    ["owner session", { resourceOwner: owner("session-b") }, "EXEC_BINDING_MISMATCH"],
    ["owner epoch", { resourceOwner: owner("session-a", 2) }, "EXEC_BINDING_MISMATCH"],
    ["owner principal", { resourceOwner: owner("session-a", 1, "local-user-api") }, "EXEC_BINDING_MISMATCH"],
    ["entry point", { entryPoint: "E9" }, "EXEC_PROFILE_INVALID"],
    ["profile", { profile: "script" }, "EXEC_PROFILE_INVALID"],
    ["payload type", { payload: "not-bytes" }],
    ["empty payload", { payload: Buffer.alloc(0) }],
    ["expiry type", { expiresAtMs: Number.NaN }, "EXEC_GRANT_EXPIRED"],
    ["expired", { expiresAtMs: now }, "EXEC_GRANT_EXPIRED"],
    ["expiry horizon", { expiresAtMs: now + 15_001 }, "EXEC_GRANT_EXPIRED"],
    ["missing limits", { limits: null }],
    ["fractional limit", { limits: limits("E1", { activeProcesses: 1.5 }) }],
    ["zero limit", { limits: limits("E1", { activeProcesses: 0 }) }],
    ["excess limit", { limits: limits("E1", { activeProcesses: 17 }) }],
    ["retained relationship", { limits: limits("E1", { retainedOutputBytes: 1025 }) }],
    ["memory relationship", { limits: limits("E1", { processMemoryBytes: 2 ** 20 + 1 }) }],
    ["one-shot idle", { limits: limits("E1", { idleTimeMs: 1 }) }],
    ["persistent idle missing", { entryPoint: "E2", profile: "agent-shell", limits: limits("E2", { idleTimeMs: null }) }],
    ["persistent idle zero", { entryPoint: "E2", profile: "agent-shell", limits: limits("E2", { idleTimeMs: 0 }) }],
    ["persistent idle excess", { entryPoint: "E2", profile: "agent-shell", limits: limits("E2", { idleTimeMs: 300_001 }) }],
    ["payload profile limit", { payload: Buffer.alloc(1025) }],
    ["roots type", { roots: null }],
    ["null root", { roots: [null] }],
    ["root id", { roots: [{ ...make().roots[0], rootId: "BAD" }] }],
    ["root access", { roots: [{ ...make().roots[0], access: "execute" }] }],
    ["root identity missing", { roots: [{ ...make().roots[0], identity: null }] }],
    ["root identity type", { roots: [{ ...make().roots[0], identity: { ...make().roots[0].identity, type: "file" } }] }],
    ["root volume", { roots: [{ ...make().roots[0], identity: { ...make().roots[0].identity, volumeSerial: "" } }] }],
    ["root file", { roots: [{ ...make().roots[0], identity: { ...make().roots[0].identity, fileId: "" } }] }],
    ["duplicate roots", { roots: [make().roots[0], { ...make().roots[0] }] }],
    ["environment missing", { environment: null }],
    ["environment prototype", { environment: Object.create(null) }],
    ["environment key grammar", { environment: { "1BAD": "x" } }],
    ["environment allowlist", { environment: { UNLISTED: "x" } }],
    ["environment value type", { environment: { SystemRoot: 1 } }],
    ["environment nul", { environment: { SystemRoot: "bad\0value" } }],
    ["environment bound", { environment: { SystemRoot: "x".repeat(32_769) } }],
    ["script ComSpec", { entryPoint: "E3", profile: "script", limits: limits("E3"), environment: { ComSpec: "cmd.exe" } }],
    ["shell Node env", { environment: { NODE_DISABLE_COLORS: "1" } }],
    ["network missing", { network: null }],
    ["network mode", { network: { mode: "direct" } }],
    ["persistent broker", { entryPoint: "E2", profile: "agent-shell", limits: limits("E2"), network: { mode: "brokered", operationsDigest: HASH } }, "EXEC_NETWORK_PROFILE_UNSUPPORTED"],
    ["script broker digest", { entryPoint: "E3", profile: "script", limits: limits("E3"), environment: { NODE_DISABLE_COLORS: "1" }, network: { mode: "brokered", operationsDigest: "bad" } }],
  ]) expectCode(label, make(overrides.entryPoint ?? "E1", overrides), expected);

  const brokered = make("E3", { network: { mode: "brokered", operationsDigest: HASH } });
  assert.ok(new ExecutionIsolationService(fakeBridge().bridge, { now: () => now }).issueExecutionGrant(brokered));
  const stopped = new ExecutionIsolationService(fakeBridge().bridge, { now: () => now });
  await stopped.shutdown();
  assert.throws(() => stopped.issueExecutionGrant(make()), error => code(error, "EXEC_SERVICE_SHUTDOWN"));
});

test("SEC-03 manual consent preparation rejects malformed JSON, bindings, display and evidence", () => {
  assert.throws(() => new ManualExecutionConsentLedger({ observeDenial: true }), TypeError);
  const invalidPrepare = (label, overrides, expected = "CONSENT_REQUEST_INVALID") => {
    const ledger = new ManualExecutionConsentLedger();
    assert.throws(() => prepare(ledger, overrides), error => consentCode(error, expected), label);
  };

  invalidPrepare("operation", { operation: "invalid" });
  for (const [label, override, expected] of [
    ["window type", { windowId: 1.5 }], ["window zero", { windowId: 0 }],
    ["web contents type", { webContentsId: 1.5 }], ["web contents zero", { webContentsId: 0 }],
    ["session type", { sessionId: 1 }], ["session grammar", { sessionId: "" }],
    ["authority type", { runtimeAuthorityId: 1 }], ["authority grammar", { runtimeAuthorityId: "" }],
    ["epoch type", { authorityEpoch: 1.5 }], ["epoch zero", { authorityEpoch: 0 }],
    ["incarnation type", { incarnationId: 1 }], ["incarnation grammar", { incarnationId: "" }],
    ["top frame", { topFrame: false }, "CONSENT_PRESENCE_REQUIRED"],
    ["visible", { windowVisible: false }, "CONSENT_PRESENCE_REQUIRED"],
    ["focused", { windowFocused: false }, "CONSENT_PRESENCE_REQUIRED"],
  ]) invalidPrepare(label, { presence: presence(override) }, expected);

  let deep = null;
  for (let index = 0; index < 34; index += 1) deep = { child: deep };
  invalidPrepare("deep request", { request: deep });
  invalidPrepare("non-finite number", { request: { value: Number.NaN } });
  invalidPrepare("non-JSON value", { request: { value: new Date() } });
  invalidPrepare("empty key", { request: { "": true } });
  invalidPrepare("long key", { request: { ["x".repeat(129)]: true } });
  invalidPrepare("large request", { request: { value: "x".repeat(256 * 1024) } });
  invalidPrepare("start root missing", { operation: "terminal-start", rootQualificationDigest: null });
  invalidPrepare("start root malformed", { operation: "terminal-start", rootQualificationDigest: "bad" });
  invalidPrepare("input root present", { rootQualificationDigest: HASH });
  for (const [label, display] of [
    ["display missing", null],
    ["display type", { operationLabel: 1, targetLabel: "target", rootAlias: "workspace", preview: "preview" }],
    ["display empty", { operationLabel: "", targetLabel: "target", rootAlias: "workspace", preview: "preview" }],
    ["display long", { operationLabel: "x".repeat(513), targetLabel: "target", rootAlias: "workspace", preview: "preview" }],
    ["display nul", { operationLabel: "bad\0label", targetLabel: "target", rootAlias: "workspace", preview: "preview" }],
  ]) invalidPrepare(label, { display });

  const validEvidence = { contextId: "context-a", sessionId: "session-a", runId: "run-a", authorityEpoch: 1, personaDigest: HASH, policyDigest: HASH };
  for (const [label, evidence] of [
    ["evidence context", { ...validEvidence, contextId: "" }],
    ["evidence epoch type", { ...validEvidence, authorityEpoch: 1.5 }],
    ["evidence epoch zero", { ...validEvidence, authorityEpoch: 0 }],
    ["evidence persona", { ...validEvidence, personaDigest: "bad" }],
    ["evidence policy", { ...validEvidence, policyDigest: "bad" }],
  ]) invalidPrepare(label, { evidence });

  const saturated = new ManualExecutionConsentLedger();
  for (let index = 0; index < 128; index += 1) prepare(saturated);
  assert.throws(() => prepare(saturated), error => consentCode(error, "CONSENT_REQUEST_INVALID"));
  const stopped = new ManualExecutionConsentLedger();
  stopped.shutdown();
  assert.throws(() => prepare(stopped), error => consentCode(error, "CONSENT_LEDGER_SHUTDOWN"));
});
