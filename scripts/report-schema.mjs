import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateSec02LayerEvidence, validateSec02UnifiedEvidence } from "./sec02-receipt-set.mjs";
import { canonicalSec03Json, validateSec03Receipt } from "../tests/sec03-receipts.mjs";

const states = new Set(["passed", "failed", "timed-out", "crashed", "unsupported"]);
const layerNames = new Set(["unit", "contract", "integration", "electron", "packaged"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const absolutePathPattern = /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\[^\\]|\/(?:Users|home)\/)/;
const forbiddenKeyPattern = /(?:api.?key|token|secret|prompt|message)/i;
const fixedBooleanEvidenceKeys = new Set(["oldTokensStale"]);
const fixedIntegerEvidenceKeys = new Set(["promptPublications"]);
const packagedPathPolicyAssertionIds = Object.freeze([
  "root-internal-success",
  "traversal-denied",
  "junction-denied",
  "viewer-range-handle-replacement",
  "terminal-cwd-denied-before-spawn",
]);
const personaChains = Object.freeze({
  "GOV-03": Object.freeze(["planner", "architect", "developer", "debugger", "reviewer"]),
  "SEC-01": Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]),
  "SEC-02": Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]),
  "SEC-03": Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]),
});

const sec03ArchitectureSha256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
const sec03ReceiptLayerByTestLayer = Object.freeze({ integration: "real-host", electron: "electron", packaged: "packaged" });
const sec03ExpectedCountByTestLayer = Object.freeze({ unit: 0, contract: 0, integration: 386, electron: 48, packaged: 48 });
const sec03EvidenceKeys = Object.freeze(["schemaVersion", "status", "context", "expectedCount", "rawCount", "validCount", "receipts", "missingKeys", "duplicateKeys", "extraKeys", "invalidKeys", "crossRunCount", "skippedCount", "todoCount", "mockCount", "testOnlyCount", "receiptSetSha256"]);
const sec03ContextKeys = Object.freeze(["architectureSha256", "matrixSha256", "schemaSha256", "sourceSha256", "launcherSha256", "hostSha256", "packageSha256", "candidateId", "buildId", "runId", "layer"]);

function expectedPersonaChain(taskId) {
  const chain = personaChains[taskId];
  assert(chain, `unsupported task persona chain: ${taskId}`);
  return chain;
}

export const selfTestScenarioContract = Object.freeze([
  { name: "formal artifact report destination rejected", expected: "path rejected before write" },
  { name: "intentional assertion failure through layer runner", expected: "TEST_ASSERTION/non-zero" },
  { name: "corrupt contract through layer runner", expected: "TEST_ASSERTION/non-zero and fixture unchanged" },
  { name: "coverage all child merge and valid stale isolation", expected: "all proofs true" },
  { name: "integer threshold and malformed denominator proof", expected: "89.9 fails; 90 passes; zero/remap fail" },
  { name: "truncated and missing coverage report", expected: "both rejected" },
  { name: "forced coverage threshold zero-hit and preserved-output isolation", expected: "COVERAGE_THRESHOLD/non-zero without preserved mutation" },
  { name: "forged coverage counters rejected", expected: "semantic schema rejection" },
  { name: "empty full unified report rejected", expected: "fixed profile rejection" },
  { name: "contradictory packaged success rejected", expected: "semantic schema rejection" },
  { name: "passing ratio cannot mask failing coverage child", expected: "COVERAGE_TEST_FAILURE with passing evaluation" },
  { name: "passing ratio cannot mask formal artifact mutation", expected: "ARTIFACT_MUTATION with passing evaluation" },
  { name: "package manifest mutation is a formal artifact mutation", expected: "ARTIFACT_MUTATION with package manifest changed" },
  { name: "coverage timeout publishes authoritative failure report", expected: "TIMEOUT/timed-out/non-zero" },
  { name: "missing installer preflight", expected: "INSTALLER_MISSING" },
  { name: "wrong installer basename preflight", expected: "INSTALLER_NAME_MISMATCH" },
  { name: "wrong installer hash preflight", expected: "INSTALLER_HASH_MISMATCH" },
]);

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

function safeInteger(value, field, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${field} must be a safe integer >= ${minimum}`);
}

function optionalInteger(value, field) {
  assert(value === null || Number.isSafeInteger(value), `${field} must be a safe integer or null`);
}

function validateTimeoutTermination(value, field = "timeoutTermination") {
  if (value === null) return;
  exactKeys(value, ["attempted", "exitCode", "childExited"], field);
  assert.equal(typeof value.attempted, "boolean", `${field}.attempted must be boolean`);
  safeInteger(value.exitCode, `${field}.exitCode`);
  assert.equal(typeof value.childExited, "boolean", `${field}.childExited must be boolean`);
}

function expectedTimeoutFailureClass(value) {
  return value?.exitCode === 0 && value?.childExited === true ? "TIMEOUT" : "TIMEOUT_CLEANUP_FAILED";
}

function validateIso(value, field) {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(isoPattern.test(value) && new Date(value).toISOString() === value, `${field} must be canonical ISO time`);
}

function validateNoSensitiveData(value, field = "report") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNoSensitiveData(entry, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const fixedBooleanEvidence = fixedBooleanEvidenceKeys.has(key) && typeof entry === "boolean";
      const fixedIntegerEvidence = fixedIntegerEvidenceKeys.has(key) && Number.isSafeInteger(entry) && entry >= 0;
      assert(key === "tokens" || fixedBooleanEvidence || fixedIntegerEvidence || !forbiddenKeyPattern.test(key), `${field}.${key} is a forbidden evidence field`);
      validateNoSensitiveData(entry, `${field}.${key}`);
    }
    return;
  }
  if (typeof value === "string") assert(!absolutePathPattern.test(value), `${field} contains an absolute user path`);
}

function validateBaseline(value) {
  exactKeys(value, ["product", "version", "manifestSha256"], "baseline");
  assert.deepEqual(value, {
    product: "Lux Desktop",
    version: "0.1.898",
    manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df",
  });
}

function validateBuild(value, expected = null) {
  exactKeys(value, ["appVersion", "buildId", "sourceDigest"], "build");
  assert.equal(typeof value.appVersion, "string");
  assert.equal(typeof value.buildId, "string");
  assert.match(value.sourceDigest, sha256Pattern);
  if (expected) assert.deepEqual(value, expected, "report build identity differs from current run");
}

function validateSnapshotSide(value, field) {
  exactKeys(value, ["buildInfo", "distIntegrity", "packageArtifactManifest", "installer", "appAsar", "distTree", "electronAppTree", "releaseTree"], field);
  for (const [key, hash] of Object.entries(value)) assert(hash === null || sha256Pattern.test(hash), `${field}.${key} must be SHA-256 or null`);
}

function validateArtifactSnapshot(value) {
  exactKeys(value, ["before", "after", "unchanged"], "artifactSnapshot");
  validateSnapshotSide(value.before, "artifactSnapshot.before");
  validateSnapshotSide(value.after, "artifactSnapshot.after");
  assert.equal(typeof value.unchanged, "boolean");
  assert.equal(value.unchanged, JSON.stringify(value.before) === JSON.stringify(value.after), "artifactSnapshot.unchanged is inconsistent");
}

function validateTap(value) {
  exactKeys(value, ["tests", "passed", "failed", "skipped", "cancelled", "todo"], "tap");
  for (const [key, count] of Object.entries(value)) assert(count === null || (Number.isSafeInteger(count) && count >= 0), `tap.${key} is invalid`);
}

function exactPercentPassed(covered, total, threshold) {
  return total > 0 && BigInt(covered) * 100n >= BigInt(total) * BigInt(threshold);
}

function assertUniqueStrings(value, field) {
  assert(Array.isArray(value) && value.every((entry) => typeof entry === "string"), `${field} must be a string array`);
  assert.equal(new Set(value.map((entry) => process.platform === "win32" ? entry.toLowerCase() : entry)).size, value.length, `${field} contains duplicate or case-alias values`);
}

function validateCommand(value, field) {
  assert(Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0), `${field} must be a non-empty string array`);
  for (const entry of value) assert(!absolutePathPattern.test(entry), `${field} contains an absolute user path`);
}

function validatePackageBinding(value, { passed = false, sinkIdentity = null } = {}) {
  assert(value && typeof value === "object" && !Array.isArray(value), "details.packageBinding must be present");
  exactKeys(value, ["schemaVersion", "buildId", "sourceDigest", "sinkInventorySha256", "detectorPolicySha256", "reviewPolicySha256", "dialectCheckerSha256", "dialectPolicySha256", "dialectImportSetSha256", "executableManifestSha256", "runtimeSinkSetSha256", "authoredExecutableProjectionSha256", "packagedSinkSetSha256", "packagedDialectImportSetSha256", "asarSha256", "authoredFileCount", "dependencyFileCount", "unpacked", "missing", "extra", "mismatched", "packageInspected", "asarPayloadBound", "producerSummaryTrusted"], "details.packageBinding");
  assert(value.schemaVersion === null || value.schemaVersion === 2, "details.packageBinding.schemaVersion is invalid");
  assert(value.buildId === null || (typeof value.buildId === "string" && value.buildId.length > 0 && value.buildId.length <= 128), "details.packageBinding.buildId is invalid");
  for (const key of ["sourceDigest", "sinkInventorySha256", "detectorPolicySha256", "reviewPolicySha256", "dialectCheckerSha256", "dialectPolicySha256", "dialectImportSetSha256", "executableManifestSha256", "runtimeSinkSetSha256", "authoredExecutableProjectionSha256", "packagedSinkSetSha256", "packagedDialectImportSetSha256", "asarSha256"]) assert(value[key] === null || sha256Pattern.test(value[key]), `details.packageBinding.${key} is invalid`);
  for (const key of ["authoredFileCount", "dependencyFileCount"]) assert(value[key] === null || (Number.isSafeInteger(value[key]) && value[key] >= 0), `details.packageBinding.${key} is invalid`);
  exactKeys(value.unpacked, ["fileCount", "executableFileCount"], "details.packageBinding.unpacked");
  for (const key of ["fileCount", "executableFileCount"]) assert(value.unpacked[key] === null || (Number.isSafeInteger(value.unpacked[key]) && value.unpacked[key] >= 0), `details.packageBinding.unpacked.${key} is invalid`);
  for (const key of ["missing", "extra", "mismatched"]) assertUniqueStrings(value[key], `details.packageBinding.${key}`);
  for (const key of ["packageInspected", "asarPayloadBound", "producerSummaryTrusted"]) assert.equal(typeof value[key], "boolean", `details.packageBinding.${key} must be boolean`);
  assert.equal(value.producerSummaryTrusted, false, "packaged evidence must not trust a producer summary");
  const bound = value.packageInspected
    && value.schemaVersion === 2
    && value.buildId !== null
    && value.sourceDigest !== null
    && value.sinkInventorySha256 !== null
    && value.detectorPolicySha256 !== null
    && value.reviewPolicySha256 !== null
    && value.dialectCheckerSha256 !== null
    && value.dialectPolicySha256 !== null
    && value.dialectImportSetSha256 !== null
    && value.executableManifestSha256 !== null
    && value.runtimeSinkSetSha256 !== null
    && value.authoredExecutableProjectionSha256 !== null
    && value.packagedSinkSetSha256 !== null
    && value.packagedDialectImportSetSha256 !== null
    && value.asarSha256 !== null
    && Number.isSafeInteger(value.authoredFileCount) && value.authoredFileCount > 0
    && Number.isSafeInteger(value.dependencyFileCount) && value.dependencyFileCount > 0
    && Number.isSafeInteger(value.unpacked.fileCount)
    && Number.isSafeInteger(value.unpacked.executableFileCount)
    && value.missing.length === 0 && value.extra.length === 0 && value.mismatched.length === 0;
  assert.equal(value.asarPayloadBound, bound, "details.packageBinding.asarPayloadBound is inconsistent");
  if (sinkIdentity && value.asarPayloadBound) {
    assert.equal(value.sinkInventorySha256, sinkIdentity.canonicalPayloadSha256, "installed ASAR sink inventory differs");
    assert.equal(value.detectorPolicySha256, sinkIdentity.detectorPolicySha256, "installed ASAR detector policy differs");
    assert.equal(value.reviewPolicySha256, sinkIdentity.reviewPolicySha256, "installed ASAR review policy differs");
    assert.equal(value.dialectCheckerSha256, sinkIdentity.dialectCheckerSha256, "installed ASAR restricted dialect checker differs");
    assert.equal(value.dialectPolicySha256, sinkIdentity.dialectPolicySha256, "installed ASAR restricted dialect policy differs");
    assert.equal(value.dialectImportSetSha256, sinkIdentity.dialectImportSetSha256, "installed ASAR restricted dialect import set differs");
    assert.equal(value.executableManifestSha256, sinkIdentity.executableManifestSha256, "installed ASAR executable manifest differs");
    assert.equal(value.runtimeSinkSetSha256, sinkIdentity.runtimeSinkSetSha256, "installed ASAR runtime sink set differs");
  }
  if (passed) assert.equal(value.asarPayloadBound, true, "passed package must bind installed ASAR bytes");
}

function validatePackagedPathPolicy(value, { passed = false } = {}) {
  assert(value && typeof value === "object" && !Array.isArray(value), "details.pathPolicy must be present");
  exactKeys(value, ["schemaVersion", "expectedLaunchCount", "assertionIds", "launches"], "details.pathPolicy");
  assert.equal(value.schemaVersion, 1, "details.pathPolicy.schemaVersion is invalid");
  assert.equal(value.expectedLaunchCount, 2, "details.pathPolicy.expectedLaunchCount is invalid");
  assert.deepEqual(value.assertionIds, packagedPathPolicyAssertionIds, "details.pathPolicy.assertionIds differ from the fixed set");
  assert(Array.isArray(value.launches), "details.pathPolicy.launches must be an array");
  assert.equal(value.launches.length, 2, "details.pathPolicy must contain exactly two launches");
  for (const [launchOffset, launch] of value.launches.entries()) {
    const field = `details.pathPolicy.launches[${launchOffset}]`;
    exactKeys(launch, ["launchIndex", "assertionCount", "passed", "assertions"], field);
    assert.equal(launch.launchIndex, launchOffset + 1, `${field}.launchIndex is invalid`);
    assert.equal(launch.assertionCount, packagedPathPolicyAssertionIds.length, `${field}.assertionCount is invalid`);
    assert.equal(typeof launch.passed, "boolean", `${field}.passed must be boolean`);
    assert(Array.isArray(launch.assertions), `${field}.assertions must be an array`);
    assert.equal(launch.assertions.length, packagedPathPolicyAssertionIds.length, `${field}.assertions count is invalid`);
    for (const [assertionOffset, assertion] of launch.assertions.entries()) {
      const assertionField = `${field}.assertions[${assertionOffset}]`;
      exactKeys(assertion, ["id", "passed"], assertionField);
      assert.equal(assertion.id, packagedPathPolicyAssertionIds[assertionOffset], `${assertionField}.id is invalid`);
      assert.equal(typeof assertion.passed, "boolean", `${assertionField}.passed must be boolean`);
    }
    assert.equal(launch.passed, launch.assertions.every(assertion => assertion.passed), `${field}.passed is inconsistent`);
  }
  if (passed) assert(value.launches.every(launch => launch.passed), "passed package must execute every fixed PathPolicy assertion on both launches");
}

export function validatePackagedDetails(value, { passed = false, sinkIdentity = null } = {}) {
  assert(value && typeof value === "object" && !Array.isArray(value), "packaged details must be present");
  exactKeys(value, ["phase", "artifactExecution", "installerExitCode", "installerSignal", "installerClassification", "installerConverged", "packageBinding", "pathPolicy", "uninstallerSignal", "uninstallerConverged", "cleanup"], "details");
  assert(["preflight", "install", "first-launch", "restart", "uninstall", "complete"].includes(value.phase));
  exactKeys(value.artifactExecution, ["sourceBytes", "sourceSha256", "executedBytes", "executedSha256", "identityMatched"], "details.artifactExecution");
  for (const key of ["sourceBytes", "executedBytes"]) assert(value.artifactExecution[key] === null || (Number.isSafeInteger(value.artifactExecution[key]) && value.artifactExecution[key] > 0), `details.artifactExecution.${key} is invalid`);
  for (const key of ["sourceSha256", "executedSha256"]) assert(value.artifactExecution[key] === null || sha256Pattern.test(value.artifactExecution[key]), `details.artifactExecution.${key} is invalid`);
  assert.equal(typeof value.artifactExecution.identityMatched, "boolean");
  const identityMatched = value.artifactExecution.sourceBytes !== null
    && value.artifactExecution.sourceBytes === value.artifactExecution.executedBytes
    && value.artifactExecution.sourceSha256 !== null
    && value.artifactExecution.sourceSha256 === value.artifactExecution.executedSha256;
  assert.equal(value.artifactExecution.identityMatched, identityMatched, "artifact execution identity is inconsistent");
  optionalInteger(value.installerExitCode, "details.installerExitCode");
  assert(value.installerSignal === null || typeof value.installerSignal === "string");
  assert(value.installerClassification === null || ["passed", "non-zero", "windows-crash", "signal-crash", "timed-out"].includes(value.installerClassification));
  assert.equal(typeof value.installerConverged, "boolean");
  validatePackageBinding(value.packageBinding, { passed, sinkIdentity });
  validatePackagedPathPolicy(value.pathPolicy, { passed });
  assert(value.uninstallerSignal === null || typeof value.uninstallerSignal === "string");
  assert.equal(typeof value.uninstallerConverged, "boolean");
  exactKeys(value.cleanup, ["attemptedOfficialUninstall", "officialUninstallExitCode", "installDirectoryEmpty", "registryObserved", "registryMatchesBaseline", "shortcutObserved", "shortcutMatchesBaseline", "processesStopped", "executionCopyReleased", "fixtureRemoved", "passed"], "details.cleanup");
  assert.equal(typeof value.cleanup.attemptedOfficialUninstall, "boolean");
  optionalInteger(value.cleanup.officialUninstallExitCode, "details.cleanup.officialUninstallExitCode");
  for (const key of ["installDirectoryEmpty", "registryObserved", "registryMatchesBaseline", "shortcutObserved", "shortcutMatchesBaseline", "processesStopped", "executionCopyReleased", "fixtureRemoved", "passed"]) assert.equal(typeof value.cleanup[key], "boolean", `details.cleanup.${key} must be boolean`);
  const cleanupPassed = (!value.cleanup.attemptedOfficialUninstall || value.cleanup.officialUninstallExitCode === 0)
    && value.cleanup.installDirectoryEmpty
    && value.cleanup.registryObserved
    && value.cleanup.registryMatchesBaseline
    && value.cleanup.shortcutObserved
    && value.cleanup.shortcutMatchesBaseline
    && value.cleanup.processesStopped
    && value.cleanup.executionCopyReleased
    && value.cleanup.fixtureRemoved;
  assert.equal(value.cleanup.passed, cleanupPassed, "details.cleanup.passed is inconsistent");
  if (passed) {
    assert.equal(value.phase, "complete");
    assert.equal(value.installerExitCode, 0);
    assert.equal(value.installerSignal, null);
    assert.equal(value.artifactExecution.identityMatched, true);
    assert.equal(value.installerClassification, "passed");
    assert.equal(value.installerConverged, true);
    assert.equal(value.uninstallerSignal, null);
    assert.equal(value.uninstallerConverged, true);
    assert.equal(value.cleanup.attemptedOfficialUninstall, true);
    assert.equal(value.cleanup.officialUninstallExitCode, 0);
    assert.equal(value.cleanup.passed, true);
  }
}

function sec03ReceiptKey(value) {
  return `${value?.layer ?? "invalid"}\0${value?.familyId ?? "invalid"}\0${value?.variantId ?? "invalid"}\0${value?.profileId ?? "invalid"}`;
}

function validateSec03Context(context, expectedLayer = null, status = "complete") {
  exactKeys(context, sec03ContextKeys, "sec03Evidence.context");
  assert.equal(context.architectureSha256, sec03ArchitectureSha256);
  for (const key of ["matrixSha256", "schemaSha256"]) assert.match(context[key], sha256Pattern, `sec03Evidence.context.${key} must be SHA-256`);
  for (const key of ["sourceSha256", "launcherSha256", "hostSha256", "packageSha256", "candidateId", "buildId"]) {
    if (status === "blocked" && context[key] === null) continue;
    assert.match(context[key], sha256Pattern, `sec03Evidence.context.${key} must be SHA-256`);
  }
  if (status === "blocked" && context.runId === null) assert.equal(context.runId, null);
  else assert.match(context.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "sec03Evidence.context.runId is invalid");
  assert(["unit", "contract", "integration", "electron", "packaged", "unified"].includes(context.layer), "sec03Evidence.context.layer is invalid");
  if (expectedLayer) assert.equal(context.layer, expectedLayer, "SEC-03 evidence layer differs");
}

export function recomputeSec03Evidence(rawReceipts, { matrix, identity, nativeVerifier, layer }) {
  assert(Array.isArray(rawReceipts), "SEC-03 raw receipts must be an array");
  assert(matrix?.architectureSha256 === sec03ArchitectureSha256, "SEC-03 architecture binding differs");
  assert(identity && nativeVerifier, "SEC-03 identity and native verifier are required");
  const nativeLayer = layer === "unified" ? null : sec03ReceiptLayerByTestLayer[layer] ?? null;
  const expectedRecords = nativeLayer === null && layer !== "unified"
    ? []
    : matrix.records.filter((record) => layer === "unified" || record.layer === nativeLayer);
  const frozenExpected = layer === "unified" ? 482 : sec03ExpectedCountByTestLayer[layer];
  assert.equal(expectedRecords.length, frozenExpected, `SEC-03 ${layer} matrix count differs from frozen contract`);
  const expectedKeys = new Set(expectedRecords.map(sec03ReceiptKey));
  const accepted = new Map();
  const seenExecutions = new Set();
  const seenAttestations = new Set();
  const invalidKeys = [];
  const extraKeys = [];
  const duplicateKeys = [];
  let crossRunCount = 0;
  for (const receipt of rawReceipts) {
    const key = sec03ReceiptKey(receipt);
    if (receipt?.runId !== identity.runId) {
      crossRunCount += 1;
      invalidKeys.push(key);
      continue;
    }
    try { validateSec03Receipt(receipt, { matrix, identity, nativeVerifier }); }
    catch { invalidKeys.push(key); continue; }
    if (!expectedKeys.has(key)) { extraKeys.push(key); continue; }
    if (accepted.has(key)) { duplicateKeys.push(key); continue; }
    if (seenExecutions.has(receipt.executionNonce) || seenAttestations.has(receipt.nativeAttestationSha256)) { invalidKeys.push(key); continue; }
    seenExecutions.add(receipt.executionNonce); seenAttestations.add(receipt.nativeAttestationSha256);
    accepted.set(key, receipt);
  }
  const receipts = [...accepted.values()].sort((left, right) => sec03ReceiptKey(left).localeCompare(sec03ReceiptKey(right)));
  const unique = (values) => [...new Set(values)].sort();
  const missingKeys = [...expectedKeys].filter((key) => !accepted.has(key)).sort();
  const skippedCount = rawReceipts.filter((receipt) => receipt?.skipped === true).length;
  const todoCount = rawReceipts.filter((receipt) => receipt?.todo === true).length;
  const mockCount = rawReceipts.filter((receipt) => receipt?.mockSubstitution === true || receipt?.testOnly === true).length;
  const testOnlyCount = rawReceipts.filter((receipt) => receipt?.testOnly === true).length;
  const clean = rawReceipts.length === frozenExpected && receipts.length === frozenExpected && missingKeys.length === 0
    && duplicateKeys.length === 0 && extraKeys.length === 0 && invalidKeys.length === 0 && crossRunCount === 0
    && skippedCount === 0 && todoCount === 0 && mockCount === 0 && testOnlyCount === 0;
  const status = identity.runId === null ? "blocked" : frozenExpected === 0 && clean ? "not-applicable" : clean ? "complete" : "blocked";
  return Object.freeze({
    schemaVersion: 1,
    status,
    context: Object.freeze({
      architectureSha256: sec03ArchitectureSha256,
      matrixSha256: identity.matrixSha256,
      schemaSha256: identity.schemaSha256,
      sourceSha256: identity.sourceSha256,
      launcherSha256: identity.launcherSha256,
      hostSha256: identity.hostSha256,
      packageSha256: identity.packageSha256,
      candidateId: identity.candidateId,
      buildId: identity.buildId,
      runId: identity.runId,
      layer,
    }),
    expectedCount: frozenExpected,
    rawCount: rawReceipts.length,
    validCount: receipts.length,
    receipts,
    missingKeys,
    duplicateKeys: unique(duplicateKeys),
    extraKeys: unique(extraKeys),
    invalidKeys: unique(invalidKeys),
    crossRunCount,
    skippedCount,
    todoCount,
    mockCount,
    testOnlyCount,
    receiptSetSha256: createHash("sha256").update(canonicalSec03Json(receipts)).digest("hex"),
  });
}

function validateSec03Evidence(evidence, context, expectedLayer) {
  exactKeys(evidence, sec03EvidenceKeys, "sec03Evidence");
  validateSec03Context(evidence.context, expectedLayer, evidence.status);
  const recomputed = recomputeSec03Evidence(evidence.receipts, { ...context, layer: expectedLayer });
  assert.deepEqual(evidence, recomputed, "SEC-03 evidence differs from parent recomputation");
  return evidence;
}

export function validateLayerReport(report, expected = {}) {
  const sec03Resolved = report.taskId === "SEC-03";
  const sec02Resolved = sec03Resolved || report.taskId === "SEC-02" || report.taskId === "GOV-03";
  const keys = ["reportVersion", "taskId", "baseline", "personaChain", "layer", "state", "failureClass", "command", "expectedFiles", "exitCode", "signal", "timeoutTermination", "tap", "build", "startedAt", "finishedAt", "durationMs", "maxRssBytes", "artifactSnapshot", "details"];
  if (sec02Resolved) keys.push("sec02Evidence");
  if (sec03Resolved) keys.push("sec03Evidence");
  exactKeys(report, keys, "layer report");
  assert.equal(report.reportVersion, sec03Resolved ? 3 : sec02Resolved ? 2 : 1);
  assert.match(report.taskId, /^[A-Z]+-\d{2}$/);
  validateBaseline(report.baseline);
  assert.deepEqual(report.personaChain, expectedPersonaChain(report.taskId));
  assert(layerNames.has(report.layer));
  if (expected.taskId) assert.equal(report.taskId, expected.taskId);
  if (expected.layer) assert.equal(report.layer, expected.layer);
  assert(states.has(report.state));
  assert(report.failureClass === null || typeof report.failureClass === "string");
  validateCommand(report.command, "command");
  assert(Array.isArray(report.expectedFiles) && report.expectedFiles.length > 0 && report.expectedFiles.every((entry) => typeof entry === "string"));
  optionalInteger(report.exitCode, "exitCode");
  assert(report.signal === null || typeof report.signal === "string");
  validateTimeoutTermination(report.timeoutTermination);
  if (report.state === "timed-out") {
    assert(report.timeoutTermination !== null, "timed-out layer must record termination evidence");
    assert.equal(report.failureClass, expectedTimeoutFailureClass(report.timeoutTermination), "timed-out layer failure class is inconsistent with termination evidence");
  } else assert.equal(report.timeoutTermination, null, "non-timeout layer must not contain termination evidence");
  validateTap(report.tap);
  assert.deepEqual(report.command, ["node", "--test", "--test-concurrency=1", "--test-reporter=tap", ...report.expectedFiles], "layer command and expected files differ");
  if (expected.expectedFiles) assert.deepEqual(report.expectedFiles, expected.expectedFiles, "layer expected files differ from current manifest");
  validateBuild(report.build, expected.build ?? null);
  validateIso(report.startedAt, "startedAt");
  validateIso(report.finishedAt, "finishedAt");
  safeInteger(report.durationMs, "durationMs");
  safeInteger(report.maxRssBytes, "maxRssBytes");
  validateArtifactSnapshot(report.artifactSnapshot);
  if (report.layer === "packaged" && report.state !== "unsupported") {
    if (report.details === null) assert(report.state === "failed" && report.failureClass === "REPORT_VALIDATION", "missing packaged details require REPORT_VALIDATION failure");
    else {
      validatePackagedDetails(report.details, { passed: report.state === "passed", sinkIdentity: expected.sec02SinkIdentity ?? null });
      if (report.details.packageBinding.asarPayloadBound) {
        assert.equal(report.details.packageBinding.buildId, report.build.buildId, "installed ASAR build ID differs from report");
        assert.equal(report.details.packageBinding.sourceDigest, report.build.sourceDigest, "installed ASAR source digest differs from report");
      }
    }
  } else assert.equal(report.details, null, "only supported packaged reports may contain details");
  if (sec02Resolved) {
    const blockedBeforeTests = sec03Resolved && report.failureClass === "SEC03_BLOCKED_NATIVE_EVIDENCE";
    if (report.state === "unsupported" || blockedBeforeTests) assert.equal(report.sec02Evidence, null, "unexecuted layer must not claim SEC-02 evidence");
    else {
      assert(expected.sec02Manifest && expected.sec02Matrix && expected.sec02RunId, "SEC-02 report validation inputs are missing");
      validateSec02LayerEvidence(report.sec02Evidence, {
        manifest: expected.sec02Manifest,
        matrix: expected.sec02Matrix,
        runId: expected.sec02RunId,
      });
      if (report.state === "passed") assert.equal(report.sec02Evidence.complete, true, "passed layer has incomplete SEC-02 evidence");
    }
  }
  if (sec03Resolved) {
    assert(expected.sec03Context, "SEC-03 report validation inputs are missing");
    validateSec03Evidence(report.sec03Evidence, expected.sec03Context, report.layer);
    if (report.state === "passed") assert(["complete", "not-applicable"].includes(report.sec03Evidence.status), "passed layer has blocked SEC-03 evidence");
    if (report.sec03Evidence.status === "blocked") assert.notEqual(report.state, "passed", "blocked SEC-03 evidence cannot pass");
    if (["integration", "electron", "packaged"].includes(report.layer) && report.state === "passed") assert.equal(report.sec03Evidence.status, "complete", "native SEC-03 layer must be complete");
    if (["unit", "contract"].includes(report.layer)) {
      const expectedStatus = report.failureClass === "SEC03_BLOCKED_NATIVE_EVIDENCE" ? "blocked" : "not-applicable";
      assert.equal(report.sec03Evidence.status, expectedStatus, "non-native SEC-03 layer evidence status differs");
      assert.equal(report.sec03Evidence.expectedCount, 0);
      assert.equal(report.sec03Evidence.validCount, 0, "non-native layer cannot contribute runtime receipts");
    }
  }
  if (report.state === "passed") {
    assert.equal(report.failureClass, null);
    assert.equal(report.exitCode, 0);
    assert.equal(report.signal, null);
    assert.equal(report.timeoutTermination, null);
    assert.equal(report.artifactSnapshot.unchanged, true);
    for (const key of ["tests", "passed", "failed", "skipped", "cancelled", "todo"]) assert(Number.isSafeInteger(report.tap[key]), `passed report tap.${key} must be an integer`);
    assert(report.tap.tests > 0 && report.tap.passed > 0, "passed report must execute tests");
    assert.equal(report.tap.failed, 0);
    assert.equal(report.tap.cancelled, 0);
    if (sec02Resolved) {
      assert.equal(report.tap.skipped, 0, "resolved cumulative layer may not skip tests");
      assert.equal(report.tap.todo, 0, "resolved cumulative layer may not contain todo tests");
    }
    assert.equal(report.tap.tests, report.tap.passed + report.tap.failed + report.tap.skipped + report.tap.cancelled + report.tap.todo, "TAP totals are inconsistent");
  }
  validateNoSensitiveData(report);
  return report;
}

function validateMetric(value, field) {
  exactKeys(value, ["covered", "total", "threshold", "passed"], field);
  safeInteger(value.covered, `${field}.covered`);
  safeInteger(value.total, `${field}.total`);
  assert(value.covered <= value.total, `${field}.covered exceeds total`);
  assert(Number.isInteger(value.threshold) && value.threshold >= 0 && value.threshold <= 100);
  assert.equal(value.passed, exactPercentPassed(value.covered, value.total, value.threshold), `${field}.passed is inconsistent`);
}

function validateCoverageEvaluation(value, scope = null) {
  if (value === null) return;
  exactKeys(value, ["passed", "overallLines", "securityBranches", "files", "zeroHitFiles", "missingFiles", "unexpectedFiles", "perFilePassed"], "evaluation");
  assert.equal(typeof value.passed, "boolean");
  validateMetric(value.overallLines, "evaluation.overallLines");
  validateMetric(value.securityBranches, "evaluation.securityBranches");
  assert(Array.isArray(value.files));
  const paths = [];
  let overallCovered = 0;
  let overallTotal = 0;
  let securityCovered = 0;
  let securityTotal = 0;
  for (const file of value.files) {
    exactKeys(file, ["path", "lines", "branches", "securityCritical", "lineMinimum", "lineFloorPassed", "securityDenominatorPassed", "zeroHit"], "evaluation file");
    assert.equal(typeof file.path, "string");
    paths.push(file.path);
    for (const metric of ["lines", "branches"]) {
      exactKeys(file[metric], ["total", "covered", "uncovered"], `evaluation file ${metric}`);
      safeInteger(file[metric].total, `${metric}.total`);
      safeInteger(file[metric].covered, `${metric}.covered`);
      safeInteger(file[metric].uncovered, `${metric}.uncovered`);
      assert.equal(file[metric].covered + file[metric].uncovered, file[metric].total);
    }
    assert.equal(typeof file.securityCritical, "boolean");
    assert(file.lineMinimum === null || (Number.isInteger(file.lineMinimum) && file.lineMinimum >= 0 && file.lineMinimum <= 100));
    const lineFloorPassed = file.lineMinimum === null || exactPercentPassed(file.lines.covered, file.lines.total, file.lineMinimum);
    const securityDenominatorPassed = !file.securityCritical || file.branches.total > 0;
    const zeroHit = file.lines.covered === 0 && file.branches.covered === 0;
    assert.equal(file.lineFloorPassed, lineFloorPassed, `line floor result is inconsistent for ${file.path}`);
    assert.equal(file.securityDenominatorPassed, securityDenominatorPassed, `security denominator result is inconsistent for ${file.path}`);
    assert.equal(file.zeroHit, zeroHit, `zero-hit result is inconsistent for ${file.path}`);
    overallCovered += file.lines.covered;
    overallTotal += file.lines.total;
    if (file.securityCritical) {
      securityCovered += file.branches.covered;
      securityTotal += file.branches.total;
    }
    assert(Number.isSafeInteger(overallCovered) && Number.isSafeInteger(overallTotal) && Number.isSafeInteger(securityCovered) && Number.isSafeInteger(securityTotal), "coverage aggregates exceed safe integers");
  }
  assertUniqueStrings(paths, "evaluation file paths");
  assert.deepEqual(value.overallLines, { ...value.overallLines, covered: overallCovered, total: overallTotal }, "overall line counters differ from file sum");
  assert.deepEqual(value.securityBranches, { ...value.securityBranches, covered: securityCovered, total: securityTotal }, "security branch counters differ from file sum");
  for (const key of ["zeroHitFiles", "missingFiles", "unexpectedFiles"]) assertUniqueStrings(value[key], `evaluation.${key}`);
  assert.deepEqual(value.zeroHitFiles, value.files.filter((entry) => entry.zeroHit).map((entry) => entry.path), "zeroHitFiles is inconsistent");
  const perFilePassed = value.files.every((entry) => entry.lineFloorPassed && entry.securityDenominatorPassed);
  assert.equal(value.perFilePassed, perFilePassed, "perFilePassed is inconsistent");
  if (scope) {
    const pathSet = new Set(paths.map((entry) => process.platform === "win32" ? entry.toLowerCase() : entry));
    const expectedPresent = scope.overall.filter((entry) => pathSet.has(process.platform === "win32" ? entry.toLowerCase() : entry));
    const expectedMissing = scope.overall.filter((entry) => !pathSet.has(process.platform === "win32" ? entry.toLowerCase() : entry));
    assert.deepEqual(paths, expectedPresent, "coverage file order or registry differs from current scope");
    assert.deepEqual(value.missingFiles, expectedMissing, "missingFiles differs from current scope");
    assert.equal(value.overallLines.threshold, scope.thresholds.overallLines);
    assert.equal(value.securityBranches.threshold, scope.thresholds.securityBranches);
    const security = new Set(scope.securityCritical.map((entry) => process.platform === "win32" ? entry.toLowerCase() : entry));
    for (const file of value.files) {
      const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
      assert.equal(file.securityCritical, security.has(key), `security classification differs for ${file.path}`);
      assert.equal(file.lineMinimum, scope.perFileLineMinimum[file.path] ?? null, `line minimum differs for ${file.path}`);
    }
  }
  const passed = value.missingFiles.length === 0 && value.unexpectedFiles.length === 0
    && value.overallLines.passed && value.securityBranches.passed && value.perFilePassed;
  assert.equal(value.passed, passed, "evaluation.passed is inconsistent");
}

export function validateCoverageReport(report, expected = {}) {
  exactKeys(report, ["reportVersion", "taskId", "state", "failureClass", "startedAt", "finishedAt", "durationMs", "registrySha256", "nodeVersion", "c8Version", "testExitCode", "testSignal", "testTimedOut", "timeoutTermination", "evaluation", "reportError", "inventory", "coverageExemptions", "artifactSnapshot", "maxRssBytes", "preservedOutput", "staleSeedFiles"], "coverage report");
  assert.equal(report.reportVersion, 1);
  assert.match(report.taskId, /^[A-Z]+-\d{2}$/);
  if (expected.taskId) assert.equal(report.taskId, expected.taskId);
  assert(states.has(report.state));
  assert(report.failureClass === null || typeof report.failureClass === "string");
  validateIso(report.startedAt, "startedAt");
  validateIso(report.finishedAt, "finishedAt");
  safeInteger(report.durationMs, "durationMs");
  assert.match(report.registrySha256, sha256Pattern);
  assert.equal(typeof report.nodeVersion, "string");
  assert.equal(typeof report.c8Version, "string");
  optionalInteger(report.testExitCode, "testExitCode");
  assert(report.testSignal === null || typeof report.testSignal === "string");
  assert.equal(typeof report.testTimedOut, "boolean");
  validateTimeoutTermination(report.timeoutTermination);
  assert.equal(report.testTimedOut, report.timeoutTermination !== null, "timeout termination evidence is inconsistent");
  if (report.testTimedOut) {
    assert.equal(report.state, "timed-out", "timed-out coverage must use timed-out state");
    assert.equal(report.failureClass, expectedTimeoutFailureClass(report.timeoutTermination), "coverage timeout failure class is inconsistent with termination evidence");
  }
  validateCoverageEvaluation(report.evaluation, expected.coverageScope ?? null);
  assert(report.reportError === null || typeof report.reportError === "string");
  exactKeys(report.inventory, ["authoredProductionFiles", "registeredAuthoredEquivalents", "unregisteredLegacyDebt"], "inventory");
  for (const [key, count] of Object.entries(report.inventory)) safeInteger(count, `inventory.${key}`);
  assert(report.coverageExemptions && typeof report.coverageExemptions === "object" && !Array.isArray(report.coverageExemptions));
  validateArtifactSnapshot(report.artifactSnapshot);
  safeInteger(report.maxRssBytes, "maxRssBytes");
  assert.equal(typeof report.preservedOutput, "boolean");
  safeInteger(report.staleSeedFiles, "staleSeedFiles");
  if (report.state === "passed") {
    assert.equal(report.failureClass, null);
    assert.equal(report.testExitCode, 0);
    assert.equal(report.testSignal, null);
    assert.equal(report.testTimedOut, false);
    assert.equal(report.reportError, null);
    assert.equal(report.evaluation?.passed, true);
    assert.equal(report.artifactSnapshot.unchanged, true);
  }
  validateNoSensitiveData(report);
  return report;
}

export function validateSelfTestReport(report, expected = {}) {
  exactKeys(report, ["reportVersion", "taskId", "state", "failureClass", "startedAt", "finishedAt", "durationMs", "scenarios", "cleanupPassed", "baselineUnchanged", "artifactSnapshot", "maxRssBytes"], "self-test report");
  assert.equal(report.reportVersion, 1);
  assert.match(report.taskId, /^[A-Z]+-\d{2}$/);
  if (expected.taskId) assert.equal(report.taskId, expected.taskId);
  assert(states.has(report.state));
  assert(report.failureClass === null || typeof report.failureClass === "string");
  validateIso(report.startedAt, "startedAt");
  validateIso(report.finishedAt, "finishedAt");
  safeInteger(report.durationMs, "durationMs");
  assert(Array.isArray(report.scenarios));
  assert.deepEqual(report.scenarios.map(({ name, expected }) => ({ name, expected })), selfTestScenarioContract, "self-test scenario contract differs from the fixed fault matrix");
  for (const scenario of report.scenarios) {
    exactKeys(scenario, ["name", "expected", "actual", "passed", "details"], "self-test scenario");
    assert.equal(typeof scenario.name, "string");
    assert.equal(typeof scenario.expected, "string");
    assert.equal(typeof scenario.actual, "string");
    assert.equal(typeof scenario.passed, "boolean");
  }
  assert.equal(typeof report.cleanupPassed, "boolean");
  assert.equal(typeof report.baselineUnchanged, "boolean");
  validateArtifactSnapshot(report.artifactSnapshot);
  safeInteger(report.maxRssBytes, "maxRssBytes");
  if (report.state === "passed") assert(report.scenarios.every((entry) => entry.passed) && report.cleanupPassed && report.baselineUnchanged && report.artifactSnapshot.unchanged);
  validateNoSensitiveData(report);
  return report;
}

export function validateUnifiedReport(report, expected = {}) {
  const sec03Resolved = report.taskId === "SEC-03";
  const sec02Resolved = sec03Resolved || report.taskId === "SEC-02" || report.taskId === "GOV-03";
  const keys = ["reportVersion", "taskId", "profile", "state", "baseline", "personaChain", "build", "startedAt", "finishedAt", "durationMs", "expected", "actual", "results", "cleanupPassed", "artifactSnapshot", "metrics", "knownLimitations", "reviewerVerdict", "userStatus"];
  if (sec02Resolved) keys.push("sec02Evidence");
  if (sec03Resolved) keys.push("sec03Evidence");
  exactKeys(report, keys, "unified report");
  assert.equal(report.reportVersion, sec03Resolved ? 3 : sec02Resolved ? 2 : 1);
  assert.match(report.taskId, /^[A-Z]+-\d{2}$/);
  if (expected.taskId) assert.equal(report.taskId, expected.taskId);
  assert(["quick", "full"].includes(report.profile));
  assert(sec03Resolved ? ["passed", "failed", "partial"].includes(report.state) : ["passed", "failed"].includes(report.state));
  validateBaseline(report.baseline);
  assert.deepEqual(report.personaChain, expectedPersonaChain(report.taskId));
  validateBuild(report.build, expected.build ?? null);
  validateIso(report.startedAt, "startedAt");
  validateIso(report.finishedAt, "finishedAt");
  safeInteger(report.durationMs, "durationMs");
  const required = report.profile === "full"
    ? ["unit", "contract", "integration", "electron", "packaged", "coverage", "self-test"]
    : sec03Resolved ? ["unit", "contract", "integration", "electron"] : ["unit", "contract", "integration", "electron", "coverage"];
  assert.deepEqual(report.expected, required, "profile expected steps differ from the fixed gate");
  assertUniqueStrings(report.actual, "actual");
  assert(Array.isArray(report.results));
  assert.deepEqual(report.actual, report.results.map((entry) => entry.name), "actual steps differ from result order");
  assert.deepEqual(report.actual, required.slice(0, report.actual.length), "results are not a prefix of the fixed gate");
  for (const result of report.results) {
    exactKeys(result, ["kind", "name", "exitCode", "report", "reportValidation"], "unified result");
    assert(["layer", "gate"].includes(result.kind));
    assert.equal(typeof result.name, "string");
    optionalInteger(result.exitCode, "unified result exitCode");
    assert(result.reportValidation === null || typeof result.reportValidation === "string");
    if (result.report === null) assert.equal(typeof result.reportValidation, "string", "missing report requires validation failure");
    else if (result.kind === "layer") validateLayerReport(result.report, {
      taskId: report.taskId,
      layer: result.name,
      build: report.build,
      expectedFiles: expected.layerExpectedFiles?.[result.name],
      sec02Manifest: expected.sec02Manifest,
      sec02Matrix: expected.sec02Matrix,
      sec02RunId: expected.sec02RunId,
      sec03Context: expected.sec03Context,
    });
    else if (result.name === "coverage") validateCoverageReport(result.report, { taskId: report.taskId, coverageScope: expected.coverageScope ?? null });
    else if (result.name === "self-test") validateSelfTestReport(result.report, { taskId: report.taskId });
    else assert.fail(`unknown unified gate: ${result.name}`);
  }
  if (sec02Resolved && report.sec02Evidence !== null) {
    assert(expected.sec02Manifest && expected.sec02Matrix && expected.sec02RunId, "SEC-02 unified report validation inputs are missing");
    validateSec02UnifiedEvidence(
      report.sec02Evidence,
      report.results.filter(result => result.kind === "layer").map(result => ({
        layer: result.name,
        receipts: result.report?.sec02Evidence?.receipts ?? null,
      })),
      { manifest: expected.sec02Manifest, matrix: expected.sec02Matrix, runId: expected.sec02RunId },
    );
  }
  if (sec03Resolved) {
    assert(expected.sec03Context, "SEC-03 unified report validation inputs are missing");
    const receipts = report.results.filter((result) => result.kind === "layer").flatMap((result) => result.report?.sec03Evidence?.receipts ?? []);
    const recomputed = recomputeSec03Evidence(receipts, { ...expected.sec03Context, layer: "unified" });
    assert.deepEqual(report.sec03Evidence, recomputed, "SEC-03 unified evidence differs from parent recomputation");
    if (report.state === "passed") assert.equal(report.sec03Evidence.status, "complete", "passed SEC-03 unified report requires 482 exact receipts");
  }
  assert.equal(typeof report.cleanupPassed, "boolean");
  validateArtifactSnapshot(report.artifactSnapshot);
  exactKeys(report.metrics, ["toolCalls", "llmCalls", "tokens", "runnerMaxRssBytes"], "metrics");
  for (const [key, count] of Object.entries(report.metrics)) safeInteger(count, `metrics.${key}`);
  assert(Array.isArray(report.knownLimitations) && report.knownLimitations.every((entry) => typeof entry === "string"));
  assert.equal(report.reviewerVerdict, null);
  assert.equal(report.userStatus, "not-reviewed");
  const sec02EvidencePassed = !sec02Resolved || report.profile === "quick" || report.sec02Evidence?.complete === true;
  const childrenPassed = report.actual.length === required.length
    && report.results.every((entry) => entry.exitCode === 0 && entry.reportValidation === null && entry.report?.state === "passed")
    && sec02EvidencePassed && report.cleanupPassed && report.artifactSnapshot.unchanged;
  const semanticallyPassed = childrenPassed && (!sec03Resolved || (report.profile === "full" && report.sec03Evidence?.status === "complete"));
  assert.equal(report.state === "passed", semanticallyPassed, "unified state is inconsistent with child evidence");
  if (sec03Resolved && report.profile === "quick") assert.equal(report.state, childrenPassed ? "partial" : "failed", "SEC-03 quick state is inconsistent");
  validateNoSensitiveData(report);
  return report;
}
