import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { collectSec02RuntimeSources, scanSec02Sinks, sec02ExecutionClass } from "./sec02-sink-scanner.mjs";
import {
  crosscheckPolicyPath,
  scanSec02RestrictedRuntime,
} from "./sec02-sink-crosscheck.mjs";

export const sinkInventoryPath = "tests/sec02-sink-inventory.json";
export const sinkInventorySchemaPath = "tests/sec02-sink-inventory.schema.json";
export const sinkPolicyPath = "tests/sec02-sink-policy.json";
const runtimeClasses = new Set(["product-runtime", "source-runtime", "electron-runtime"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

const runtimeEvidenceDefinitions = Object.freeze([
  Object.freeze({ id: "database-lifetime", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/bootstrap-database-lifetime.test.mjs", testCaseId: "SEC-02 SQLite connection lifetime blocks bootstrap retirement until clean close" }),
  Object.freeze({ id: "daemon-lifetime", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/daemon-bootstrap-lifetime.test.mjs", testCaseId: "SEC-02 Daemon holds Node, loader and server leases until runtime ready and cleans the process tree" }),
  Object.freeze({ id: "dispatcher-gateway", layer: "integration", executionContract: "sec02-receipt", testFile: "tests/integration/path-tool-gateway.test.mjs", testCaseId: "SEC-02 real dispatcher executes read and exact-approved write/edit through scoped gateways" }),
  Object.freeze({ id: "electron-source", layer: "electron", executionContract: "node-test-file-pass", testFile: "tests/electron/desktop-smoke.test.mjs", testCaseId: "real Electron main, preload and renderer preserve identity and session across restart" }),
  Object.freeze({ id: "file-viewer", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/file-viewer-direct.test.mjs", testCaseId: "SEC-02 File Viewer uses one authority snapshot for list, preview, resolve and range handles" }),
  Object.freeze({ id: "model-lifetime", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/embedding-path-lifetime.test.mjs", testCaseId: "SEC-02 model tree lease binds every descendant identity and content for its lifetime" }),
  Object.freeze({ id: "packaged-asar", layer: "packaged", executionContract: "installed-parent-scan", testFile: "tests/packaged/installed-smoke.test.mjs", testCaseId: "current Windows installer repeats identity, persistence and cleanup smoke" }),
  Object.freeze({ id: "process-cwd", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/process-cwd.test.mjs", testCaseId: "SEC-02 Shell and Script use authorized initial CWD and deny external CWD before spawn" }),
  Object.freeze({ id: "process-tree", layer: "contract", executionContract: "node-test-file-pass", testFile: "tests/unit/process-tree.test.mjs", testCaseId: "SEC-02 Windows process-tree termination fails closed on taskkill failure" }),
  Object.freeze({ id: "repo-oracle", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/repo-oracle-path.test.mjs", testCaseId: "SEC-02 read_repo uses fixed Git NUL enumeration and authorizes every tracked entry" }),
  Object.freeze({ id: "watcher", layer: "integration", executionContract: "node-test-file-pass", testFile: "tests/integration/watcher-authority.test.mjs", testCaseId: "SEC-02 watcher events and controls remain bound to one runtime authority" }),
]);

function packageExpectation(relative) {
  if (relative.startsWith("src/")) return "compiled-to-asar";
  if (relative.startsWith("electron/")) return "included-in-asar";
  if (relative === "scripts/after-pack.cjs") return "builder-hook-only";
  if (relative.startsWith("public/vendor/")) return "included-in-asar";
  return "excluded-from-asar";
}

const policyKinds = new Set(["adapter-internal", "bootstrap-adapter", "runtime-canary", "worker-byte-only", "static-module-loader", "build-governance", "test-only", "configuration-only"]);
const runtimePolicyKinds = new Set(["adapter-internal", "bootstrap-adapter", "runtime-canary", "worker-byte-only", "static-module-loader"]);
const sitePolicyKeys = Object.freeze(["siteId", "sourcePath", "normalizedNodeSha256", "container", "family", "api", "pathOperands", "executionClass", "packageExpectation", "binding"]);

function canonicalPayload(value) {
  const { canonicalPayloadSha256: _digest, ...payload } = value;
  return payload;
}

function validatePolicyBinding(binding, site) {
  assert.deepEqual(Object.keys(binding).sort(), ["anchor", "evidenceIds", "kind", "operands"].sort(), `Sink policy binding keys differ: ${site.id}`);
  assert(policyKinds.has(binding.kind), `Sink policy kind is invalid: ${site.id}`);
  assert.equal(typeof binding.anchor, "string");
  assert(binding.anchor.length > 0, `Sink policy anchor is empty: ${site.id}`);
  assert(Array.isArray(binding.evidenceIds));
  assert.equal(new Set(binding.evidenceIds).size, binding.evidenceIds.length, `Sink policy evidence is duplicated: ${site.id}`);
  assert(Array.isArray(binding.operands));
  assert.deepEqual(binding.operands.map(operand => operand.selector), site.pathOperands, `Sink operand policy differs: ${site.id}`);
  for (const operand of binding.operands) {
    assert.deepEqual(Object.keys(operand).sort(), ["anchor", "classification", "selector"].sort(), `Sink operand policy keys differ: ${site.id}`);
    assert.equal(typeof operand.classification, "string");
    assert(operand.classification.length > 0, `Sink operand classification is empty: ${site.id}`);
    assert.equal(typeof operand.anchor, "string");
    assert(operand.anchor.length > 0, `Sink operand anchor is empty: ${site.id}`);
  }
  if (runtimeClasses.has(site.executionClass)) {
    assert(runtimePolicyKinds.has(binding.kind), `Runtime sink has non-runtime policy: ${site.id}`);
    assert(binding.evidenceIds.length > 0, `Runtime sink has no evidence owner: ${site.id}`);
  } else {
    assert(!runtimePolicyKinds.has(binding.kind), `Non-runtime sink has runtime policy: ${site.id}`);
  }
}

export function validateSec02SinkPolicy(policy, sites, detectorPolicySha256) {
  assert.deepEqual(Object.keys(policy).sort(), ["schemaVersion", "task", "detectorPolicySha256", "bindings", "canonicalPayloadSha256"].sort(), "Sink review policy keys differ");
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.task, "SEC-02");
  assert.equal(policy.detectorPolicySha256, detectorPolicySha256, "Sink review policy targets a different detector");
  assert.equal(policy.canonicalPayloadSha256, sha256(canonicalJson(canonicalPayload(policy))), "Sink review policy digest differs");
  assert(Array.isArray(policy.bindings));
  const byId = new Map(policy.bindings.map(binding => [binding.siteId, binding]));
  assert.equal(byId.size, policy.bindings.length, "Sink review policy contains duplicate site IDs");
  for (const site of sites) {
    assert.notEqual(site.family, "unresolved-governed-call", `UNRESOLVED_GOVERNED_SINK: ${site.sourcePath}:${site.line}`);
    const reviewed = byId.get(site.id);
    assert(reviewed, `UNBOUND_SINK: ${site.sourcePath}:${site.line} ${site.family}.${site.api}`);
    assert.deepEqual(Object.keys(reviewed).sort(), sitePolicyKeys.slice().sort(), `Sink review record keys differ: ${site.id}`);
    for (const key of ["siteId", "sourcePath", "normalizedNodeSha256", "container", "family", "api", "executionClass", "packageExpectation"]) {
      const expected = key === "siteId" ? site.id : site[key];
      assert.deepEqual(reviewed[key], expected, `Sink review identity differs for ${site.id}: ${key}`);
    }
    assert.deepEqual(reviewed.pathOperands, site.pathOperands, `Sink review operands differ: ${site.id}`);
    validatePolicyBinding(reviewed.binding, site);
  }
  const currentIds = new Set(sites.map(site => site.id));
  const stale = policy.bindings.filter(binding => !currentIds.has(binding.siteId)).map(binding => binding.siteId);
  assert.deepEqual(stale, [], "STALE_SINK_POLICY entries remain");
  return Object.freeze({ policy, byId, canonicalPayloadSha256: policy.canonicalPayloadSha256 });
}

async function loadReviewedPolicy(projectRoot, sites, detectorPolicySha256) {
  const policy = JSON.parse(await readFile(path.join(projectRoot, ...sinkPolicyPath.split("/")), "utf8"));
  return validateSec02SinkPolicy(policy, sites, detectorPolicySha256);
}

async function executableFileRecords(projectRoot) {
  const sources = await collectSec02RuntimeSources(projectRoot);
  return [...sources].map(([sourcePath, source]) => {
    const bytes = Buffer.from(source, "utf8");
    return Object.freeze({
      sourcePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      role: sec02ExecutionClass(sourcePath),
      packageExpectation: packageExpectation(sourcePath),
    });
  });
}

function packageProjection() {
  return Object.freeze({
    stageValidator: "scripts/electron-stage-integrity.mjs",
    asarValidator: "scripts/electron-asar-integrity.mjs",
    installedOwner: Object.freeze({
      observationId: "SEC02-P36-packaged-asar-bound",
      testFile: "tests/packaged/installed-smoke.test.mjs",
      testCaseId: "current Windows installer repeats identity, persistence and cleanup smoke",
    }),
  });
}

async function runtimeEvidenceRecords(projectRoot) {
  return Promise.all(runtimeEvidenceDefinitions.map(async definition => Object.freeze({
    ...definition,
    testFileSha256: sha256(await readFile(path.join(projectRoot, ...definition.testFile.split("/")))),
  })));
}

async function expectedPayload(projectRoot) {
  const [files, sites, detectorBytes, runtimeEvidence, dialectCheckerBytes, dialectPolicyBytes] = await Promise.all([
    executableFileRecords(projectRoot),
    scanSec02Sinks(projectRoot),
    readFile(path.join(projectRoot, "scripts", "sec02-sink-scanner.mjs")),
    runtimeEvidenceRecords(projectRoot),
    readFile(path.join(projectRoot, "scripts", "sec02-sink-crosscheck.mjs")),
    readFile(path.join(projectRoot, ...crosscheckPolicyPath.split("/")), "utf8"),
  ]);
  const detectorPolicySha256 = sha256(detectorBytes);
  const dialectCheckerSha256 = sha256(dialectCheckerBytes);
  const dialectPolicy = JSON.parse(dialectPolicyBytes);
  const [reviewed, dialect] = await Promise.all([
    loadReviewedPolicy(projectRoot, sites, detectorPolicySha256),
    scanSec02RestrictedRuntime(projectRoot, dialectPolicy, dialectCheckerSha256),
  ]);
  const sinks = sites.map(site => Object.freeze({ ...site, binding: reviewed.byId.get(site.id).binding }));
  const executableManifestSha256 = sha256(canonicalJson(files));
  const runtimeSinkSetSha256 = sha256(canonicalJson(sinks));
  return Object.freeze({
    schemaVersion: 2,
    task: "SEC-02",
    detectorPolicySha256,
    reviewPolicySha256: reviewed.canonicalPayloadSha256,
    dialectCheckerSha256,
    dialectPolicySha256: dialectPolicy.canonicalPayloadSha256,
    dialectImportSetSha256: dialect.importSetSha256,
    runtimeSinkSetSha256,
    sourceClosure: Object.freeze({
      domain: "mini-lux/sec02/restricted-runtime-dialect/v1",
      executableFileCount: files.length,
      executableManifestSha256,
      dialectImportCount: dialect.importCount,
      dialectExceptionCount: dialect.exceptionCount,
    }),
    files,
    runtimeEvidence,
    sinks,
    packageProjection: packageProjection(),
  });
}

function withDigest(payload) {
  return Object.freeze({ ...payload, canonicalPayloadSha256: sha256(canonicalJson(payload)) });
}

async function compileSchema(projectRoot) {
  const schema = JSON.parse(await readFile(path.join(projectRoot, ...sinkInventorySchemaPath.split("/")), "utf8"));
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function assertEvidenceCatalog(projectRoot, catalog) {
  assert.equal(new Set(catalog.map(evidence => evidence.id)).size, catalog.length, "Runtime evidence IDs are duplicated");
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "tests", "manifests", "sec-02.json"), "utf8"));
  for (const evidence of catalog) {
    assert(manifest.layers[evidence.layer]?.includes(evidence.testFile), `Runtime evidence file is absent from its governed layer: ${evidence.id}`);
    const source = await readFile(path.join(projectRoot, ...evidence.testFile.split("/")));
    assert.equal(evidence.testFileSha256, sha256(source), `Runtime evidence source hash differs: ${evidence.id}`);
  }
}

async function assertOwners(projectRoot, inventory) {
  const evidenceMap = JSON.parse(await readFile(path.join(projectRoot, "tests", "sec02-evidence-map.json"), "utf8"));
  const runtimeOwner = evidenceMap.observationOverrides["SEC02-P36-runtime-adapter-canaries"];
  assert.deepEqual(runtimeOwner, { layer: "integration", testFile: "tests/integration/path-tool-gateway.test.mjs", testCaseId: "SEC-02 real dispatcher executes read and exact-approved write/edit through scoped gateways", producer: "node-test" });
  const packagedOwner = evidenceMap.observationOverrides[inventory.packageProjection.installedOwner.observationId];
  assert.deepEqual(packagedOwner, { layer: "packaged", testFile: inventory.packageProjection.installedOwner.testFile, testCaseId: inventory.packageProjection.installedOwner.testCaseId, producer: "node-test" });
}

export async function buildSec02SinkInventory(projectRoot) {
  return withDigest(await expectedPayload(projectRoot));
}

export async function validateSec02SinkInventory(projectRoot, inventory = null) {
  const actual = inventory ?? JSON.parse(await readFile(path.join(projectRoot, ...sinkInventoryPath.split("/")), "utf8"));
  const validate = await compileSchema(projectRoot);
  assert(validate(actual), `SEC-02 sink inventory schema failed: ${JSON.stringify(validate.errors)}`);
  assert.match(actual.canonicalPayloadSha256, sha256Pattern);
  const { canonicalPayloadSha256, ...payload } = actual;
  assert.equal(canonicalPayloadSha256, sha256(canonicalJson(payload)), "SEC-02 sink inventory digest differs");
  const expected = await buildSec02SinkInventory(projectRoot);
  assert.deepEqual(actual, expected, "SEC-02 sink inventory differs from canonical executable closure or AST sites");
  assert.equal(actual.sinks.some(site => site.family === "unresolved-governed-call"), false, "SEC-02 sink inventory contains unresolved governed calls");
  await assertEvidenceCatalog(projectRoot, actual.runtimeEvidence);
  const evidenceIds = new Set(actual.runtimeEvidence.map(evidence => evidence.id));
  const runtimeSinks = actual.sinks.filter(site => runtimeClasses.has(site.executionClass));
  const referencedRuntimeEvidence = new Set();
  for (const site of actual.sinks) {
    for (const evidenceId of site.binding.evidenceIds) {
      assert(evidenceIds.has(evidenceId), `Sink policy references unknown evidence: ${site.id}:${evidenceId}`);
      if (runtimeClasses.has(site.executionClass)) referencedRuntimeEvidence.add(evidenceId);
    }
  }
  await assertOwners(projectRoot, actual);
  const inventoryComplete = actual.files.length > 0
    && actual.sinks.length > 0
    && actual.sourceClosure.dialectImportCount > 0
    && actual.sourceClosure.dialectExceptionCount >= 0
    && !actual.sinks.some(site => site.family === "unresolved-governed-call");
  const runtimeCanaryComplete = runtimeSinks.length > 0
    && runtimeSinks.every(site => runtimePolicyKinds.has(site.binding.kind) && site.binding.evidenceIds.length > 0)
    && actual.runtimeEvidence.every(evidence => referencedRuntimeEvidence.has(evidence.id));
  const packagedBound = actual.packageProjection.stageValidator === "scripts/electron-stage-integrity.mjs"
    && actual.packageProjection.asarValidator === "scripts/electron-asar-integrity.mjs"
    && actual.packageProjection.installedOwner.observationId === "SEC02-P36-packaged-asar-bound"
    && referencedRuntimeEvidence.has("packaged-asar");
  assert.equal(inventoryComplete, true, "SEC-02 static inventory closure is incomplete");
  assert.equal(runtimeCanaryComplete, true, "SEC-02 runtime canary binding closure is incomplete");
  assert.equal(packagedBound, true, "SEC-02 package projection binding closure is incomplete");
  return Object.freeze({
    inventoryComplete,
    runtimeCanaryComplete,
    packagedBound,
    executableFileCount: actual.files.length,
    sinkCount: actual.sinks.length,
    runtimeSinkCount: actual.sinks.filter(site => runtimeClasses.has(site.executionClass)).length,
    canonicalPayloadSha256,
    detectorPolicySha256: actual.detectorPolicySha256,
    reviewPolicySha256: actual.reviewPolicySha256,
    dialectCheckerSha256: actual.dialectCheckerSha256,
    dialectPolicySha256: actual.dialectPolicySha256,
    dialectImportSetSha256: actual.dialectImportSetSha256,
    dialectImportCount: actual.sourceClosure.dialectImportCount,
    dialectExceptionCount: actual.sourceClosure.dialectExceptionCount,
    executableManifestSha256: actual.sourceClosure.executableManifestSha256,
    runtimeSinkSetSha256: actual.runtimeSinkSetSha256,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] === "--write") {
    const inventory = await buildSec02SinkInventory(projectRoot);
    await writeFile(path.join(projectRoot, ...sinkInventoryPath.split("/")), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ output: sinkInventoryPath, files: inventory.files.length, sinks: inventory.sinks.length, sha256: inventory.canonicalPayloadSha256 }, null, 2));
  } else if (process.argv[2] === "--check") {
    console.log(JSON.stringify(await validateSec02SinkInventory(projectRoot), null, 2));
  } else {
    throw new Error("Usage: node scripts/sec02-sink-inventory.mjs --write|--check");
  }
}
