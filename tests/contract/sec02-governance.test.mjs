import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { validateSec02Architecture } from "../../parity/scripts/validate-sec02-architecture.mjs";
import {
  assertCumulativeInclusion,
  buildSec02ResolvedManifest,
  canonicalJson,
  canonicalPayloadSha256,
  projectRoot,
  resolvedManifestPath,
  sha256Bytes,
  validateSec02ObservationActual,
  validateSec02Receipt,
  validateSec02ResolvedManifest,
} from "../../scripts/sec02-governance.mjs";

const run = promisify(execFile);
const resolvedPath = path.join(projectRoot, ...resolvedManifestPath.split("/"));

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(projectRoot, ...relative.split("/")), "utf8"));
}

function redigest(manifest) {
  manifest.canonicalPayloadSha256 = canonicalPayloadSha256(manifest);
  return manifest;
}

test("SEC-02 frozen architecture, matrix, predecessor manifests and pipeline inputs remain exact", async () => {
  assert.deepEqual(await validateSec02Architecture(), {
    schemaVersion: 2,
    state: "architecture-frozen",
    scenarios: 36,
    observations: 411,
    denials: 380,
    positives: 22,
  });
});

test("SEC-02 generator is canonical, byte-stable, and fully bound", async () => {
  await run(process.execPath, ["scripts/generate-sec02-resolved-manifest.mjs", "--check"], { cwd: projectRoot });
  const manifest = JSON.parse(await readFile(resolvedPath, "utf8"));
  await validateSec02ResolvedManifest(manifest);
  assert.equal(manifest.evidence.observations.length, 411);
  assert.equal(new Set(manifest.evidence.observations.map(binding => binding.observationId)).size, 411);
  assert.equal(manifest.evidence.positives.length, 22);
  assert.equal(new Set(manifest.evidence.positives.map(binding => binding.positiveReceiptId)).size, 22);
  assert.deepEqual(
    manifest.evidence.observations.filter(binding => binding.producer === "unified-runner").map(binding => binding.observationId),
    ["SEC02-P34-all-denial-receipts-audited", "SEC02-P35-fixed-positive-set-complete"],
  );
});

test("SEC-02 cumulative views preserve frozen hashes, counts, tuples and source-qualified exemptions", async () => {
  const manifest = await buildSec02ResolvedManifest();
  assert.deepEqual(manifest.sourceManifests.map(source => [source.taskId, source.frozenPredecessorSha256]), [
    ["SEC-01", "b836976785366f01d1147fef99fe30c53d44d07969708564e64ec3cd2d424964"],
    ["SEC-02", null],
    ["GOV-03", "97907ee2f8e66e99381e52743ff8acb70bf82d640b641dc05f6ff6891194ba1f"],
  ]);
  assert.deepEqual(manifest.cumulativeViews.map(view => [view.taskId, view.tests.length]), [["SEC-01", 12], ["SEC-02", 30], ["GOV-03", 31]]);
  assertCumulativeInclusion(manifest.cumulativeViews);
  assert(manifest.cumulativeViews[1].coverageExemptions.some(entry => entry.sourceTask === "SEC-01"));
  assert(manifest.cumulativeViews[1].coverageExemptions.some(entry => entry.sourceTask === "SEC-02"));
  assert.equal(manifest.coverageScope.thresholds.overallLines, 80);
  assert.equal(manifest.coverageScope.thresholds.securityBranches, 90);
  assert.equal(manifest.coverageScope.perFileLineMinimum["dist/path-policy.js"], 90);
});

test("SEC-02 governance rejects missing, duplicate, stale-owner, source-hash and coverage-floor mutations", async () => {
  const evidenceMap = await readJson("tests/sec02-evidence-map.json");
  const missing = structuredClone(evidenceMap);
  delete missing.scenarioOwners["SEC02-P01"];
  await assert.rejects(buildSec02ResolvedManifest({ evidenceMap: missing }));

  const stale = structuredClone(evidenceMap);
  stale.scenarioOwners["SEC02-P01"].testCaseId = "stale owner";
  await assert.rejects(buildSec02ResolvedManifest({ evidenceMap: stale }));

  const resolved = await buildSec02ResolvedManifest();
  const duplicate = structuredClone(resolved);
  duplicate.evidence.observations.push(structuredClone(duplicate.evidence.observations[0]));
  await assert.rejects(validateSec02ResolvedManifest(redigest(duplicate)));

  const changedSource = structuredClone(resolved);
  changedSource.sourceManifests[0].sha256 = "0".repeat(64);
  await assert.rejects(validateSec02ResolvedManifest(redigest(changedSource)));

  const weakenedCoverage = structuredClone(resolved);
  weakenedCoverage.coverageScope.perFileLineMinimum["dist/path-policy.js"] = 89;
  await assert.rejects(validateSec02ResolvedManifest(redigest(weakenedCoverage)));
});

test("SEC-02 receipt validator recomputes identity, actual semantics and conditional outcomes", async () => {
  const manifest = await buildSec02ResolvedManifest();
  const matrix = await readJson("tests/sec02-attack-matrix.json");
  const runId = "12345678-1234-4234-9234-123456789abc";
  const matrixSha256 = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json").sha256;
  const observations = matrix.scenarios.flatMap(scenario => scenario.observations);
  const observation = observations.find(entry => entry.id === "SEC02-P01-forward-dotdot");
  const binding = manifest.evidence.observations.find(entry => entry.observationId === observation.id);
  const actual = structuredClone(observation.expected);
  const payload = {
    schemaVersion: 1,
    kind: "observation",
    runId,
    resolvedManifestSha256: manifest.canonicalPayloadSha256,
    matrixSha256,
    id: observation.id,
    evidenceTier: binding.evidenceTier,
    stimulusSha256: binding.stimulusCanonicalSha256,
    evidenceFile: binding.test.exactCasePath,
    testCaseId: binding.testCaseId,
    actual,
    actualSha256: sha256Bytes(canonicalJson(actual)),
    passed: true,
    skipped: false,
    todo: false,
    mockSubstitution: false,
  };
  const receipt = { ...payload, receiptSha256: sha256Bytes(canonicalJson(payload)) };
  assert.deepEqual(validateSec02Receipt(receipt, { manifest, matrix, runId }), {
    kind: "observation",
    id: observation.id,
    passed: true,
    neutral: false,
  });

  const staleRun = { ...receipt, runId: "22345678-1234-4234-9234-123456789abc" };
  staleRun.receiptSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(staleRun).filter(([key]) => key !== "receiptSha256"))));
  assert.throws(() => validateSec02Receipt(staleRun, { manifest, matrix, runId }), /run ID differs/);
  const falseActual = structuredClone(receipt);
  falseActual.actual.filesystemCalls = 1;
  falseActual.actualSha256 = sha256Bytes(canonicalJson(falseActual.actual));
  falseActual.receiptSha256 = sha256Bytes(canonicalJson(Object.fromEntries(Object.entries(falseActual).filter(([key]) => key !== "receiptSha256"))));
  assert.throws(() => validateSec02Receipt(falseActual, { manifest, matrix, runId }), /actual state differs/);

  const conditional = observations.find(entry => entry.id === "SEC02-P12-short-name-alias-probe");
  assert.deepEqual(validateSec02ObservationActual(conditional, {
    receiptPresent: true,
    skipped: false,
    outcome: "not-exposed",
    passed: false,
    verdictContribution: "neutral",
  }), { passed: false, neutral: true });
  const cleanup = observations.find(entry => entry.id === "SEC02-P20-post-create-identity-rollback");
  assert.deepEqual(validateSec02ObservationActual(cleanup, {
    identityChangeDetected: true,
    furtherWrites: 0,
    handleClosed: true,
    cleanupOutcome: "PATH_ROLLBACK_FAILED",
    ordinarySuccessOnRollbackFailure: false,
  }), { passed: true, neutral: false });
  assert.throws(() => validateSec02ObservationActual(cleanup, {
    identityChangeDetected: true,
    furtherWrites: 0,
    handleClosed: true,
    cleanupOutcome: "ordinary-success",
    ordinarySuccessOnRollbackFailure: false,
  }), /not allowed/);
});
