import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  invalidateNativeProcessConsent,
  registerNativeProcessConsentHandler,
  requestNativeProcessConsent,
} from "../../dist/native-process-consent.js";
import { ManualExecutionConsentLedger } from "../../dist/manual-execution-consent.js";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function processRequest(overrides = {}) {
  const authority = Object.freeze({ authorityId: "runtime-authority-a" });
  const args = { cwd: "C:/workspace", command: "x".repeat(1200) };
  return {
    authority,
    authorityEpoch: 1,
    sessionId: "session-a",
    runId: "run-a",
    contextId: "context-a",
    registrationId: "registration-a",
    toolName: "execute_command",
    argumentsDigest: "a".repeat(64),
    args,
    profile: "developer",
    rootAliases: ["workspace", "output"],
    cwd: "C:/workspace",
    validateCurrent: () => true,
    ...overrides,
  };
}

test("SEC-03 native process consent is unavailable without the private main-process handler", async () => {
  invalidateNativeProcessConsent();
  assert.equal(await requestNativeProcessConsent(processRequest()), false);
});

test("SEC-03 native process consent binds exact bytes, authority and one native decision", async () => {
  let observed;
  const cleanup = registerNativeProcessConsentHandler(challenge => {
    observed = challenge;
    return "approve";
  });
  try {
    const request = processRequest();
    assert.equal(await requestNativeProcessConsent(request), true);
    assert.match(observed.nonce, /^[a-f0-9]{64}$/u);
    assert.equal(observed.runtimeAuthorityId, request.authority.authorityId);
    assert.equal(observed.sessionId, request.sessionId);
    assert.equal(observed.runId, request.runId);
    assert.equal(observed.contextId, request.contextId);
    assert.equal(observed.registrationId, request.registrationId);
    assert.equal(observed.toolName, request.toolName);
    assert.equal(observed.argumentsDigest, request.argumentsDigest);
    const encoded = Buffer.from(JSON.stringify({ command: request.args.command, cwd: request.args.cwd }), "utf8");
    assert.equal(observed.argumentsUtf8Bytes, encoded.length);
    assert.equal(observed.argumentsBytesSha256, createHash("sha256").update(encoded).digest("hex"));
    assert.equal(observed.previewTruncated, true);
    assert.match(observed.preview, /\[truncated;/u);
  } finally {
    cleanup();
  }
});

test("SEC-03 native process consent denies invalidation and current-runtime replacement", async () => {
  const gate = deferred();
  const cleanup = registerNativeProcessConsentHandler(async () => {
    await gate.promise;
    return "approve";
  });
  try {
    const pending = requestNativeProcessConsent(processRequest());
    invalidateNativeProcessConsent();
    gate.resolve();
    assert.equal(await pending, false);
  } finally {
    cleanup();
  }

  const cleanupReplacement = registerNativeProcessConsentHandler(() => "approve");
  try {
    assert.equal(await requestNativeProcessConsent(processRequest({ validateCurrent: () => false })), false);
  } finally {
    cleanupReplacement();
  }
});

function presence(overrides = {}) {
  return {
    windowId: 7,
    webContentsId: 9,
    sessionId: "session-a",
    runtimeAuthorityId: "runtime-a",
    authorityEpoch: 1,
    incarnationId: "incarnation-a",
    topFrame: true,
    windowVisible: true,
    windowFocused: true,
    ...overrides,
  };
}

function prepareManual(ledger, overrides = {}) {
  return ledger.prepare({
    operation: "terminal-input",
    presence: presence(),
    request: { id: "terminal-a", input: "dir" },
    display: { operationLabel: "input", targetLabel: "terminal-a", rootAlias: "terminal", preview: "dir" },
    ...overrides,
  });
}

test("SEC-03 manual consent rejects authority reincarnation, old A-to-B-to-A and invalidation", async () => {
  const ledger = new ManualExecutionConsentLedger();
  let executions = 0;
  const challenge = prepareManual(ledger);
  await assert.rejects(
    () => ledger.decide({
      challengeId: challenge.challengeId,
      decision: "approve",
      presence: presence({ incarnationId: "incarnation-b" }),
      operation: challenge.operation,
      argumentsDigest: challenge.argumentsDigest,
    }, () => { executions += 1; }),
    error => error?.code === "EXEC_CONSENT_CROSS_SESSION",
  );

  const oldAuthority = prepareManual(ledger);
  await assert.rejects(
    () => ledger.decide({
      challengeId: oldAuthority.challengeId,
      decision: "approve",
      presence: presence({ runtimeAuthorityId: "runtime-b" }),
      operation: oldAuthority.operation,
      argumentsDigest: oldAuthority.argumentsDigest,
    }, () => { executions += 1; }),
    error => error?.code === "EXEC_CONSENT_CROSS_SESSION",
  );

  const invalidated = prepareManual(ledger);
  ledger.invalidateAll();
  await assert.rejects(
    () => ledger.decide({
      challengeId: invalidated.challengeId,
      decision: "approve",
      presence: presence(),
      operation: invalidated.operation,
      argumentsDigest: invalidated.argumentsDigest,
    }, () => { executions += 1; }),
    error => error?.code === "EXEC_CONSENT_REPLAYED",
  );
  assert.equal(executions, 0);
});

test("SEC-03 manual consent keeps prepare/shutdown failures outside A12 decision codes", () => {
  const ledger = new ManualExecutionConsentLedger();
  assert.throws(
    () => prepareManual(ledger, { presence: presence({ windowFocused: false }) }),
    error => error?.code === "CONSENT_PRESENCE_REQUIRED",
  );
  assert.throws(
    () => prepareManual(ledger, { presence: presence({ windowId: 0 }) }),
    error => error?.code === "CONSENT_REQUEST_INVALID",
  );
  ledger.shutdown();
  assert.throws(() => prepareManual(ledger), error => error?.code === "CONSENT_LEDGER_SHUTDOWN");
});

test("SEC-03 manual terminal start requires and preserves a private root qualification digest", async () => {
  const ledger = new ManualExecutionConsentLedger();
  const request = { shell: "powershell", cwd: "C:/workspace" };
  const display = { operationLabel: "start", targetLabel: "workspace", rootAlias: "workspace", preview: "powershell" };
  assert.throws(() => ledger.prepare({
    operation: "terminal-start",
    presence: presence(),
    request,
    display,
  }), error => error?.code === "CONSENT_REQUEST_INVALID");

  const rootQualificationDigest = "b".repeat(64);
  const challenge = ledger.prepare({
    operation: "terminal-start",
    presence: presence(),
    request,
    display,
    rootQualificationDigest,
  });
  let observedDigest;
  await ledger.decide({
    challengeId: challenge.challengeId,
    decision: "approve",
    presence: presence(),
    operation: challenge.operation,
    argumentsDigest: challenge.argumentsDigest,
  }, (_operation, _exactRequest, storedDigest) => { observedDigest = storedDigest; });
  assert.equal(observedDigest, rootQualificationDigest);
});
