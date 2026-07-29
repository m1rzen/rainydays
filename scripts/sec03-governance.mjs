import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const resolvedManifestPath = "tests/manifests/sec-03-resolved.json";
export const architectureSha256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
export const predecessorFileSha256 = "a788157aeb96cf6a4ca4ac6878eb902207df4aeffad2b537a782930a98961b5a";
export const predecessorPayloadSha256 = "e1826c3c47342813095569432326640b2fc88854163c54ced8aba7244adc7108";
export const attackMatrixSha256 = "5b2bc86c818aab0135d1db11de0ac5dc138ae253c41944aef1829053963eff21";
export const layerNames = Object.freeze(["unit", "contract", "integration", "electron", "packaged"]);
const sourcePath = "tests/manifests/sec-03.json";
const predecessorPath = "tests/manifests/sec-02-resolved.json";
const shaPattern = /^[a-f0-9]{64}$/u;
const nativePrefix = "native/sandbox-host/";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function sha256Bytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalPayloadSha256(value) {
  const { canonicalPayloadSha256: _ignored, ...payload } = value;
  return sha256Bytes(canonicalJson(payload));
}
function exactKeys(value, keys, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${field} keys differ`);
}
function safePath(value, field) {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(value && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/u.test(value), `${field} must be a POSIX relative path`);
  assert.equal(path.posix.normalize(value), value, `${field} must be normalized`);
  assert(!value.startsWith("../") && !value.includes("/../"), `${field} escapes the project`);
}
async function boundFile(relative, root, field) {
  safePath(relative, field);
  let cursor = root;
  for (const segment of relative.split("/")) {
    const names = await readdir(cursor);
    assert(names.includes(segment), `${field} is missing or casing differs: ${relative}`);
    cursor = path.join(cursor, segment);
    assert(!(await lstat(cursor)).isSymbolicLink(), `${field} traverses a link: ${relative}`);
  }
  assert((await stat(cursor)).isFile(), `${field} is not a regular file: ${relative}`);
  const containment = path.relative(await realpath(root), await realpath(cursor));
  assert(containment && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes the project: ${relative}`);
  const bytes = await readFile(cursor);
  return { bytes, sha256: sha256Bytes(bytes) };
}
function assertUnique(records, field) {
  const seen = new Set();
  for (const record of records) {
    const identity = record.exactCasePath.toLowerCase();
    assert(!seen.has(identity), `${field} duplicate or case alias: ${record.exactCasePath}`);
    seen.add(identity);
  }
}
function testCaseIds(bytes, relative) {
  const source = bytes.toString("utf8");
  const ids = [];
  const pattern = /\b(?:test|[A-Za-z_$][\w$]*Test)\s*\(\s*["'`]([^"'`]+)["'`]/gu;
  for (const match of source.matchAll(pattern)) ids.push(match[1]);
  assert(ids.length > 0, `test entry has no test case: ${relative}`);
  assert.equal(new Set(ids).size, ids.length, `test case IDs are duplicated: ${relative}`);
  return ids;
}
function predecessorCanonical(manifest) {
  const { canonicalPayloadSha256: _ignored, ...payload } = manifest;
  return sha256Bytes(canonicalJson(payload));
}
function predecessorOwners(predecessor) {
  const view = predecessor.cumulativeViews.find((entry) => entry.taskId === "SEC-02");
  assert(view, "SEC-02 predecessor cumulative view is missing");
  const owners = new Map();
  for (const record of view.tests) owners.set(record.exactCasePath.toLowerCase(), { owner: record.sourceTask, sha256: record.sha256, hashScope: "file" });
  for (const exactCasePath of view.changedRuntimeFiles) if (!owners.has(exactCasePath.toLowerCase())) owners.set(exactCasePath.toLowerCase(), { owner: "SEC-02", sha256: predecessorPayloadSha256, hashScope: "predecessor-manifest" });
  for (const record of predecessor.governedArtifacts ?? []) owners.set(record.exactCasePath.toLowerCase(), { owner: "SEC-02", sha256: record.sha256, hashScope: "file" });
  return { view, owners };
}
function validateSourceShape(source) {
  exactKeys(source, ["schemaVersion", "taskId", "baseline", "personaChain", "architecture", "attackMatrix", "predecessor", "deltaEntries", "coverageExemptions"], "SEC-03 source manifest");
  assert.equal(source.schemaVersion, 2);
  assert.equal(source.taskId, "SEC-03");
  exactKeys(source.baseline, ["product", "version", "manifestSha256"], "baseline");
  assert.deepEqual(source.baseline, { product: "Lux Desktop", version: "0.1.898", manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df" });
  assert.deepEqual(source.personaChain, ["architect", "sentinel", "developer", "debugger", "reviewer"]);
  exactKeys(source.architecture, ["exactCasePath", "sha256"], "architecture");
  exactKeys(source.attackMatrix, ["exactCasePath", "sha256"], "attackMatrix");
  exactKeys(source.predecessor, ["taskId", "exactCasePath", "fileSha256", "canonicalPayloadSha256"], "predecessor");
  assert.equal(source.architecture.sha256, architectureSha256);
  assert.equal(source.attackMatrix.sha256, attackMatrixSha256);
  assert.deepEqual(source.predecessor, { taskId: "SEC-02", exactCasePath: predecessorPath, fileSha256: predecessorFileSha256, canonicalPayloadSha256: predecessorPayloadSha256 });
  assert(Array.isArray(source.deltaEntries) && source.deltaEntries.length > 0);
  assertUnique(source.deltaEntries, "delta entries");
  for (const entry of source.deltaEntries) {
    exactKeys(entry, ["exactCasePath", "kind", "layer", "owner", "supersedes"], `delta ${entry.exactCasePath}`);
    safePath(entry.exactCasePath, "delta path");
    assert(["runtime", "governance", "test"].includes(entry.kind), `delta kind is invalid: ${entry.exactCasePath}`);
    assert.equal(entry.owner, "SEC-03");
    assert.equal(typeof entry.supersedes, "boolean");
    if (entry.kind === "test") assert(layerNames.includes(entry.layer), `test layer is invalid: ${entry.exactCasePath}`);
    else assert.equal(entry.layer, null, `non-test layer must be null: ${entry.exactCasePath}`);
  }
  assert(Array.isArray(source.coverageExemptions));
  assertUnique(source.coverageExemptions, "coverage exemptions");
}
function validateNativeOwners(exemption, matrix, deltaPaths) {
  assert(exemption.evidenceOwners.length > 0, `native exemption evidence owners are empty: ${exemption.exactCasePath}`);
  const expectedFamilies = [...new Set(matrix.records.filter((record) => record.layer === "real-host").map((record) => record.familyId))];
  assert.deepEqual(expectedFamilies, Array.from({ length: 19 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`));
  for (const owner of exemption.evidenceOwners) {
    exactKeys(owner, ["receiptLayer", "testFile", "familyIds"], `native owner ${exemption.exactCasePath}`);
    assert.equal(owner.receiptLayer, "real-host");
    assert(deltaPaths.has(owner.testFile.toLowerCase()), `native owner test is outside SEC-03 delta: ${owner.testFile}`);
    assert(owner.familyIds.length > 0, `native owner families are empty: ${exemption.exactCasePath}`);
    assert.deepEqual(owner.familyIds, expectedFamilies, `native owner families differ from real-host matrix: ${exemption.exactCasePath}`);
  }
}
async function loadInputs(root) {
  const predecessorFile = await boundFile(predecessorPath, root, "SEC-02 predecessor");
  assert.equal(predecessorFile.sha256, predecessorFileSha256, "SEC-02 predecessor bytes changed");
  const predecessor = JSON.parse(predecessorFile.bytes);
  assert.equal(predecessor.canonicalPayloadSha256, predecessorPayloadSha256, "SEC-02 predecessor payload digest changed");
  assert.equal(predecessorCanonical(predecessor), predecessorPayloadSha256, "SEC-02 predecessor content changed");
  const sourceFile = await boundFile(sourcePath, root, "SEC-03 source manifest");
  const source = JSON.parse(sourceFile.bytes);
  validateSourceShape(source);
  const architecture = await boundFile(source.architecture.exactCasePath, root, "SEC-03 architecture");
  assert.equal(architecture.sha256, architectureSha256, "SEC-03 architecture hash changed");
  const matrixFile = await boundFile(source.attackMatrix.exactCasePath, root, "SEC-03 matrix");
  assert.equal(matrixFile.sha256, attackMatrixSha256, "SEC-03 matrix hash changed");
  const matrix = JSON.parse(matrixFile.bytes);
  assert.equal(matrix.architectureSha256, architectureSha256);
  assert.equal(matrix.records.length, 482);
  return { predecessor, predecessorFile, source, sourceFile, matrix };
}
function cumulativeBase(view) {
  const records = [];
  const testPaths = new Set();
  for (const test of view.tests) {
    testPaths.add(test.exactCasePath.toLowerCase());
    records.push({ exactCasePath: test.exactCasePath, sha256: test.sha256, kind: "test", layer: test.layer, owner: test.sourceTask, testCaseIds: [], supersedes: null });
  }
  for (const exactCasePath of view.changedRuntimeFiles) if (!testPaths.has(exactCasePath.toLowerCase())) records.push({ exactCasePath, sha256: null, kind: "runtime", layer: null, owner: "SEC-02", testCaseIds: [], supersedes: null });
  return records;
}
function exactUnion(base, delta) {
  const result = [...base];
  const indexes = new Map(result.map((entry, index) => [entry.exactCasePath.toLowerCase(), index]));
  for (const entry of delta) {
    const identity = entry.exactCasePath.toLowerCase();
    if (indexes.has(identity)) result[indexes.get(identity)] = entry;
    else { indexes.set(identity, result.length); result.push(entry); }
  }
  return result;
}
export async function buildSec03ResolvedManifest(options = {}) {
  const root = options.root ?? projectRoot;
  const { predecessor, predecessorFile, source, sourceFile, matrix } = await loadInputs(root);
  const { view, owners } = predecessorOwners(predecessor);
  const deltaPaths = new Set(source.deltaEntries.map((entry) => entry.exactCasePath.toLowerCase()));
  const deltaEntries = [];
  for (const entry of source.deltaEntries) {
    const file = await boundFile(entry.exactCasePath, root, "SEC-03 delta entry");
    const old = owners.get(entry.exactCasePath.toLowerCase()) ?? null;
    assert.equal(entry.supersedes, old !== null, `supersedes marker differs from predecessor ownership: ${entry.exactCasePath}`);
    deltaEntries.push({ exactCasePath: entry.exactCasePath, sha256: file.sha256, kind: entry.kind, layer: entry.layer, owner: entry.owner, testCaseIds: entry.kind === "test" ? testCaseIds(file.bytes, entry.exactCasePath) : [], supersedes: old });
  }
  const exemptions = [];
  for (const record of view.coverageExemptions) exemptions.push({ ...record, evidenceOwners: [] });
  const exemptionIndex = new Map(exemptions.map((entry, index) => [entry.exactCasePath.toLowerCase(), index]));
  for (const exemption of source.coverageExemptions) {
    exactKeys(exemption, ["exactCasePath", "reason", "evidenceLayer", "evidenceOwners"], `exemption ${exemption.exactCasePath}`);
    assert(deltaPaths.has(exemption.exactCasePath.toLowerCase()), `exemption is outside SEC-03 delta: ${exemption.exactCasePath}`);
    assert(layerNames.includes(exemption.evidenceLayer));
    if (exemption.exactCasePath.startsWith(nativePrefix)) validateNativeOwners(exemption, matrix, deltaPaths);
    else assert.deepEqual(exemption.evidenceOwners, [], `non-native exemption owners must be empty: ${exemption.exactCasePath}`);
    const resolved = { sourceTask: "SEC-03", ...exemption };
    const identity = exemption.exactCasePath.toLowerCase();
    if (exemptionIndex.has(identity)) exemptions[exemptionIndex.get(identity)] = resolved;
    else { exemptionIndex.set(identity, exemptions.length); exemptions.push(resolved); }
  }
  const cumulativeEntries = exactUnion(cumulativeBase(view), deltaEntries);
  for (const entry of cumulativeEntries) if (entry.sha256 === null) entry.sha256 = (await boundFile(entry.exactCasePath, root, "cumulative predecessor entry")).sha256;
  assertUnique(cumulativeEntries, "cumulative entries");
  const payload = {
    schemaVersion: 2,
    task: "SEC-03",
    state: "governance-ready-runtime-receipts-required",
    architecture: { exactCasePath: source.architecture.exactCasePath, sha256: architectureSha256 },
    attackMatrix: { exactCasePath: source.attackMatrix.exactCasePath, sha256: attackMatrixSha256, realHostFamilyIds: [...new Set(matrix.records.filter((record) => record.layer === "real-host").map((record) => record.familyId))], runtimeReceiptCount: matrix.records.length },
    predecessor: { taskId: "SEC-02", exactCasePath: predecessorPath, fileSha256: predecessorFile.sha256, canonicalPayloadSha256: predecessorPayloadSha256 },
    sourceManifest: { taskId: "SEC-03", exactCasePath: sourcePath, sha256: sourceFile.sha256 },
    deltaEntries,
    cumulativeEntries,
    coverageExemptions: exemptions,
  };
  return { ...payload, canonicalPayloadSha256: canonicalPayloadSha256(payload) };
}
export async function validateSec03ResolvedManifest(manifest, options = {}) {
  exactKeys(manifest, ["schemaVersion", "task", "state", "architecture", "attackMatrix", "predecessor", "sourceManifest", "deltaEntries", "cumulativeEntries", "coverageExemptions", "canonicalPayloadSha256"], "SEC-03 resolved manifest");
  assert.match(manifest.canonicalPayloadSha256, shaPattern);
  assert.equal(manifest.canonicalPayloadSha256, canonicalPayloadSha256(manifest), "SEC-03 canonical payload digest differs");
  const expected = await buildSec03ResolvedManifest(options);
  assert.deepEqual(manifest, expected, "resolved SEC-03 manifest differs from governed inputs");
  return manifest;
}
export function serializeResolvedManifest(manifest) { return `${JSON.stringify(manifest, null, 2)}\n`; }
