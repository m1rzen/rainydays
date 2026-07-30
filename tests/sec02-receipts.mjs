import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  currentResolvedManifestPath,
  projectRoot,
  validateSec02ObservationActual,
  validateSec02ResolvedManifest,
} from "../scripts/sec02-governance.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const environmentKeys = Object.freeze([
  "RAINYDAYS_SEC02_RECEIPT_DIR",
  "RAINYDAYS_SEC02_RUN_ID",
  "RAINYDAYS_SEC02_RESOLVED_SHA256",
  "RAINYDAYS_SEC02_MATRIX_SHA256",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneJson(value, field) {
  const serialized = JSON.stringify(value);
  assert.notEqual(serialized, undefined, `${field} must be JSON serializable`);
  const cloned = JSON.parse(serialized);
  assert.deepEqual(cloned, value, `${field} must contain only JSON values`);
  return cloned;
}

function relativeEvidenceFile(moduleUrl) {
  assert.equal(typeof moduleUrl, "string");
  const absolute = fileURLToPath(moduleUrl);
  const relative = path.relative(projectRoot, absolute).replaceAll("\\", "/");
  assert(relative && !relative.startsWith("../") && !path.posix.isAbsolute(relative), "evidence module escapes the project");
  return relative;
}

function configuredEnvironment(env) {
  const values = environmentKeys.map(key => env[key]);
  const present = values.filter(value => typeof value === "string" && value.length > 0).length;
  if (present === 0) return null;
  assert.equal(present, environmentKeys.length, "SEC-02 receipt environment is incomplete");
  return Object.fromEntries(environmentKeys.map(key => [key, env[key]]));
}

export function sec02EvidenceEnabled(env = process.env) {
  return configuredEnvironment(env) !== null;
}

let governedInputsPromise = null;
async function loadGovernedInputs() {
  if (!governedInputsPromise) governedInputsPromise = (async () => {
    const manifestFile = path.join(projectRoot, ...currentResolvedManifestPath.split("/"));
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    await validateSec02ResolvedManifest(manifest, { root: projectRoot });
    const matrixBinding = manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json");
    assert(matrixBinding, "resolved manifest does not bind the attack matrix");
    const matrixBytes = await readFile(path.join(projectRoot, "tests", "sec02-attack-matrix.json"));
    assert.equal(sha256(matrixBytes), matrixBinding.sha256, "attack matrix bytes differ from the resolved manifest");
    const matrix = JSON.parse(matrixBytes);
    const observations = new Map();
    for (const scenario of matrix.scenarios) {
      for (const observation of scenario.observations) {
        assert(!observations.has(observation.id), `duplicate frozen observation: ${observation.id}`);
        observations.set(observation.id, observation);
      }
    }
    return {
      manifest,
      matrix,
      matrixSha256: matrixBinding.sha256,
      observations,
      observationBindings: new Map(manifest.evidence.observations.map(binding => [binding.observationId, binding])),
      positiveBindings: new Map(manifest.evidence.positives.map(binding => [binding.positiveReceiptId, binding])),
    };
  })();
  return governedInputsPromise;
}

async function assertReceiptDirectory(directory) {
  assert(path.isAbsolute(directory), "SEC-02 receipt directory must be absolute");
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink(), "SEC-02 receipt directory must be a real directory");
  assert.equal(await realpath(directory), path.resolve(directory), "SEC-02 receipt directory must already be canonical");
}

function hashReceipt(receipt) {
  const { receiptSha256: _ignored, ...payload } = receipt;
  return sha256(canonicalJson(payload));
}

export async function createSec02Recorder(moduleUrl, testCaseId, env = process.env) {
  assert.equal(typeof testCaseId, "string");
  assert(testCaseId.length > 0, "SEC-02 testCaseId is empty");
  const evidenceFile = relativeEvidenceFile(moduleUrl);
  const configured = configuredEnvironment(env);
  if (!configured) {
    return Object.freeze({
      enabled: false,
      observe: async () => { throw new Error("SEC-02 receipt collection is not enabled"); },
      positive: async () => { throw new Error("SEC-02 receipt collection is not enabled"); },
      close: async () => undefined,
    });
  }

  const receiptDirectory = configured.RAINYDAYS_SEC02_RECEIPT_DIR;
  const runId = configured.RAINYDAYS_SEC02_RUN_ID;
  const resolvedSha256 = configured.RAINYDAYS_SEC02_RESOLVED_SHA256;
  const matrixSha256 = configured.RAINYDAYS_SEC02_MATRIX_SHA256;
  assert.match(runId, runIdPattern, "SEC-02 run ID is invalid");
  assert.match(resolvedSha256, sha256Pattern, "SEC-02 resolved digest is invalid");
  assert.match(matrixSha256, sha256Pattern, "SEC-02 matrix digest is invalid");
  await assertReceiptDirectory(receiptDirectory);

  const governed = await loadGovernedInputs();
  assert.equal(governed.manifest.canonicalPayloadSha256, resolvedSha256, "SEC-02 resolved digest is stale");
  assert.equal(governed.matrixSha256, matrixSha256, "SEC-02 matrix digest is stale");
  const recorderId = sha256(`${evidenceFile}\0${testCaseId}`).slice(0, 16);
  const sidecarPath = path.join(receiptDirectory, `receipts-${process.pid}-${recorderId}.jsonl`);
  const handle = await open(sidecarPath, "wx");
  const emitted = new Set();
  let queue = Promise.resolve();
  let closed = false;

  const append = async receipt => {
    assert(!closed, "SEC-02 recorder is closed");
    const key = `${receipt.kind}\0${receipt.id}`;
    assert(!emitted.has(key), `duplicate SEC-02 receipt in process: ${receipt.id}`);
    emitted.add(key);
    const complete = { ...receipt, receiptSha256: hashReceipt(receipt) };
    queue = queue.then(() => handle.appendFile(`${JSON.stringify(complete)}\n`, "utf8"));
    await queue;
  };

  const assertBinding = (binding, id) => {
    assert(binding, `unmapped SEC-02 evidence ID: ${id}`);
    assert.equal(binding.test.exactCasePath, evidenceFile, `${id} evidence file differs`);
    assert.equal(binding.testCaseId, testCaseId, `${id} testCaseId differs`);
    assert.equal(binding.producer, "node-test", `${id} is not produced by a node test`);
  };

  return Object.freeze({
    enabled: true,
    observe: async (id, actualValue) => {
      const binding = governed.observationBindings.get(id);
      assertBinding(binding, id);
      const observation = governed.observations.get(id);
      assert(observation, `frozen observation is missing: ${id}`);
      const actual = cloneJson(actualValue, `${id} actual`);
      const evaluation = validateSec02ObservationActual(observation, actual);
      await append({
        schemaVersion: 1,
        kind: "observation",
        runId,
        resolvedManifestSha256: resolvedSha256,
        matrixSha256,
        id,
        evidenceTier: observation.evidenceTier,
        stimulusSha256: binding.stimulusCanonicalSha256,
        evidenceFile,
        testCaseId,
        actual,
        actualSha256: sha256(canonicalJson(actual)),
        passed: evaluation.passed,
        skipped: false,
        todo: false,
        mockSubstitution: false,
      });
    },
    positive: async id => {
      const binding = governed.positiveBindings.get(id);
      assertBinding(binding, id);
      const actual = { passed: true };
      await append({
        schemaVersion: 1,
        kind: "positive",
        runId,
        resolvedManifestSha256: resolvedSha256,
        matrixSha256,
        id,
        evidenceFile,
        testCaseId,
        actual,
        actualSha256: sha256(canonicalJson(actual)),
        passed: true,
        skipped: false,
        todo: false,
        mockSubstitution: false,
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await queue;
      await handle.close();
    },
  });
}

export function validateSec02ReceiptHash(receipt) {
  assert.match(receipt?.receiptSha256, sha256Pattern, "SEC-02 receipt hash is invalid");
  assert.equal(receipt.receiptSha256, hashReceipt(receipt), "SEC-02 receipt hash differs");
  return receipt;
}
