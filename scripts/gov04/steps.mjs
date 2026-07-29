import assert from "node:assert/strict";
import { constants as fsConstants, access, copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateLayerReport, validateSelfTestReport, validateUnifiedReport } from "../report-schema.mjs";
import { expectedInstallerName, fileSha256, verifyInstallerPreflight } from "../package-artifact-lib.mjs";
import { hashTree, sha256File } from "../../tests/helpers.mjs";
import { resolveNpmCli, runBoundedProcess, safeChildEnvironment } from "./process.mjs";
import { assertEmptyFormalOutputs, computeCandidateIdentity, publicCandidateIdentity, sha256 } from "./identity.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function processFailure(error, failureClass) {
  const timedOut = error?.timedOut === true;
  return {
    passed: false,
    failureClass: timedOut ? (error.code === "PROCESS_TIMEOUT_CLEANUP_FAILED" ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT") : error?.code === "PROCESS_OUTPUT_LIMIT" ? "OUTPUT_LIMIT" : failureClass,
    exitCode: null,
    signal: null,
    timedOut,
    timeoutTermination: error?.termination ?? null,
    childReportSha256: null,
    evidence: { status: "process-failed" },
  };
}

function observedOperation(result, evidence, failureClass) {
  const passed = result.code === 0 && result.signal === null;
  return {
    passed,
    failureClass: passed ? null : failureClass,
    exitCode: result.code,
    signal: result.signal,
    timedOut: false,
    timeoutTermination: null,
    childReportSha256: null,
    evidence: { ...evidence, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 },
  };
}

async function npmInvocation(workspace, args, { env, timeoutMs = 180_000, maxOutputBytes } = {}) {
  const npmCli = await resolveNpmCli();
  return runBoundedProcess(process.execPath, [npmCli, ...args], { cwd: workspace, env, timeoutMs, maxOutputBytes });
}

export async function runCleanInstall({ workspace, evidenceDirectory, policy, role }) {
  assert(["source-test", "package"].includes(role));
  const packagePath = path.join(workspace, "package.json");
  const lockPath = path.join(workspace, "package-lock.json");
  const packageBefore = await sha256File(packagePath);
  const lockBefore = await sha256File(lockPath);
  const nodeModulesAbsentBefore = !await exists(path.join(workspace, "node_modules"));
  const npmrc = path.join(evidenceDirectory, `${role}-clean-install.npmrc`);
  await writeFile(npmrc, `registry=${policy.sca.registry}\naudit=false\nfund=false\n`, { encoding: "utf8", flag: "wx" });
  const env = safeChildEnvironment({ npm_config_userconfig: npmrc, npm_config_registry: policy.sca.registry });
  if (process.versions.node !== policy.toolchain.node || !nodeModulesAbsentBefore) {
    return { passed: false, failureClass: process.versions.node !== policy.toolchain.node ? "NODE_VERSION_MISMATCH" : "DIRTY_INSTALL_INPUT", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { role, nodeVersion: process.versions.node, npmVersion: null, nodeModulesAbsentBefore, packageJsonSha256: packageBefore, lockfileSha256: lockBefore, inputsUnchanged: true } };
  }
  let version;
  try { version = await npmInvocation(workspace, ["--version"], { env, timeoutMs: 30_000 }); }
  catch (error) { return processFailure(error, "NPM_UNAVAILABLE"); }
  const npmVersion = version.stdout.trim();
  if (version.code !== 0 || npmVersion !== policy.toolchain.npm) {
    return { passed: false, failureClass: "NPM_VERSION_MISMATCH", exitCode: version.code, signal: version.signal, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { role, nodeVersion: process.versions.node, npmVersion, nodeModulesAbsentBefore, packageJsonSha256: packageBefore, lockfileSha256: lockBefore, inputsUnchanged: true } };
  }
  let result;
  try { result = await npmInvocation(workspace, ["ci", "--registry", policy.sca.registry, "--no-audit", "--no-fund"], { env, timeoutMs: 300_000 }); }
  catch (error) { return processFailure(error, "CLEAN_INSTALL_FAILED"); }
  let electronInstall;
  try { electronInstall = await runBoundedProcess(process.execPath, ["node_modules/electron/install.js"], { cwd: workspace, env, timeoutMs: 300_000 }); }
  catch (error) { return processFailure(error, "ELECTRON_RUNTIME_INSTALL_FAILED"); }
  if (electronInstall.code !== 0 || electronInstall.signal !== null) return observedOperation(electronInstall, { role, status: "electron-runtime-install-failed" }, "ELECTRON_RUNTIME_INSTALL_FAILED");
  const electronPackage = JSON.parse(await readFile(path.join(workspace, "node_modules", "electron", "package.json"), "utf8"));
  const electronVersion = (await readFile(path.join(workspace, "node_modules", "electron", "dist", "version"), "utf8")).trim().replace(/^v/, "");
  const electronExecutableSha256 = await sha256File(path.join(workspace, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"));
  const packageAfter = await sha256File(packagePath);
  const lockAfter = await sha256File(lockPath);
  const inputsUnchanged = packageBefore === packageAfter && lockBefore === lockAfter;
  const actualTools = {};
  for (const [name, relative] of Object.entries({ typescript: "typescript", eslint: "eslint", c8: "c8" })) actualTools[name] = JSON.parse(await readFile(path.join(workspace, "node_modules", relative, "package.json"), "utf8")).version;
  const toolsMatched = Object.entries(actualTools).every(([name, value]) => value === policy.toolchain[name]);
  const electronMatched = electronPackage.version === "43.1.1" && electronVersion === electronPackage.version;
  const observation = observedOperation(result, { role, nodeVersion: process.versions.node, npmVersion, nodeModulesAbsentBefore, packageJsonSha256: packageBefore, lockfileSha256: lockBefore, inputsUnchanged, tools: actualTools, electronVersion, electronExecutableSha256, electronInstallStdoutSha256: electronInstall.stdoutSha256, electronInstallStderrSha256: electronInstall.stderrSha256 }, "CLEAN_INSTALL_FAILED");
  if (observation.passed && (!inputsUnchanged || !toolsMatched || !electronMatched)) return { ...observation, passed: false, failureClass: !inputsUnchanged ? "DEPENDENCY_INPUT_MUTATION" : "TOOLCHAIN_VERSION_MISMATCH", exitCode: 1 };
  return observation;
}

export async function runStaticCommand({ workspace, npmArgs, evidence, timeoutMs = 180_000, failureClass }) {
  const before = publicCandidateIdentity(await computeCandidateIdentity(workspace));
  const distAbsentBefore = !await exists(path.join(workspace, "dist"));
  let result;
  try { result = await npmInvocation(workspace, npmArgs, { env: safeChildEnvironment(), timeoutMs }); }
  catch (error) { return processFailure(error, failureClass); }
  const after = publicCandidateIdentity(await computeCandidateIdentity(workspace));
  const sourceUnchanged = before.releaseCandidateId === after.releaseCandidateId;
  const distAbsentAfter = !await exists(path.join(workspace, "dist"));
  const observation = observedOperation(result, { ...evidence, sourceBefore: before.releaseCandidateId, sourceAfter: after.releaseCandidateId, sourceUnchanged, distAbsentBefore, distAbsentAfter }, failureClass);
  if (observation.passed && (!sourceUnchanged || !distAbsentBefore || !distAbsentAfter)) return { ...observation, passed: false, failureClass: !sourceUnchanged ? "SOURCE_MUTATION" : "UNEXPECTED_BUILD_OUTPUT", exitCode: 1 };
  return observation;
}

async function runDirectStep(workspace, args, env, timeoutMs = 300_000) {
  return runBoundedProcess(process.execPath, args, { cwd: workspace, env, timeoutMs });
}

export async function runSourceTestBuild({ workspace, buildId, sourceDateEpoch, candidateSourceDigest }) {
  try { await assertEmptyFormalOutputs(workspace); }
  catch { return { passed: false, failureClass: "SOURCE_TEST_OUTPUT_PREEXISTS", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "preexisting-output" } }; }
  const env = safeChildEnvironment({ MINI_LUX_BUILD_ID: buildId, SOURCE_DATE_EPOCH: sourceDateEpoch });
  const commands = [
    ["scripts/generate-build-info.mjs"],
    ["node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
    ["scripts/generate-dist-integrity.mjs"],
  ];
  const observations = [];
  for (const args of commands) {
    let result;
    try { result = await runDirectStep(workspace, args, env); }
    catch (error) { return processFailure(error, "SOURCE_TEST_BUILD_FAILED"); }
    observations.push(result);
    if (result.code !== 0 || result.signal !== null) return observedOperation(result, { commandIndex: observations.length }, "SOURCE_TEST_BUILD_FAILED");
  }
  try {
    const buildInfoPath = path.join(workspace, "build-info.json");
    const integrityPath = path.join(workspace, "dist-integrity.json");
    const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
    assert.equal(buildInfo.buildId, buildId);
    assert.equal(buildInfo.sourceDigest, candidateSourceDigest);
    const evidence = {
      buildId,
      sourceDateEpoch,
      sourceDigest: buildInfo.sourceDigest,
      buildInfoSha256: await sha256File(buildInfoPath),
      distIntegritySha256: await sha256File(integrityPath),
      distTreeSha256: await hashTree(path.join(workspace, "dist")),
      commands: [
        ["node", "scripts/generate-build-info.mjs"],
        ["node", "node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
        ["node", "scripts/generate-dist-integrity.mjs"],
      ],
      outputHashes: observations.map((result) => ({ stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 })),
    };
    return { passed: true, failureClass: null, exitCode: 0, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: evidence.buildInfoSha256, evidence, buildEvidence: evidence };
  } catch { return { passed: false, failureClass: "SOURCE_TEST_BUILD_EVIDENCE_INVALID", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "invalid-build-evidence" } }; }
}

async function readJsonReport(reportPath) {
  const bytes = await readFile(reportPath);
  return { report: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
}

export async function runGov03Quick({ workspace, evidenceDirectory, candidateSourceDigest, candidateId, buildId }) {
  const sourceBefore = publicCandidateIdentity(await computeCandidateIdentity(workspace));
  const reportPath = path.join(evidenceDirectory, "gov03-quick.json");
  let result;
  try { result = await runBoundedProcess(process.execPath, ["scripts/run-tests.mjs", "--profile", "quick", "--report", reportPath], { cwd: workspace, env: safeChildEnvironment(), timeoutMs: 900_000 }); }
  catch (error) { return processFailure(error, "GOV03_QUICK_FAILED"); }
  try {
    const child = await readJsonReport(reportPath);
    const manifest = JSON.parse(await readFile(path.join(workspace, "tests", "manifests", "gov-03.json"), "utf8"));
    const coverageScope = JSON.parse(await readFile(path.join(workspace, "tests", "coverage-scope.json"), "utf8"));
    validateUnifiedReport(child.report, { taskId: "GOV-03", build: { appVersion: "0.1.0", buildId, sourceDigest: candidateSourceDigest }, coverageScope, layerExpectedFiles: manifest.layers });
    const sourceAfter = publicCandidateIdentity(await computeCandidateIdentity(workspace));
    const sourceUnchanged = sourceBefore.releaseCandidateId === candidateId && sourceAfter.releaseCandidateId === candidateId;
    const passed = result.code === 0 && child.report.state === "passed" && sourceUnchanged;
    return { passed, failureClass: passed ? null : !sourceUnchanged ? "SOURCE_MUTATION" : "GOV03_QUICK_FAILED", exitCode: passed ? 0 : result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: child.sha256, evidence: { childState: child.report.state, childBuildId: child.report.build.buildId, childSourceDigest: child.report.build.sourceDigest, sourceUnchanged, reportSha256: child.sha256, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 } };
  } catch { return { passed: false, failureClass: "GOV03_REPORT_INVALID", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "invalid-child-report" } }; }
}

export async function runGov03SelfTest({ workspace, evidenceDirectory, candidateId }) {
  const sourceBefore = publicCandidateIdentity(await computeCandidateIdentity(workspace));
  const reportPath = path.join(evidenceDirectory, "gov03-self-test.json");
  let result;
  try { result = await runBoundedProcess(process.execPath, ["scripts/test-gate-selftest.mjs", "--task", "GOV-03", "--report", reportPath], { cwd: workspace, env: safeChildEnvironment(), timeoutMs: 900_000 }); }
  catch (error) { return processFailure(error, "GOV03_SELF_TEST_FAILED"); }
  try {
    const child = await readJsonReport(reportPath);
    validateSelfTestReport(child.report, { taskId: "GOV-03" });
    const sourceAfter = publicCandidateIdentity(await computeCandidateIdentity(workspace));
    const sourceUnchanged = sourceBefore.releaseCandidateId === candidateId && sourceAfter.releaseCandidateId === candidateId;
    const passed = result.code === 0 && child.report.state === "passed" && sourceUnchanged;
    return { passed, failureClass: passed ? null : !sourceUnchanged ? "SOURCE_MUTATION" : "GOV03_SELF_TEST_FAILED", exitCode: passed ? 0 : result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: child.sha256, evidence: { childState: child.report.state, sourceUnchanged, reportSha256: child.sha256, scenarioCount: child.report.scenarios.length, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 } };
  } catch { return { passed: false, failureClass: "GOV03_REPORT_INVALID", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "invalid-child-report" } }; }
}

export async function claimPackageAttempt({ evidenceDirectory, runId, challenge, candidateId, buildId, sourceManifestSha256, previousReceiptSha256 }) {
  const attempt = { schemaVersion: 1, runId, challenge, candidateId, buildId, sourceManifestSha256, previousReceiptSha256, command: ["npm", "run", "dist"] };
  assert.deepEqual(Object.keys(attempt).sort(), ["schemaVersion", "runId", "challenge", "candidateId", "buildId", "sourceManifestSha256", "previousReceiptSha256", "command"].sort());
  assert.equal(attempt.schemaVersion, 1);
  assert.match(attempt.runId, /^[0-9a-f-]{36}$/);
  for (const value of [attempt.challenge, attempt.candidateId, attempt.sourceManifestSha256, attempt.previousReceiptSha256]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.match(attempt.buildId, /^0\.1\.0\+ci\.[a-f0-9]{64}$/);
  assert.deepEqual(attempt.command, ["npm", "run", "dist"]);
  const bytes = `${JSON.stringify(attempt, null, 2)}\n`;
  await writeFile(path.join(evidenceDirectory, "package-attempt.json"), bytes, { encoding: "utf8", flag: "wx" });
  return { attempt, bytes, sha256: sha256(bytes) };
}

export function validateStagingInstall(staging, { runId, challenge, candidateId }) {
  assert(staging && typeof staging === "object" && !Array.isArray(staging));
  assert.deepEqual(Object.keys(staging).sort(), ["schemaVersion", "role", "runId", "challenge", "candidateId", "command"].sort());
  assert.equal(staging.schemaVersion, 1);
  assert.equal(staging.runId, runId);
  assert.equal(staging.challenge, challenge);
  assert.equal(staging.candidateId, candidateId);
  assert.equal(staging.role, "electron-staging");
  assert.deepEqual(staging.command, ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  return staging;
}

export async function assertFrozenArtifactInput({ artifactPath, artifactManifestPath, artifactSha256 }) {
  assert.equal(path.basename(path.dirname(path.dirname(artifactPath))), "sha256", "artifact is outside frozen sha256 store");
  assert.equal(path.basename(path.dirname(artifactPath)), artifactSha256, "artifact frozen directory differs from expected hash");
  const info = await lstat(artifactPath);
  assert(info.isFile() && !info.isSymbolicLink(), "frozen artifact is not a regular file");
  const manifest = JSON.parse(await readFile(artifactManifestPath, "utf8"));
  assert.equal(manifest?.artifact?.filename, path.basename(artifactPath));
  assert.equal(manifest?.artifact?.sha256, artifactSha256);
  assert.equal(manifest?.artifact?.bytes, info.size);
  assert.equal(await fileSha256(artifactPath), artifactSha256);
  return { filename: path.basename(artifactPath), bytes: info.size, sha256: artifactSha256 };
}

export async function runPackage({ workspace, evidenceDirectory, artifactsDirectory, runId, challenge, candidateId, candidateSourceDigest, candidateSourceManifestSha256, buildId, sourceDateEpoch, sourceBuildEvidence, previousReceiptSha256 }) {
  try { await assertEmptyFormalOutputs(workspace); }
  catch { return { passed: false, failureClass: "PACKAGE_OUTPUT_PREEXISTS", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "preexisting-output" } }; }
  let packageAttempt;
  try { packageAttempt = await claimPackageAttempt({ evidenceDirectory, runId, challenge, candidateId, buildId, sourceManifestSha256: candidateSourceManifestSha256, previousReceiptSha256 }); }
  catch { return { passed: false, failureClass: "PACKAGE_ALREADY_ATTEMPTED", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "attempt-exists" } }; }
  const npmCli = await resolveNpmCli();
  const stagingMarker = path.join(evidenceDirectory, "staging-install.json");
  const env = safeChildEnvironment({
    MINI_LUX_BUILD_ID: buildId,
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    MINI_LUX_NPM_CLI_PATH: npmCli,
    MINI_LUX_GOV04_STAGING_INSTALL_MARKER: stagingMarker,
    MINI_LUX_GOV04_RUN_ID: runId,
    MINI_LUX_GOV04_CHALLENGE: challenge,
    MINI_LUX_GOV04_CANDIDATE_ID: candidateId,
  });
  let result;
  try { result = await npmInvocation(workspace, ["run", "dist"], { env, timeoutMs: 900_000 }); }
  catch (error) { return processFailure(error, "PACKAGE_FAILED"); }
  if (result.code !== 0 || result.signal !== null) return observedOperation(result, { status: "package-command-failed" }, "PACKAGE_FAILED");
  let manifestResult;
  try { manifestResult = await runBoundedProcess(process.execPath, ["scripts/write-package-artifact.mjs"], { cwd: workspace, env, timeoutMs: 120_000 }); }
  catch (error) { return processFailure(error, "PACKAGE_MANIFEST_FAILED"); }
  if (manifestResult.code !== 0) return observedOperation(manifestResult, { status: "manifest-command-failed" }, "PACKAGE_MANIFEST_FAILED");
  try {
    const staging = validateStagingInstall(JSON.parse(await readFile(stagingMarker, "utf8")), { runId, challenge, candidateId });
    const buildInfoPath = path.join(workspace, "build-info.json");
    const integrityPath = path.join(workspace, "dist-integrity.json");
    const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
    assert.equal(buildInfo.buildId, buildId);
    assert.equal(buildInfo.sourceDigest, candidateSourceDigest);
    const formalBuildEvidence = { buildInfoSha256: await sha256File(buildInfoPath), distIntegritySha256: await sha256File(integrityPath), distTreeSha256: await hashTree(path.join(workspace, "dist")) };
    assert.equal(formalBuildEvidence.buildInfoSha256, sourceBuildEvidence.buildInfoSha256);
    assert.equal(formalBuildEvidence.distIntegritySha256, sourceBuildEvidence.distIntegritySha256);
    assert.equal(formalBuildEvidence.distTreeSha256, sourceBuildEvidence.distTreeSha256);
    const manifestPath = path.join(workspace, "test-results", "package-artifact.json");
    const { installer, manifest } = await verifyInstallerPreflight({ manifestPath, buildInfo, projectRoot: workspace });
    assert.equal(path.basename(installer), expectedInstallerName(buildInfo));
    const hashDirectory = path.join(artifactsDirectory, "sha256", manifest.artifact.sha256);
    await mkdir(hashDirectory, { recursive: true });
    const frozenPath = path.join(hashDirectory, manifest.artifact.filename);
    await copyFile(installer, frozenPath, fsConstants.COPYFILE_EXCL);
    const frozenInfo = await stat(frozenPath);
    const frozenHash = await fileSha256(frozenPath);
    assert.equal(frozenInfo.size, manifest.artifact.bytes);
    assert.equal(frozenHash, manifest.artifact.sha256);
    const preservedManifest = path.join(evidenceDirectory, "package-artifact.json");
    await copyFile(manifestPath, preservedManifest, fsConstants.COPYFILE_EXCL);
    const packageSourceIdentity = publicCandidateIdentity(await computeCandidateIdentity(workspace));
    assert.equal(packageSourceIdentity.releaseCandidateId, candidateId);
    const evidence = {
      runId,
      candidateId,
      buildId,
      sourceDateEpoch,
      sourceIdentityAfter: packageSourceIdentity.releaseCandidateId,
      sourceManifestSha256: candidateSourceManifestSha256,
      filename: manifest.artifact.filename,
      bytes: manifest.artifact.bytes,
      sha256: manifest.artifact.sha256,
      attemptSha256: packageAttempt.sha256,
      stagingInstallSha256: await sha256File(stagingMarker),
      manifestSha256: await sha256File(preservedManifest),
      frozenSha256: frozenHash,
      buildInfoSha256: formalBuildEvidence.buildInfoSha256,
      distIntegritySha256: formalBuildEvidence.distIntegritySha256,
      distTreeSha256: formalBuildEvidence.distTreeSha256,
      electronAppTreeSha256: await hashTree(path.join(workspace, ".electron-app")),
      releaseTreeSha256: await hashTree(path.join(workspace, "release")),
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
    };
    return { passed: true, failureClass: null, exitCode: 0, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: evidence.manifestSha256, evidence, artifactPath: frozenPath, artifact: manifest.artifact, formalEvidence: evidence };
  } catch { return { passed: false, failureClass: "PACKAGE_EVIDENCE_INVALID", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "invalid-package-evidence" } }; }
}

export async function runPackagedSmoke({ workspace, evidenceDirectory, artifactPath, artifactManifestPath, artifactSha256, buildId, sourceDateEpoch }) {
  const reportPath = path.join(evidenceDirectory, "gov03-packaged.json");
  try { await assertFrozenArtifactInput({ artifactPath, artifactManifestPath, artifactSha256 }); }
  catch { return { passed: false, failureClass: "PACKAGED_SMOKE_INPUT_INVALID", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { status: "non-frozen-or-mutated-input" } }; }
  let result;
  try {
    result = await runBoundedProcess(process.execPath, ["scripts/run-test-layer.mjs", "--task", "GOV-03", "--layer", "packaged", "--report", reportPath], { cwd: workspace, env: safeChildEnvironment({ MINI_LUX_INSTALLER_OVERRIDE: artifactPath, MINI_LUX_PACKAGE_ARTIFACT_MANIFEST: artifactManifestPath, MINI_LUX_BUILD_ID: buildId, SOURCE_DATE_EPOCH: sourceDateEpoch }), timeoutMs: 900_000 });
  } catch (error) { return processFailure(error, "PACKAGED_SMOKE_FAILED"); }
  try {
    const child = await readJsonReport(reportPath);
    const manifest = JSON.parse(await readFile(path.join(workspace, "tests", "manifests", "gov-03.json"), "utf8"));
    const buildInfo = JSON.parse(await readFile(path.join(workspace, "build-info.json"), "utf8"));
    validateLayerReport(child.report, { taskId: "GOV-03", layer: "packaged", build: { appVersion: buildInfo.appVersion, buildId: buildInfo.buildId, sourceDigest: buildInfo.sourceDigest }, expectedFiles: manifest.layers.packaged });
    const executedHash = child.report.details?.artifactExecution?.executedSha256;
    const passed = result.code === 0 && child.report.state === "passed" && executedHash === artifactSha256;
    return { passed, failureClass: passed ? null : "PACKAGED_SMOKE_FAILED", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: child.sha256, evidence: { artifactSha256, executedSha256: executedHash ?? null, childState: child.report.state, reportSha256: child.sha256, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 } };
  } catch { return { passed: false, failureClass: "PACKAGED_REPORT_INVALID", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, childReportSha256: null, evidence: { artifactSha256, status: "invalid-child-report" } }; }
}
