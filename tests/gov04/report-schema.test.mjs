import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestFiles, sourceDirectories } from "../../scripts/build-inputs.mjs";
import { assertEmptyFormalOutputs, canonicalJson, sha256 } from "../../scripts/gov04/identity.mjs";
import { assertFrozenArtifactInput, claimPackageAttempt, validateStagingInstall } from "../../scripts/gov04/steps.mjs";
import { validateAuditReport } from "../../scripts/gov04/sca.mjs";
import { validateGitleaksBinary } from "../../scripts/gov04/secret-scan.mjs";
import { validateGov04Marker, validateGov04Report } from "../../scripts/gov04/report-schema.mjs";
import { resolveRetryEvidence } from "../../scripts/gov04/retry.mjs";
import { createValidGov04Report, rechain } from "./report-fixture.mjs";

function step(report, id) {
  return report.steps.find((entry) => entry.id === id);
}

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "mini-lux-gov04-test-"));
}

function failedReport() {
  const report = createValidGov04Report();
  const failedIndex = report.steps.findIndex((entry) => entry.id === "typecheck");
  Object.assign(report.steps[failedIndex], { state: "failed", failureClass: "TYPECHECK_FAILED", exitCode: 1 });
  for (let index = failedIndex + 1; index < report.steps.length - 1; index += 1) {
    Object.assign(report.steps[index], { state: "blocked", failureClass: "UPSTREAM_BLOCKED", executed: false, attempt: 0, startedAt: null, finishedAt: null, durationMs: null, command: [], exitCode: null, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { blockedBy: "typecheck" } });
  }
  report.state = "failed";
  report.artifact = null;
  report.toolchain.gitleaks = null;
  rechain(report);
  return report;
}

async function writePriorRun(runBase, report) {
  const reports = path.join(runBase, report.runId, "reports");
  await mkdir(reports, { recursive: true });
  const reportPath = path.join(reports, "gov04-report.json");
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  const marker = { schemaVersion: 1, taskId: "GOV-04", runId: report.runId, reportSha256: sha256(reportBytes), artifactSha256: report.artifact?.sha256 ?? null, candidateId: report.candidate.releaseCandidateId, createdAt: "2026-07-17T00:00:00.000Z" };
  const markerPath = path.join(reports, "gov04-final-marker.json");
  await writeFile(reportPath, reportBytes);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  await validateGov04Marker(marker, reportPath, report.artifact?.sha256 ?? null);
  return { reportPath, markerPath, reportBytes, markerBytes: await readFile(markerPath) };
}

test("GOV-04 valid report passes strict semantic validation", () => {
  const report = createValidGov04Report();
  assert.equal(validateGov04Report(report), report);
});

test("GOV-04 failed report preserves blocked tail and still finalizes", () => {
  const report = createValidGov04Report();
  const failedIndex = report.steps.findIndex((entry) => entry.id === "typecheck");
  Object.assign(report.steps[failedIndex], { state: "failed", failureClass: "TYPECHECK_FAILED", exitCode: 1 });
  for (let index = failedIndex + 1; index < report.steps.length - 1; index += 1) {
    Object.assign(report.steps[index], { state: "blocked", failureClass: "UPSTREAM_BLOCKED", executed: false, attempt: 0, startedAt: null, finishedAt: null, durationMs: null, command: [], exitCode: null, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { blockedBy: "typecheck" } });
  }
  report.state = "failed";
  report.artifact = null;
  report.toolchain.gitleaks = null;
  rechain(report);
  assert.equal(validateGov04Report(report), report);
});

test("G04-01 missing typecheck command is rejected", () => {
  const report = createValidGov04Report();
  step(report, "typecheck").command = [];
  rechain(report);
  assert.throws(() => validateGov04Report(report), /command differs|command/);
});

test("G04-02 lint warning or failed state cannot be reported as overall pass", () => {
  const report = createValidGov04Report();
  const lint = step(report, "lint");
  lint.state = "failed";
  lint.failureClass = "LINT_FAILED";
  lint.exitCode = 1;
  rechain(report);
  assert.throws(() => validateGov04Report(report), /executed after a failed step|state/);
});

test("G04-03 stale challenge invalidates every receipt input binding", () => {
  const report = createValidGov04Report();
  report.challenge = "0".repeat(64);
  assert.throws(() => validateGov04Report(report), /inputDigest is inconsistent/);
});

test("G04-04 missing, duplicate and reordered steps are rejected", () => {
  for (const mutate of [
    (report) => report.steps.pop(),
    (report) => { report.steps[2] = structuredClone(report.steps[1]); },
    (report) => { [report.steps[1], report.steps[2]] = [report.steps[2], report.steps[1]]; },
  ]) {
    const report = createValidGov04Report();
    mutate(report);
    assert.throws(() => validateGov04Report(report));
  }
});

test("G04-05 a second within-run attempt is rejected", async () => {
  const report = createValidGov04Report();
  step(report, "lint").attempt = 2;
  assert.throws(() => validateGov04Report(report), /attempt/);
  const root = await fixture();
  try {
    const input = { evidenceDirectory: root, runId: report.runId, challenge: report.challenge, candidateId: report.candidate.releaseCandidateId, buildId: `0.1.0+ci.${report.candidate.releaseCandidateId}`, sourceManifestSha256: report.candidate.sourceManifestSha256, previousReceiptSha256: "a".repeat(64) };
    await claimPackageAttempt(input);
    await assert.rejects(() => claimPackageAttempt(input), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-06 child evidence cannot be omitted behind exit zero", () => {
  const report = createValidGov04Report();
  step(report, "gov03-quick").childReportSha256 = null;
  rechain(report);
  assert.throws(() => validateGov04Report(report), /child evidence/);
});

test("G04-07 unavailable SCA cannot pass as zero findings", () => {
  const report = createValidGov04Report();
  const sca = step(report, "sca-production");
  sca.evidence = { ...sca.evidence, status: "unavailable", auditReportVersion: null, dependencyTotal: null, counts: null, reportSha256: null };
  rechain(report);
  assert.throws(() => validateGov04Report(report), /valid/);
});

test("G04-08 malformed audit metadata is rejected", () => {
  const malformed = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 }, dependencies: { total: 1 } } };
  assert.throws(() => validateAuditReport(malformed, { auditReportVersion: 2 }));
});

test("G04-09 a high advisory cannot coexist with passed SCA", () => {
  const report = createValidGov04Report();
  const counts = step(report, "sca-full").evidence.counts;
  counts.high = 1;
  counts.total = 1;
  rechain(report);
  assert.throws(() => validateGov04Report(report), /high\/critical/);
});

test("G04-10 secret findings and sensitive evidence are rejected", () => {
  const report = createValidGov04Report();
  step(report, "secret-current").evidence.findings = 1;
  rechain(report);
  assert.throws(() => validateGov04Report(report));
  const sensitive = createValidGov04Report();
  step(sensitive, "prepare").evidence.secretValue = "synthetic-credential";
  rechain(sensitive);
  assert.throws(() => validateGov04Report(sensitive), /forbidden evidence field/);
});

test("G04-11 pre-existing formal package output and malformed staging ledger are rejected", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "release"));
    await assert.rejects(() => assertEmptyFormalOutputs(root), /formal output must be absent/);
    const report = createValidGov04Report();
    const valid = { schemaVersion: 1, role: "electron-staging", runId: report.runId, challenge: report.challenge, candidateId: report.candidate.releaseCandidateId, command: ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] };
    assert.equal(validateStagingInstall(valid, valid), valid);
    assert.throws(() => validateStagingInstall({ ...valid, extraInstall: true }, valid));
    assert.throws(() => validateStagingInstall({ ...valid, command: ["npm", "install"] }, valid), /deep-equal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-12 models are governed and model bytes change package digest", async () => {
  assert(sourceDirectories.includes("models"));
  const root = await fixture();
  try {
    const model = path.join(root, "model.onnx");
    await writeFile(model, "model-a");
    const before = await digestFiles(root, [model], "mini-lux-package-input-v1");
    await writeFile(model, "model-b");
    const after = await digestFiles(root, [model], "mini-lux-package-input-v1");
    assert.notEqual(after, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-13 package artifact replacement breaks frozen hash binding", async () => {
  const report = createValidGov04Report();
  step(report, "package").evidence.sha256 = "0".repeat(64);
  rechain(report);
  assert.throws(() => validateGov04Report(report));
  const root = await fixture();
  try {
    const bytes = Buffer.from("frozen artifact");
    const artifactSha256 = sha256(bytes);
    const artifactPath = path.join(root, "artifacts", "sha256", artifactSha256, "Mini-Lux Setup.exe");
    const manifestPath = path.join(root, "package-artifact.json");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);
    await writeFile(manifestPath, JSON.stringify({ artifact: { filename: path.basename(artifactPath), bytes: bytes.length, sha256: artifactSha256 } }));
    await assertFrozenArtifactInput({ artifactPath, artifactManifestPath: manifestPath, artifactSha256 });
    await writeFile(artifactPath, "mutated artifact");
    await assert.rejects(() => assertFrozenArtifactInput({ artifactPath, artifactManifestPath: manifestPath, artifactSha256 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-14 unsigned, wrong signer and missing timestamp cannot pass trusted release", () => {
  for (const evidence of [
    { mode: "trusted-release", status: "NotSigned", allowlisted: false, timestamped: false },
    { mode: "trusted-release", status: "Valid", allowlisted: false, timestamped: true },
    { mode: "trusted-release", status: "Valid", allowlisted: true, timestamped: false },
  ]) {
    const report = createValidGov04Report();
    report.profile = "trusted-release";
    report.policy.trustedRelease = { ...report.policy.trustedRelease, state: "configured", repository: "example/mini-lux" };
    report.provenance = { level: "git-full-history", provider: "github-actions", repository: "example/mini-lux", commit: "f".repeat(40), historyComplete: true, clean: true, event: "workflow_dispatch", ref: "refs/heads/main", refProtected: true, workflow: ".github/workflows/gov-04-trusted-release.yml", runId: "123456", runAttempt: 1, environment: "mini-lux-trusted-release", headShaMatches: true };
    report.artifact = { ...report.artifact, artifactClass: "trusted-release", trust: "trusted", releaseEligible: true };
    const signature = step(report, "signature-policy");
    signature.evidence = { ...evidence, artifactSha256: report.artifact.sha256 };
    step(report, "package").evidence = { ...step(report, "package").evidence, sha256: report.artifact.sha256 };
    rechain(report);
    assert.throws(() => validateGov04Report(report));
  }

  const hostedRelease = createValidGov04Report();
  hostedRelease.profile = "trusted-release";
  hostedRelease.releaseEligible = true;
  hostedRelease.policy.trustedRelease = { ...hostedRelease.policy.trustedRelease, state: "configured", repository: "example/mini-lux" };
  hostedRelease.provenance = { level: "git-full-history", provider: "github-actions", repository: "example/mini-lux", commit: "f".repeat(40), historyComplete: true, clean: true, event: "workflow_dispatch", ref: "refs/heads/main", refProtected: true, workflow: ".github/workflows/gov-04-trusted-release.yml", runId: "123456", runAttempt: 1, environment: "mini-lux-trusted-release", headShaMatches: true };
  hostedRelease.artifact = { ...hostedRelease.artifact, artifactClass: "trusted-release", trust: "trusted", releaseEligible: true };
  step(hostedRelease, "package").evidence = { ...step(hostedRelease, "package").evidence, sha256: hostedRelease.artifact.sha256, frozenSha256: hostedRelease.artifact.sha256 };
  step(hostedRelease, "signature-policy").evidence = { mode: "trusted-release", status: "Valid", allowlisted: true, timestamped: true, artifactSha256: hostedRelease.artifact.sha256 };
  rechain(hostedRelease);
  assert.equal(validateGov04Report(hostedRelease), hostedRelease);

  const localForgery = createValidGov04Report();
  localForgery.profile = "trusted-release";
  localForgery.releaseEligible = true;
  localForgery.policy.trustedRelease = { ...localForgery.policy.trustedRelease, state: "configured", repository: "example/mini-lux" };
  localForgery.artifact = { ...localForgery.artifact, artifactClass: "trusted-release", trust: "trusted", releaseEligible: true };
  step(localForgery, "package").evidence = { ...step(localForgery, "package").evidence, sha256: localForgery.artifact.sha256, frozenSha256: localForgery.artifact.sha256 };
  step(localForgery, "signature-policy").evidence = { mode: "trusted-release", status: "Valid", allowlisted: true, timestamped: true, artifactSha256: localForgery.artifact.sha256 };
  rechain(localForgery);
  assert.throws(() => validateGov04Report(localForgery), /hosted provenance/);
});

test("G04-15 packaged smoke must bind the frozen artifact hash", async () => {
  const report = createValidGov04Report();
  step(report, "packaged-smoke").evidence.artifactSha256 = "0".repeat(64);
  rechain(report);
  assert.throws(() => validateGov04Report(report));
  const root = await fixture();
  try {
    const bytes = Buffer.from("same bytes outside frozen store");
    const artifactSha256 = sha256(bytes);
    const artifactPath = path.join(root, "not-frozen.exe");
    const manifestPath = path.join(root, "package-artifact.json");
    await writeFile(artifactPath, bytes);
    await writeFile(manifestPath, JSON.stringify({ artifact: { filename: path.basename(artifactPath), bytes: bytes.length, sha256: artifactSha256 } }));
    await assert.rejects(() => assertFrozenArtifactInput({ artifactPath, artifactManifestPath: manifestPath, artifactSha256 }), /outside frozen/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-16 diagnostic merge cannot claim release eligibility", () => {
  const report = createValidGov04Report();
  report.releaseEligible = true;
  assert.throws(() => validateGov04Report(report));
});

test("G04-17 final report mutation invalidates marker", async () => {
  const root = await fixture();
  try {
    const reportPath = path.join(root, "report.json");
    const report = createValidGov04Report();
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, reportBytes);
    const marker = { schemaVersion: 1, taskId: "GOV-04", runId: report.runId, reportSha256: sha256(reportBytes), artifactSha256: report.artifact.sha256, candidateId: report.candidate.releaseCandidateId, createdAt: "2026-07-17T00:00:00.000Z" };
    await validateGov04Marker(marker, reportPath, report.artifact.sha256);
    await assert.rejects(() => validateGov04Marker({ ...marker, candidateId: "0".repeat(64) }, reportPath, report.artifact.sha256), /candidate differs/);
    await assert.rejects(() => validateGov04Marker({ ...marker, artifactSha256: "0".repeat(64) }, reportPath, report.artifact.sha256), /artifact differs/);
    await writeFile(reportPath, `${reportBytes} `);
    await assert.rejects(() => validateGov04Marker(marker, reportPath, report.artifact.sha256));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-18 missing scanner fails closed", async () => {
  await assert.rejects(() => validateGitleaksBinary(path.join(os.tmpdir(), `missing-${Date.now()}.exe`), { windowsX64ExecutableSha256: "0".repeat(64), version: "8.30.1" }), /unavailable/);
});

test("G04-19 random or bare retry references are rejected", async () => {
  const report = createValidGov04Report();
  report.retry = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => validateGov04Report(report), /retry must be an object/);
  const root = await fixture();
  try {
    await assert.rejects(() => resolveRetryEvidence({ runBase: root, retryOf: "00000000-0000-4000-8000-000000000001" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-20 retry rejects a marker mismatch and a prior passing run", async () => {
  const root = await fixture();
  try {
    const passed = createValidGov04Report();
    await writePriorRun(root, passed);
    await assert.rejects(() => resolveRetryEvidence({ runBase: root, retryOf: passed.runId }), /only a failed/);
    const failed = failedReport();
    const prior = await writePriorRun(root, failed);
    const marker = JSON.parse((await readFile(prior.markerPath, "utf8")));
    marker.candidateId = "0".repeat(64);
    await writeFile(prior.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await assert.rejects(() => resolveRetryEvidence({ runBase: root, retryOf: failed.runId }), /marker candidate differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-21 a failed prior run creates a hash-bound retry record across candidates", async () => {
  const root = await fixture();
  try {
    const priorReport = failedReport();
    await writePriorRun(root, priorReport);
    const retry = await resolveRetryEvidence({ runBase: root, retryOf: priorReport.runId });
    assert.deepEqual(retry, {
      runId: priorReport.runId,
      priorReportSha256: sha256(`${JSON.stringify(priorReport, null, 2)}\n`),
      priorMarkerSha256: sha256(await readFile(path.join(root, priorReport.runId, "reports", "gov04-final-marker.json"))),
      priorCandidateId: priorReport.candidate.releaseCandidateId,
      priorState: "failed",
    });
    const nextReport = createValidGov04Report();
    nextReport.candidate.sourceDigest = "b".repeat(64);
    nextReport.candidate.releaseCandidateId = sha256(canonicalJson({
      sourceDigest: nextReport.candidate.sourceDigest,
      packageInputDigest: nextReport.candidate.packageInputDigest,
      pipelineDefinitionDigest: nextReport.candidate.pipelineDefinitionDigest,
      policyDigest: nextReport.candidate.policyDigest,
    }));
    const nextBuildId = `0.1.0+ci.${nextReport.candidate.releaseCandidateId}`;
    step(nextReport, "source-test-build").evidence.buildId = nextBuildId;
    step(nextReport, "source-test-build").evidence.sourceDigest = nextReport.candidate.sourceDigest;
    step(nextReport, "package").evidence.buildId = nextBuildId;
    step(nextReport, "package").evidence.candidateId = nextReport.candidate.releaseCandidateId;
    step(nextReport, "package").evidence.sourceIdentityAfter = nextReport.candidate.releaseCandidateId;
    assert.notEqual(nextReport.candidate.releaseCandidateId, retry.priorCandidateId);
    nextReport.retry = retry;
    rechain(nextReport);
    assert.equal(validateGov04Report(nextReport), nextReport);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-22 resolving retry evidence preserves prior report and marker bytes", async () => {
  const root = await fixture();
  try {
    const priorReport = failedReport();
    const prior = await writePriorRun(root, priorReport);
    const reportBefore = await readFile(prior.reportPath);
    const markerBefore = await readFile(prior.markerPath);
    await resolveRetryEvidence({ runBase: root, retryOf: priorReport.runId });
    assert.equal(sha256(await readFile(prior.reportPath)), sha256(reportBefore));
    assert.equal(sha256(await readFile(prior.markerPath)), sha256(markerBefore));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G04-23 forged candidate cannot retain an older source or package Build ID", () => {
  const report = createValidGov04Report();
  report.candidate.sourceDigest = "b".repeat(64);
  report.candidate.releaseCandidateId = sha256(canonicalJson({
    sourceDigest: report.candidate.sourceDigest,
    packageInputDigest: report.candidate.packageInputDigest,
    pipelineDefinitionDigest: report.candidate.pipelineDefinitionDigest,
    policyDigest: report.candidate.policyDigest,
  }));
  step(report, "package").evidence.candidateId = report.candidate.releaseCandidateId;
  step(report, "package").evidence.sourceIdentityAfter = report.candidate.releaseCandidateId;
  rechain(report);
  assert.throws(() => validateGov04Report(report), /source-test-build Build ID differs from candidate/);
});

test("local snapshot cannot forge a passed history scan", () => {
  const report = createValidGov04Report();
  report.provenance = { level: "local-snapshot-unauthenticated", provider: null, repository: null, commit: null, historyComplete: false, clean: true, event: null, ref: null, refProtected: false, workflow: null, runId: null, runAttempt: null, environment: null, headShaMatches: false };
  assert.throws(() => validateGov04Report(report), /cannot prove secret history/);
});

test("toolchain versions are frozen semantically", () => {
  const report = createValidGov04Report();
  report.toolchain.npm = "11.12.0";
  assert.throws(() => validateGov04Report(report), /toolchain differs/);
});
