import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateModelManifest } from "../../scripts/bootstrap-models.mjs";
import { gov04StepIds } from "../../scripts/gov04/report-schema.mjs";
import { extractUnifiedRunnerCrashEvidence, reconcileUnifiedRunnerCrashEvidence, summarizeInvalidUnifiedReport } from "../../scripts/gov04/steps.mjs";
import { projectRoot } from "../helpers.mjs";

const workflowPaths = [
  ".github/workflows/gov-04-merge.yml",
  ".github/workflows/gov-04-trusted-release.yml",
];

test("GOV-04 invalid child diagnostics require an exact private challenge binding", () => {
  const challenge = "a".repeat(64);
  const expectedContext = { taskId: "GOV-03", diagnosticChallenge: challenge };
  assert.deepEqual(summarizeInvalidUnifiedReport(null, expectedContext), {
    status: "invalid-child-report",
    childReadable: false,
    childState: null,
    resultCount: null,
    firstFailure: null,
    crashStage: null,
    crashCode: null,
  });
  const summary = summarizeInvalidUnifiedReport({
    state: "failed",
    rawPath: "C:\\sensitive\\checkout",
    results: [{
      kind: "layer",
      name: "unit",
      exitCode: 1,
      reportValidation: "REPORT_SCHEMA_INVALID",
      report: { state: "failed", error: "C:\\sensitive\\checkout" },
    }],
  }, expectedContext);
  assert.deepEqual(summary, {
    status: "invalid-child-report",
    childReadable: true,
    childState: "failed",
    resultCount: 1,
    firstFailure: {
      kind: "layer",
      name: "unit",
      exitCode: 1,
      reportValidation: "REPORT_SCHEMA_INVALID",
      reportState: "failed",
    },
    crashStage: null,
    crashCode: null,
  });
  assert.doesNotMatch(JSON.stringify(summary), /sensitive|checkout/u);

  const marker = {
    reportVersion: 0,
    taskId: "GOV-03",
    state: "crashed",
    diagnosticChallenge: challenge,
    crashStage: "report-rename",
    crashCode: "EPERM",
  };
  const trusted = summarizeInvalidUnifiedReport(marker, expectedContext);
  assert.equal(trusted.crashStage, "report-rename");
  assert.equal(trusted.crashCode, "EPERM");
  assert.equal(summarizeInvalidUnifiedReport({ ...marker, taskId: "OTHER-03" }, expectedContext).crashStage, null);
  assert.equal(summarizeInvalidUnifiedReport({ ...marker, diagnosticChallenge: "b".repeat(64) }, expectedContext).crashStage, null);
  assert.equal(summarizeInvalidUnifiedReport({ ...marker, extra: "forged" }, expectedContext).crashStage, null);

  const line = `[GOV-03:${challenge}] unified runner crashed at report-rename code EPERM`;
  const stderrMarker = extractUnifiedRunnerCrashEvidence(`untrusted diagnostic\n${line}\n`, expectedContext);
  assert.deepEqual(stderrMarker, { stage: "report-rename", code: "EPERM" });
  assert.equal(extractUnifiedRunnerCrashEvidence(`${line}\n${line}\n`, expectedContext), null);
  assert.equal(extractUnifiedRunnerCrashEvidence(`[GOV-03:${"b".repeat(64)}] unified runner crashed at report-rename code EPERM\n`, expectedContext), null);
  assert.equal(extractUnifiedRunnerCrashEvidence(`prefix ${line}\n`, expectedContext), null);
  assert.equal(extractUnifiedRunnerCrashEvidence(`[GOV-03:${challenge}] unified runner crashed at C:\\sensitive\\checkout code EPERM\n`, expectedContext), null);
  assert.deepEqual(extractUnifiedRunnerCrashEvidence(
    `[GOV-03:${challenge}] unified runner crashed at report-path-validation code REPORT_ALLOWED_ROOT\n`,
    expectedContext,
  ), { stage: "report-path-validation", code: "REPORT_ALLOWED_ROOT" });
  assert.deepEqual(reconcileUnifiedRunnerCrashEvidence(trusted, stderrMarker), { stage: "report-rename", code: "EPERM" });
  assert.equal(reconcileUnifiedRunnerCrashEvidence(trusted, { stage: "report-revalidation", code: "EPERM" }), null);
  assert.equal(reconcileUnifiedRunnerCrashEvidence(trusted, null), null);
  assert.deepEqual(reconcileUnifiedRunnerCrashEvidence(summary, stderrMarker), stderrMarker);
});

test("GOV-04 test manifest binds the frozen 16-step state machine", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "tests", "manifests", "gov-04.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["schemaVersion", "stepOrder", "taskId", "testFiles"].sort());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, "GOV-04");
  assert.deepEqual(manifest.stepOrder, gov04StepIds);
  assert.deepEqual(manifest.testFiles, ["tests/gov04/report-schema.test.mjs", "tests/gov04/workflow-policy.test.mjs"]);
});

test("model bootstrap manifest pins the complete immutable payload", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "models-manifest.json"), "utf8"));
  assert.equal(validateModelManifest(manifest), manifest);
  const mutableRevision = structuredClone(manifest);
  mutableRevision.revision = "main";
  assert.throws(() => validateModelManifest(mutableRevision), /revision is invalid/);
  const changedUrl = structuredClone(manifest);
  changedUrl.files[0].url = "https://example.com/config.json";
  assert.throws(() => validateModelManifest(changedUrl), /URL differs/);

  const provenance = await readFile(path.join(projectRoot, "scripts", "gov04", "provenance.mjs"), "utf8");
  const checkout = provenance.indexOf('git(workspace, ["checkout"');
  const bootstrap = provenance.indexOf('runProcess(process.execPath, ["scripts/bootstrap-models.mjs"]');
  const identity = provenance.indexOf("computeCandidateIdentity(workspace)", bootstrap);
  assert(checkout >= 0 && checkout < bootstrap && bootstrap < identity);

  const toolchain = await readFile(path.join(projectRoot, "scripts", "gov04", "ensure-native-toolchain.ps1"), "utf8");
  assert.match(toolchain, /Microsoft\.VisualStudio\.Component\.VC\.14\.43\.17\.13\.x86\.x64/);
  assert.match(toolchain, /Microsoft\.VisualStudio\.Component\.Windows11SDK\.22621/);
  assert.match(toolchain, /\[17\.0,18\.0\)/);
  assert.doesNotMatch(toolchain, /-requires Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/);
  assert.match(toolchain, /17\.13\.35825\.156/);
  assert.match(toolchain, /https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/84955a63-15ca-4f52-94af-14ea55b50424\/e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e\/vs_BuildTools\.exe/);
  assert.match(toolchain, /e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e/);
  assert.match(toolchain, /Microsoft\.VisualStudio\.Product\.BuildTools/);
  assert.match(toolchain, /Microsoft\.VisualStudio\.Product\.Community/);
  assert.match(toolchain, /19\.43\.34808\.0/);
  assert.match(toolchain, /10\.0\.22621\.0/);
  assert.match(toolchain, /\$arguments = @\(\s*'install',\s*'--installPath'/);
  assert.match(toolchain, /Write-BoundedInstallerDiagnostics/);
  assert.match(toolchain, /ExitCode -ne 0/);
  assert.match(toolchain, /AddMinutes\(10\)/);
  assert.match(toolchain, /instances\.Count -gt 1/);
  assert.match(toolchain, /installation did not become ready before the deadline/);

  const electronHeaders = await readFile(path.join(projectRoot, "scripts", "gov04", "bootstrap-electron-headers.mjs"), "utf8");
  assert.match(electronHeaders, /https:\/\/electronjs\.org\/headers\/v43\.1\.1\/node-v43\.1\.1-headers\.tar\.gz/);
  assert.match(electronHeaders, /b1112989ad4c4807a6bf59bfc96ce8d0f0b16962efe9818fa768e5908cc24d21/);
  assert.match(electronHeaders, /https:\/\/electronjs\.org\/headers\/v43\.1\.1\/win-x64\/node\.lib/);
  assert.match(electronHeaders, /757cde97e0dd2f01aed47326440429a1012624892e6e4cbebf59dac964ac8e6d/);
  assert.match(electronHeaders, /956c2a3dda4622f75093a7adf5e19bbc09d760e166afb092e9d0e62be9e8873d/);
  assert(!electronHeaders.includes("node-gyp"));

  const nativeBuild = await readFile(path.join(projectRoot, "scripts", "build-sec03-native.mjs"), "utf8");
  assert.match(nativeBuild, /installationVersion !== "17\.13\.35825\.156"/);
  assert.doesNotMatch(nativeBuild, /"-requires", "Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64"/);
  assert.match(nativeBuild, /versionProbe\.status !== 0/);
  assert.match(nativeBuild, /electronHeaders/);

  const orchestrator = await readFile(path.join(projectRoot, "scripts", "gov04", "orchestrator.mjs"), "utf8");
  assert.match(orchestrator, /const canonicalRunBase = await realpath\(runBase\)/);
  assert.match(orchestrator, /resolveRetryEvidence\(\{ runBase: canonicalRunBase, retryOf \}\)/);
  assert.match(orchestrator, /const runRoot = path\.join\(canonicalRunBase, runId\)/);
  assert.doesNotMatch(orchestrator, /const runRoot = path\.join\(runBase, runId\)/);

  const gov04Steps = await readFile(path.join(projectRoot, "scripts", "gov04", "steps.mjs"), "utf8");
  assert.equal(gov04Steps.match(/loadTaskManifest\("GOV-03", workspace\)/g)?.length, 2);
  assert.doesNotMatch(gov04Steps, /tests["'],\s*["']manifests["'],\s*["']gov-03\.json/);
  assert.match(gov04Steps, /const sec02RunId = randomUUID\(\)/);
  assert.match(gov04Steps, /const diagnosticChallenge = randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(gov04Steps, /RAINYDAYS_SEC02_RUN_ID: sec02RunId,[\s\S]*RAINYDAYS_GOV04_DIAGNOSTIC_CHALLENGE: diagnosticChallenge/);
  assert.match(gov04Steps, /sec02Manifest: loadedTask\.resolvedManifest,[\s\S]*sec02Matrix,[\s\S]*sec02RunId/);
  const unifiedRunner = await readFile(path.join(projectRoot, "scripts", "run-tests.mjs"), "utf8");
  assert.match(unifiedRunner, /process\.env\.RAINYDAYS_SEC02_RUN_ID/);
  assert.match(unifiedRunner, /GOV-04 SEC-02 run ID is invalid/);
  assert.match(unifiedRunner, /configuredSec02RunId \?\? randomUUID\(\)/);
  assert.match(unifiedRunner, /const sec02ReceiptEnvironmentKeys = Object\.freeze/);
  assert.match(unifiedRunner, /const reportTarget = await prepareReportTarget\(args\.report\)/);
  assert.equal(unifiedRunner.match(/atomicWriteJson\(reportTarget,/g)?.length, 1);
  assert.equal(unifiedRunner.match(/atomicWriteJson\(context\.reportTarget,/g)?.length, 1);
  assert.match(unifiedRunner, /GOV-04 diagnostic challenge is invalid/);
  assert.equal(unifiedRunner.match(/env: withoutGov04DiagnosticChallenge\(\)/g)?.length, 1);
  assert.equal(unifiedRunner.match(/env: withoutSec02ReceiptEnvironment\(withoutGov04DiagnosticChallenge\(\)\)/g)?.length, 2);
  assert.match(unifiedRunner, /reportVersion: 0,[\s\S]*state: "crashed",[\s\S]*diagnosticChallenge: context\.diagnosticChallenge,[\s\S]*crashStage: context\.stage/);
  assert.match(unifiedRunner, /\[\$\{context\.taskId\}:\$\{context\.diagnosticChallenge\}\] unified runner crashed at \$\{context\.stage\} code \$\{crashCode\}/);

  const layerRunner = await readFile(path.join(projectRoot, "scripts", "run-test-layer.mjs"), "utf8");
  const coverageRunner = await readFile(path.join(projectRoot, "scripts", "run-coverage.mjs"), "utf8");
  const gateSelfTest = await readFile(path.join(projectRoot, "scripts", "test-gate-selftest.mjs"), "utf8");
  const gov04SelfTest = await readFile(path.join(projectRoot, "scripts", "test-gov04-selftest.mjs"), "utf8");
  for (const publisher of [layerRunner, coverageRunner, gateSelfTest, gov04SelfTest]) {
    assert.match(publisher, /const reportTarget = await prepareReportTarget\(args\.report\)/);
    assert.doesNotMatch(publisher, /atomicWriteJson\(args\.report,/);
  }
  assert.equal(layerRunner.match(/atomicWriteJson\(reportTarget,/g)?.length, 3);
  assert.equal(coverageRunner.match(/atomicWriteJson\(reportTarget,/g)?.length, 1);
  assert.equal(gateSelfTest.match(/atomicWriteJson\(reportTarget,/g)?.length, 1);
  assert.equal(gov04SelfTest.match(/atomicWriteJson\(reportTarget,/g)?.length, 1);
  assert.match(coverageRunner, /\.\.\.manifest\.layers\.unit[\s\S]*\.\.\.manifest\.layers\.contract[\s\S]*\.\.\.manifest\.layers\.integration/);
  assert.match(coverageRunner, /scope\.additionalTestsByTask\[manifest\.taskId\]/);
  assert.match(coverageRunner, /\.map\(entry => entry\.exactCasePath\)/);
  assert.match(coverageRunner, /coverage test registry contains duplicate or case-alias paths/);
  const testHelpers = await readFile(path.join(projectRoot, "tests", "helpers.mjs"), "utf8");
  assert.match(testHelpers, /additional coverage test hash differs/);
  assert.match(testHelpers, /record\.owner, entry\.sourceTask/);
});

test("GitHub Actions are immutable, read-only and never use pull_request_target", async () => {
  for (const relative of workflowPaths) {
    const text = await readFile(path.join(projectRoot, ...relative.split("/")), "utf8");
    assert(!text.includes("pull_request_target"));
    assert.match(text, /permissions:\s*\n\s+contents: read/);
    assert(!/contents:\s*write/.test(text));
    const uses = [...text.matchAll(/^\s*uses:\s*([^\s]+)$/gm)].map((match) => match[1]);
    assert(uses.length >= 3);
    for (const identity of uses) assert.match(identity, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
    assert(!/@v\d+(?:\s|$)/m.test(text));
    assert.match(text, /fetch-depth: 0/);
    assert.match(text, /persist-credentials: false/);
    assert.match(text, /run: npm ci --no-audit --no-fund/);
    assert.match(text, /run: npm run models:bootstrap/);
    assert.match(text, /run: \.\\scripts\\gov04\\ensure-native-toolchain\.ps1/);
    assert.match(text, /if-no-files-found: error/);
  }
});

test("merge and trusted artifact retention/trust domains stay separated", async () => {
  const merge = await readFile(path.join(projectRoot, ".github", "workflows", "gov-04-merge.yml"), "utf8");
  const release = await readFile(path.join(projectRoot, ".github", "workflows", "gov-04-trusted-release.yml"), "utf8");
  assert.match(merge, /UNSIGNED-UNTRUSTED-DO-NOT-DISTRIBUTE/);
  assert.match(merge, /retention-days: 7/);
  assert(!merge.includes("environment: mini-lux-trusted-release"));
  assert.match(release, /environment: mini-lux-trusted-release/);
  assert.match(release, /RAINYDAYS_TRUSTED_ENVIRONMENT: mini-lux-trusted-release/);
  assert.match(release, /cancel-in-progress: false/);
  assert.match(release, /retention-days: 90/);
  assert(!release.includes("pull_request:"));
});

test("trusted signer and hosted repository policies remain explicitly unconfigured", async () => {
  const signers = JSON.parse(await readFile(path.join(projectRoot, "parity", "policies", "gov-04-signer-allowlist.json"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(projectRoot, "parity", "policies", "gov-04-policy.json"), "utf8"));
  assert.equal(signers.state, "unconfigured");
  assert.deepEqual(signers.allowedSigners, []);
  assert.equal(policy.trustedRelease.state, "unconfigured");
  assert.equal(policy.trustedRelease.repository, null);
  assert.equal(policy.trustedRelease.provider, "github-actions");
  assert.equal(policy.trustedRelease.requireProtectedRef, true);
});
