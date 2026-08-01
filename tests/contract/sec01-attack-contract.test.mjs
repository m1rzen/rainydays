import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";
import { resolveSec01ReceiptDestination } from "../sec01-probe.mjs";

const matrixPath = path.join(projectRoot, "tests", "sec01-attack-matrix.json");
const manifestPath = path.join(projectRoot, "tests", "manifests", "sec-01.json");
const allowedProbes = new Set([
  "approval-result-state", "argument-digest", "binding-identity", "challenge-ledger", "child-binding-set",
  "context-active-state", "deep-freeze", "direct-operation-ledger", "executor-call-count",
  "filesystem-state", "grant-ledger", "immutable-registration-snapshot", "immutable-snapshot",
  "manager-invocation-count", "memory-message-count", "per-authority-marker-count", "per-tool-executor-call-count",
  "playbook-run-state", "principal-separation", "private-context-identity", "process-canary-state",
  "registry-state", "static-boundary-state", "structured-approval-state", "supervisor-state", "terminal-owner-state",
  "terminal-resource-count",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys differ`);
}

function assertExpectation(actual, expectation, label) {
  exactKeys(expectation, expectation.kind === "exact" ? ["kind", "value"] : ["kind"], `${label} expectation`);
  if (expectation.kind === "exact") {
    assert.deepEqual(actual, expectation.value, `${label} differs from governed expected value`);
    return;
  }
  assert.equal(expectation.kind, "unchanged", `${label} expectation kind is unsupported`);
  exactKeys(actual, ["before", "after"], `${label} unchanged observation`);
  assert.deepEqual(actual.after, actual.before, `${label} changed`);
}

async function safeEvidenceFile(relativePath) {
  assert.match(relativePath, /^tests\/(?:unit|contract|integration|electron|packaged)\/[A-Za-z0-9._-]+\.mjs$/);
  const absolute = path.resolve(projectRoot, relativePath);
  const [rootReal, fileReal] = await Promise.all([realpath(projectRoot), realpath(absolute)]);
  const relative = path.relative(rootReal, fileReal);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `evidence escapes project: ${relativePath}`);
  assert((await stat(fileReal)).isFile(), `evidence is not a regular file: ${relativePath}`);
  return fileReal;
}

function parseReceipts(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { assert.fail(`runtime receipt line ${index + 1} is not JSON`); }
  });
}

function validateRuntimeReceipts(receipts, expectedByObservation, runId) {
  assert.equal(receipts.length, expectedByObservation.size, "runtime receipt count differs");
  const seen = new Set();
  for (const receipt of receipts) {
    exactKeys(receipt, ["runId", "scenarioId", "probe", "observationId", "evidenceFile", "evidenceTest", "actual", "actualDigest"], "runtime receipt");
    assert.equal(receipt.runId, runId, `${receipt.observationId} belongs to another run`);
    assert(!seen.has(receipt.observationId), `duplicate runtime receipt: ${receipt.observationId}`);
    const governed = expectedByObservation.get(receipt.observationId);
    assert(governed, `unexpected runtime receipt: ${receipt.observationId}`);
    assert.equal(receipt.scenarioId, governed.scenario.id);
    assert.equal(receipt.probe, governed.probe.name);
    assert.equal(receipt.evidenceFile, governed.evidence.file);
    assert.equal(receipt.evidenceTest, governed.evidence.testName);
    assert.equal(receipt.actualDigest, digestValue(receipt.actual), `${receipt.observationId} actual digest differs`);
    assertExpectation(receipt.actual, governed.probe.expectation, receipt.observationId);
    seen.add(receipt.observationId);
  }
  assert.deepEqual([...seen].sort(), [...expectedByObservation.keys()].sort(), "runtime receipt set differs");
}

test("SEC-01 runtime receipt validator rejects missing, duplicate, stale and false observations", () => {
  const runId = "a".repeat(64);
  const observationId = "SEC01-A01-executor-call-count";
  const expected = new Map([[observationId, {
    scenario: { id: "SEC01-A01" },
    evidence: { file: "tests/integration/sec01-agent.test.mjs", testName: "synthetic evidence" },
    probe: { name: "executor-call-count", expectation: { kind: "exact", value: 0 } },
  }]]);
  const valid = {
    runId,
    scenarioId: "SEC01-A01",
    probe: "executor-call-count",
    observationId,
    evidenceFile: "tests/integration/sec01-agent.test.mjs",
    evidenceTest: "synthetic evidence",
    actual: 0,
    actualDigest: digestValue(0),
  };
  validateRuntimeReceipts([valid], expected, runId);
  assert.throws(() => validateRuntimeReceipts([], expected, runId), /receipt count differs/);
  assert.throws(() => validateRuntimeReceipts([valid, valid], new Map([...expected, ["other", expected.get(observationId)]]), runId), /duplicate runtime receipt/);
  assert.throws(() => validateRuntimeReceipts([{ ...valid, runId: "b".repeat(64) }], expected, runId), /belongs to another run/);
  assert.throws(() => validateRuntimeReceipts([{ ...valid, actual: 1, actualDigest: digestValue(1) }], expected, runId), /differs from governed expected value/);
});

test("SEC-01 receipt authority recognizes Windows temporary-root aliases by directory identity", { skip: process.platform !== "win32" }, async () => {
  const temporaryRoot = await realpath(os.tmpdir());
  let aliasRoot = `\\\\?\\${temporaryRoot}`;
  if (!temporaryRoot.includes(" ")) {
    const aliasProbe = await runProcess(process.env.ComSpec || "cmd.exe", [
      "/d", "/c", "for %I in (%SEC01_ALIAS_ROOT%) do @echo %~sI",
    ], { env: { ...process.env, SEC01_ALIAS_ROOT: temporaryRoot } });
    assert.equal(aliasProbe.code, 0);
    const aliasOutput = aliasProbe.stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
    const shortRoot = aliasOutput.startsWith('"') && aliasOutput.endsWith('"') ? aliasOutput.slice(1, -1) : aliasOutput;
    if (shortRoot && path.resolve(shortRoot).toLowerCase() !== path.resolve(temporaryRoot).toLowerCase()) aliasRoot = shortRoot;
  }

  const fixture = await makeTempDir("mini-lux-sec01-alias-");
  const destination = path.join(fixture, "receipts.jsonl");
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = aliasRoot;
  process.env.TMP = aliasRoot;
  try {
    assert.equal(resolveSec01ReceiptDestination(destination), path.join(await realpath(fixture), "receipts.jsonl"));
    const outsideRootDestination = path.join(path.parse(temporaryRoot).root, "rainydays-sec01-forbidden-receipt.jsonl");
    assert.throws(() => resolveSec01ReceiptDestination(outsideRootDestination), /outside allowed test roots/);
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
    await removeFixture(fixture);
  }
});

test("SEC-01 frozen 31-scenario contract produces complete runtime receipts", async () => {
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  exactKeys(matrix, ["schemaVersion", "taskId", "architecture", "scenarios"], "matrix");
  assert.equal(matrix.schemaVersion, 3);
  assert.equal(matrix.taskId, "SEC-01");
  exactKeys(matrix.architecture, ["path", "sha256"], "matrix.architecture");
  assert.equal(matrix.architecture.path, "parity/SEC-01-CAPABILITY-BROKER-ARCHITECTURE.md");
  assert.match(matrix.architecture.sha256, /^[a-f0-9]{64}$/);

  const architecturePath = path.join(projectRoot, matrix.architecture.path);
  const architecture = await readFile(architecturePath, "utf8");
  assert.equal(sha256Text(architecture), matrix.architecture.sha256, "frozen SEC-01 architecture changed");
  const contractStart = architecture.indexOf("## 12. Fixed attack and regression contract");
  const contractEnd = architecture.indexOf("\nPositive regressions", contractStart);
  assert(contractStart >= 0 && contractEnd > contractStart, "frozen contract section is missing");
  const frozenScenarios = [...architecture.slice(contractStart, contractEnd).matchAll(/^(\d+)\. (.+?)[;.]\r?$/gm)]
    .map((match) => ({ id: `SEC01-A${match[1].padStart(2, "0")}`, title: match[2] }));
  assert.equal(frozenScenarios.length, 31);
  assert.equal(matrix.scenarios.length, 31);
  assert.deepEqual(matrix.scenarios.map(({ id, title }) => ({ id, title })), frozenScenarios);

  const manifestTests = new Set(Object.values(manifest.layers).flat());
  const evidenceFiles = new Set();
  const evidenceTests = new Set();
  const expectedByObservation = new Map();
  for (const [index, scenario] of matrix.scenarios.entries()) {
    exactKeys(scenario, ["id", "title", "evidence", "zeroSideEffectProbes"], `scenario ${index + 1}`);
    assert.equal(scenario.id, `SEC01-A${String(index + 1).padStart(2, "0")}`);
    assert(Array.isArray(scenario.evidence) && scenario.evidence.length > 0, `${scenario.id} has no evidence`);
    assert(Array.isArray(scenario.zeroSideEffectProbes) && scenario.zeroSideEffectProbes.length > 0, `${scenario.id} has no probes`);
    assert.equal(new Set(scenario.zeroSideEffectProbes).size, scenario.zeroSideEffectProbes.length, `${scenario.id} repeats probes`);
    for (const name of scenario.zeroSideEffectProbes) assert(allowedProbes.has(name), `${scenario.id} has unknown probe: ${name}`);

    const assignedNames = [];
    for (const evidence of scenario.evidence) {
      exactKeys(evidence, ["file", "testName", "probes"], `${scenario.id} evidence`);
      assert(manifestTests.has(evidence.file), `${scenario.id} evidence is outside the SEC-01 runner: ${evidence.file}`);
      await safeEvidenceFile(evidence.file);
      assert(Array.isArray(evidence.probes) && evidence.probes.length > 0, `${scenario.id} evidence has no observations`);
      evidenceFiles.add(evidence.file);
      evidenceTests.add(`${evidence.file}\0${evidence.testName}`);
      for (const probe of evidence.probes) {
        exactKeys(probe, ["name", "observationId", "expectation"], `${scenario.id} probe`);
        assert(allowedProbes.has(probe.name), `${scenario.id} has unknown observation probe: ${probe.name}`);
        assert(scenario.zeroSideEffectProbes.includes(probe.name), `${scenario.id} observation is undeclared: ${probe.name}`);
        assert.equal(probe.observationId, `${scenario.id}-${probe.name}`, `${scenario.id} observation id differs`);
        assert(!expectedByObservation.has(probe.observationId), `duplicate observation id: ${probe.observationId}`);
        assertExpectation(probe.expectation.kind === "exact" ? probe.expectation.value : { before: null, after: null }, probe.expectation, `${scenario.id} ${probe.name} schema`);
        expectedByObservation.set(probe.observationId, { scenario, evidence, probe });
        assignedNames.push(probe.name);
      }
    }
    assert.deepEqual([...assignedNames].sort(), [...scenario.zeroSideEffectProbes].sort(), `${scenario.id} observation assignment differs`);
  }
  assert.equal(expectedByObservation.size, 63, "SEC-01 observation count differs");
  assert(evidenceTests.size >= 12, "contract collapses into too few evidence tests");

  const fixture = await makeTempDir("mini-lux-sec01-receipts-");
  const receiptPath = path.join(fixture, "runtime-receipts.jsonl");
  const runId = randomBytes(32).toString("hex");
  try {
    const childEnv = { ...process.env, SEC01_PROBE_RECEIPT_PATH: receiptPath, SEC01_PROBE_RUN_ID: runId };
    delete childEnv.NODE_TEST_CONTEXT;
    const nestedEvidenceEnvironment = [
      "RAINYDAYS_SEC02_RECEIPT_DIR",
      "RAINYDAYS_SEC02_RUN_ID",
      "RAINYDAYS_SEC02_RESOLVED_SHA256",
      "RAINYDAYS_SEC02_MATRIX_SHA256",
    ];
    for (const key of nestedEvidenceEnvironment) delete childEnv[key];
    assert(nestedEvidenceEnvironment.every(key => !(key in childEnv)), "nested SEC-01 evidence runner inherited SEC-02 producer authority");
    const result = await runProcess(process.execPath, [
      "--test", "--test-concurrency=1", "--test-reporter=tap", ...[...evidenceFiles].sort(),
    ], {
      cwd: projectRoot,
      timeoutMs: 180_000,
      env: childEnv,
    });
    assert.equal(result.signal, null, `evidence child ended by signal: ${result.signal}`);
    assert.equal(result.code, 0, `evidence child failed\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);

    const receipts = parseReceipts(await readFile(receiptPath, "utf8"));
    validateRuntimeReceipts(receipts, expectedByObservation, runId);
  } finally {
    await removeFixture(fixture);
  }
});
