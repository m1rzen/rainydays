import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scenarioPattern = /^SEC01-A(?:0[1-9]|[12][0-9]|3[01])$/;
const probePattern = /^[a-z][a-z0-9-]*$/;
const runIdPattern = /^[a-f0-9]{64}$/;
const matrix = JSON.parse(readFileSync(new URL("./sec01-attack-matrix.json", import.meta.url), "utf8"));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function expectedProbe(scenarioId, probe) {
  const scenario = matrix.scenarios.find((entry) => entry.id === scenarioId);
  assert(scenario, `${scenarioId} is absent from the governed matrix`);
  const matches = scenario.evidence.flatMap((evidence) =>
    evidence.probes.filter((entry) => entry.name === probe).map((entry) => ({ evidence, entry }))
  );
  assert.equal(matches.length, 1, `${scenarioId} ${probe} must have one governed observation`);
  return matches[0];
}

function assertMatrixExpectation(actual, expectation, label) {
  assert(expectation && typeof expectation === "object" && !Array.isArray(expectation), `${label} expectation is invalid`);
  if (expectation.kind === "exact") {
    assert.deepEqual(actual, expectation.value, `${label} differs from matrix-controlled expected value`);
    return;
  }
  if (expectation.kind === "unchanged") {
    assert(actual && typeof actual === "object" && !Array.isArray(actual), `${label} unchanged observation must be an object`);
    assert.deepEqual(Object.keys(actual).sort(), ["after", "before"], `${label} unchanged observation keys differ`);
    assert.deepEqual(actual.after, actual.before, `${label} changed`);
    return;
  }
  assert.fail(`${label} expectation kind is unsupported`);
}

function directoryIdentity(directory, label) {
  const info = lstatSync(directory, { bigint: true });
  assert(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a regular directory`);
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function resolveSec01ReceiptDestination(requested) {
  assert(path.isAbsolute(requested), "SEC-01 receipt path must be absolute");
  const absolute = path.resolve(requested);
  const parent = path.dirname(absolute);
  const allowedRootIdentities = [path.resolve(os.tmpdir()), path.resolve(process.cwd(), "test-results")]
    .filter((root) => existsSync(root))
    .map((root) => directoryIdentity(root, "SEC-01 receipt root"));

  let cursor = parent;
  let authorized = false;
  while (true) {
    const identity = directoryIdentity(cursor, "SEC-01 receipt ancestor");
    if (allowedRootIdentities.some((root) => sameIdentity(root, identity))) {
      authorized = true;
      break;
    }
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  assert(authorized, "SEC-01 receipt path is outside allowed test roots");
  if (existsSync(absolute)) assert(!lstatSync(absolute).isSymbolicLink(), "SEC-01 receipt path must not be a symbolic link");
  return absolute;
}

function receiptDestination() {
  const requested = process.env.SEC01_PROBE_RECEIPT_PATH;
  if (!requested) return null;
  const runId = process.env.SEC01_PROBE_RUN_ID;
  assert.match(runId ?? "", runIdPattern, "SEC-01 receipt run id is invalid");
  return { absolute: resolveSec01ReceiptDestination(requested), runId };
}

/**
 * Executes a strict local assertion, independently checks the matrix-controlled
 * expectation, and emits one runtime receipt when the contract collector is active.
 */
export function assertSec01Probe(scenarioId, probe, actual, localExpected) {
  assert.match(scenarioId, scenarioPattern, "SEC-01 scenario id is invalid");
  assert.match(probe, probePattern, "SEC-01 probe name is invalid");
  assert.deepEqual(actual, localExpected, `${scenarioId} ${probe} local state differs`);

  const { evidence, entry } = expectedProbe(scenarioId, probe);
  const normalizedStack = String(new Error().stack || "").replaceAll("\\", "/");
  assert(normalizedStack.includes(evidence.file), `${scenarioId} ${probe} executed outside its governed evidence file`);
  assertMatrixExpectation(actual, entry.expectation, `${scenarioId} ${probe}`);

  const destination = receiptDestination();
  if (destination) {
    const receipt = {
      runId: destination.runId,
      scenarioId,
      probe,
      observationId: entry.observationId,
      evidenceFile: evidence.file,
      evidenceTest: evidence.testName,
      actual,
      actualDigest: digest(actual),
    };
    appendFileSync(destination.absolute, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "a" });
  }
}
