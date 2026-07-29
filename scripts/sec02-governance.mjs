import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSec02SinkInventory } from "./sec02-sink-inventory.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const layerNames = Object.freeze(["unit", "contract", "integration", "electron", "packaged"]);
export const resolvedManifestPath = "tests/manifests/sec-02-resolved.json";
const sha256Pattern = /^[a-f0-9]{64}$/;
const frozenSourceHashes = Object.freeze({
  "SEC-01": "b836976785366f01d1147fef99fe30c53d44d07969708564e64ec3cd2d424964",
  "GOV-03": "97907ee2f8e66e99381e52743ff8acb70bf82d640b641dc05f6ff6891194ba1f",
});
const expectedViewCounts = Object.freeze({ "SEC-01": 12, "SEC-02": 30, "GOV-03": 31 });
const sourcePaths = Object.freeze({
  "SEC-01": "tests/manifests/sec-01.json",
  "SEC-02": "tests/manifests/sec-02.json",
  "GOV-03": "tests/manifests/gov-03.json",
});
const governedArtifacts = Object.freeze([
  "parity/SEC-02-PATH-POLICY-ARCHITECTURE.md",
  "parity/SEC-02-P36-RUNTIME-DIALECT-AMENDMENT-01.md",
  "parity/reports/sec-02-p36-runtime-dialect-freeze.json",
  "tests/sec02-attack-matrix.json",
  "tests/sec02-attack-matrix.schema.json",
  "parity/schema/sec-02-governance-contract.json",
  "parity/reports/sec-02-architect-freeze.json",
  "parity/scripts/validate-sec02-architecture.mjs",
  "tests/coverage-scope.json",
  "tests/helpers.mjs",
  "scripts/run-tests.mjs",
  "scripts/run-test-layer.mjs",
  "scripts/run-coverage.mjs",
  "scripts/report-schema.mjs",
  "scripts/test-gate-selftest.mjs",
  "scripts/run-gov04.mjs",
  "scripts/build-inputs.mjs",
  "scripts/build-electron.mjs",
  "scripts/electron-asar-integrity.mjs",
  "scripts/electron-stage-integrity.mjs",
  "scripts/prepare-electron-app.mjs",
  "scripts/sec02-sink-scanner.mjs",
  "scripts/sec02-sink-crosscheck.mjs",
  "scripts/sec02-sink-inventory.mjs",
  "tests/sec02-sink-inventory.json",
  "tests/sec02-sink-policy.json",
  "tests/sec02-sink-crosscheck-policy.json",
  "tests/sec02-sink-inventory.schema.json",
  "tests/contract/sec02-sink-inventory.test.mjs",
  "scripts/gov04/identity.mjs",
  "scripts/gov04/report-schema.mjs",
  "scripts/sec02-governance.mjs",
  "scripts/sec02-receipt-set.mjs",
  "scripts/generate-sec02-resolved-manifest.mjs",
  "tests/sec02-evidence-map.json",
  "tests/sec02-receipts.mjs",
  "tests/sec02-path-policy-details.schema.json",
  "tests/contract/sec02-governance.test.mjs",
  "package.json",
  "package-lock.json",
]);
const unifiedRunnerObservationIds = new Set([
  "SEC02-P34-all-denial-receipts-audited",
  "SEC02-P35-fixed-positive-set-complete",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPayloadSha256(value) {
  const { canonicalPayloadSha256: _digest, ...payload } = value;
  return sha256Bytes(canonicalJson(payload));
}

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

export function validateSec02ObservationActual(observation, actual) {
  assert(observation && typeof observation === "object", "SEC-02 observation is missing");
  assert(actual && typeof actual === "object" && !Array.isArray(actual), `${observation.id} actual must be an object`);
  const expected = observation.expected;
  if (Array.isArray(expected.allowedOutcomes)) {
    const selected = expected.allowedOutcomes.find(candidate => candidate.outcome === actual.outcome);
    assert(selected, `${observation.id} actual outcome is not allowed`);
    const translated = { receiptPresent: expected.receiptPresent, skipped: expected.skipped, ...selected };
    assert.deepEqual(actual, translated, `${observation.id} conditional outcome differs`);
    return { passed: selected.verdictContribution === "pass", neutral: selected.verdictContribution === "neutral" };
  }

  const translated = { ...expected };
  if (Array.isArray(expected.allowedCleanupOutcomes)) {
    delete translated.allowedCleanupOutcomes;
    assert.equal(typeof actual.cleanupOutcome, "string", `${observation.id} cleanupOutcome is missing`);
    assert(expected.allowedCleanupOutcomes.includes(actual.cleanupOutcome), `${observation.id} cleanupOutcome is not allowed`);
    translated.cleanupOutcome = actual.cleanupOutcome;
  }
  if (Array.isArray(expected.allowedFinalStates)) {
    delete translated.allowedFinalStates;
    assert.equal(typeof actual.finalState, "string", `${observation.id} finalState is missing`);
    assert(expected.allowedFinalStates.includes(actual.finalState), `${observation.id} finalState is not allowed`);
    translated.finalState = actual.finalState;
  }
  assert.deepEqual(actual, translated, `${observation.id} actual state differs from the frozen expectation`);
  return { passed: true, neutral: false };
}

function safeRelativePath(value, field) {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(value && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value), `${field} must be a POSIX relative path`);
  assert.equal(path.posix.normalize(value), value, `${field} must be normalized`);
  assert(!value.startsWith("../") && !value.includes("/../"), `${field} escapes the project`);
}

export async function assertExactRegularProjectFile(relative, root = projectRoot, field = "path") {
  safeRelativePath(relative, field);
  let cursor = root;
  for (const segment of relative.split("/")) {
    const names = await readdir(cursor);
    assert(names.includes(segment), `${field} casing differs on disk: ${relative}`);
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    assert(!info.isSymbolicLink(), `${field} traverses a symlink or junction: ${relative}`);
  }
  assert((await stat(cursor)).isFile(), `${field} is not a regular file: ${relative}`);
  const containment = path.relative(await realpath(root), await realpath(cursor));
  assert(containment && containment !== ".." && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes the project: ${relative}`);
  return cursor;
}

async function readBoundFile(relative, root = projectRoot, field = "path") {
  const absolute = await assertExactRegularProjectFile(relative, root, field);
  const bytes = await readFile(absolute);
  return { bytes, sha256: sha256Bytes(bytes) };
}

function assertUniqueExactPaths(paths, field) {
  assert.equal(new Set(paths).size, paths.length, `${field} contains duplicate exact paths`);
  const folded = new Set();
  for (const entry of paths) {
    const identity = entry.toLowerCase();
    assert(!folded.has(identity), `${field} contains a case alias: ${entry}`);
    folded.add(identity);
  }
}

async function loadSource(taskId, root) {
  const relative = sourcePaths[taskId];
  const { bytes, sha256 } = await readBoundFile(relative, root, `${taskId} source manifest`);
  if (frozenSourceHashes[taskId]) assert.equal(sha256, frozenSourceHashes[taskId], `${taskId} frozen predecessor hash changed`);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.taskId, taskId);
  assert.deepEqual(Object.keys(manifest.layers), layerNames);
  const tests = [];
  for (const layer of layerNames) {
    for (const exactCasePath of manifest.layers[layer]) {
      const test = await readBoundFile(exactCasePath, root, `${taskId} ${layer} test`);
      tests.push({ exactCasePath, sha256: test.sha256, layer, sourceTask: taskId });
    }
  }
  assertUniqueExactPaths(tests.map(record => record.exactCasePath), `${taskId} tests`);
  return { taskId, relative, sha256, manifest, tests };
}

function stableUnion(left, right, key) {
  const result = [];
  const seen = new Set();
  for (const entry of [...left, ...right]) {
    const identity = key(entry);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(entry);
    }
  }
  return result;
}

function sourceQualifiedExemptions(sources) {
  return sources.flatMap(source => Object.entries(source.manifest.coverageExemptions).map(([exactCasePath, exemption]) => ({
    sourceTask: source.taskId,
    exactCasePath,
    reason: exemption.reason,
    evidenceLayer: exemption.evidenceLayer,
  })));
}

async function makeViews(sources) {
  const sec01 = sources[0].tests;
  const sec02 = stableUnion(sec01, sources[1].tests, entry => entry.exactCasePath);
  const gov03 = stableUnion(sec02, sources[2].tests, entry => entry.exactCasePath);
  const sourceGroups = [[sources[0]], sources.slice(0, 2), sources];
  return [sec01, sec02, gov03].map((tests, index) => {
    const taskId = ["SEC-01", "SEC-02", "GOV-03"][index];
    assert.equal(tests.length, expectedViewCounts[taskId], `${taskId} cumulative test count changed`);
    const changedRuntimeFiles = stableUnion([], sourceGroups[index].flatMap(source => source.manifest.changedRuntimeFiles), entry => entry);
    assertUniqueExactPaths(changedRuntimeFiles, `${taskId} changed runtime files`);
    return {
      taskId,
      tests,
      changedRuntimeFiles,
      coverageExemptions: sourceQualifiedExemptions(sourceGroups[index]),
    };
  });
}

function ownerFields(owner, field) {
  assert(owner && typeof owner === "object" && !Array.isArray(owner), `${field} owner is missing`);
  assert.deepEqual(Object.keys(owner).sort(), ["layer", "producer", "testCaseId", "testFile"], `${field} owner fields changed`);
  assert(layerNames.includes(owner.layer), `${field} layer is invalid`);
  assert.equal(typeof owner.testCaseId, "string");
  assert(["node-test", "unified-runner"].includes(owner.producer), `${field} producer is invalid`);
  safeRelativePath(owner.testFile, `${field} testFile`);
  return owner;
}

async function bindOwner(owner, root, field) {
  ownerFields(owner, field);
  const { bytes, sha256 } = await readBoundFile(owner.testFile, root, `${field} testFile`);
  assert(bytes.toString("utf8").includes(`test(${JSON.stringify(owner.testCaseId)}`), `${field} has a stale testCaseId`);
  return {
    layer: owner.layer,
    test: { exactCasePath: owner.testFile, sha256 },
    testCaseId: owner.testCaseId,
    producer: owner.producer,
  };
}

async function expandEvidence(matrix, evidenceMap, root) {
  assert.equal(evidenceMap.schemaVersion, 1);
  assert.equal(evidenceMap.task, "SEC-02");
  assert.equal(typeof evidenceMap.stimulusDigestDomain, "string");
  const scenarioIds = matrix.scenarios.map(scenario => scenario.id);
  assert.deepEqual(Object.keys(evidenceMap.scenarioOwners), scenarioIds, "scenario owner set/order differs from frozen matrix");
  const observations = [];
  const observationIds = new Set();
  for (const scenario of matrix.scenarios) {
    const scenarioOwner = evidenceMap.scenarioOwners[scenario.id];
    for (const observation of scenario.observations) {
      assert(!observationIds.has(observation.id), `duplicate observation ${observation.id}`);
      observationIds.add(observation.id);
      const owner = evidenceMap.observationOverrides[observation.id] ?? scenarioOwner;
      const binding = await bindOwner(owner, root, observation.id);
      if (binding.producer === "unified-runner") assert(unifiedRunnerObservationIds.has(observation.id), `${observation.id} may not use unified-runner`);
      observations.push({
        observationId: observation.id,
        evidenceTier: observation.evidenceTier,
        stimulusCanonicalSha256: sha256Bytes(evidenceMap.stimulusDigestDomain + canonicalJson(observation.stimulus)),
        ...binding,
      });
    }
  }
  assert.equal(observations.length, 411);
  assert.equal(observationIds.size, 411);
  for (const overrideId of Object.keys(evidenceMap.observationOverrides)) assert(observationIds.has(overrideId), `stale observation override ${overrideId}`);

  assert.deepEqual(Object.keys(evidenceMap.positiveOwners), matrix.positiveReceiptIds, "positive owner set/order differs from frozen matrix");
  const positives = [];
  for (const positiveReceiptId of matrix.positiveReceiptIds) {
    const binding = await bindOwner(evidenceMap.positiveOwners[positiveReceiptId], root, positiveReceiptId);
    assert.notEqual(binding.producer, "unified-runner", `${positiveReceiptId} must bind a concrete producer`);
    positives.push({ positiveReceiptId, ...binding });
  }
  assert.equal(positives.length, 22);
  return { stimulusDigestDomain: evidenceMap.stimulusDigestDomain, observations, positives };
}

function receiptHash(receipt) {
  const { receiptSha256: _ignored, ...payload } = receipt;
  return sha256Bytes(canonicalJson(payload));
}

export function validateSec02Receipt(receipt, { manifest, matrix, runId }) {
  assert(manifest && matrix, "SEC-02 receipt validation inputs are missing");
  assert.equal(receipt?.schemaVersion, 1);
  assert(["observation", "positive"].includes(receipt.kind), "SEC-02 receipt kind is invalid");
  const commonKeys = [
    "schemaVersion", "kind", "runId", "resolvedManifestSha256", "matrixSha256", "id",
    "evidenceFile", "testCaseId", "actual", "actualSha256", "passed", "skipped", "todo",
    "mockSubstitution", "receiptSha256",
  ];
  const expectedKeys = receipt.kind === "observation"
    ? [...commonKeys, "evidenceTier", "stimulusSha256"]
    : commonKeys;
  exactKeys(receipt, expectedKeys, "SEC-02 receipt");
  assert.equal(receipt.runId, runId, "SEC-02 receipt run ID differs");
  assert.equal(receipt.resolvedManifestSha256, manifest.canonicalPayloadSha256, "SEC-02 receipt resolved digest differs");
  const matrixBinding = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json");
  assert(matrixBinding, "SEC-02 resolved manifest does not bind the attack matrix");
  assert.equal(receipt.matrixSha256, matrixBinding.sha256, "SEC-02 receipt matrix digest differs");
  assert.equal(receipt.actualSha256, sha256Bytes(canonicalJson(receipt.actual)), "SEC-02 receipt actual digest differs");
  assert.equal(receipt.receiptSha256, receiptHash(receipt), "SEC-02 receipt digest differs");
  assert.equal(receipt.skipped, false, "SEC-02 receipt may not be skipped");
  assert.equal(receipt.todo, false, "SEC-02 receipt may not be todo");
  assert.equal(receipt.mockSubstitution, false, "SEC-02 receipt may not use a mock substitution");

  if (receipt.kind === "positive") {
    const binding = manifest.evidence.positives.find(entry => entry.positiveReceiptId === receipt.id);
    assert(binding, `unknown SEC-02 positive receipt: ${receipt.id}`);
    assert.equal(receipt.evidenceFile, binding.test.exactCasePath, `${receipt.id} evidence file differs`);
    assert.equal(receipt.testCaseId, binding.testCaseId, `${receipt.id} testCaseId differs`);
    assert.deepEqual(receipt.actual, { passed: true }, `${receipt.id} positive actual differs`);
    assert.equal(receipt.passed, true, `${receipt.id} positive receipt did not pass`);
    return { kind: "positive", id: receipt.id, passed: true, neutral: false };
  }

  const binding = manifest.evidence.observations.find(entry => entry.observationId === receipt.id);
  assert(binding, `unknown SEC-02 observation receipt: ${receipt.id}`);
  assert.equal(receipt.evidenceTier, binding.evidenceTier, `${receipt.id} evidence tier differs`);
  assert.equal(receipt.stimulusSha256, binding.stimulusCanonicalSha256, `${receipt.id} stimulus digest differs`);
  assert.equal(receipt.evidenceFile, binding.test.exactCasePath, `${receipt.id} evidence file differs`);
  assert.equal(receipt.testCaseId, binding.testCaseId, `${receipt.id} testCaseId differs`);
  const observation = matrix.scenarios.flatMap(scenario => scenario.observations).find(entry => entry.id === receipt.id);
  assert(observation, `frozen SEC-02 observation is missing: ${receipt.id}`);
  const evaluation = validateSec02ObservationActual(observation, receipt.actual);
  assert.equal(receipt.passed, evaluation.passed, `${receipt.id} passed flag is self-inconsistent`);
  return { kind: "observation", id: receipt.id, ...evaluation };
}

async function loadCoverage(root) {
  const relative = "tests/coverage-scope.json";
  const { bytes, sha256 } = await readBoundFile(relative, root, "coverage scope");
  const scope = JSON.parse(bytes);
  assert(scope.thresholds.overallLines >= 80, "overall line threshold weakened");
  assert(scope.thresholds.securityBranches >= 90, "security branch threshold weakened");
  assert(scope.perFileLineMinimum["dist/path-policy.js"] >= 90, "PathPolicy line floor weakened");
  for (const exactCasePath of scope.overall) await assertExactRegularProjectFile(exactCasePath, root, "coverage file");
  return {
    source: { exactCasePath: relative, sha256 },
    overallFiles: scope.overall,
    securityCriticalFiles: scope.securityCritical,
    thresholds: scope.thresholds,
    perFileLineMinimum: scope.perFileLineMinimum,
  };
}

async function bindArtifacts(root) {
  const bindings = [];
  for (const exactCasePath of governedArtifacts) {
    assert.notEqual(exactCasePath, resolvedManifestPath, "resolved manifest cannot hash itself");
    const { sha256 } = await readBoundFile(exactCasePath, root, "governed artifact");
    bindings.push({ exactCasePath, sha256 });
  }
  return bindings;
}

function tupleSet(records) {
  return new Set(records.map(record => `${record.exactCasePath}\0${record.sha256}`));
}

export function assertCumulativeInclusion(views) {
  for (let index = 1; index < views.length; index += 1) {
    const next = tupleSet(views[index].tests);
    for (const tuple of tupleSet(views[index - 1].tests)) assert(next.has(tuple), `${views[index - 1].taskId} test tuple missing from ${views[index].taskId}`);
  }
}

export async function buildSec02ResolvedManifest(options = {}) {
  const root = options.root ?? projectRoot;
  await validateSec02SinkInventory(root);
  const sources = await Promise.all(["SEC-01", "SEC-02", "GOV-03"].map(taskId => loadSource(taskId, root)));
  const matrix = options.matrix ?? JSON.parse((await readBoundFile("tests/sec02-attack-matrix.json", root, "attack matrix")).bytes);
  const evidenceMap = options.evidenceMap ?? JSON.parse((await readBoundFile("tests/sec02-evidence-map.json", root, "evidence map")).bytes);
  const views = await makeViews(sources);
  assertCumulativeInclusion(views);
  const payload = {
    schemaVersion: 1,
    task: "SEC-02",
    state: "governance-runtime-receipts-complete",
    sourceManifests: sources.map(source => ({ taskId: source.taskId, exactCasePath: source.relative, sha256: source.sha256, frozenPredecessorSha256: frozenSourceHashes[source.taskId] ?? null })),
    cumulativeViews: views,
    coverageScope: await loadCoverage(root),
    evidence: await expandEvidence(matrix, evidenceMap, root),
    governedArtifacts: await bindArtifacts(root),
    exclusions: [],
  };
  return { ...payload, canonicalPayloadSha256: canonicalPayloadSha256(payload) };
}

export async function validateSec02ResolvedManifest(manifest, options = {}) {
  const root = options.root ?? projectRoot;
  assert.equal(manifest.canonicalPayloadSha256, canonicalPayloadSha256(manifest), "canonical payload digest differs");
  assert.match(manifest.canonicalPayloadSha256, sha256Pattern);
  const expected = await buildSec02ResolvedManifest({ root, evidenceMap: options.evidenceMap, matrix: options.matrix });
  assert.deepEqual(manifest, expected, "resolved SEC-02 manifest differs from governed inputs");
  assertCumulativeInclusion(manifest.cumulativeViews);
  return manifest;
}

export function serializeResolvedManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
