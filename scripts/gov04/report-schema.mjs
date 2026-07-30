import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalJson, sha256, validateCandidateIdentity } from "./identity.mjs";
import { trustedProvenanceMatches } from "./provenance.mjs";

export const gov04SelfTestIds = Object.freeze([
  "G04-01", "G04-02", "G04-03", "G04-04", "G04-05", "G04-06", "G04-07", "G04-08", "G04-09",
  "G04-10", "G04-11", "G04-12", "G04-13", "G04-14", "G04-15", "G04-16", "G04-17", "G04-18",
  "G04-19", "G04-20", "G04-21", "G04-22", "G04-23",
]);

export const gov04StepIds = Object.freeze([
  "prepare",
  "source-clean-install",
  "typecheck",
  "lint",
  "source-test-build",
  "gov03-quick",
  "gov03-self-test",
  "sca-production",
  "sca-full",
  "secret-current",
  "secret-history",
  "package-clean-install",
  "package",
  "signature-policy",
  "packaged-smoke",
  "finalize",
]);

const commandByStep = Object.freeze({
  "prepare": ["internal", "prepare"],
  "source-clean-install": ["npm", "ci", "--registry", "https://registry.npmjs.org", "--no-audit", "--no-fund"],
  "typecheck": ["npm", "run", "typecheck"],
  "lint": ["npm", "run", "lint"],
  "source-test-build": ["internal", "source-test-build"],
  "gov03-quick": ["node", "scripts/run-tests.mjs", "--profile", "quick", "--report", "<run-report>"],
  "gov03-self-test": ["node", "scripts/test-gate-selftest.mjs", "--task", "GOV-03", "--report", "<run-report>"],
  "sca-production": ["npm", "audit", "--omit=dev", "--registry", "https://registry.npmjs.org", "--audit-level=high", "--json"],
  "sca-full": ["npm", "audit", "--registry", "https://registry.npmjs.org", "--audit-level=high", "--json"],
  "secret-current": ["gitleaks", "dir", ".", "--redact=100"],
  "secret-history": ["gitleaks", "git", ".", "--redact=100"],
  "package-clean-install": ["npm", "ci", "--registry", "https://registry.npmjs.org", "--no-audit", "--no-fund"],
  "package": ["npm", "run", "dist"],
  "signature-policy": ["powershell", "authenticode.ps1", "<artifact>"],
  "packaged-smoke": ["node", "scripts/run-test-layer.mjs", "--task", "GOV-03", "--layer", "packaged", "--report", "<run-report>"],
  "finalize": ["internal", "finalize"],
});

const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const absolutePathPattern = /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\[^\\]|\/(?:Users|home)\/)/;
const forbiddenKeyPattern = /(?:api.?key|private.?key|access.?token|secret.?value|prompt|message)/i;

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

function validateIso(value, field) {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(isoPattern.test(value) && new Date(value).toISOString() === value, `${field} must be canonical ISO`);
}

function validateNoSensitiveData(value, field = "report") {
  if (Array.isArray(value)) return value.forEach((entry, index) => validateNoSensitiveData(entry, `${field}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assert(!forbiddenKeyPattern.test(key), `${field}.${key} is a forbidden evidence field`);
      validateNoSensitiveData(entry, `${field}.${key}`);
    }
    return;
  }
  if (typeof value === "string") assert(!absolutePathPattern.test(value), `${field} contains an absolute user path`);
}

function validateTimeoutTermination(value, field) {
  if (value === null) return;
  exactKeys(value, ["attempted", "exitCode", "childExited"], field);
  assert.equal(typeof value.attempted, "boolean");
  assert(Number.isSafeInteger(value.exitCode) && value.exitCode >= 0);
  assert.equal(typeof value.childExited, "boolean");
}

function receiptPayload(receipt) {
  const { receiptSha256: _ignored, ...payload } = receipt;
  return payload;
}

export function sealReceipt(receipt) {
  return { ...receipt, receiptSha256: sha256(canonicalJson(receipt)) };
}

function validateReceipt(receipt, expectedId, previousReceiptSha256, runId, challenge, candidateId) {
  exactKeys(receipt, [
    "id", "executed", "attempt", "state", "failureClass", "startedAt", "finishedAt", "durationMs",
    "command", "exitCode", "signal", "timedOut", "timeoutTermination", "inputDigest", "outputDigest",
    "childReportSha256", "previousReceiptSha256", "evidence", "receiptSha256",
  ], `step ${expectedId}`);
  assert.equal(receipt.id, expectedId);
  assert.equal(typeof receipt.executed, "boolean");
  assert.equal(receipt.attempt, receipt.executed ? 1 : 0, `${expectedId} attempt must prove single execution`);
  assert(["passed", "failed", "unsupported", "blocked"].includes(receipt.state));
  assert.equal(receipt.executed, receipt.state !== "blocked", `${expectedId} execution/state mismatch`);
  assert(receipt.failureClass === null || /^[A-Z][A-Z0-9_]{2,63}$/.test(receipt.failureClass));
  assert.equal(receipt.failureClass === null, receipt.state === "passed", `${expectedId} failureClass/state mismatch`);
  assert(Array.isArray(receipt.command) && receipt.command.every((entry) => typeof entry === "string" && entry.length > 0));
  if (receipt.executed) assert.deepEqual(receipt.command, commandByStep[expectedId], `${expectedId} command differs from frozen contract`);
  assert(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode));
  assert(receipt.signal === null || typeof receipt.signal === "string");
  assert.equal(typeof receipt.timedOut, "boolean");
  validateTimeoutTermination(receipt.timeoutTermination, `${expectedId}.timeoutTermination`);
  assert.match(receipt.inputDigest, sha256Pattern);
  assert.equal(receipt.inputDigest, sha256(canonicalJson({ runId, challenge, candidateId, id: expectedId, previousReceiptSha256 })), `${expectedId} inputDigest is inconsistent`);
  assert.match(receipt.outputDigest, sha256Pattern);
  assert(receipt.childReportSha256 === null || sha256Pattern.test(receipt.childReportSha256));
  assert.equal(receipt.previousReceiptSha256, previousReceiptSha256);
  assert(receipt.evidence && typeof receipt.evidence === "object" && !Array.isArray(receipt.evidence));
  assert.equal(receipt.outputDigest, sha256(canonicalJson(receipt.evidence)), `${expectedId} outputDigest is inconsistent`);
  assert.equal(receipt.receiptSha256, sha256(canonicalJson(receiptPayload(receipt))), `${expectedId} receipt hash is inconsistent`);
  if (receipt.executed) {
    validateIso(receipt.startedAt, `${expectedId}.startedAt`);
    validateIso(receipt.finishedAt, `${expectedId}.finishedAt`);
    assert(Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= 0);
  } else {
    assert.equal(receipt.startedAt, null);
    assert.equal(receipt.finishedAt, null);
    assert.equal(receipt.durationMs, null);
    assert.deepEqual(receipt.command, []);
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.timeoutTermination, null);
    assert.equal(receipt.childReportSha256, null);
  }
  if (receipt.timedOut) {
    assert(receipt.timeoutTermination !== null, `${expectedId} timeout lacks termination evidence`);
    const cleanupPassed = receipt.timeoutTermination.exitCode === 0 && receipt.timeoutTermination.childExited;
    assert.equal(receipt.failureClass, cleanupPassed ? "TIMEOUT" : "TIMEOUT_CLEANUP_FAILED");
  }
}

function validateCleanInstallEvidence(value, expectedRole, passed) {
  if (!passed) return;
  exactKeys(value, ["role", "nodeVersion", "npmVersion", "nodeModulesAbsentBefore", "packageJsonSha256", "lockfileSha256", "inputsUnchanged", "tools", "electronVersion", "electronExecutableSha256", "electronInstallStdoutSha256", "electronInstallStderrSha256", "stdoutBytes", "stderrBytes", "stdoutSha256", "stderrSha256"], `${expectedRole} clean install`);
  assert.equal(value.role, expectedRole);
  assert.equal(value.nodeVersion, "24.14.1");
  assert.equal(value.npmVersion, "11.11.0");
  assert.equal(value.nodeModulesAbsentBefore, true);
  assert.equal(value.inputsUnchanged, true);
  assert.match(value.packageJsonSha256, sha256Pattern);
  assert.match(value.lockfileSha256, sha256Pattern);
  exactKeys(value.tools, ["typescript", "eslint", "c8"], `${expectedRole} install tools`);
  assert.deepEqual(value.tools, { typescript: "5.7.3", eslint: "10.7.0", c8: "10.1.3" });
  assert.equal(value.electronVersion, "43.1.1");
  for (const key of ["electronExecutableSha256", "electronInstallStdoutSha256", "electronInstallStderrSha256"]) assert.match(value[key], sha256Pattern);
  assert(Number.isSafeInteger(value.stdoutBytes) && value.stdoutBytes >= 0);
  assert(Number.isSafeInteger(value.stderrBytes) && value.stderrBytes >= 0);
  assert.match(value.stdoutSha256, sha256Pattern);
  assert.match(value.stderrSha256, sha256Pattern);
}

function validateSourceBuildEvidence(value, passed, candidate) {
  if (!passed) return;
  exactKeys(value, ["buildId", "sourceDateEpoch", "sourceDigest", "buildInfoSha256", "distIntegritySha256", "distTreeSha256", "commands", "outputHashes"], "source-test-build evidence");
  assert.equal(value.buildId, `0.1.0+ci.${candidate.releaseCandidateId}`, "source-test-build Build ID differs from candidate");
  assert.equal(value.sourceDigest, candidate.sourceDigest, "source-test-build source digest differs from candidate");
  assert.match(value.sourceDateEpoch, /^\d+$/);
  for (const key of ["sourceDigest", "buildInfoSha256", "distIntegritySha256", "distTreeSha256"]) assert.match(value[key], sha256Pattern);
  assert.deepEqual(value.commands, [
    ["node", "scripts/build-sec03-native.mjs"],
    ["node", "scripts/generate-build-info.mjs"],
    ["node", "node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
    ["node", "scripts/generate-dist-integrity.mjs"],
  ]);
  assert(Array.isArray(value.outputHashes) && value.outputHashes.length === 4);
  for (const hashes of value.outputHashes) {
    exactKeys(hashes, ["stdoutSha256", "stderrSha256"], "source build output hash");
    assert.match(hashes.stdoutSha256, sha256Pattern);
    assert.match(hashes.stderrSha256, sha256Pattern);
  }
}

function validateScaEvidence(value, field, passed) {
  exactKeys(value, ["status", "registry", "npmVersion", "packageJsonSha256", "lockfileSha256", "inputsUnchanged", "auditReportVersion", "dependencyTotal", "counts", "exceptionCount", "reportSha256"], field);
  assert(["valid", "unavailable", "invalid"].includes(value.status));
  assert.equal(value.registry, "https://registry.npmjs.org");
  assert(value.npmVersion === null || /^\d+\.\d+\.\d+$/.test(value.npmVersion));
  assert.match(value.packageJsonSha256, sha256Pattern);
  assert.match(value.lockfileSha256, sha256Pattern);
  assert.equal(typeof value.inputsUnchanged, "boolean");
  assert(value.auditReportVersion === null || value.auditReportVersion === 2);
  assert(value.dependencyTotal === null || (Number.isSafeInteger(value.dependencyTotal) && value.dependencyTotal > 0));
  assert(value.counts === null || (value.counts && typeof value.counts === "object" && !Array.isArray(value.counts)));
  if (value.counts !== null) {
    exactKeys(value.counts, ["info", "low", "moderate", "high", "critical", "total"], `${field}.counts`);
    for (const count of Object.values(value.counts)) assert(Number.isSafeInteger(count) && count >= 0);
    assert.equal(value.counts.total, value.counts.info + value.counts.low + value.counts.moderate + value.counts.high + value.counts.critical);
  }
  assert.equal(value.exceptionCount, 0);
  assert(value.reportSha256 === null || sha256Pattern.test(value.reportSha256));
  if (passed) {
    assert.equal(value.status, "valid");
    assert.equal(value.npmVersion, "11.11.0");
    assert.equal(value.inputsUnchanged, true, `${field} passed after dependency input mutation`);
    assert(value.counts !== null);
    assert.equal(value.counts.high + value.counts.critical, 0, `${field} passed with high/critical findings`);
    assert.match(value.reportSha256, sha256Pattern);
  }
}

function validateScanEvidence(value, field, passed, history) {
  exactKeys(value, ["status", "scanner", "version", "executableSha256", "findings", "redactionPercent", "redacted", "historyComplete", "reportSha256"], field);
  assert(["valid", "unavailable", "invalid", "unsupported-history"].includes(value.status));
  assert.equal(value.scanner, "gitleaks");
  assert(value.version === null || value.version === "8.30.1");
  assert(value.executableSha256 === null || sha256Pattern.test(value.executableSha256));
  assert(value.findings === null || (Number.isSafeInteger(value.findings) && value.findings >= 0));
  assert.equal(value.redactionPercent, 100);
  assert.equal(typeof value.redacted, "boolean");
  assert.equal(typeof value.historyComplete, "boolean");
  assert(value.reportSha256 === null || sha256Pattern.test(value.reportSha256));
  if (passed) {
    assert.equal(value.status, "valid");
    assert.equal(value.findings, 0);
    assert.equal(value.redacted, true);
    assert.equal(value.historyComplete, history);
    assert.match(value.reportSha256, sha256Pattern);
  }
}

function validateRetry(value) {
  if (value === null) return;
  exactKeys(value, ["runId", "priorReportSha256", "priorMarkerSha256", "priorCandidateId", "priorState"], "retry");
  assert.match(value.runId, uuidPattern);
  assert.match(value.priorReportSha256, sha256Pattern);
  assert.match(value.priorMarkerSha256, sha256Pattern);
  assert.match(value.priorCandidateId, sha256Pattern);
  assert.equal(value.priorState, "failed");
}

function validateArtifact(value) {
  if (value === null) return;
  exactKeys(value, ["filename", "bytes", "sha256", "artifactClass", "trust", "releaseEligible"], "artifact");
  assert.equal(typeof value.filename, "string");
  assert(!/[\\/]/.test(value.filename));
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0);
  assert.match(value.sha256, sha256Pattern);
  assert(["test-only", "trusted-release"].includes(value.artifactClass));
  assert(["untrusted", "trusted"].includes(value.trust));
  assert.equal(typeof value.releaseEligible, "boolean");
  assert.equal(value.releaseEligible, value.artifactClass === "trusted-release" && value.trust === "trusted");
}

function validateStepSemantics(step, profile, artifact, report) {
  if (!step.executed) return;
  const passed = step.state === "passed";
  if (passed) assert.equal(step.exitCode, 0, `${step.id} passed without exitCode 0`);
  if (passed && ["source-test-build", "gov03-quick", "gov03-self-test", "sca-production", "sca-full", "secret-current", "secret-history", "package", "signature-policy", "packaged-smoke"].includes(step.id)) {
    assert.match(step.childReportSha256, sha256Pattern, `${step.id} passed without governed child evidence`);
  }
  if (step.id === "source-clean-install") validateCleanInstallEvidence(step.evidence, "source-test", passed);
  if (step.id === "package-clean-install") validateCleanInstallEvidence(step.evidence, "package", passed);
  if (step.id === "source-test-build") validateSourceBuildEvidence(step.evidence, passed, report.candidate);
  if (step.id === "sca-production" || step.id === "sca-full") validateScaEvidence(step.evidence, step.id, passed);
  if (step.id === "secret-current") validateScanEvidence(step.evidence, step.id, passed, false);
  if (step.id === "secret-history") validateScanEvidence(step.evidence, step.id, passed, true);
  if (step.id === "package" && passed) {
    exactKeys(step.evidence, ["runId", "candidateId", "buildId", "sourceDateEpoch", "sourceIdentityAfter", "sourceManifestSha256", "filename", "bytes", "sha256", "attemptSha256", "stagingInstallSha256", "manifestSha256", "frozenSha256", "buildInfoSha256", "distIntegritySha256", "distTreeSha256", "electronAppTreeSha256", "releaseTreeSha256", "stdoutSha256", "stderrSha256"], "package evidence");
    assert.equal(step.evidence.runId, report.runId);
    assert.equal(step.evidence.candidateId, report.candidate.releaseCandidateId);
    assert.equal(step.evidence.buildId, `0.1.0+ci.${report.candidate.releaseCandidateId}`, "package Build ID differs from candidate");
    assert.match(step.evidence.sourceDateEpoch, /^\d+$/);
    assert.equal(step.evidence.sourceIdentityAfter, report.candidate.releaseCandidateId);
    assert.equal(step.evidence.sourceManifestSha256, report.candidate.sourceManifestSha256);
    assert.equal(step.evidence.filename, artifact?.filename);
    assert.equal(step.evidence.bytes, artifact?.bytes);
    assert.equal(step.evidence.sha256, artifact?.sha256);
    assert.equal(step.evidence.frozenSha256, artifact?.sha256);
    for (const key of ["attemptSha256", "stagingInstallSha256", "manifestSha256", "buildInfoSha256", "distIntegritySha256", "distTreeSha256", "electronAppTreeSha256", "releaseTreeSha256", "stdoutSha256", "stderrSha256"]) assert.match(step.evidence[key], sha256Pattern);
  }
  if (step.id === "signature-policy" && passed) {
    exactKeys(step.evidence, ["mode", "status", "allowlisted", "timestamped", "artifactSha256"], "signature evidence");
    assert.equal(step.evidence.artifactSha256, artifact?.sha256);
    if (profile === "merge") {
      assert.equal(step.evidence.mode, "unsigned-test");
      assert.equal(step.evidence.status, "NotSigned");
      assert.equal(step.evidence.allowlisted, false);
      assert.equal(step.evidence.timestamped, false);
    } else {
      assert.equal(step.evidence.mode, "trusted-release");
      assert.equal(step.evidence.status, "Valid");
      assert.equal(step.evidence.allowlisted, true);
      assert.equal(step.evidence.timestamped, true);
      assert.equal(artifact?.artifactClass, "trusted-release");
      assert.equal(artifact?.trust, "trusted");
      assert.equal(artifact?.releaseEligible, true);
    }
  }
  if (step.id === "packaged-smoke" && passed) assert.equal(step.evidence.artifactSha256, artifact?.sha256);
}

export function validateGov04Report(report) {
  exactKeys(report, [
    "schemaVersion", "taskId", "profile", "state", "releaseEligible", "runId", "challenge", "retry", "attempt",
    "provenance", "candidate", "policy", "toolchain", "startedAt", "finishedAt", "durationMs",
    "expectedSteps", "executedSteps", "steps", "artifact", "cleanup", "knownLimitations", "reviewerVerdict", "userStatus",
  ], "GOV-04 report");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.taskId, "GOV-04");
  assert(["merge", "trusted-release"].includes(report.profile));
  assert(["passed", "failed"].includes(report.state));
  assert.equal(typeof report.releaseEligible, "boolean");
  assert.match(report.runId, uuidPattern);
  assert.match(report.challenge, sha256Pattern);
  validateRetry(report.retry);
  assert.equal(report.retry?.runId === report.runId, false, "run cannot retry itself");
  assert.equal(report.attempt, 1);
  validateIso(report.startedAt, "startedAt");
  validateIso(report.finishedAt, "finishedAt");
  assert(Number.isSafeInteger(report.durationMs) && report.durationMs >= 0);
  assert.deepEqual(report.expectedSteps, gov04StepIds);
  validateCandidateIdentity(report.candidate);
  validateArtifact(report.artifact);
  assert.equal(report.steps.length, gov04StepIds.length);
  let previous = null;
  for (let index = 0; index < report.steps.length; index += 1) {
    validateReceipt(report.steps[index], gov04StepIds[index], previous, report.runId, report.challenge, report.candidate.releaseCandidateId);
    validateStepSemantics(report.steps[index], report.profile, report.artifact, report);
    previous = report.steps[index].receiptSha256;
  }
  assert.deepEqual(report.executedSteps, report.steps.filter((step) => step.executed).map((step) => step.id));
  const sourceBuildStep = report.steps.find((step) => step.id === "source-test-build");
  const packageStep = report.steps.find((step) => step.id === "package");
  if (sourceBuildStep.state === "passed" && packageStep.state === "passed") {
    assert.equal(packageStep.evidence.buildId, sourceBuildStep.evidence.buildId, "source/package Build ID mismatch");
    assert.equal(packageStep.evidence.sourceDateEpoch, sourceBuildStep.evidence.sourceDateEpoch, "source/package epoch mismatch");
    assert.equal(packageStep.evidence.buildInfoSha256, sourceBuildStep.evidence.buildInfoSha256, "source/package build-info mismatch");
    assert.equal(packageStep.evidence.distIntegritySha256, sourceBuildStep.evidence.distIntegritySha256, "source/package dist-integrity mismatch");
    assert.equal(packageStep.evidence.distTreeSha256, sourceBuildStep.evidence.distTreeSha256, "source/package dist tree mismatch");
  }
  const finalize = report.steps.at(-1);
  assert.equal(finalize.id, "finalize");
  assert.equal(finalize.executed, true);
  let failed = false;
  for (const step of report.steps.slice(0, -1)) {
    if (failed) assert.equal(step.state, "blocked", `${step.id} executed after a failed step`);
    if (step.state === "failed" || step.state === "unsupported") failed = true;
  }
  const allRequiredPassed = report.steps.every((step) => step.state === "passed");
  assert.equal(report.state, allRequiredPassed ? "passed" : "failed");
  exactKeys(report.policy, ["path", "sha256", "signerAllowlistSha256", "trustedRelease"], "policy");
  assert.equal(report.policy.path, "parity/policies/gov-04-policy.json");
  assert.match(report.policy.sha256, sha256Pattern);
  assert.match(report.policy.signerAllowlistSha256, sha256Pattern);
  exactKeys(report.policy.trustedRelease, ["state", "provider", "repository", "workflow", "event", "environment", "requireProtectedRef"], "trusted release policy");
  assert(["unconfigured", "configured"].includes(report.policy.trustedRelease.state));
  assert.equal(report.policy.trustedRelease.provider, "github-actions");
  assert(report.policy.trustedRelease.repository === null || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(report.policy.trustedRelease.repository));
  assert.equal(report.policy.trustedRelease.state === "configured", report.policy.trustedRelease.repository !== null);
  assert.equal(report.policy.trustedRelease.workflow, ".github/workflows/gov-04-trusted-release.yml");
  assert.equal(report.policy.trustedRelease.event, "workflow_dispatch");
  assert.equal(report.policy.trustedRelease.environment, "mini-lux-trusted-release");
  assert.equal(report.policy.trustedRelease.requireProtectedRef, true);
  exactKeys(report.provenance, ["level", "provider", "repository", "commit", "historyComplete", "clean", "event", "ref", "refProtected", "workflow", "runId", "runAttempt", "environment", "headShaMatches"], "provenance");
  assert(["git-full-history", "local-snapshot-unauthenticated"].includes(report.provenance.level));
  assert([null, "github-actions"].includes(report.provenance.provider));
  assert.equal(typeof report.provenance.historyComplete, "boolean");
  assert.equal(typeof report.provenance.clean, "boolean");
  assert.equal(typeof report.provenance.refProtected, "boolean");
  assert.equal(typeof report.provenance.headShaMatches, "boolean");
  assert(report.provenance.repository === null || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(report.provenance.repository));
  assert(report.provenance.commit === null || /^[a-f0-9]{40}$/.test(report.provenance.commit));
  assert(report.provenance.event === null || typeof report.provenance.event === "string");
  assert(report.provenance.ref === null || typeof report.provenance.ref === "string");
  assert(report.provenance.workflow === null || typeof report.provenance.workflow === "string");
  assert(report.provenance.runId === null || /^\d+$/.test(report.provenance.runId));
  assert(report.provenance.runAttempt === null || (Number.isSafeInteger(report.provenance.runAttempt) && report.provenance.runAttempt > 0));
  assert(report.provenance.environment === null || typeof report.provenance.environment === "string");
  if (report.provenance.level === "git-full-history") {
    assert.match(report.provenance.commit, /^[a-f0-9]{40}$/);
  } else {
    assert.equal(report.provenance.provider, null);
    assert.equal(report.provenance.repository, null);
    assert.equal(report.provenance.commit, null);
    assert.equal(report.provenance.historyComplete, false);
    assert.equal(report.provenance.event, null);
    assert.equal(report.provenance.ref, null);
    assert.equal(report.provenance.refProtected, false);
    assert.equal(report.provenance.workflow, null);
    assert.equal(report.provenance.runId, null);
    assert.equal(report.provenance.runAttempt, null);
    assert.equal(report.provenance.environment, null);
    assert.equal(report.provenance.headShaMatches, false);
    assert.notEqual(report.steps.find((step) => step.id === "secret-history")?.state, "passed", "local snapshot cannot prove secret history");
  }
  if (report.provenance.provider === "github-actions") {
    assert.match(report.provenance.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.equal(typeof report.provenance.event, "string");
    assert.equal(typeof report.provenance.ref, "string");
    assert.equal(typeof report.provenance.workflow, "string");
    assert.match(report.provenance.runId, /^\d+$/);
    assert(Number.isSafeInteger(report.provenance.runAttempt) && report.provenance.runAttempt > 0);
    assert.equal(report.provenance.headShaMatches, true);
  }
  if (report.provenance.provider === null) {
    assert.equal(report.provenance.repository, null);
    assert.equal(report.provenance.event, null);
    assert.equal(report.provenance.ref, null);
    assert.equal(report.provenance.refProtected, false);
    assert.equal(report.provenance.workflow, null);
    assert.equal(report.provenance.runId, null);
    assert.equal(report.provenance.runAttempt, null);
    assert.equal(report.provenance.environment, null);
    assert.equal(report.provenance.headShaMatches, false);
  }
  const trustedProvenance = trustedProvenanceMatches(report.provenance, report.policy.trustedRelease);
  if (report.profile === "trusted-release" && allRequiredPassed) assert.equal(trustedProvenance, true, "trusted release passed without governed hosted provenance");
  assert.equal(report.releaseEligible, report.state === "passed" && report.profile === "trusted-release" && trustedProvenance && report.artifact?.releaseEligible === true);
  exactKeys(report.toolchain, ["node", "npm", "typescript", "eslint", "c8", "gitleaks"], "toolchain");
  assert.deepEqual({ node: report.toolchain.node, npm: report.toolchain.npm, typescript: report.toolchain.typescript, eslint: report.toolchain.eslint, c8: report.toolchain.c8 }, { node: "24.14.1", npm: "11.11.0", typescript: "5.7.3", eslint: "10.7.0", c8: "10.1.3" }, "toolchain differs from frozen GOV-04 policy");
  const secretPassed = report.steps.filter((step) => step.id === "secret-current" || step.id === "secret-history").some((step) => step.state === "passed");
  assert.equal(report.toolchain.gitleaks, secretPassed ? "8.30.1" : null, "Gitleaks version/step state mismatch");
  exactKeys(report.cleanup, ["workspaceRemoved", "sourceUnchanged", "artifactUnchanged", "evidencePreserved"], "cleanup");
  for (const value of Object.values(report.cleanup)) assert.equal(typeof value, "boolean");
  assert.deepEqual(finalize.evidence, report.cleanup, "finalize evidence differs from top-level cleanup");
  if (report.state === "passed") assert(Object.values(report.cleanup).every(Boolean), "passed report has incomplete cleanup");
  assert.equal(report.cleanup.evidencePreserved, true);
  assert(Array.isArray(report.knownLimitations) && report.knownLimitations.every((entry) => typeof entry === "string"));
  assert.equal(report.reviewerVerdict, null);
  assert.equal(report.userStatus, "not-reviewed");
  validateNoSensitiveData(report);
  return report;
}

export function validateGov04SelfTestReport(report) {
  exactKeys(report, ["schemaVersion", "taskId", "state", "failureClass", "startedAt", "finishedAt", "durationMs", "expected", "actual", "scenarios", "exitCode", "stdoutSha256", "stderrSha256", "cleanupPassed"], "GOV-04 self-test report");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.taskId, "GOV-04");
  assert(["passed", "failed"].includes(report.state));
  assert(report.failureClass === null || report.failureClass === "SELF_TEST_PROOF_FAILED");
  validateIso(report.startedAt, "self-test.startedAt");
  validateIso(report.finishedAt, "self-test.finishedAt");
  assert(Number.isSafeInteger(report.durationMs) && report.durationMs >= 0);
  assert.deepEqual(report.expected, gov04SelfTestIds);
  assert(Array.isArray(report.actual));
  assert.deepEqual(report.actual, gov04SelfTestIds);
  assert(Array.isArray(report.scenarios) && report.scenarios.length === gov04SelfTestIds.length);
  for (let index = 0; index < report.scenarios.length; index += 1) {
    const scenario = report.scenarios[index];
    exactKeys(scenario, ["id", "passed"], `self-test scenario ${index}`);
    assert.equal(scenario.id, gov04SelfTestIds[index]);
    assert.equal(typeof scenario.passed, "boolean");
  }
  assert(Number.isSafeInteger(report.exitCode));
  assert.match(report.stdoutSha256, sha256Pattern);
  assert.match(report.stderrSha256, sha256Pattern);
  assert.equal(typeof report.cleanupPassed, "boolean");
  const passed = report.exitCode === 0 && report.cleanupPassed && report.scenarios.every((scenario) => scenario.passed);
  assert.equal(report.state, passed ? "passed" : "failed");
  assert.equal(report.failureClass, passed ? null : "SELF_TEST_PROOF_FAILED");
  validateNoSensitiveData(report);
  return report;
}

export async function validateGov04Marker(marker, reportPath, artifactSha256 = null) {
  exactKeys(marker, ["schemaVersion", "taskId", "runId", "reportSha256", "artifactSha256", "candidateId", "createdAt"], "GOV-04 marker");
  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.taskId, "GOV-04");
  assert.match(marker.runId, uuidPattern);
  assert.match(marker.reportSha256, sha256Pattern);
  assert(marker.artifactSha256 === null || sha256Pattern.test(marker.artifactSha256));
  assert.match(marker.candidateId, sha256Pattern);
  validateIso(marker.createdAt, "marker.createdAt");
  const reportBytes = await readFile(reportPath);
  assert.equal(marker.reportSha256, sha256(reportBytes));
  const report = JSON.parse(reportBytes.toString("utf8"));
  validateGov04Report(report);
  assert.equal(marker.runId, report.runId, "marker runId differs from report");
  assert.equal(marker.candidateId, report.candidate.releaseCandidateId, "marker candidate differs from report");
  assert.equal(marker.artifactSha256, report.artifact?.sha256 ?? null, "marker artifact differs from report");
  assert.equal(marker.artifactSha256, artifactSha256, "marker artifact differs from verified artifact");
}
