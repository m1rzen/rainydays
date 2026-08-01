import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { evaluateCoverageSummary, meetsPercent } from "./coverage-lib.mjs";
import {
  selfTestScenarioContract,
  validateCoverageReport,
  validatePackagedDetails,
  validateSelfTestReport,
  validateUnifiedReport,
} from "./report-schema.mjs";
import {
  expectedInstallerName,
  fileSha256,
  verifyInstallerPreflight,
} from "./package-artifact-lib.mjs";
import {
  atomicWriteJson,
  formalArtifactSnapshot,
  hashTree,
  loadCoverageScope,
  loadTaskManifest,
  makeTempDir,
  prepareReportTarget,
  projectRoot,
  removeFixture,
  runProcess,
  sameSnapshot,
  sha256File,
} from "../tests/helpers.mjs";

function parseArgs(argv) {
  const result = { task: "GOV-03", report: path.join(projectRoot, "test-results", "gate-selftest.json") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--task") result.task = argv[++index] ?? "";
    else if (argv[index] === "--report") result.report = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  assert.match(result.task, /^[A-Z]+-\d{2}$/);
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readChildReport(reportPath, child) {
  try {
    return JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`child report unavailable (${child.code}/${child.signal ?? "no-signal"}): ${reportPath}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`, { cause: error });
  }
}

function summaryEntry(linesCovered, linesTotal, branchesCovered, branchesTotal) {
  return {
    lines: { covered: linesCovered, total: linesTotal },
    branches: { covered: branchesCovered, total: branchesTotal },
  };
}

async function expectPreflightCode(input, expectedCode) {
  try {
    await verifyInstallerPreflight(input);
    return { passed: false, actual: "accepted" };
  } catch (error) {
    return { passed: error?.code === expectedCode, actual: error?.code ?? error?.name ?? "unknown" };
  }
}

async function runCoverageMechanismProof(root) {
  const fixture = path.join(root, "coverage-mechanism");
  await mkdir(fixture, { recursive: true });
  await writeFile(path.join(fixture, "imported.mjs"), "export function covered(value) { return value ? 'yes' : 'no'; }\n");
  await writeFile(path.join(fixture, "child-only.mjs"), "export function childOnly(value) { return value > 0 ? 'positive' : 'other'; }\n");
  await writeFile(path.join(fixture, "never-imported.mjs"), "export function never(value) { return value ? 'never' : 'still-never'; }\n");
  await writeFile(path.join(fixture, "child-runner.mjs"), "import { childOnly } from './child-only.mjs'; if (childOnly(1) !== 'positive') process.exitCode = 2;\n");
  await writeFile(path.join(fixture, "seed-stale.mjs"), "import { never } from './never-imported.mjs'; never(true); never(false);\n");
  await writeFile(path.join(fixture, "coverage.test.mjs"), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { covered } from './imported.mjs';
test('parent and child execution', () => {
  assert.equal(covered(true), 'yes');
  const savedCoverage = process.env.NODE_V8_COVERAGE;
  if (process.env.DROP_CHILD_COVERAGE === '1') delete process.env.NODE_V8_COVERAGE;
  const child = spawnSync(process.execPath, ['child-runner.mjs'], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8' });
  if (savedCoverage !== undefined) process.env.NODE_V8_COVERAGE = savedCoverage;
  assert.equal(child.status, 0, child.stderr);
});
`);
  const c8 = path.join(projectRoot, "node_modules", "c8", "bin", "c8.js");
  const seedRaw = path.join(fixture, "valid-stale-seed");
  await mkdir(seedRaw, { recursive: true });
  const seed = await runProcess(process.execPath, ["seed-stale.mjs"], {
    cwd: fixture,
    env: { ...process.env, NODE_V8_COVERAGE: seedRaw },
    timeoutMs: 30_000,
  });
  assert.equal(seed.code, 0, seed.stderr);
  const staleFiles = await readdir(seedRaw);
  assert(staleFiles.length > 0, "valid stale V8 coverage was not generated");

  async function execute(name, dropChildCoverage, preseed) {
    const reports = path.join(fixture, `${name}-reports`);
    const raw = path.join(fixture, `${name}-raw`);
    await mkdir(raw, { recursive: true });
    if (preseed) {
      for (const file of staleFiles) await cp(path.join(seedRaw, file), path.join(raw, `stale-${file}`));
    }
    const result = await runProcess(process.execPath, [
      c8,
      "--all",
      "--clean=true",
      "--src=.",
      "--include=imported.mjs",
      "--include=child-only.mjs",
      "--include=never-imported.mjs",
      "--reporter=json-summary",
      `--reports-dir=${reports}`,
      `--temp-directory=${raw}`,
      process.execPath,
      "--test",
      "coverage.test.mjs",
    ], {
      cwd: fixture,
      env: { ...process.env, DROP_CHILD_COVERAGE: dropChildCoverage ? "1" : "0" },
      timeoutMs: 60_000,
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(await readFile(path.join(reports, "coverage-summary.json"), "utf8"));
  }

  const inherited = await execute("inherited", false, true);
  const dropped = await execute("dropped", true, false);
  const find = (summary, basename) => Object.entries(summary).find(([key]) => key !== "total" && path.basename(key) === basename)?.[1];
  const inheritedChild = find(inherited, "child-only.mjs");
  const droppedChild = find(dropped, "child-only.mjs");
  const neverImported = find(inherited, "never-imported.mjs");
  assert(inheritedChild?.lines.covered > 0, "child process coverage did not merge");
  assert.equal(droppedChild?.lines.covered, 0, "child coverage survived deliberate NODE_V8_COVERAGE removal");
  assert.equal(neverImported?.lines.covered, 0, "valid stale coverage raised a --all zero-hit file");
  return {
    passed: true,
    validStaleRawFiles: staleFiles.length,
    childMergedCoveredLines: inheritedChild.lines.covered,
    childWithoutInheritanceCoveredLines: droppedChild.lines.covered,
    zeroHitCoveredLines: neverImported.lines.covered,
    seedDirectory: seedRaw,
  };
}

async function createGateSandbox(root, name, mode) {
  const sandbox = path.join(root, name);
  for (const directory of [
    "scripts", "tests/fixtures", "tests/manifests", "tests/unit", "tests/contract", "tests/integration", "tests/electron", "tests/packaged",
    "dist", "electron", "parity/baselines", "parity/scripts", "src", "public", "test-results",
  ]) await mkdir(path.join(sandbox, ...directory.split("/")), { recursive: true });
  await cp(path.join(projectRoot, "scripts"), path.join(sandbox, "scripts"), { recursive: true });
  await cp(path.join(projectRoot, "tests", "helpers.mjs"), path.join(sandbox, "tests", "helpers.mjs"));
  await cp(path.join(projectRoot, "tests", "sec03-receipts.mjs"), path.join(sandbox, "tests", "sec03-receipts.mjs"));
  await cp(path.join(projectRoot, "parity", "scripts"), path.join(sandbox, "parity", "scripts"), { recursive: true });
  await cp(path.join(projectRoot, "parity", "baselines", "lux-desktop-0.1.898.json"), path.join(sandbox, "parity", "baselines", "lux-desktop-0.1.898.json"));
  for (const file of ["build-info.json", "dist-integrity.json", "package.json"]) await cp(path.join(projectRoot, file), path.join(sandbox, file));
  await symlink(path.join(projectRoot, "node_modules"), path.join(sandbox, "node_modules"), "junction");
  await writeFile(path.join(sandbox, "electron", "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(sandbox, "dist", "proof.js"), "export function proof(value) { return value ? 1 : 0; }\n");

  const passTest = "import test from 'node:test'; test('pass', () => {});\n";
  const unitTest = mode === "assertion"
    ? "import assert from 'node:assert/strict'; import test from 'node:test'; test('intentional assertion failure',()=>assert.equal(1,2));\n"
    : passTest;
  await writeFile(path.join(sandbox, "tests", "unit", "proof.test.mjs"), unitTest);
  if (mode === "corrupt-contract") {
    await cp(path.join(projectRoot, "tests", "contract", "lux-baseline.test.mjs"), path.join(sandbox, "tests", "contract", "proof.test.mjs"));
    const baselinePath = path.join(sandbox, "parity", "baselines", "lux-desktop-0.1.898.json");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.debuggerFault = true;
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2));
  } else {
    await writeFile(path.join(sandbox, "tests", "contract", "proof.test.mjs"), "import assert from 'node:assert/strict'; import test from 'node:test'; import {proof} from '../../dist/proof.js'; test('cover proof',()=>{assert.equal(proof(true),1);assert.equal(proof(false),0)});\n");
  }
  let integrationTest = passTest;
  if (mode === "coverage-child-failure") integrationTest = "import assert from 'node:assert/strict'; import test from 'node:test'; import {proof} from '../../dist/proof.js'; test('covered child failure',()=>{proof(true);proof(false);assert.fail('intentional covered child failure')});\n";
  if (mode === "coverage-artifact-mutation") integrationTest = "import assert from 'node:assert/strict'; import {appendFile} from 'node:fs/promises'; import test from 'node:test'; import {proof} from '../../dist/proof.js'; test('covered artifact mutation',async()=>{assert.equal(proof(true),1);assert.equal(proof(false),0);await appendFile('build-info.json','\\n')});\n";
  if (mode === "coverage-package-manifest-mutation") integrationTest = "import assert from 'node:assert/strict'; import {writeFile} from 'node:fs/promises'; import test from 'node:test'; import {proof} from '../../dist/proof.js'; test('package manifest mutation',async()=>{assert.equal(proof(true),1);assert.equal(proof(false),0);await writeFile('test-results/package-artifact.json','{}\\n')});\n";
  if (mode === "coverage-timeout") integrationTest = "import test from 'node:test'; test('intentional coverage timeout',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));\n";
  await writeFile(path.join(sandbox, "tests", "integration", "proof.test.mjs"), integrationTest);
  await writeFile(path.join(sandbox, "tests", "electron", "proof.test.mjs"), passTest);
  await writeFile(path.join(sandbox, "tests", "packaged", "proof.test.mjs"), passTest);

  const manifest = {
    schemaVersion: 1,
    taskId: "SEC-01",
    baseline: { product: "Lux Desktop", version: "0.1.898", manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df" },
    personaChain: ["architect", "sentinel", "developer", "debugger", "reviewer"],
    changedRuntimeFiles: [],
    coverageExemptions: {},
    layers: {
      unit: ["tests/unit/proof.test.mjs"],
      contract: ["tests/contract/proof.test.mjs"],
      integration: ["tests/integration/proof.test.mjs"],
      electron: ["tests/electron/proof.test.mjs"],
      packaged: ["tests/packaged/proof.test.mjs"],
    },
  };
  await writeFile(path.join(sandbox, "tests", "manifests", "sec-01.json"), JSON.stringify(manifest, null, 2));
  const scope = {
    schemaVersion: 3,
    additionalTestsByTask: {},
    overall: ["dist/proof.js"],
    securityCritical: ["dist/proof.js"],
    thresholds: { overallLines: 80, securityBranches: 90 },
    perFileLineMinimum: { "dist/proof.js": 80 },
  };
  await writeFile(path.join(sandbox, "tests", "coverage-scope.json"), JSON.stringify(scope, null, 2));
  return sandbox;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportTarget = await prepareReportTarget(args.report);
  const { manifest: taskManifest } = await loadTaskManifest(args.task);
  const startedAt = new Date();
  const started = Date.now();
  const before = await formalArtifactSnapshot();
  const baselinePath = path.join(projectRoot, "parity", "baselines", "lux-desktop-0.1.898.json");
  const baselineHashBefore = await sha256File(baselinePath);
  const fixture = await makeTempDir("mini-lux-gov03-selftest-");
  const scenarios = [];
  let cleanupPassed = false;
  const record = (name, expected, actual, passed, details = null) => {
    scenarios.push({ name, expected, actual, passed, details });
  };

  try {
    const formalBuildPath = path.join(projectRoot, "build-info.json");
    const formalBuildHash = await sha256File(formalBuildPath);
    let reportPathRejected = false;
    try { await atomicWriteJson(formalBuildPath, { state: "passed" }); }
    catch { reportPathRejected = true; }
    const formalBuildUnchanged = await sha256File(formalBuildPath) === formalBuildHash;
    record(
      "formal artifact report destination rejected",
      "path rejected before write",
      reportPathRejected && formalBuildUnchanged ? "rejected unchanged" : "unsafe",
      reportPathRejected && formalBuildUnchanged,
      { formalBuildUnchanged }
    );

    const assertionSandbox = await createGateSandbox(fixture, "assertion-sandbox", "assertion");
    const assertionReportPath = path.join(assertionSandbox, "test-results", "assertion-layer.json");
    const assertion = await runProcess(process.execPath, [
      path.join(assertionSandbox, "scripts", "run-test-layer.mjs"), "--task", "SEC-01", "--layer", "unit", "--report", assertionReportPath,
    ], { cwd: assertionSandbox, timeoutMs: 60_000 });
    const assertionReport = await readChildReport(assertionReportPath, assertion);
    record(
      "intentional assertion failure through layer runner",
      "TEST_ASSERTION/non-zero",
      `${assertionReport.failureClass}/${assertion.code === 0 ? "zero" : "non-zero"}`,
      assertion.code !== 0 && assertionReport.failureClass === "TEST_ASSERTION" && assertionReport.state === "failed"
    );

    const contractSandbox = await createGateSandbox(fixture, "contract-sandbox", "corrupt-contract");
    const corruptBaseline = path.join(contractSandbox, "parity", "baselines", "lux-desktop-0.1.898.json");
    const corruptHashBefore = await sha256File(corruptBaseline);
    const contractReportPath = path.join(contractSandbox, "test-results", "contract-layer.json");
    const contract = await runProcess(process.execPath, [
      path.join(contractSandbox, "scripts", "run-test-layer.mjs"), "--task", "SEC-01", "--layer", "contract", "--report", contractReportPath,
    ], { cwd: contractSandbox, timeoutMs: 90_000 });
    const contractReport = await readChildReport(contractReportPath, contract);
    const corruptUnchanged = await sha256File(corruptBaseline) === corruptHashBefore;
    record(
      "corrupt contract through layer runner",
      "TEST_ASSERTION/non-zero and fixture unchanged",
      `${contractReport.failureClass}/${contract.code === 0 ? "zero" : "non-zero"}`,
      contract.code !== 0 && contractReport.failureClass === "TEST_ASSERTION" && corruptUnchanged,
      { fixtureUnchanged: corruptUnchanged }
    );

    const { seedDirectory, ...coverageMechanism } = await runCoverageMechanismProof(fixture);
    record("coverage all child merge and valid stale isolation", "all proofs true", "all proofs true", coverageMechanism.passed, coverageMechanism);

    const arithmeticScope = {
      overall: ["dist/a.js"],
      securityCritical: ["dist/a.js"],
      thresholds: { overallLines: 80, securityBranches: 90 },
      perFileLineMinimum: {},
    };
    const exact89 = evaluateCoverageSummary({ [path.join(projectRoot, "dist", "a.js")]: summaryEntry(8, 10, 899, 1000) }, arithmeticScope, projectRoot);
    const exact90 = evaluateCoverageSummary({ [path.join(projectRoot, "dist", "a.js")]: summaryEntry(8, 10, 9, 10) }, arithmeticScope, projectRoot);
    const zero = evaluateCoverageSummary({ [path.join(projectRoot, "dist", "a.js")]: summaryEntry(8, 10, 0, 0) }, arithmeticScope, projectRoot);
    let remapRejected = false;
    try {
      evaluateCoverageSummary({
        [path.join(projectRoot, "dist", "a.js")]: summaryEntry(8, 10, 9, 10),
        [path.join(projectRoot, "DIST", "A.JS")]: summaryEntry(8, 10, 9, 10),
      }, arithmeticScope, projectRoot);
    } catch { remapRejected = true; }
    const exactArithmeticPassed = !exact89.passed && exact90.passed && !zero.passed && remapRejected
      && !meetsPercent(899, 1000, 90) && meetsPercent(9, 10, 90);
    record("integer threshold and malformed denominator proof", "89.9 fails; 90 passes; zero/remap fail", exactArithmeticPassed ? "matched" : "mismatch", exactArithmeticPassed);

    let truncatedRejected = false;
    try { JSON.parse("{truncated"); } catch { truncatedRejected = true; }
    const missingCoverage = evaluateCoverageSummary({}, arithmeticScope, projectRoot);
    const malformedCoveragePassed = truncatedRejected && !missingCoverage.passed && missingCoverage.missingFiles.includes("dist/a.js");
    record("truncated and missing coverage report", "both rejected", malformedCoveragePassed ? "both rejected" : "accepted", malformedCoveragePassed);

    const { scope } = await loadCoverageScope();
    const forcedScope = {
      ...scope,
      additionalTestsByTask: {},
      overall: [...scope.overall, "scripts/write-package-artifact.mjs"],
      thresholds: { overallLines: 100, securityBranches: 100 },
      perFileLineMinimum: { ...scope.perFileLineMinimum, "scripts/write-package-artifact.mjs": 100 },
    };
    const forcedScopePath = path.join(fixture, "forced-coverage-scope.json");
    const forcedReportPath = path.join(fixture, "forced-coverage-report.json");
    await writeFile(forcedScopePath, JSON.stringify(forcedScope, null, 2));
    const preservedBefore = await hashTree(path.join(projectRoot, "test-results", "coverage"));
    const forcedCoverage = await runProcess(process.execPath, [
      "scripts/run-coverage.mjs", "--task", args.task, "--scope", forcedScopePath,
      "--seed-stale-coverage", seedDirectory, "--no-preserve-output", "--report", forcedReportPath,
    ], { timeoutMs: 660_000 });
    const forcedReport = await readChildReport(forcedReportPath, forcedCoverage);
    const preservedAfter = await hashTree(path.join(projectRoot, "test-results", "coverage"));
    record(
      "forced coverage threshold zero-hit and preserved-output isolation",
      "COVERAGE_THRESHOLD/non-zero without preserved mutation",
      `${forcedReport.failureClass}/${forcedCoverage.code === 0 ? "zero" : "non-zero"}`,
      forcedCoverage.code !== 0 && forcedReport.failureClass === "COVERAGE_THRESHOLD"
        && forcedReport.evaluation.zeroHitFiles.includes("scripts/write-package-artifact.mjs")
        && forcedReport.staleSeedFiles === coverageMechanism.validStaleRawFiles
        && forcedReport.testExitCode === 0 && !forcedReport.preservedOutput && preservedBefore === preservedAfter,
      { zeroHitFiles: forcedReport.evaluation.zeroHitFiles, staleSeedFiles: forcedReport.staleSeedFiles, preservedOutputUnchanged: preservedBefore === preservedAfter }
    );

    const forgedCoverage = structuredClone(forcedReport);
    forgedCoverage.evaluation.overallLines.covered = 0;
    forgedCoverage.evaluation.overallLines.passed = true;
    let forgedCoverageRejected = false;
    try { validateCoverageReport(forgedCoverage, { taskId: args.task, coverageScope: forcedScope }); }
    catch { forgedCoverageRejected = true; }
    record("forged coverage counters rejected", "semantic schema rejection", forgedCoverageRejected ? "rejected" : "accepted", forgedCoverageRejected);

    const emptyUnified = {
      reportVersion: 1,
      taskId: args.task,
      profile: "full",
      state: "passed",
      baseline: { product: "Lux Desktop", version: "0.1.898", manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df" },
      personaChain: taskManifest.personaChain,
      build: { appVersion: "0.1.0", buildId: "synthetic", sourceDigest: "0".repeat(64) },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      expected: [], actual: [], results: [], cleanupPassed: true,
      artifactSnapshot: { before, after: before, unchanged: true },
      metrics: { toolCalls: 0, llmCalls: 0, tokens: 0, runnerMaxRssBytes: 0 },
      knownLimitations: [], reviewerVerdict: null, userStatus: "not-reviewed",
    };
    let emptyUnifiedRejected = false;
    try { validateUnifiedReport(emptyUnified, { taskId: args.task }); }
    catch { emptyUnifiedRejected = true; }
    record("empty full unified report rejected", "fixed profile rejection", emptyUnifiedRejected ? "rejected" : "accepted", emptyUnifiedRejected);

    const contradictoryPackaged = {
      phase: "complete",
      artifactExecution: { sourceBytes: 4, sourceSha256: "0".repeat(64), executedBytes: 4, executedSha256: "0".repeat(64), identityMatched: true },
      installerExitCode: 0, installerSignal: null, installerClassification: "passed", installerConverged: true,
      uninstallerSignal: null, uninstallerConverged: true,
      cleanup: {
        attemptedOfficialUninstall: true, officialUninstallExitCode: 0, installDirectoryEmpty: true,
        registryObserved: true, registryMatchesBaseline: true, shortcutObserved: true, shortcutMatchesBaseline: true,
        processesStopped: true, executionCopyReleased: true, fixtureRemoved: true, passed: false,
      },
    };
    let contradictoryPackagedRejected = false;
    try { validatePackagedDetails(contradictoryPackaged, { passed: true }); }
    catch { contradictoryPackagedRejected = true; }
    record("contradictory packaged success rejected", "semantic schema rejection", contradictoryPackagedRejected ? "rejected" : "accepted", contradictoryPackagedRejected);

    const failingCoverageSandbox = await createGateSandbox(fixture, "coverage-child-sandbox", "coverage-child-failure");
    const failingCoverageReportPath = path.join(failingCoverageSandbox, "test-results", "coverage-child-failure.json");
    const failingCoverage = await runProcess(process.execPath, [
      path.join(failingCoverageSandbox, "scripts", "run-coverage.mjs"), "--task", "SEC-01", "--no-preserve-output", "--report", failingCoverageReportPath,
    ], { cwd: failingCoverageSandbox, timeoutMs: 120_000 });
    const failingCoverageReport = await readChildReport(failingCoverageReportPath, failingCoverage);
    record(
      "passing ratio cannot mask failing coverage child",
      "COVERAGE_TEST_FAILURE with passing evaluation",
      `${failingCoverageReport.failureClass}/${failingCoverageReport.evaluation?.passed}`,
      failingCoverage.code !== 0 && failingCoverageReport.failureClass === "COVERAGE_TEST_FAILURE" && failingCoverageReport.evaluation?.passed === true
    );

    const mutationSandbox = await createGateSandbox(fixture, "coverage-mutation-sandbox", "coverage-artifact-mutation");
    const mutationReportPath = path.join(mutationSandbox, "test-results", "coverage-artifact-mutation.json");
    const mutationCoverage = await runProcess(process.execPath, [
      path.join(mutationSandbox, "scripts", "run-coverage.mjs"), "--task", "SEC-01", "--no-preserve-output", "--report", mutationReportPath,
    ], { cwd: mutationSandbox, timeoutMs: 120_000 });
    const mutationReport = await readChildReport(mutationReportPath, mutationCoverage);
    record(
      "passing ratio cannot mask formal artifact mutation",
      "ARTIFACT_MUTATION with passing evaluation",
      `${mutationReport.failureClass}/${mutationReport.evaluation?.passed}`,
      mutationCoverage.code !== 0 && mutationReport.failureClass === "ARTIFACT_MUTATION"
        && mutationReport.evaluation?.passed === true && mutationReport.artifactSnapshot.unchanged === false
    );

    const manifestMutationSandbox = await createGateSandbox(fixture, "coverage-package-manifest-mutation-sandbox", "coverage-package-manifest-mutation");
    const manifestMutationReportPath = path.join(manifestMutationSandbox, "test-results", "coverage-package-manifest-mutation.json");
    const manifestMutationCoverage = await runProcess(process.execPath, [
      path.join(manifestMutationSandbox, "scripts", "run-coverage.mjs"), "--task", "SEC-01", "--no-preserve-output", "--report", manifestMutationReportPath,
    ], { cwd: manifestMutationSandbox, timeoutMs: 120_000 });
    const manifestMutationReport = await readChildReport(manifestMutationReportPath, manifestMutationCoverage);
    record(
      "package manifest mutation is a formal artifact mutation",
      "ARTIFACT_MUTATION with package manifest changed",
      `${manifestMutationReport.failureClass}/${manifestMutationReport.artifactSnapshot.before.packageArtifactManifest === manifestMutationReport.artifactSnapshot.after.packageArtifactManifest ? "unchanged" : "changed"}`,
      manifestMutationCoverage.code !== 0 && manifestMutationReport.failureClass === "ARTIFACT_MUTATION"
        && manifestMutationReport.artifactSnapshot.before.packageArtifactManifest === null
        && /^[a-f0-9]{64}$/.test(manifestMutationReport.artifactSnapshot.after.packageArtifactManifest)
    );

    const timeoutSandbox = await createGateSandbox(fixture, "coverage-timeout-sandbox", "coverage-timeout");
    const timeoutReportPath = path.join(timeoutSandbox, "test-results", "coverage-timeout.json");
    const timeoutCoverage = await runProcess(process.execPath, [
      path.join(timeoutSandbox, "scripts", "run-coverage.mjs"), "--task", "SEC-01", "--timeout-ms", "1000",
      "--no-preserve-output", "--report", timeoutReportPath,
    ], { cwd: timeoutSandbox, timeoutMs: 30_000 });
    const timeoutReport = await readChildReport(timeoutReportPath, timeoutCoverage);
    const forgedTimeoutCleanup = structuredClone(timeoutReport);
    forgedTimeoutCleanup.timeoutTermination.exitCode = 1;
    forgedTimeoutCleanup.timeoutTermination.childExited = false;
    let forgedTimeoutCleanupRejected = false;
    try { validateCoverageReport(forgedTimeoutCleanup, { taskId: args.task }); }
    catch { forgedTimeoutCleanupRejected = true; }
    record(
      "coverage timeout publishes authoritative failure report",
      "TIMEOUT/timed-out/non-zero",
      `${timeoutReport.failureClass}/${timeoutReport.state}/${timeoutCoverage.code === 0 ? "zero" : "non-zero"}`,
      timeoutCoverage.code !== 0 && timeoutReport.failureClass === "TIMEOUT"
        && timeoutReport.state === "timed-out" && timeoutReport.testTimedOut === true
        && timeoutReport.timeoutTermination?.exitCode === 0 && timeoutReport.timeoutTermination?.childExited === true
        && forgedTimeoutCleanupRejected,
      { forgedCleanupFailureRejected: forgedTimeoutCleanupRejected }
    );

    const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
    const fakeProject = path.join(fixture, "package-preflight");
    const release = path.join(fakeProject, "release");
    await mkdir(release, { recursive: true });
    await cp(path.join(projectRoot, "build-info.json"), path.join(fakeProject, "build-info.json"));
    const filename = expectedInstallerName(buildInfo);
    const manifestPath = path.join(fakeProject, "artifact.json");
    const expectedBytes = Buffer.from("GOOD");
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      build: {
        appVersion: buildInfo.appVersion,
        buildId: buildInfo.buildId,
        sourceDigest: buildInfo.sourceDigest,
        buildInfoSha256: await fileSha256(path.join(fakeProject, "build-info.json")),
        executionIsolation: buildInfo.versions.executionIsolation,
      },
      artifact: { filename, bytes: expectedBytes.length, sha256: sha256(expectedBytes) },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const baseInput = { manifestPath, buildInfo, projectRoot: fakeProject };
    const missing = await expectPreflightCode(baseInput, "INSTALLER_MISSING");
    record("missing installer preflight", "INSTALLER_MISSING", missing.actual, missing.passed);
    const wrongNamePath = path.join(fakeProject, "wrong-name.exe");
    await writeFile(wrongNamePath, expectedBytes);
    const wrongName = await expectPreflightCode({ ...baseInput, installerOverride: wrongNamePath }, "INSTALLER_NAME_MISMATCH");
    record("wrong installer basename preflight", "INSTALLER_NAME_MISMATCH", wrongName.actual, wrongName.passed);
    const exactInstaller = path.join(release, filename);
    await writeFile(exactInstaller, Buffer.from("EVIL"));
    const wrongHash = await expectPreflightCode(baseInput, "INSTALLER_HASH_MISMATCH");
    record("wrong installer hash preflight", "INSTALLER_HASH_MISMATCH", wrongHash.actual, wrongHash.passed);
  } finally {
    await removeFixture(fixture);
    cleanupPassed = true;
  }

  const after = await formalArtifactSnapshot();
  const artifactsUnchanged = sameSnapshot(before, after);
  const baselineUnchanged = await sha256File(baselinePath) === baselineHashBefore;
  const passed = scenarios.length === selfTestScenarioContract.length && scenarios.every((entry) => entry.passed)
    && cleanupPassed && artifactsUnchanged && baselineUnchanged;
  const report = {
    reportVersion: 1,
    taskId: args.task,
    state: passed ? "passed" : "failed",
    failureClass: passed ? null : "SELF_TEST_PROOF_FAILED",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    scenarios,
    cleanupPassed,
    baselineUnchanged,
    artifactSnapshot: { before, after, unchanged: artifactsUnchanged },
    maxRssBytes: process.memoryUsage().rss,
  };
  validateSelfTestReport(report, { taskId: args.task });
  await atomicWriteJson(reportTarget, report);
  console.log(`[${args.task}] self-test: ${report.state} (${report.durationMs} ms)`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
