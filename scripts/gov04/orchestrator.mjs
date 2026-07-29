import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeCandidateIdentity, copyCandidateSnapshot, publicCandidateIdentity, sha256 } from "./identity.mjs";
import { detectProvenance, prepareWorkspace, trustedProvenanceMatches } from "./provenance.mjs";
import { loadGov04Policy } from "./policy.mjs";
import { blockedReceipt, receiptFromOperation } from "./receipts.mjs";
import { gov04StepIds, validateGov04Marker, validateGov04Report } from "./report-schema.mjs";
import { runSca } from "./sca.mjs";
import { runSecretScan } from "./secret-scan.mjs";
import { runSignaturePolicy } from "./signature.mjs";
import { resolveRetryEvidence } from "./retry.mjs";
import { runCleanInstall, runGov03Quick, runGov03SelfTest, runPackage, runPackagedSmoke, runSourceTestBuild, runStaticCommand } from "./steps.mjs";
import { hashTree, sha256File } from "../../tests/helpers.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function exclusiveJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    assert.equal(await exists(filePath), false, "authoritative evidence path already exists");
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function failedOperation(failureClass, evidence = { status: "failed" }, exitCode = 1) {
  return { passed: false, failureClass, exitCode, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence };
}

async function removeAndObserve(paths) {
  let passed = true;
  for (const target of paths) {
    try { await rm(target, { recursive: true, force: true }); } catch { passed = false; }
    if (await exists(target)) passed = false;
  }
  return passed;
}

async function exportEvidenceBundle({ destination, evidenceDirectory, report, artifactPath }) {
  if (!await exists(destination)) await mkdir(destination, { recursive: true });
  const info = await lstat(destination);
  assert(info.isDirectory() && !info.isSymbolicLink(), "evidence export destination must be a regular directory");
  assert.deepEqual(await readdir(destination), [], "evidence export destination must be empty");
  const governedFiles = [
    "gov04-report.json", "gov04-final-marker.json", "gov03-quick.json", "gov03-self-test.json", "gov03-packaged.json",
    "sca-production.json", "sca-full.json", "secret-current.json", "secret-history.json",
    "signature.json", "package-attempt.json", "staging-install.json", "package-artifact.json",
  ];
  for (const name of governedFiles) {
    const source = path.join(evidenceDirectory, name);
    if (report.state === "passed") assert.equal(await exists(source), true, `passed GOV-04 evidence is missing: ${name}`);
    if (await exists(source)) await copyFile(source, path.join(destination, name), fsConstants.COPYFILE_EXCL);
  }
  if (report.state === "passed") {
    const childEvidence = new Map([
      ["gov03-quick.json", "gov03-quick"], ["gov03-self-test.json", "gov03-self-test"],
      ["sca-production.json", "sca-production"], ["sca-full.json", "sca-full"],
      ["secret-current.json", "secret-current"], ["secret-history.json", "secret-history"],
      ["signature.json", "signature-policy"], ["package-artifact.json", "package"], ["gov03-packaged.json", "packaged-smoke"],
    ]);
    for (const [filename, stepId] of childEvidence) {
      const step = report.steps.find((entry) => entry.id === stepId);
      assert(step?.childReportSha256, `passed ${stepId} lacks child evidence hash`);
      assert.equal(await sha256File(path.join(evidenceDirectory, filename)), step.childReportSha256, `${filename} hash differs from ${stepId} receipt`);
    }
    const packageStep = report.steps.find((entry) => entry.id === "package");
    assert.equal(await sha256File(path.join(evidenceDirectory, "package-attempt.json")), packageStep.evidence.attemptSha256, "package attempt hash differs from receipt");
    assert.equal(await sha256File(path.join(evidenceDirectory, "staging-install.json")), packageStep.evidence.stagingInstallSha256, "staging install hash differs from receipt");
  }
  let publicationPath = null;
  if (report.state === "passed" && artifactPath && report.artifact) {
    const directory = report.profile === "merge" ? "unsigned" : "trusted";
    await mkdir(path.join(destination, directory), { recursive: false });
    const filename = report.profile === "merge" ? `UNSIGNED-UNTRUSTED-DO-NOT-DISTRIBUTE--${report.artifact.filename}` : report.artifact.filename;
    publicationPath = `${directory}/${filename}`;
    await copyFile(artifactPath, path.join(destination, directory, filename), fsConstants.COPYFILE_EXCL);
    assert.equal(await sha256File(path.join(destination, directory, filename)), report.artifact.sha256);
  }
  await exclusiveJson(path.join(destination, "publication.json"), {
    schemaVersion: 1,
    taskId: "GOV-04",
    runId: report.runId,
    state: report.state,
    profile: report.profile,
    releaseEligible: report.releaseEligible,
    artifactSha256: report.artifact?.sha256 ?? null,
    publicationPath,
  });
}

async function formalEvidence(workspace) {
  return {
    buildInfoSha256: await sha256File(path.join(workspace, "build-info.json")),
    distIntegritySha256: await sha256File(path.join(workspace, "dist-integrity.json")),
    distTreeSha256: await hashTree(path.join(workspace, "dist")),
    electronAppTreeSha256: await hashTree(path.join(workspace, ".electron-app")),
    releaseTreeSha256: await hashTree(path.join(workspace, "release")),
    packageManifestSha256: await sha256File(path.join(workspace, "test-results", "package-artifact.json")),
  };
}

export async function runGov04({ projectRoot, profile = "merge", retryOf = null, exportReportPath = null, exportEvidenceDirectory = null, adapters = {}, runBase = path.join(os.tmpdir(), "mini-lux-gov04") }) {
  assert(["merge", "trusted-release"].includes(profile), "profile must be merge or trusted-release");
  await mkdir(runBase, { recursive: true });
  const retry = await resolveRetryEvidence({ runBase, retryOf });
  const runId = randomUUID();
  const challenge = randomBytes(32).toString("hex");
  const runStartedAt = new Date();
  const runStarted = Date.now();
  const sourceDateEpoch = String(Math.floor(runStartedAt.getTime() / 1000));
  const runRoot = path.join(runBase, runId);
  await mkdir(runRoot, { recursive: false });
  const sourceSnapshot = path.join(runRoot, "source-snapshot");
  const sourceWorkspace = path.join(runRoot, "source-test-workspace");
  const packageWorkspace = path.join(runRoot, "package-workspace");
  const evidenceDirectory = path.join(runRoot, "reports");
  const artifactsDirectory = path.join(runRoot, "artifacts");
  await mkdir(evidenceDirectory, { recursive: false });

  const initialIdentity = await computeCandidateIdentity(projectRoot);
  const candidate = publicCandidateIdentity(initialIdentity);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const canonicalBuildId = `${packageJson.version}+ci.${candidate.releaseCandidateId}`;
  const provenance = await detectProvenance(projectRoot);
  const loadedPolicy = await loadGov04Policy(projectRoot);
  const sourceBefore = candidate.releaseCandidateId;
  const receipts = [];
  const invoked = new Set();
  let firstFailure = null;
  let sourceBuildEvidence = null;
  let packageFormalEvidence = null;
  let artifact = null;
  let artifactPath = null;
  let artifactManifestPath = null;
  let gitleaksVersion = null;

  const context = () => ({ runId, challenge, candidateId: candidate.releaseCandidateId, previousReceiptSha256: receipts.at(-1)?.receiptSha256 ?? null });
  const record = async (id, command, operationFactory) => {
    assert(gov04StepIds.includes(id), `unknown GOV-04 step: ${id}`);
    assert(!invoked.has(id), `GOV-04 step already invoked: ${id}`);
    invoked.add(id);
    if (firstFailure && id !== "finalize") {
      const receipt = blockedReceipt({ id, ...context(), blockedBy: firstFailure });
      receipts.push(receipt);
      return null;
    }
    const startedAt = new Date();
    let operation;
    try { operation = await operationFactory(); }
    catch { operation = failedOperation(`${id.toUpperCase().replaceAll("-", "_")}_INTERNAL`); }
    const receipt = receiptFromOperation({ id, ...context(), startedAt, command: operation.command ?? command, operation });
    receipts.push(receipt);
    if (!operation.passed && id !== "finalize") firstFailure = id;
    return operation;
  };

  await record("prepare", ["internal", "prepare"], async () => {
    if (profile === "trusted-release" && !trustedProvenanceMatches(provenance, loadedPolicy.policy.trustedRelease)) {
      return failedOperation("TRUSTED_PROVENANCE_UNVERIFIED", { status: "unverified" }, 2);
    }
    try {
      const prepared = await prepareWorkspace({ projectRoot, workspace: sourceSnapshot, identity: initialIdentity, provenance });
      const snapshotIdentity = await computeCandidateIdentity(sourceSnapshot);
      await copyCandidateSnapshot(sourceSnapshot, sourceWorkspace, snapshotIdentity);
      await copyCandidateSnapshot(sourceSnapshot, packageWorkspace, snapshotIdentity);
      assert.deepEqual(publicCandidateIdentity(snapshotIdentity), candidate);
      assert.deepEqual(publicCandidateIdentity(await computeCandidateIdentity(sourceWorkspace)), candidate);
      assert.deepEqual(publicCandidateIdentity(await computeCandidateIdentity(packageWorkspace)), candidate);
      return { passed: true, failureClass: null, exitCode: 0, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { method: prepared.method, provenanceLevel: provenance.level, sourceManifestSha256: candidate.sourceManifestSha256, sourceWorkspaceMatched: true, packageWorkspaceMatched: true, canonicalBuildId, sourceDateEpoch } };
    } catch { return failedOperation("PREPARE_FAILED"); }
  });

  await record("source-clean-install", ["npm", "ci", "--registry", loadedPolicy.policy.sca.registry, "--no-audit", "--no-fund"], () =>
    (adapters.runCleanInstall ?? runCleanInstall)({ workspace: sourceWorkspace, evidenceDirectory, policy: loadedPolicy.policy, role: "source-test" })
  );
  await record("typecheck", ["npm", "run", "typecheck"], () =>
    (adapters.runStaticCommand ?? runStaticCommand)({ workspace: sourceWorkspace, npmArgs: ["run", "typecheck"], evidence: { commandIdentity: "npm run typecheck" }, failureClass: "TYPECHECK_FAILED" })
  );
  await record("lint", ["npm", "run", "lint"], () =>
    (adapters.runStaticCommand ?? runStaticCommand)({ workspace: sourceWorkspace, npmArgs: ["run", "lint"], evidence: { commandIdentity: "npm run lint" }, failureClass: "LINT_FAILED" })
  );
  const sourceBuild = await record("source-test-build", ["internal", "source-test-build"], () =>
    (adapters.runSourceTestBuild ?? runSourceTestBuild)({ workspace: sourceWorkspace, buildId: canonicalBuildId, sourceDateEpoch, candidateSourceDigest: candidate.sourceDigest })
  );
  if (sourceBuild?.passed) sourceBuildEvidence = sourceBuild.buildEvidence;
  await record("gov03-quick", ["node", "scripts/run-tests.mjs", "--profile", "quick", "--report", "<run-report>"], () =>
    (adapters.runGov03Quick ?? runGov03Quick)({ workspace: sourceWorkspace, evidenceDirectory, candidateSourceDigest: candidate.sourceDigest, candidateId: candidate.releaseCandidateId, buildId: canonicalBuildId })
  );
  await record("gov03-self-test", ["node", "scripts/test-gate-selftest.mjs", "--task", "GOV-03", "--report", "<run-report>"], () =>
    (adapters.runGov03SelfTest ?? runGov03SelfTest)({ workspace: sourceWorkspace, evidenceDirectory, candidateId: candidate.releaseCandidateId })
  );
  await record("sca-production", ["npm", "audit", "--omit=dev", "--registry", loadedPolicy.policy.sca.registry, "--audit-level=high", "--json"], () =>
    (adapters.runSca ?? runSca)({ workspace: sourceWorkspace, scope: "production", policy: { ...loadedPolicy.policy.sca, toolchainVersion: loadedPolicy.policy.toolchain.npm }, evidenceDirectory })
  );
  await record("sca-full", ["npm", "audit", "--registry", loadedPolicy.policy.sca.registry, "--audit-level=high", "--json"], () =>
    (adapters.runSca ?? runSca)({ workspace: sourceWorkspace, scope: "full", policy: { ...loadedPolicy.policy.sca, toolchainVersion: loadedPolicy.policy.toolchain.npm }, evidenceDirectory })
  );
  const scannerExecutable = adapters.gitleaksExecutable ?? process.env.MINI_LUX_GITLEAKS_EXE ?? "";
  await record("secret-current", ["gitleaks", "dir", ".", "--redact=100"], async () => {
    const operation = await (adapters.runSecretScan ?? runSecretScan)({ scanRoot: sourceSnapshot, workspace: sourceSnapshot, history: false, historyComplete: false, policy: loadedPolicy.policy.secretScan, evidenceDirectory, executable: scannerExecutable });
    if (operation.passed) gitleaksVersion = loadedPolicy.policy.secretScan.version;
    return operation;
  });
  await record("secret-history", ["gitleaks", "git", ".", "--redact=100"], async () => {
    const operation = await (adapters.runSecretScan ?? runSecretScan)({ scanRoot: sourceSnapshot, workspace: sourceSnapshot, history: true, historyComplete: provenance.historyComplete, policy: loadedPolicy.policy.secretScan, evidenceDirectory, executable: scannerExecutable });
    if (operation.passed) gitleaksVersion = loadedPolicy.policy.secretScan.version;
    return operation;
  });
  await record("package-clean-install", ["npm", "ci", "--registry", loadedPolicy.policy.sca.registry, "--no-audit", "--no-fund"], () =>
    (adapters.runCleanInstall ?? runCleanInstall)({ workspace: packageWorkspace, evidenceDirectory, policy: loadedPolicy.policy, role: "package" })
  );
  const packageOperation = await record("package", ["npm", "run", "dist"], () => {
    if (!sourceBuildEvidence) return failedOperation("SOURCE_BUILD_EVIDENCE_UNAVAILABLE");
    return (adapters.runPackage ?? runPackage)({ workspace: packageWorkspace, evidenceDirectory, artifactsDirectory, runId, challenge, candidateId: candidate.releaseCandidateId, candidateSourceDigest: candidate.sourceDigest, candidateSourceManifestSha256: candidate.sourceManifestSha256, buildId: canonicalBuildId, sourceDateEpoch, sourceBuildEvidence, previousReceiptSha256: receipts.at(-1)?.receiptSha256 ?? null });
  });
  if (packageOperation?.passed) {
    artifactPath = packageOperation.artifactPath;
    artifactManifestPath = path.join(evidenceDirectory, "package-artifact.json");
    packageFormalEvidence = packageOperation.formalEvidence;
    artifact = { filename: packageOperation.artifact.filename, bytes: packageOperation.artifact.bytes, sha256: packageOperation.artifact.sha256, artifactClass: "test-only", trust: "untrusted", releaseEligible: false };
  }
  const signatureOperation = await record("signature-policy", ["powershell", "authenticode.ps1", "<artifact>"], async () => {
    if (!artifactPath) return failedOperation("ARTIFACT_UNAVAILABLE");
    const operation = await (adapters.runSignaturePolicy ?? runSignaturePolicy)({ workspace: packageWorkspace, artifactPath, mode: profile === "merge" ? "unsigned-test" : "trusted-release", policy: loadedPolicy.policy.signature, signers: loadedPolicy.signers, evidenceDirectory });
    if (operation.passed && profile === "trusted-release") Object.assign(artifact, { artifactClass: "trusted-release", trust: "trusted", releaseEligible: true });
    return operation;
  });
  await record("packaged-smoke", ["node", "scripts/run-test-layer.mjs", "--task", "GOV-03", "--layer", "packaged", "--report", "<run-report>"], async () => {
    if (!signatureOperation?.passed || !artifactPath || !artifactManifestPath) return failedOperation("ARTIFACT_UNAVAILABLE");
    return (adapters.runPackagedSmoke ?? runPackagedSmoke)({ workspace: packageWorkspace, evidenceDirectory, artifactPath, artifactManifestPath, artifactSha256: artifact.sha256, buildId: canonicalBuildId, sourceDateEpoch });
  });

  let cleanup = { workspaceRemoved: false, sourceUnchanged: false, artifactUnchanged: artifactPath === null, evidencePreserved: true };
  await record("finalize", ["internal", "finalize"], async () => {
    let sourceUnchanged = false;
    let artifactUnchanged = artifactPath === null;
    try {
      sourceUnchanged = publicCandidateIdentity(await computeCandidateIdentity(projectRoot)).releaseCandidateId === sourceBefore;
      if (artifactPath && artifact && packageFormalEvidence) {
        const finalFormal = await formalEvidence(packageWorkspace);
        artifactUnchanged = await sha256File(artifactPath) === artifact.sha256
          && finalFormal.buildInfoSha256 === packageFormalEvidence.buildInfoSha256
          && finalFormal.distIntegritySha256 === packageFormalEvidence.distIntegritySha256
          && finalFormal.distTreeSha256 === packageFormalEvidence.distTreeSha256
          && finalFormal.electronAppTreeSha256 === packageFormalEvidence.electronAppTreeSha256
          && finalFormal.releaseTreeSha256 === packageFormalEvidence.releaseTreeSha256
          && finalFormal.packageManifestSha256 === packageFormalEvidence.manifestSha256;
      }
    } catch {}
    const workspaceRemoved = await removeAndObserve([sourceSnapshot, sourceWorkspace, packageWorkspace]);
    cleanup = { workspaceRemoved, sourceUnchanged, artifactUnchanged, evidencePreserved: await exists(evidenceDirectory) };
    const passed = Object.values(cleanup).every(Boolean);
    return { passed, failureClass: passed ? null : "FINALIZE_FAILED", exitCode: passed ? 0 : 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: cleanup };
  });

  assert.deepEqual(receipts.map((entry) => entry.id), gov04StepIds);
  const report = {
    schemaVersion: 1,
    taskId: "GOV-04",
    profile,
    state: receipts.every((receipt) => receipt.state === "passed") ? "passed" : "failed",
    releaseEligible: receipts.every((receipt) => receipt.state === "passed") && profile === "trusted-release" && trustedProvenanceMatches(provenance, loadedPolicy.policy.trustedRelease) && artifact?.releaseEligible === true,
    runId,
    challenge,
    retry,
    attempt: 1,
    provenance,
    candidate,
    policy: loadedPolicy.public,
    toolchain: { ...loadedPolicy.policy.toolchain, gitleaks: gitleaksVersion },
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - runStarted,
    expectedSteps: [...gov04StepIds],
    executedSteps: receipts.filter((receipt) => receipt.executed).map((receipt) => receipt.id),
    steps: receipts,
    artifact,
    cleanup,
    knownLimitations: ["Remote GitHub ruleset, required-check and hosted-run enforcement require independent server-side evidence", "The signer allowlist is intentionally unconfigured until REL-01 provisions an approved certificate and timestamp policy"],
    reviewerVerdict: null,
    userStatus: "not-reviewed",
  };
  validateGov04Report(report);
  const reportPath = path.join(evidenceDirectory, "gov04-report.json");
  await exclusiveJson(reportPath, report);
  const marker = { schemaVersion: 1, taskId: "GOV-04", runId, reportSha256: sha256(await readFile(reportPath)), artifactSha256: artifact?.sha256 ?? null, candidateId: candidate.releaseCandidateId, createdAt: new Date().toISOString() };
  await validateGov04Marker(marker, reportPath, artifact?.sha256 ?? null);
  const markerPath = path.join(evidenceDirectory, "gov04-final-marker.json");
  await exclusiveJson(markerPath, marker);
  if (exportReportPath) await copyFile(reportPath, exportReportPath, fsConstants.COPYFILE_EXCL);
  if (exportEvidenceDirectory) await exportEvidenceBundle({ destination: exportEvidenceDirectory, evidenceDirectory, report, artifactPath });
  return { report, reportPath, markerPath, runRoot };
}
