import { canonicalJson, sha256 } from "./identity.mjs";
import { sealReceipt } from "./report-schema.mjs";

function inputDigest(runId, challenge, candidateId, id, previousReceiptSha256) {
  return sha256(canonicalJson({ runId, challenge, candidateId, id, previousReceiptSha256 }));
}

export function executedReceipt({
  id,
  runId,
  challenge,
  candidateId,
  previousReceiptSha256,
  startedAt,
  finishedAt,
  command = [],
  state,
  failureClass = null,
  exitCode = 0,
  signal = null,
  timedOut = false,
  timeoutTermination = null,
  childReportSha256 = null,
  evidence = {},
}) {
  const start = new Date(startedAt);
  const finish = new Date(finishedAt);
  return sealReceipt({
    id,
    executed: true,
    attempt: 1,
    state,
    failureClass,
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    durationMs: Math.max(0, finish.getTime() - start.getTime()),
    command,
    exitCode,
    signal,
    timedOut,
    timeoutTermination,
    inputDigest: inputDigest(runId, challenge, candidateId, id, previousReceiptSha256),
    outputDigest: sha256(canonicalJson(evidence)),
    childReportSha256,
    previousReceiptSha256,
    evidence,
  });
}

export function blockedReceipt({ id, runId, challenge, candidateId, previousReceiptSha256, blockedBy }) {
  const evidence = { blockedBy };
  return sealReceipt({
    id,
    executed: false,
    attempt: 0,
    state: "blocked",
    failureClass: "UPSTREAM_BLOCKED",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    command: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutTermination: null,
    inputDigest: inputDigest(runId, challenge, candidateId, id, previousReceiptSha256),
    outputDigest: sha256(canonicalJson(evidence)),
    childReportSha256: null,
    previousReceiptSha256,
    evidence,
  });
}

export function receiptFromOperation({ id, runId, challenge, candidateId, previousReceiptSha256, startedAt, command, operation }) {
  const finishedAt = new Date();
  return executedReceipt({
    id,
    runId,
    challenge,
    candidateId,
    previousReceiptSha256,
    startedAt,
    finishedAt,
    command,
    state: operation.passed ? "passed" : operation.unsupported ? "unsupported" : "failed",
    failureClass: operation.passed ? null : operation.failureClass,
    exitCode: operation.exitCode,
    signal: operation.signal ?? null,
    timedOut: operation.timedOut ?? false,
    timeoutTermination: operation.timeoutTermination ?? null,
    childReportSha256: operation.childReportSha256 ?? null,
    evidence: operation.evidence ?? {},
  });
}
