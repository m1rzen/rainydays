import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Bytes, validateSec02Receipt } from "./sec02-governance.mjs";

const sidecarPattern = /^receipts-[1-9]\d*-[a-f0-9]{16}\.jsonl$/u;
const layerOrder = Object.freeze(["unit", "contract", "integration", "electron", "packaged"]);
const layers = new Set(layerOrder);

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

function expectedBindings(manifest, layer) {
  const observations = manifest.evidence.observations
    .filter(binding => binding.layer === layer && binding.producer === "node-test")
    .map(binding => binding.observationId);
  const positives = manifest.evidence.positives
    .filter(binding => binding.layer === layer && binding.producer === "node-test")
    .map(binding => binding.positiveReceiptId);
  return { observations, positives };
}

function receiptLayer(manifest, receipt) {
  const entries = receipt.kind === "observation" ? manifest.evidence.observations : manifest.evidence.positives;
  const binding = entries.find(entry => (entry.observationId ?? entry.positiveReceiptId) === receipt.id);
  return binding?.layer ?? null;
}

function evaluateReceipts(receipts, invalidCount, { manifest, matrix, runId, layer, sidecarCount }) {
  assert(layers.has(layer), "SEC-02 receipt layer is invalid");
  assert(Number.isSafeInteger(invalidCount) && invalidCount >= 0, "SEC-02 invalid receipt count is invalid");
  assert(Number.isSafeInteger(sidecarCount) && sidecarCount >= 0, "SEC-02 sidecar count is invalid");
  const expected = expectedBindings(manifest, layer);
  const expectedObservationSet = new Set(expected.observations);
  const expectedPositiveSet = new Set(expected.positives);
  const seen = new Set();
  const duplicates = [];
  const extras = [];
  const failed = [];
  const valid = [];

  for (const receipt of receipts) {
    let evaluation;
    try {
      evaluation = validateSec02Receipt(receipt, { manifest, matrix, runId });
      assert.equal(receiptLayer(manifest, receipt), layer, `${receipt.id} belongs to a different layer`);
    } catch {
      invalidCount += 1;
      continue;
    }
    valid.push(receipt);
    const key = `${receipt.kind}\0${receipt.id}`;
    if (seen.has(key)) {
      duplicates.push(receipt.id);
      continue;
    }
    seen.add(key);
    const expectedSet = receipt.kind === "observation" ? expectedObservationSet : expectedPositiveSet;
    if (!expectedSet.has(receipt.id)) extras.push(receipt.id);
    if (!evaluation.passed && !evaluation.neutral) failed.push(receipt.id);
  }

  valid.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const observedObservations = new Set(valid.filter(receipt => receipt.kind === "observation").map(receipt => receipt.id));
  const observedPositives = new Set(valid.filter(receipt => receipt.kind === "positive").map(receipt => receipt.id));
  const missingObservations = expected.observations.filter(id => !observedObservations.has(id));
  const missingPositives = expected.positives.filter(id => !observedPositives.has(id));
  duplicates.sort();
  extras.sort();
  failed.sort();
  const complete = invalidCount === 0
    && duplicates.length === 0
    && extras.length === 0
    && failed.length === 0
    && missingObservations.length === 0
    && missingPositives.length === 0;
  const matrixBinding = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json");
  assert(matrixBinding, "SEC-02 matrix binding is missing");
  return Object.freeze({
    schemaVersion: 1,
    runId,
    resolvedManifestSha256: manifest.canonicalPayloadSha256,
    matrixSha256: matrixBinding.sha256,
    layer,
    sidecarCount,
    expectedObservationIds: Object.freeze([...expected.observations]),
    expectedPositiveIds: Object.freeze([...expected.positives]),
    receipts: Object.freeze(valid),
    missingObservationIds: Object.freeze(missingObservations),
    missingPositiveIds: Object.freeze(missingPositives),
    duplicateIds: Object.freeze(duplicates),
    extraIds: Object.freeze(extras),
    failedIds: Object.freeze(failed),
    invalidCount,
    receiptSetSha256: sha256Bytes(canonicalJson(valid)),
    complete,
  });
}

export async function collectSec02LayerEvidence(directory, context) {
  assert(path.isAbsolute(directory), "SEC-02 receipt directory must be absolute");
  const names = (await readdir(directory)).sort();
  const receipts = [];
  let invalidCount = 0;
  let sidecarCount = 0;
  for (const name of names) {
    if (!sidecarPattern.test(name)) {
      invalidCount += 1;
      continue;
    }
    sidecarCount += 1;
    const filePath = path.join(directory, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      invalidCount += 1;
      continue;
    }
    const text = await readFile(filePath, "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) !== "") invalidCount += 1;
    else lines.pop();
    for (const line of lines) {
      if (!line) {
        invalidCount += 1;
        continue;
      }
      try { receipts.push(JSON.parse(line)); }
      catch { invalidCount += 1; }
    }
  }
  return evaluateReceipts(receipts, invalidCount, { ...context, sidecarCount });
}

export function validateSec02LayerEvidence(evidence, context) {
  exactKeys(evidence, [
    "schemaVersion", "runId", "resolvedManifestSha256", "matrixSha256", "layer", "sidecarCount",
    "expectedObservationIds", "expectedPositiveIds", "receipts", "missingObservationIds",
    "missingPositiveIds", "duplicateIds", "extraIds", "failedIds", "invalidCount",
    "receiptSetSha256", "complete",
  ], "SEC-02 layer evidence");
  assert.equal(evidence.schemaVersion, 1);
  const recomputed = evaluateReceipts(evidence.receipts, evidence.invalidCount, {
    ...context,
    layer: evidence.layer,
    sidecarCount: evidence.sidecarCount,
  });
  assert.deepEqual(evidence, recomputed, "SEC-02 layer evidence differs from parent recomputation");
  return evidence;
}

function receiptSort(left, right) {
  return left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
    || left.receiptSha256.localeCompare(right.receiptSha256);
}

function unifiedReceipt(id, { manifest, matrix, runId }) {
  const binding = manifest.evidence.observations.find(entry => entry.observationId === id);
  const observation = matrix.scenarios.flatMap(scenario => scenario.observations).find(entry => entry.id === id);
  assert(binding?.producer === "unified-runner", `${id} is not bound to the unified runner`);
  assert(observation, `${id} frozen observation is missing`);
  const actual = structuredClone(observation.expected);
  const matrixBinding = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json");
  assert(matrixBinding, "SEC-02 matrix binding is missing");
  const payload = {
    schemaVersion: 1,
    kind: "observation",
    runId,
    resolvedManifestSha256: manifest.canonicalPayloadSha256,
    matrixSha256: matrixBinding.sha256,
    id,
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
  validateSec02Receipt(receipt, { manifest, matrix, runId });
  return Object.freeze(receipt);
}

export function aggregateSec02UnifiedEvidence(sources, { manifest, matrix, runId }) {
  assert(Array.isArray(sources), "SEC-02 unified receipt sources must be an array");
  const matrixBinding = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json");
  assert(matrixBinding, "SEC-02 matrix binding is missing");
  const observations = matrix.scenarios.flatMap(scenario => scenario.observations);
  const expectedObservations = manifest.evidence.observations.filter(binding => binding.producer === "node-test");
  const expectedPositives = manifest.evidence.positives.filter(binding => binding.producer === "node-test");
  const expectedByKey = new Map([
    ...expectedObservations.map(binding => [`observation\0${binding.observationId}`, binding]),
    ...expectedPositives.map(binding => [`positive\0${binding.positiveReceiptId}`, binding]),
  ]);
  const denialIds = observations.filter(observation => observation.outcomeClass === "denial").map(observation => observation.id);
  assert.equal(denialIds.length, 380, "frozen SEC-02 denial count differs");
  assert.equal(expectedPositives.length, 22, "frozen SEC-02 positive count differs");

  const layerCounts = new Map();
  const receiptCounts = new Map();
  const joinedByKey = new Map();
  const validRawReceipts = [];
  const duplicateIds = [];
  const extraIds = [];
  const crossLayerIds = [];
  const failedIds = [];
  let rawReceiptCount = 0;
  let invalidCount = 0;
  let crossRunCount = 0;

  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source) || !layers.has(source.layer)) {
      invalidCount += 1;
      continue;
    }
    layerCounts.set(source.layer, (layerCounts.get(source.layer) ?? 0) + 1);
    if (!Array.isArray(source.receipts)) {
      invalidCount += 1;
      continue;
    }
    for (const receipt of source.receipts) {
      rawReceiptCount += 1;
      if (receipt?.runId !== runId) {
        crossRunCount += 1;
        invalidCount += 1;
        continue;
      }
      let evaluation;
      try { evaluation = validateSec02Receipt(receipt, { manifest, matrix, runId }); }
      catch {
        invalidCount += 1;
        continue;
      }
      validRawReceipts.push(receipt);
      const key = `${receipt.kind}\0${receipt.id}`;
      const count = (receiptCounts.get(key) ?? 0) + 1;
      receiptCounts.set(key, count);
      if (count > 1) duplicateIds.push(receipt.id);
      const binding = expectedByKey.get(key);
      if (!binding) {
        extraIds.push(receipt.id);
        continue;
      }
      if (binding.layer !== source.layer) {
        crossLayerIds.push(receipt.id);
        continue;
      }
      if (!evaluation.passed && !evaluation.neutral) failedIds.push(receipt.id);
      if (!joinedByKey.has(key)) joinedByKey.set(key, receipt);
    }
  }

  const missingObservationIds = expectedObservations
    .map(binding => binding.observationId)
    .filter(id => !joinedByKey.has(`observation\0${id}`));
  const missingPositiveIds = expectedPositives
    .map(binding => binding.positiveReceiptId)
    .filter(id => !joinedByKey.has(`positive\0${id}`));
  const denialReceipts = denialIds.map(id => joinedByKey.get(`observation\0${id}`));
  const denialFacts = {
    expectedCount: 380,
    observedCount: denialReceipts.filter(Boolean).length,
    exactlyOnce: denialIds.every(id => receiptCounts.get(`observation\0${id}`) === 1),
    denied: denialReceipts.every(receipt => receipt?.actual?.denied === true),
    auditAttemptsOne: denialReceipts.every(receipt => receipt?.actual?.auditAttempts === 1),
    auditAllowedFieldsExact: denialReceipts.every(receipt => receipt?.actual?.auditAllowedFieldsExact === true),
    rawPathsAbsent: denialReceipts.every(receipt => receipt?.actual?.rawPathsAbsent === true),
  };
  const denialProof = Object.freeze({
    ...denialFacts,
    passed: denialFacts.observedCount === denialFacts.expectedCount
      && denialFacts.exactlyOnce && denialFacts.denied && denialFacts.auditAttemptsOne
      && denialFacts.auditAllowedFieldsExact && denialFacts.rawPathsAbsent,
  });
  const positiveIds = expectedPositives.map(binding => binding.positiveReceiptId);
  const positiveReceipts = positiveIds.map(id => joinedByKey.get(`positive\0${id}`)).filter(Boolean);
  const positiveFacts = {
    expectedCount: 22,
    observedCount: positiveReceipts.length,
    exactIds: positiveIds.every(id => joinedByKey.has(`positive\0${id}`)),
    exactlyOnce: positiveIds.every(id => receiptCounts.get(`positive\0${id}`) === 1),
    passedCount: positiveReceipts.filter(receipt => receipt.passed === true).length,
    skipped: positiveReceipts.filter(receipt => receipt.skipped === true).length,
    todo: positiveReceipts.filter(receipt => receipt.todo === true).length,
    failed: positiveReceipts.filter(receipt => receipt.passed !== true).length,
  };
  const positiveProof = Object.freeze({
    ...positiveFacts,
    passed: positiveFacts.observedCount === positiveFacts.expectedCount
      && positiveFacts.exactIds && positiveFacts.exactlyOnce
      && positiveFacts.passedCount === positiveFacts.expectedCount
      && positiveFacts.skipped === 0 && positiveFacts.todo === 0 && positiveFacts.failed === 0,
  });

  const synthesizedReceipts = [];
  if (denialProof.passed) synthesizedReceipts.push(unifiedReceipt("SEC02-P34-all-denial-receipts-audited", { manifest, matrix, runId }));
  if (positiveProof.passed) synthesizedReceipts.push(unifiedReceipt("SEC02-P35-fixed-positive-set-complete", { manifest, matrix, runId }));
  const joinedRawReceipts = [...joinedByKey.values()].sort(receiptSort);
  const finalReceipts = [...joinedRawReceipts, ...synthesizedReceipts].sort(receiptSort);
  const observedLayers = layerOrder.filter(layer => layerCounts.has(layer));
  const missingLayerNames = layerOrder.filter(layer => !layerCounts.has(layer));
  const duplicateLayerNames = layerOrder.filter(layer => (layerCounts.get(layer) ?? 0) > 1);
  for (const values of [duplicateIds, extraIds, crossLayerIds, failedIds]) values.sort();
  const complete = missingLayerNames.length === 0 && duplicateLayerNames.length === 0
    && layerOrder.every(layer => layerCounts.get(layer) === 1)
    && invalidCount === 0 && crossRunCount === 0 && duplicateIds.length === 0
    && extraIds.length === 0 && crossLayerIds.length === 0 && failedIds.length === 0
    && missingObservationIds.length === 0 && missingPositiveIds.length === 0
    && joinedRawReceipts.length === expectedByKey.size
    && denialProof.passed && positiveProof.passed && synthesizedReceipts.length === 2;

  return Object.freeze({
    schemaVersion: 1,
    runId,
    resolvedManifestSha256: manifest.canonicalPayloadSha256,
    matrixSha256: matrixBinding.sha256,
    requiredLayers: layerOrder,
    observedLayers: Object.freeze(observedLayers),
    producerSummaryTrusted: false,
    rawReceiptCount,
    validRawReceiptCount: validRawReceipts.length,
    expectedRawReceiptCount: expectedByKey.size,
    joinedRawReceiptCount: joinedRawReceipts.length,
    rawReceiptSetSha256: sha256Bytes(canonicalJson([...validRawReceipts].sort(receiptSort))),
    missingLayerNames: Object.freeze(missingLayerNames),
    duplicateLayerNames: Object.freeze(duplicateLayerNames),
    missingObservationIds: Object.freeze(missingObservationIds),
    missingPositiveIds: Object.freeze(missingPositiveIds),
    duplicateIds: Object.freeze(duplicateIds),
    extraIds: Object.freeze(extraIds),
    crossLayerIds: Object.freeze(crossLayerIds),
    failedIds: Object.freeze(failedIds),
    invalidCount,
    crossRunCount,
    denialProof,
    positiveProof,
    synthesizedReceipts: Object.freeze(synthesizedReceipts),
    receiptSetSha256: sha256Bytes(canonicalJson(finalReceipts)),
    complete,
  });
}

export function validateSec02UnifiedEvidence(evidence, sources, context) {
  exactKeys(evidence, [
    "schemaVersion", "runId", "resolvedManifestSha256", "matrixSha256", "requiredLayers",
    "observedLayers", "producerSummaryTrusted", "rawReceiptCount", "validRawReceiptCount",
    "expectedRawReceiptCount", "joinedRawReceiptCount", "rawReceiptSetSha256", "missingLayerNames",
    "duplicateLayerNames", "missingObservationIds", "missingPositiveIds", "duplicateIds", "extraIds",
    "crossLayerIds", "failedIds", "invalidCount", "crossRunCount", "denialProof", "positiveProof",
    "synthesizedReceipts", "receiptSetSha256", "complete",
  ], "SEC-02 unified evidence");
  exactKeys(evidence.denialProof, [
    "expectedCount", "observedCount", "exactlyOnce", "denied", "auditAttemptsOne",
    "auditAllowedFieldsExact", "rawPathsAbsent", "passed",
  ], "SEC-02 unified denial proof");
  exactKeys(evidence.positiveProof, [
    "expectedCount", "observedCount", "exactIds", "exactlyOnce", "passedCount", "skipped",
    "todo", "failed", "passed",
  ], "SEC-02 unified positive proof");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.producerSummaryTrusted, false, "SEC-02 unified evidence must not trust producer summaries");
  const recomputed = aggregateSec02UnifiedEvidence(sources, context);
  assert.deepEqual(evidence, recomputed, "SEC-02 unified evidence differs from independent raw-receipt recomputation");
  return evidence;
}
