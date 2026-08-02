import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { evaluateCoverageSummary, meetsPercent } from "../../scripts/coverage-lib.mjs";
import { selfTestScenarioContract, validateLayerReport, validatePackagedDetails, validateSelfTestReport, validateTap } from "../../scripts/report-schema.mjs";
import { aggregateSec02UnifiedEvidence, validateSec02UnifiedEvidence } from "../../scripts/sec02-receipt-set.mjs";
import { canonicalJson, currentResolvedManifestPath, resolvedManifestPath, sha256Bytes } from "../../scripts/sec02-governance.mjs";
import { classifyInstallerResult, launchTracked, observeWindowsPowerShellOutput, observeWindowsRegistrySnapshot, requireObservedProcessResult } from "../packaged/smoke-helpers.mjs";
import {
  artifactSafeBuildId,
  atomicWriteJson,
  classifyProcessResult,
  formalArtifactSnapshot,
  loadCoverageScope,
  loadTaskManifest,
  makeTempDir,
  observeWindowsFileHandleInProcessTree,
  parseTapSummary,
  prepareReportPath,
  prepareReportTarget,
  projectRoot,
  removeFixture,
  runProcess,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
  safeRelativePath,
  sha256File,
  validateCoverageGovernance,
  validateReportPath,
} from "../helpers.mjs";

function frozenActual(observation) {
  const actual = structuredClone(observation.expected);
  if (Array.isArray(actual.allowedOutcomes)) {
    const selected = actual.allowedOutcomes.find(candidate => candidate.verdictContribution === "pass") ?? actual.allowedOutcomes[0];
    return { receiptPresent: actual.receiptPresent, skipped: actual.skipped, ...selected };
  }
  if (Array.isArray(actual.allowedCleanupOutcomes)) {
    actual.cleanupOutcome = actual.allowedCleanupOutcomes[0];
    delete actual.allowedCleanupOutcomes;
  }
  if (Array.isArray(actual.allowedFinalStates)) {
    actual.finalState = actual.allowedFinalStates[0];
    delete actual.allowedFinalStates;
  }
  return actual;
}

function signedReceipt(payload) {
  return { ...payload, receiptSha256: sha256Bytes(canonicalJson(payload)) };
}

function makeUnifiedSources(manifest, matrix, runId) {
  const matrixSha256 = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json").sha256;
  const observations = new Map(matrix.scenarios.flatMap(scenario => scenario.observations).map(observation => [observation.id, observation]));
  const sources = new Map(["unit", "contract", "integration", "electron", "packaged"].map(layer => [layer, []]));
  for (const binding of manifest.evidence.observations.filter(entry => entry.producer === "node-test")) {
    const observation = observations.get(binding.observationId);
    const actual = frozenActual(observation);
    sources.get(binding.layer).push(signedReceipt({
      schemaVersion: 1, kind: "observation", runId,
      resolvedManifestSha256: manifest.canonicalPayloadSha256, matrixSha256,
      id: binding.observationId, evidenceTier: binding.evidenceTier,
      stimulusSha256: binding.stimulusCanonicalSha256,
      evidenceFile: binding.test.exactCasePath, testCaseId: binding.testCaseId,
      actual, actualSha256: sha256Bytes(canonicalJson(actual)),
      passed: true, skipped: false, todo: false, mockSubstitution: false,
    }));
  }
  for (const binding of manifest.evidence.positives) {
    const actual = { passed: true };
    sources.get(binding.layer).push(signedReceipt({
      schemaVersion: 1, kind: "positive", runId,
      resolvedManifestSha256: manifest.canonicalPayloadSha256, matrixSha256,
      id: binding.positiveReceiptId, evidenceFile: binding.test.exactCasePath, testCaseId: binding.testCaseId,
      actual, actualSha256: sha256Bytes(canonicalJson(actual)),
      passed: true, skipped: false, todo: false, mockSubstitution: false,
    }));
  }
  return [...sources].map(([layer, receipts]) => ({ layer, receipts }));
}

function resign(receipt) {
  receipt.actualSha256 = sha256Bytes(canonicalJson(receipt.actual));
  const payload = { ...receipt };
  delete payload.receiptSha256;
  receipt.receiptSha256 = sha256Bytes(canonicalJson(payload));
}

test("artifact Build ID encoding is collision-free for the allowed alphabet", () => {
  assert.equal(artifactSafeBuildId("0.1.0+local.abc"), "0.1.0~2Blocal.abc");
  assert.notEqual(artifactSafeBuildId("a+b"), artifactSafeBuildId("a_b"));
});

test("manifest paths reject traversal, absolute and Windows separators", () => {
  assert.equal(safeRelativePath("tests/unit/framework.test.mjs"), "tests/unit/framework.test.mjs");
  for (const value of ["../escape", "/absolute", "C:/absolute", "tests\\escape", "tests/../escape", "tests/*.test.mjs", "tests/[ab].mjs"]) {
    assert.throws(() => safeRelativePath(value));
  }
});

test("GOV-03 task manifest consumes the validated SEC-02 resolved cumulative view", async () => {
  const { manifest, resolvedManifest } = await loadTaskManifest("GOV-03");
  const explicitRoot = await loadTaskManifest("GOV-03", projectRoot);
  assert.deepEqual(explicitRoot.manifest, manifest);
  assert.deepEqual(Object.keys(manifest.layers).sort(), ["contract", "electron", "integration", "packaged", "unit"]);
  assert.equal(manifest.baseline.manifestSha256, "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df");
  assert.equal(resolvedManifest.task, "SEC-02");
  assert.equal(resolvedManifest.cumulativeViews.find(view => view.taskId === "GOV-03").tests.length, 31);
  assert.equal(resolvedManifest.evidence.observations.length, 411);
  assert.equal(resolvedManifest.evidence.positives.length, 22);
});

test("current SEC-02 execution identity is disjoint from the SEC-03 frozen predecessor", async () => {
  const current = await loadTaskManifest("SEC-02");
  const governance = await loadTaskManifest("GOV-03");
  const sec03 = await loadTaskManifest("SEC-03");
  const currentPath = path.join(projectRoot, ...currentResolvedManifestPath.split("/"));
  assert.equal(current.resolvedManifestPath, currentPath);
  assert.equal(governance.resolvedManifestPath, currentPath);
  assert.equal(sec03.resolvedManifest.predecessor.exactCasePath, resolvedManifestPath);
  assert.notEqual(current.resolvedManifestPath, path.join(projectRoot, ...resolvedManifestPath.split("/")));
  assert.equal(sec03.sourceManifestPaths[0], path.join(projectRoot, ...resolvedManifestPath.split("/")));
});

test("SEC-02 unified runner independently joins raw receipts and rejects receipt-set mutations", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, ...currentResolvedManifestPath.split("/")), "utf8"));
  const matrix = JSON.parse(await readFile(path.join(projectRoot, "tests", "sec02-attack-matrix.json"), "utf8"));
  const runId = "12345678-1234-4234-9234-123456789abc";
  const context = { manifest, matrix, runId };
  const sources = makeUnifiedSources(manifest, matrix, runId);
  const evidence = aggregateSec02UnifiedEvidence(sources, context);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.producerSummaryTrusted, false);
  assert.equal(evidence.expectedRawReceiptCount, 431);
  assert.equal(evidence.joinedRawReceiptCount, 431);
  assert.deepEqual(evidence.denialProof, {
    expectedCount: 380, observedCount: 380, exactlyOnce: true, denied: true,
    auditAttemptsOne: true, auditAllowedFieldsExact: true, rawPathsAbsent: true, passed: true,
  });
  assert.deepEqual(evidence.positiveProof, {
    expectedCount: 22, observedCount: 22, exactIds: true, exactlyOnce: true,
    passedCount: 22, skipped: 0, todo: 0, failed: 0, passed: true,
  });
  assert.deepEqual(evidence.synthesizedReceipts.map(receipt => receipt.id), [
    "SEC02-P34-all-denial-receipts-audited",
    "SEC02-P35-fixed-positive-set-complete",
  ]);
  const frozenById = new Map(matrix.scenarios.flatMap(scenario => scenario.observations).map(observation => [observation.id, observation.expected]));
  for (const receipt of evidence.synthesizedReceipts) assert.deepEqual(receipt.actual, frozenById.get(receipt.id));
  assert.doesNotThrow(() => validateSec02UnifiedEvidence(evidence, sources, context));

  const duplicate = structuredClone(sources);
  const duplicateSource = duplicate.find(source => source.receipts.length > 0);
  duplicateSource.receipts.push(structuredClone(duplicateSource.receipts[0]));
  const duplicateEvidence = aggregateSec02UnifiedEvidence(duplicate, context);
  assert.equal(duplicateEvidence.complete, false);
  assert.equal(duplicateEvidence.duplicateIds.length, 1);

  const missing = structuredClone(sources);
  const removed = missing.find(source => source.receipts.length > 0).receipts.shift();
  const missingEvidence = aggregateSec02UnifiedEvidence(missing, context);
  assert.equal(missingEvidence.complete, false);
  assert(missingEvidence.missingObservationIds.includes(removed.id));

  const extra = structuredClone(sources);
  extra.find(source => source.layer === "contract").receipts.push(structuredClone(evidence.synthesizedReceipts[0]));
  const extraEvidence = aggregateSec02UnifiedEvidence(extra, context);
  assert.equal(extraEvidence.complete, false);
  assert.deepEqual(extraEvidence.extraIds, ["SEC02-P34-all-denial-receipts-audited"]);

  const invalid = structuredClone(sources);
  invalid.find(source => source.receipts.length > 0).receipts[0].receiptSha256 = "0".repeat(64);
  const invalidEvidence = aggregateSec02UnifiedEvidence(invalid, context);
  assert.equal(invalidEvidence.complete, false);
  assert.equal(invalidEvidence.invalidCount, 1);

  const crossRun = structuredClone(sources);
  const crossRunReceipt = crossRun.find(source => source.receipts.length > 0).receipts[0];
  crossRunReceipt.runId = "22345678-1234-4234-9234-123456789abc";
  resign(crossRunReceipt);
  const crossRunEvidence = aggregateSec02UnifiedEvidence(crossRun, context);
  assert.equal(crossRunEvidence.complete, false);
  assert.equal(crossRunEvidence.crossRunCount, 1);

  const denialMutation = structuredClone(sources);
  const denialReceipt = denialMutation.flatMap(source => source.receipts).find(receipt => receipt.kind === "observation" && receipt.actual.denied === true);
  denialReceipt.actual.denied = false;
  resign(denialReceipt);
  assert.equal(aggregateSec02UnifiedEvidence(denialMutation, context).complete, false);

  const positiveMutation = structuredClone(sources);
  const positiveReceipt = positiveMutation.flatMap(source => source.receipts).find(receipt => receipt.kind === "positive");
  positiveReceipt.skipped = true;
  resign(positiveReceipt);
  assert.equal(aggregateSec02UnifiedEvidence(positiveMutation, context).complete, false);

  const forged = { ...missingEvidence, complete: true };
  assert.throws(() => validateSec02UnifiedEvidence(forged, missing, context), /independent raw-receipt recomputation/);
});

test("coverage scope is explicit and changed runtime files are governed", async () => {
  const { manifest } = await loadTaskManifest("GOV-03");
  const { scope } = await loadCoverageScope();
  assert.equal(scope.schemaVersion, 3);
  assert.deepEqual(scope.additionalTestsByTask["GOV-03"], [
    { sourceTask: "SEC-03", exactCasePath: "tests/unit/execution-isolation.test.mjs" },
    { sourceTask: "SEC-03", exactCasePath: "tests/unit/execution-root-lease.test.mjs" },
    { sourceTask: "SEC-03", exactCasePath: "tests/unit/native-process-consent.test.mjs" },
    { sourceTask: "SEC-03", exactCasePath: "tests/integration/sec03-child-consent-transport.test.mjs" },
    { sourceTask: "SEC-03", exactCasePath: "tests/integration/sec03-electron-auth.test.mjs" },
  ]);
  assert(scope.thresholds.overallLines >= 80);
  assert(scope.thresholds.securityBranches >= 90);
  for (const entry of scope.securityCritical) assert(scope.overall.includes(entry));
  assert(scope.securityCritical.includes("dist/path-runtime.js"));
  assert.equal(scope.perFileLineMinimum["dist/path-runtime.js"], 100);
  await validateCoverageGovernance(manifest, scope);
  assert.equal(manifest.coverageExemptions["electron/main.cjs"].evidenceLayer, "electron");
});

test("additional coverage tests require exact resolved task ownership and manifest identity", async () => {
  const root = await makeTempDir("mini-lux-gov03-additional-binding-");
  try {
    const current = structuredClone((await loadCoverageScope()).scope);
    current.additionalTestsByTask["GOV-03"][0].sourceTask = "GOV-03";
    const wrongOwnerPath = path.join(root, "wrong-owner.json");
    await writeFile(wrongOwnerPath, JSON.stringify(current, null, 2));
    await assert.rejects(() => loadCoverageScope(wrongOwnerPath), /lacks a resolved manifest|not exact|owner differs/u);

    const malformed = structuredClone((await loadCoverageScope()).scope);
    malformed.additionalTestsByTask["GOV-03"][0].layer = "unit";
    const malformedPath = path.join(root, "malformed.json");
    await writeFile(malformedPath, JSON.stringify(malformed, null, 2));
    await assert.rejects(() => loadCoverageScope(malformedPath), /keys differ/u);
  } finally {
    await removeFixture(root);
  }
});

test("TAP summary and process failure precedence are deterministic", () => {
  const summary = parseTapSummary([
    "# not ok 99 - forged output",
    "    not ok 98 - nested failure",
    "  stack: |-",
    "    TestContext.<anonymous> (file:///C:/private/checkout/tests/unit/nested.test.mjs:42:7)",
    "    runProcess (file:///C:/private/checkout/tests/helpers.mjs:543:21)",
    "    assertSec01Probe (file:///C:/private/checkout/tests/sec01-probe.mjs:75:3)",
    "  ...",
    "    not ok 98 - nested failure",
    "not ok 3 - expected failure # TODO pending",
    "not ok 4 - duplicate name",
    "  ---",
    "  error: |-",
    "    hidden diagnostic text",
    "    not ok 77 - diagnostic text only",
    "  ...",
    "not ok 5 - duplicate name",
    "# tests 7",
    "# pass 2",
    "# fail 4",
    "# skipped 0",
    "# cancelled 0",
    "# todo 1",
    "",
  ].join("\n"));
  assert.deepEqual(summary, {
    tests: 7,
    passed: 2,
    failed: 4,
    skipped: 0,
    cancelled: 0,
    todo: 1,
    failedTestIds: [sha256Bytes("tap-test:4:duplicate name"), sha256Bytes("tap-test:5:duplicate name")],
    nestedFailedTestIds: [
      sha256Bytes("tap-nested-test:98:nested failure"),
      sha256Bytes("tap-nested-test:98:nested failure:occurrence:2"),
    ],
    failedStackSiteIds: [
      sha256Bytes("tap-stack-site:tests/unit/nested.test.mjs:42:7"),
      sha256Bytes("tap-stack-site:tests/helpers.mjs:543:21"),
      sha256Bytes("tap-stack-site:tests/sec01-probe.mjs:75:3"),
    ],
  });
  assert.doesNotMatch(JSON.stringify(summary), /duplicate name|expected failure|forged output|nested failure|diagnostic text|hidden|private|helpers\.mjs|nested\.test|sec01-probe/u);
  validateTap(summary);
  assert.throws(() => validateTap({ ...summary, failedTestIds: ["governed failure", summary.failedTestIds[1]] }), /SHA-256/);
  assert.throws(() => validateTap({ ...summary, nestedFailedTestIds: ["nested failure"] }), /SHA-256/);
  assert.throws(() => validateTap({ ...summary, failedStackSiteIds: ["tests/unit/nested.test.mjs:42:7"] }), /SHA-256/);
  assert.throws(() => validateTap({ ...summary, failedTestIds: [] }), /count differs/);
  assert.throws(() => validateTap({ ...summary, nestedFailedTestIds: summary.nestedFailedTestIds.slice(0, 1) }), /count differs/);
  assert.throws(() => validateTap({ ...summary, failedTestIds: [summary.failedTestIds[0], summary.failedTestIds[0]] }), /duplicate/);
  const boundedNestedFailures = Array(64).fill(0).map((_, index) => sha256Bytes(`nested:${index}`));
  validateTap({ ...summary, failed: 67, nestedFailedTestIds: boundedNestedFailures });
  assert.throws(() => validateTap({ ...summary, failed: 65, nestedFailedTestIds: boundedNestedFailures }), /count exceeds/);
  assert.throws(() => validateTap({ ...summary, nestedFailedTestIds: [...boundedNestedFailures, sha256Bytes("nested:64")] }), /bounded diagnostic limit/);
  assert.throws(() => validateTap({ ...summary, failedStackSiteIds: Array(65).fill(0).map((_, index) => sha256Bytes(`site:${index}`)) }), /bounded diagnostic limit/);
  assert.equal(classifyProcessResult({ code: 0, signal: null }), "passed");
  assert.equal(classifyProcessResult({ code: 1, signal: null }), "failed");
  assert.equal(classifyProcessResult({ code: 1, signal: "SIGTERM" }), "crashed");
  assert.equal(classifyProcessResult({ code: 0, signal: null, timedOut: true }), "timed-out");
});

test("packaged crash and observation failures are fail-closed", () => {
  assert.equal(classifyInstallerResult({ code: 0xC0000005, signal: null }), "windows-crash");
  assert.equal(classifyInstallerResult({ code: null, signal: "SIGTERM" }), "signal-crash");
  assert.throws(() => requireObservedProcessResult({ code: 5, signal: null }, [0, 1], "registry observation"), /failed with 5/);
  assert.throws(() => requireObservedProcessResult({ code: null, signal: "SIGTERM" }, [0], "registry observation"), /crashed/);
  assert.throws(() => validatePackagedDetails(null, { passed: true }), /must be present/);
  const packageBinding = {
    schemaVersion: 3, buildId: "0.1.0+local.synthetic", sourceDigest: "1".repeat(64),
    stageManifestSha256: "f".repeat(64), buildInfoSha256: "0".repeat(64), distIntegritySha256: "3".repeat(64),
    native: {
      architectureSha256: "1".repeat(64),
      manifest: { path: "dist/native/sec03-native-manifest.json", bytes: 128, sha256: "2".repeat(64) },
      sourceDigest: "3".repeat(64), toolchainDigest: "4".repeat(64), signatureStatus: "unsigned-local",
      binaries: [
        { path: "dist/native/sandbox-host.exe", bytes: 128, sha256: "5".repeat(64), machine: "AMD64" },
        { path: "dist/native/sandbox-launcher.node", bytes: 128, sha256: "6".repeat(64), machine: "AMD64" },
      ],
      testProjection: { manifest: { path: ".sec03-native-test/sec03-native-test-manifest.json", bytes: 128, sha256: "7".repeat(64) } },
    },
    sinkInventorySha256: "4".repeat(64), detectorPolicySha256: "5".repeat(64), reviewPolicySha256: "6".repeat(64),
    dialectCheckerSha256: "b".repeat(64), dialectPolicySha256: "c".repeat(64), dialectImportSetSha256: "d".repeat(64),
    executableManifestSha256: "7".repeat(64), runtimeSinkSetSha256: "8".repeat(64),
    authoredExecutableProjectionSha256: "9".repeat(64), packagedSinkSetSha256: "a".repeat(64), packagedDialectImportSetSha256: "e".repeat(64), asarSha256: "2".repeat(64),
    authoredFileCount: 3, dependencyFileCount: 4, unpacked: { fileCount: 2, executableFileCount: 1 },
    missing: [], extra: [], mismatched: [], packageInspected: true, asarPayloadBound: true, producerSummaryTrusted: false,
  };
  const assertionIds = [
    "root-internal-success", "traversal-denied", "junction-denied",
    "viewer-range-handle-replacement", "terminal-cwd-denied-before-spawn",
  ];
  const pathPolicy = {
    schemaVersion: 1,
    expectedLaunchCount: 2,
    assertionIds,
    launches: [1, 2].map(launchIndex => ({
      launchIndex,
      assertionCount: assertionIds.length,
      passed: true,
      assertions: assertionIds.map(id => ({ id, passed: true })),
    })),
  };
  const packagedDetails = {
    phase: "complete",
    artifactExecution: { sourceBytes: 4, sourceSha256: "3".repeat(64), executedBytes: 4, executedSha256: "3".repeat(64), identityMatched: true },
    installerExitCode: 0, installerSignal: null, installerClassification: "passed", installerConverged: true,
    packageBinding,
    pathPolicy,
    uninstallerSignal: null, uninstallerConverged: true,
    cleanup: {
      attemptedOfficialUninstall: true, officialUninstallExitCode: 0, installDirectoryEmpty: true,
      registryObserved: true, registryMatchesBaseline: true, shortcutObserved: true, shortcutMatchesBaseline: true,
      processesStopped: true, executionCopyReleased: true, fixtureRemoved: true, passed: true,
    },
  };
  const sinkIdentity = {
    canonicalPayloadSha256: packageBinding.sinkInventorySha256,
    detectorPolicySha256: packageBinding.detectorPolicySha256,
    reviewPolicySha256: packageBinding.reviewPolicySha256,
    dialectCheckerSha256: packageBinding.dialectCheckerSha256,
    dialectPolicySha256: packageBinding.dialectPolicySha256,
    dialectImportSetSha256: packageBinding.dialectImportSetSha256,
    executableManifestSha256: packageBinding.executableManifestSha256,
    runtimeSinkSetSha256: packageBinding.runtimeSinkSetSha256,
  };
  assert.doesNotThrow(() => validatePackagedDetails(packagedDetails, { passed: true, sinkIdentity }));
  assert.throws(() => validatePackagedDetails({ ...packagedDetails, packageBinding: { ...packageBinding, runtimeSinkSetSha256: "f".repeat(64) } }, { passed: true, sinkIdentity }), /runtime sink set differs/);
  assert.throws(() => validatePackagedDetails({ ...packagedDetails, packageBinding: { ...packageBinding, dialectPolicySha256: "f".repeat(64) } }, { passed: true, sinkIdentity }), /restricted dialect policy differs/);
  assert.throws(() => validatePackagedDetails({ ...packagedDetails, packageBinding: { ...packageBinding, missing: ["dist/bypass.js"] } }, { passed: true }), /asarPayloadBound is inconsistent/);
  assert.throws(() => validatePackagedDetails({ ...packagedDetails, packageBinding: { ...packageBinding, producerSummaryTrusted: true } }, { passed: true }), /must not trust/);
  assert.throws(() => validatePackagedDetails({ ...packagedDetails, pathPolicy: { ...pathPolicy, launches: pathPolicy.launches.slice(0, 1) } }, { passed: true }), /exactly two launches/);
  assert.throws(() => validatePackagedDetails({
    ...packagedDetails,
    pathPolicy: {
      ...pathPolicy,
      launches: [pathPolicy.launches[0], {
        ...pathPolicy.launches[1],
        passed: false,
        assertions: pathPolicy.launches[1].assertions.map((entry, index) => index === 0 ? { ...entry, passed: false } : entry),
      }],
    },
  }, { passed: true }), /both launches/);
  assert.throws(() => validatePackagedDetails({
    ...packagedDetails,
    pathPolicy: {
      ...pathPolicy,
      launches: [{
        ...pathPolicy.launches[0],
        assertions: [{ ...pathPolicy.launches[0].assertions[0], path: "C:\\secret" }, ...pathPolicy.launches[0].assertions.slice(1)],
      }, pathPolicy.launches[1]],
    },
  }), /keys differ/);
});

test("process timeout records successful child-tree reclamation", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)"], { timeoutMs: 100 }),
    (error) => error?.code === "PROCESS_TIMEOUT" && error?.termination?.exitCode === 0 && error?.termination?.childExited === true
  );
});

test("process capture waits for inherited output pipes to close", async () => {
  const child = await runProcess(process.execPath, [
    "-e",
    "require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('late-output'),100)\"],{stdio:['ignore',1,2],windowsHide:true})",
  ]);
  assert.equal(child.code, 0);
  assert.equal(child.stdout, "late-output");
});

test("packaged registry baseline treats an absent uninstall container as an empty set", async () => {
  assert.equal(process.platform, "win32", "packaged registry observation requires Windows");
  const fixture = await makeTempDir("rainydays-registry-observation-");
  try {
    const missingRoot = `HKCU:\\Software\\RainyDays-GOV03-Missing-${process.pid}`;
    const output = await observeWindowsRegistrySnapshot(missingRoot, path.join(fixture, "snapshot.json"));
    assert.equal(output, '{"rootPresent":false,"items":[]}');
    assert.deepEqual(JSON.parse(output), { rootPresent: false, items: [] });
    const powershellOutput = path.join(fixture, "powershell-output.txt");
    assert.equal(await observeWindowsPowerShellOutput("'READY'", powershellOutput), "READY");
    await assert.rejects(observeWindowsPowerShellOutput("throw 'EXPECTED_FAILURE'", powershellOutput), /failed with 1/);
  } finally {
    await removeFixture(fixture);
  }
});

test("Windows file handle observation binds holders to the exact process tree", async (t) => {
  assert.equal(process.platform, "win32", "file handle observation contract requires Windows");
  const root = await makeTempDir("rainydays-file-handle-observer-");
  let holder;
  let unrelatedRoot;
  try {
    const target = path.join(root, "target.bin");
    await writeFile(target, Buffer.alloc(4096, 0x41));
    const holderScript = "const fs=require('node:fs');fs.openSync(process.env.RAINYDAYS_HANDLE_FILE,'r');process.on('message',message=>{if(message==='stop')process.exit(0)});process.on('disconnect',()=>process.exit(0));process.send('ready');setInterval(()=>{},1000)";
    holder = spawnManaged(process.execPath, [
      "-e",
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.env.RAINYDAYS_HOLDER_SCRIPT],{env:process.env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});child.once('message',()=>process.stdout.write('ready\\n'));process.on('message',message=>{if(message==='stop')child.send('stop')});child.once('exit',()=>process.exit(0));setInterval(()=>{},1000)",
    ], { env: { ...process.env, RAINYDAYS_HANDLE_FILE: target, RAINYDAYS_HOLDER_SCRIPT: holderScript }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const waitForReady = (child, label) => new Promise((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready\n")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`${label} exited before readiness: ${code}`)));
    });
    await waitForReady(holder, "file holder");
    unrelatedRoot = spawnManaged(process.execPath, ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"]);
    await waitForReady(unrelatedRoot, "unrelated process root");
    assert.notEqual(holder.pid, unrelatedRoot.pid);

    let matchedFailed = false;
    await t.test("matched holder is attributed to the managed holder root", async () => {
      try {
        const matched = await observeWindowsFileHandleInProcessTree(target, holder.pid);
        assert.deepEqual(Object.keys(matched).sort(), ["holderCount", "matched", "matchingCount"]);
        assert.equal(Object.isFrozen(matched), true);
        assert.equal(matched.matchingCount, 1);
        assert.equal(matched.matched, true);
      } catch (error) {
        matchedFailed = true;
        throw error;
      }
    });
    if (matchedFailed) return;

    let unrelatedFailed = false;
    await t.test("holder is excluded from the unrelated sibling root", async () => {
      try {
        const unrelated = await observeWindowsFileHandleInProcessTree(target, unrelatedRoot.pid);
        assert.equal(unrelated.matchingCount, 0);
        assert.equal(unrelated.matched, false);
      } catch (error) {
        unrelatedFailed = true;
        throw error;
      }
    });
    if (unrelatedFailed) return;

    let uncFailed = false;
    await t.test("canonical UNC spelling completes a bounded observation", async () => {
      try {
        const packagePath = path.join(projectRoot, "package.json");
        const uncPath = `\\\\localhost\\${packagePath[0]}` + "$" + packagePath.slice(2);
        const observation = await observeWindowsFileHandleInProcessTree(uncPath, unrelatedRoot.pid);
        assert.equal(Object.isFrozen(observation), true);
        assert.equal(observation.matchingCount, 0);
        assert.equal(observation.matched, false);
      } catch (error) {
        uncFailed = true;
        throw error;
      }
    });
    if (uncFailed) return;

    let terminationFailed = false;
    await t.test("managed holder tree terminates cleanly", async () => {
      try {
        const exited = new Promise((resolve, reject) => {
          holder.once("error", reject);
          holder.once("exit", (code) => resolve(code));
        });
        holder.send("stop");
        assert.equal(await exited, 0);
      } catch (error) {
        terminationFailed = true;
        throw error;
      }
    });
    if (terminationFailed) return;

    await t.test("closed holder is absent while an unrelated managed root remains live", async () => {
      const closed = await observeWindowsFileHandleInProcessTree(target, unrelatedRoot.pid);
      assert.equal(closed.holderCount, 0);
      assert.equal(closed.matchingCount, 0);
      assert.equal(closed.matched, false);
    });
  } finally {
    if (holder?.exitCode === null) await terminateProcessTreeAsync(holder);
    if (unrelatedRoot?.exitCode === null) await terminateProcessTreeAsync(unrelatedRoot);
    await removeFixture(root);
  }
});

test("Windows file handle observation fails closed when an intermediate ancestor exits", async () => {
  assert.equal(process.platform, "win32", "file handle observation contract requires Windows");
  const root = await makeTempDir("rainydays-file-handle-observer-gap-");
  const target = path.join(root, "target.bin");
  await writeFile(target, Buffer.alloc(4096, 0x42));
  const holderScript = "const fs=require('node:fs');fs.openSync(process.env.RAINYDAYS_HANDLE_FILE,'r');process.send({holderPid:process.pid});setInterval(()=>{try{process.kill(Number(process.env.RAINYDAYS_ROOT_PID),0)}catch{process.exit(0)}},50)";
  const intermediateScript = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.env.RAINYDAYS_HOLDER_SCRIPT],{env:process.env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:true});child.once('message',message=>{process.send(message,()=>{child.disconnect();child.unref();process.exit(0)})})";
  const rootScript = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.env.RAINYDAYS_INTERMEDIATE_SCRIPT],{env:{...process.env,RAINYDAYS_ROOT_PID:String(process.pid)},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});let holderPid=0,intermediateExited=false;const publish=()=>{if(holderPid&&intermediateExited)process.send({holderPid})};child.once('message',message=>{holderPid=message.holderPid;publish()});child.once('exit',()=>{intermediateExited=true;publish()});setInterval(()=>{},1000)";
  const managedRoot = spawnManaged(process.execPath, ["-e", rootScript], {
    env: {
      ...process.env,
      RAINYDAYS_HANDLE_FILE: target,
      RAINYDAYS_HOLDER_SCRIPT: holderScript,
      RAINYDAYS_INTERMEDIATE_SCRIPT: intermediateScript,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let holderPid = 0;
  try {
    holderPid = await new Promise((resolve, reject) => {
      managedRoot.once("message", (message) => resolve(Number(message?.holderPid)));
      managedRoot.once("error", reject);
      managedRoot.once("exit", (code) => reject(new Error(`managed ancestry root exited before readiness: ${code}`)));
    });
    assert(Number.isInteger(holderPid) && holderPid > 0);
    const laterRoot = spawnManaged(process.execPath, ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"]);
    try {
      await new Promise((resolve, reject) => {
        laterRoot.stdout.setEncoding("utf8");
        laterRoot.stdout.once("data", resolve);
        laterRoot.once("error", reject);
        laterRoot.once("exit", (code) => reject(new Error(`later observation root exited before readiness: ${code}`)));
      });
      const present = await observeWindowsFileHandleInProcessTree(target, laterRoot.pid);
      assert.equal(present.holderCount, 1);
      assert.equal(present.matchingCount, 0);
    } finally {
      if (laterRoot.exitCode === null) await terminateProcessTreeAsync(laterRoot);
    }
    await assert.rejects(
      observeWindowsFileHandleInProcessTree(target, managedRoot.pid),
      (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_DOMAIN" && !String(error.message).includes(String(holderPid)),
    );
  } finally {
    if (managedRoot.exitCode === null) {
      const termination = await terminateProcessTreeAsync(managedRoot);
      assert.equal(termination.exitCode, 0);
      assert.equal(termination.childExited, true);
    }
    const cleanupRoot = spawnManaged(process.execPath, ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"]);
    try {
      await new Promise((resolve, reject) => {
        cleanupRoot.stdout.setEncoding("utf8");
        cleanupRoot.stdout.once("data", resolve);
        cleanupRoot.once("error", reject);
        cleanupRoot.once("exit", (code) => reject(new Error(`cleanup observation root exited before readiness: ${code}`)));
      });
      let closed;
      await waitFor(async () => {
        closed = await observeWindowsFileHandleInProcessTree(target, cleanupRoot.pid);
        return closed.holderCount === 0;
      }, { timeoutMs: 5_000, intervalMs: 50, label: "orphaned holder kernel release" });
      assert.equal(closed.matchingCount, 0);
      assert.equal(closed.matched, false);
    } finally {
      if (cleanupRoot.exitCode === null) await terminateProcessTreeAsync(cleanupRoot);
    }
    await removeFixture(root);
  }
});

test("readiness failure leaves a tracked child available for cleanup", async () => {
  const instance = launchTracked(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: process.env,
    timeoutMs: 100,
    label: "synthetic readiness",
    readyProbe: async () => { throw new Error("intentional readiness failure"); },
  });
  assert(instance.child.pid, "spawned child was not returned immediately");
  await assert.rejects(instance.ready, /intentional readiness failure/);
  const termination = await terminateProcessTreeAsync(instance.child);
  assert.equal(termination.exitCode, 0);
  assert.equal(termination.childExited, true);
});

test("atomic JSON reports publish complete parseable content", async () => {
  const root = await makeTempDir("mini-lux-gov03-report-");
  try {
    const report = path.join(root, "nested", "report.json");
    const stages = [];
    await atomicWriteJson(report, { state: "passed", count: 2 }, (stage) => stages.push(stage));
    assert.deepEqual(stages, ["path-validation", "serialization", "temporary-write", "revalidation", "rename"]);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), { state: "passed", count: 2 });
  } finally {
    await removeFixture(root);
  }
});

test("prepared report authority survives ambient temporary-root drift", async () => {
  const root = await makeTempDir("mini-lux-gov03-temp-root-drift-");
  const previous = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]));
  try {
    const report = path.join(root, "report.json");
    const target = await prepareReportTarget(report);
    const driftRoot = path.join(projectRoot, "ambient-temp-root-drift");
    process.env.TEMP = driftRoot;
    process.env.TMP = driftRoot;
    process.env.TMPDIR = driftRoot;
    await atomicWriteJson(target, { state: "passed" });
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), { state: "passed" });
    await assert.rejects(() => atomicWriteJson({ ...target }, { state: "forged" }), /not authentic/);
    await assert.rejects(() => validateReportPath(path.join(driftRoot, "forged.json")), /inside test-results/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeFixture(root);
  }
});

test("canonical report paths remain authorized when TEMP uses an 8.3 alias", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeTempDir("mini-lux-gov03-report-alias-");
  try {
    if (root.includes(" ")) {
      context.skip("8.3 alias probe root contains spaces");
      return;
    }
    const aliasProbe = await runProcess(process.env.ComSpec || "cmd.exe", [
      "/d", "/c", "for %I in (%RAINYDAYS_ALIAS_ROOT%) do @echo %~sI",
    ], { env: { ...process.env, RAINYDAYS_ALIAS_ROOT: root } });
    assert.equal(aliasProbe.code, 0, aliasProbe.stderr);
    const shortOutput = aliasProbe.stdout.trim();
    const shortRoot = shortOutput.startsWith('"') && shortOutput.endsWith('"') ? shortOutput.slice(1, -1) : shortOutput;
    const canonicalRoot = await realpath(root);
    if (shortRoot.toLowerCase() === canonicalRoot.toLowerCase()) {
      context.skip("8.3 aliases are not exposed on this volume");
      return;
    }

    const report = path.join(canonicalRoot, "nested", "report.json");
    const child = await runProcess(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { prepareReportTarget } from './tests/helpers.mjs'; const target = await prepareReportTarget(process.env.RAINYDAYS_REPORT_PATH); console.log(target.path);",
    ], {
      env: {
        ...process.env,
        TEMP: shortRoot,
        TMP: shortRoot,
        TMPDIR: shortRoot,
        RAINYDAYS_REPORT_PATH: report,
      },
    });
    assert.equal(child.code, 0, child.stderr);
    assert.equal(child.stdout.trim(), report);
  } finally {
    await removeFixture(root);
  }
});

test("ambient temporary-root junctions remain fail-closed", { skip: process.platform !== "win32" }, async () => {
  const root = await makeTempDir("mini-lux-gov03-report-root-target-");
  const junction = `${root}-junction`;
  try {
    await symlink(root, junction, "junction");
    const report = path.join(await realpath(root), "junction-report.json");
    const child = await runProcess(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { prepareReportTarget } from './tests/helpers.mjs'; await prepareReportTarget(process.env.RAINYDAYS_REPORT_PATH);",
    ], {
      env: {
        ...process.env,
        TEMP: junction,
        TMP: junction,
        TMPDIR: junction,
        RAINYDAYS_REPORT_PATH: report,
      },
    });
    assert.notEqual(child.code, 0);
    assert.match(child.stderr, /report root must not be a symbolic link/);
  } finally {
    await unlink(junction).catch(() => {});
    await removeFixture(root);
  }
});

test("current runs remove stale reports before execution", async () => {
  const root = await makeTempDir("mini-lux-gov03-stale-report-");
  try {
    const report = path.join(root, "stale.json");
    await writeFile(report, JSON.stringify({ state: "passed" }));
    const prepared = await prepareReportPath(report);
    assert.equal(await realpath(path.dirname(prepared)), await realpath(root));
    assert.equal(path.basename(prepared), path.basename(report));
    await assert.rejects(() => readFile(report, "utf8"));
  } finally {
    await removeFixture(root);
  }
});

test("malformed successful reports fail strict schema validation", () => {
  assert.throws(() => validateLayerReport({ state: "passed" }), /keys differ/);
});

test("self-test reports cannot shrink the fixed fault matrix", () => {
  const side = {
    buildInfo: null, distIntegrity: null, packageArtifactManifest: null, installer: null,
    appAsar: null, distTree: "0".repeat(64), electronAppTree: "0".repeat(64), releaseTree: "0".repeat(64),
  };
  const report = {
    reportVersion: 1, taskId: "GOV-03", state: "passed", failureClass: null,
    startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), durationMs: 0,
    scenarios: [{ ...selfTestScenarioContract[0], actual: "rejected unchanged", passed: true, details: null }],
    cleanupPassed: true, baselineUnchanged: true,
    artifactSnapshot: { before: side, after: side, unchanged: true }, maxRssBytes: 0,
  };
  assert.throws(() => validateSelfTestReport(report, { taskId: "GOV-03" }), /fixed fault matrix/);
});

test("report destinations cannot target formal artifacts", async () => {
  const buildInfoPath = path.join(projectRoot, "build-info.json");
  const before = await sha256File(buildInfoPath);
  await assert.rejects(() => validateReportPath(buildInfoPath));
  assert.equal(await sha256File(buildInfoPath), before);
});

test("allowed-root internal junctions cannot redirect reports", async () => {
  const reportRoot = path.join(projectRoot, "test-results");
  const pivot = path.join(reportRoot, `junction-${process.pid}-${Date.now()}`);
  try {
    await mkdir(reportRoot, { recursive: true });
    await symlink(projectRoot, pivot, "junction");
    await assert.rejects(() => validateReportPath(path.join(pivot, "build-info.json")), /symbolic link/);
  } finally {
    await unlink(pivot).catch(() => {});
  }
});

test("formal artifact snapshot represents present and absent package outputs", async () => {
  const snapshot = await formalArtifactSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["appAsar", "buildInfo", "distIntegrity", "packageArtifactManifest", "installer", "distTree", "electronAppTree", "releaseTree"].sort());
  for (const key of ["distTree", "electronAppTree", "releaseTree"]) assert.match(snapshot[key], /^[a-f0-9]{64}$/);
  for (const key of ["buildInfo", "distIntegrity", "packageArtifactManifest", "installer", "appAsar"]) {
    assert(snapshot[key] === null || /^[a-f0-9]{64}$/.test(snapshot[key]), `${key} must be null or SHA-256`);
  }
});

test("Windows case aliases cannot disable per-file floors", async () => {
  const root = await makeTempDir("mini-lux-gov03-case-floor-");
  try {
    const current = (await loadCoverageScope()).scope;
    const aliased = {
      ...current,
      perFileLineMinimum: {
        ...current.perFileLineMinimum,
        "dist/version.js": undefined,
        "DIST/VERSION.JS": 100,
      },
    };
    delete aliased.perFileLineMinimum["dist/version.js"];
    const scopePath = path.join(root, "case-alias.json");
    await writeFile(scopePath, JSON.stringify(aliased, null, 2));
    await assert.rejects(() => loadCoverageScope(scopePath), /casing\/path must exactly match/);
  } finally {
    await removeFixture(root);
  }
});

test("coverage thresholds use exact integer arithmetic", () => {
  assert.equal(meetsPercent(89, 100, 90), false);
  assert.equal(meetsPercent(9, 10, 90), true);
  assert.equal(meetsPercent(0, 0, 90), false);
  const scope = {
    overall: ["dist/a.js", "dist/b.js"],
    securityCritical: ["dist/a.js"],
    thresholds: { overallLines: 80, securityBranches: 90 },
    perFileLineMinimum: { "dist/a.js": 80 },
  };
  const metric = (linesCovered, linesTotal, branchCovered, branchTotal) => ({
    lines: { covered: linesCovered, total: linesTotal },
    branches: { covered: branchCovered, total: branchTotal },
  });
  const summary = {
    [path.join(projectRoot, "dist", "a.js")]: metric(8, 10, 9, 10),
    [path.join(projectRoot, "dist", "b.js")]: metric(8, 10, 0, 0),
  };
  const passed = evaluateCoverageSummary(summary, scope, projectRoot);
  assert.equal(passed.passed, true);
  summary[path.join(projectRoot, "dist", "a.js")].branches.covered = 8;
  const failed = evaluateCoverageSummary(summary, scope, projectRoot);
  assert.equal(failed.passed, false);
  assert.equal(failed.securityBranches.passed, false);
  assert.equal(failed.files.find((entry) => entry.path === "dist/a.js").securityDenominatorPassed, true);
});

test("coverage evaluation fails missing and unexpected paths", () => {
  const scope = {
    overall: ["dist/a.js"],
    securityCritical: ["dist/a.js"],
    thresholds: { overallLines: 80, securityBranches: 90 },
    perFileLineMinimum: {},
  };
  const summary = {
    [path.join(projectRoot, "dist", "other.js")]: {
      lines: { covered: 10, total: 10 },
      branches: { covered: 10, total: 10 },
    },
  };
  const result = evaluateCoverageSummary(summary, scope, projectRoot);
  assert.equal(result.passed, false);
  assert.deepEqual(result.missingFiles, ["dist/a.js"]);
  assert.deepEqual(result.unexpectedFiles, ["dist/other.js"]);
});

test("fixture cleanup is idempotent", async () => {
  const root = await makeTempDir("mini-lux-gov03-unit-");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "sentinel.txt"), "sentinel");
  await removeFixture(root);
  await removeFixture(root);
});
