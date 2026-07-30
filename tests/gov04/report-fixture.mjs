import { randomUUID } from "node:crypto";
import { blockedReceipt, executedReceipt } from "../../scripts/gov04/receipts.mjs";
import { canonicalJson, sha256 } from "../../scripts/gov04/identity.mjs";
import { gov04StepIds } from "../../scripts/gov04/report-schema.mjs";

const hash = (character) => character.repeat(64);
const commands = {
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
};

function candidate() {
  const value = {
    schemaVersion: 1,
    sourceDigest: hash("1"),
    packageInputDigest: hash("2"),
    pipelineDefinitionDigest: hash("3"),
    policyDigest: hash("4"),
    sourceManifestSha256: hash("5"),
    releaseCandidateId: "",
    fileCount: 42,
    totalBytes: 4096,
  };
  value.releaseCandidateId = sha256(canonicalJson({ sourceDigest: value.sourceDigest, packageInputDigest: value.packageInputDigest, pipelineDefinitionDigest: value.pipelineDefinitionDigest, policyDigest: value.policyDigest }));
  return value;
}

function scaEvidence() {
  return { status: "valid", registry: "https://registry.npmjs.org", npmVersion: "11.11.0", packageJsonSha256: hash("6"), lockfileSha256: hash("7"), inputsUnchanged: true, auditReportVersion: 2, dependencyTotal: 100, counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, exceptionCount: 0, reportSha256: hash("8") };
}

function scanEvidence(history) {
  return { status: "valid", scanner: "gitleaks", version: "8.30.1", executableSha256: hash("9"), findings: 0, redactionPercent: 100, redacted: true, historyComplete: history, reportSha256: hash("a") };
}

function evidenceFor(id, report) {
  if (id === "source-clean-install" || id === "package-clean-install") return { role: id === "source-clean-install" ? "source-test" : "package", nodeVersion: "24.14.1", npmVersion: "11.11.0", nodeModulesAbsentBefore: true, packageJsonSha256: hash("6"), lockfileSha256: hash("7"), inputsUnchanged: true, tools: { typescript: "5.7.3", eslint: "10.7.0", c8: "10.1.3" }, electronVersion: "43.1.1", electronExecutableSha256: hash("a"), electronInstallStdoutSha256: hash("b"), electronInstallStderrSha256: hash("c"), stdoutBytes: 1, stderrBytes: 0, stdoutSha256: hash("8"), stderrSha256: hash("9") };
  if (id === "source-test-build") return { buildId: `0.1.0+ci.${report.candidate.releaseCandidateId}`, sourceDateEpoch: "1700000000", sourceDigest: report.candidate.sourceDigest, buildInfoSha256: hash("b"), distIntegritySha256: hash("c"), distTreeSha256: hash("d"), commands: [["node", "scripts/build-sec03-native.mjs"], ["node", "scripts/generate-build-info.mjs"], ["node", "node_modules/typescript/bin/tsc", "--project", "tsconfig.json"], ["node", "scripts/generate-dist-integrity.mjs"]], outputHashes: [{ stdoutSha256: hash("1"), stderrSha256: hash("2") }, { stdoutSha256: hash("3"), stderrSha256: hash("4") }, { stdoutSha256: hash("5"), stderrSha256: hash("6") }, { stdoutSha256: hash("7"), stderrSha256: hash("8") }] };
  if (id === "sca-production" || id === "sca-full") return scaEvidence();
  if (id === "secret-current") return scanEvidence(false);
  if (id === "secret-history") return scanEvidence(true);
  if (id === "package") return { runId: report.runId, candidateId: report.candidate.releaseCandidateId, buildId: `0.1.0+ci.${report.candidate.releaseCandidateId}`, sourceDateEpoch: "1700000000", sourceIdentityAfter: report.candidate.releaseCandidateId, sourceManifestSha256: report.candidate.sourceManifestSha256, filename: report.artifact.filename, bytes: report.artifact.bytes, sha256: report.artifact.sha256, attemptSha256: hash("a"), stagingInstallSha256: hash("a"), manifestSha256: hash("a"), frozenSha256: report.artifact.sha256, buildInfoSha256: hash("b"), distIntegritySha256: hash("c"), distTreeSha256: hash("d"), electronAppTreeSha256: hash("e"), releaseTreeSha256: hash("f"), stdoutSha256: hash("1"), stderrSha256: hash("2") };
  if (id === "signature-policy") return { mode: "unsigned-test", status: "NotSigned", allowlisted: false, timestamped: false, artifactSha256: report.artifact.sha256 };
  if (id === "packaged-smoke") return { artifactSha256: report.artifact.sha256 };
  if (id === "finalize") return report.cleanup;
  return { status: "passed" };
}

export function createValidGov04Report() {
  const report = {
    schemaVersion: 1,
    taskId: "GOV-04",
    profile: "merge",
    state: "passed",
    releaseEligible: false,
    runId: randomUUID(),
    challenge: hash("e"),
    retry: null,
    attempt: 1,
    provenance: { level: "git-full-history", provider: null, repository: null, commit: "f".repeat(40), historyComplete: true, clean: true, event: null, ref: null, refProtected: false, workflow: null, runId: null, runAttempt: null, environment: null, headShaMatches: false },
    candidate: candidate(),
    policy: { path: "parity/policies/gov-04-policy.json", sha256: hash("1"), signerAllowlistSha256: hash("2"), trustedRelease: { state: "unconfigured", provider: "github-actions", repository: null, workflow: ".github/workflows/gov-04-trusted-release.yml", event: "workflow_dispatch", environment: "mini-lux-trusted-release", requireProtectedRef: true } },
    toolchain: { node: "24.14.1", npm: "11.11.0", typescript: "5.7.3", eslint: "10.7.0", c8: "10.1.3", gitleaks: "8.30.1" },
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
    durationMs: 1000,
    expectedSteps: [...gov04StepIds],
    executedSteps: [...gov04StepIds],
    steps: [],
    artifact: { filename: "RainyDays Setup.exe", bytes: 1024, sha256: hash("3"), artifactClass: "test-only", trust: "untrusted", releaseEligible: false },
    cleanup: { workspaceRemoved: true, sourceUnchanged: true, artifactUnchanged: true, evidencePreserved: true },
    knownLimitations: ["Remote service enforcement requires separate evidence"],
    reviewerVerdict: null,
    userStatus: "not-reviewed",
  };
  let previousReceiptSha256 = null;
  for (const id of gov04StepIds) {
    const childReportSha256 = ["source-test-build", "gov03-quick", "gov03-self-test", "sca-production", "sca-full", "secret-current", "secret-history", "package", "signature-policy", "packaged-smoke"].includes(id) ? hash("4") : null;
    const receipt = executedReceipt({ id, runId: report.runId, challenge: report.challenge, candidateId: report.candidate.releaseCandidateId, previousReceiptSha256, startedAt: report.startedAt, finishedAt: report.finishedAt, command: commands[id], state: "passed", exitCode: 0, childReportSha256, evidence: evidenceFor(id, report) });
    report.steps.push(receipt);
    previousReceiptSha256 = receipt.receiptSha256;
  }
  return report;
}

export function rechain(report) {
  let previousReceiptSha256 = null;
  report.steps = report.steps.map((step) => {
    let receipt;
    if (step.state === "blocked") {
      receipt = blockedReceipt({ id: step.id, runId: report.runId, challenge: report.challenge, candidateId: report.candidate.releaseCandidateId, previousReceiptSha256, blockedBy: step.evidence.blockedBy });
    } else {
      receipt = executedReceipt({
        id: step.id,
        runId: report.runId,
        challenge: report.challenge,
        candidateId: report.candidate.releaseCandidateId,
        previousReceiptSha256,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        command: step.command,
        state: step.state,
        failureClass: step.failureClass,
        exitCode: step.exitCode,
        signal: step.signal,
        timedOut: step.timedOut,
        timeoutTermination: step.timeoutTermination,
        childReportSha256: step.childReportSha256,
        evidence: step.evidence,
      });
      if (step.attempt !== 1) receipt.attempt = step.attempt;
    }
    previousReceiptSha256 = receipt.receiptSha256;
    return receipt;
  });
  report.executedSteps = report.steps.filter((step) => step.executed).map((step) => step.id);
  return report;
}
