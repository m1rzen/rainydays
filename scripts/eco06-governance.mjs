import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sourceManifestPath = "tests/manifests/eco-06.json";
export const resolvedManifestPath = "tests/manifests/eco-06-resolved.json";
const baseline = Object.freeze({ product: "Lux Desktop", version: "0.1.898", manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df" });
const personaChain = Object.freeze(["architect", "developer", "debugger", "reviewer"]);
const requirements = Object.freeze([
  "managed-npm-esm-project",
  "canonical-playbook-mjs",
  "lux-done-agent-parallel-pipeline",
  "persistent-status-logs-artifacts-state",
  "singleton-and-child-abort",
  "archive-unarchive-delete-lifecycle",
  "running-mutation-denial",
]);
const layers = new Set(["unit", "integration", "contract"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

function safeRelativePath(value, field) {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(value.length > 0 && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/u.test(value), `${field} must be a POSIX relative path`);
  assert.equal(path.posix.normalize(value), value, `${field} is not normalized`);
  assert(!value.startsWith("../") && !value.includes("/../"), `${field} escapes the project`);
}

function uniquePaths(values, field) {
  const seen = new Set();
  for (const value of values) {
    safeRelativePath(value, field);
    const key = value.toLowerCase();
    assert(!seen.has(key), `${field} contains duplicate/case alias: ${value}`);
    seen.add(key);
  }
}

export async function readEco06BoundFile(relative, { root = projectRoot, field = "ECO-06 governed file" } = {}) {
  safeRelativePath(relative, field);
  const rootCanonical = await realpath(root);
  let cursor = root;
  for (const segment of relative.split("/")) {
    const names = await readdir(cursor);
    assert(names.includes(segment), `${field} casing differs: ${relative}`);
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    assert(!info.isSymbolicLink(), `${field} traverses a symbolic link: ${relative}`);
  }
  const containment = path.relative(rootCanonical, await realpath(cursor));
  assert(containment && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes project`);
  const handle = await open(cursor, "r");
  try {
    const before = await handle.stat({ bigint: true });
    assert(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(MAX_FILE_BYTES), `${field} identity/size invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, `${field} changed while reading`);
    return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  } finally {
    await handle.close();
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function payloadDigest(value) {
  const { canonicalPayloadSha256: _digest, ...payload } = value;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

async function loadSource(root = projectRoot) {
  const sourceFile = await readEco06BoundFile(sourceManifestPath, { root, field: "ECO-06 source manifest" });
  const source = JSON.parse(sourceFile.bytes.toString("utf8"));
  exactKeys(source, ["schemaVersion", "taskId", "baseline", "personaChain", "requirements", "runtimeFiles", "tests"], "ECO-06 source manifest");
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.taskId, "ECO-06");
  assert.deepEqual(source.baseline, baseline);
  assert.deepEqual(source.personaChain, personaChain);
  assert.deepEqual(source.requirements, requirements);
  assert(Array.isArray(source.runtimeFiles) && source.runtimeFiles.length > 0);
  uniquePaths(source.runtimeFiles, "ECO-06 runtime file");
  assert(Array.isArray(source.tests) && source.tests.length === 3);
  uniquePaths(source.tests.map(entry => entry?.exactCasePath), "ECO-06 test");
  for (const entry of source.tests) {
    exactKeys(entry, ["exactCasePath", "layer"], "ECO-06 test entry");
    assert(layers.has(entry.layer), `invalid ECO-06 layer: ${entry.layer}`);
  }
  assert.deepEqual(new Set(source.tests.map(entry => entry.layer)), layers);
  return Object.freeze({ source, sourceSha256: sourceFile.sha256 });
}

export async function buildEco06ResolvedManifest(root = projectRoot) {
  const { source, sourceSha256 } = await loadSource(root);
  const runtimeEntries = await Promise.all(source.runtimeFiles.map(async exactCasePath => ({ exactCasePath, sha256: (await readEco06BoundFile(exactCasePath, { root, field: "ECO-06 runtime file" })).sha256, owner: "ECO-06" })));
  const testEntries = await Promise.all(source.tests.map(async entry => ({ exactCasePath: entry.exactCasePath, sha256: (await readEco06BoundFile(entry.exactCasePath, { root, field: "ECO-06 test file" })).sha256, kind: "test", layer: entry.layer, owner: "ECO-06" })));
  const manifest = { schemaVersion: 1, taskId: "ECO-06", sourceManifest: { exactCasePath: sourceManifestPath, sha256: sourceSha256 }, requirements: [...requirements], runtimeEntries, testEntries };
  return Object.freeze({ ...manifest, canonicalPayloadSha256: payloadDigest(manifest) });
}

export async function validateEco06ResolvedManifest(manifest, root = projectRoot) {
  exactKeys(manifest, ["schemaVersion", "taskId", "sourceManifest", "requirements", "runtimeEntries", "testEntries", "canonicalPayloadSha256"], "ECO-06 resolved manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, "ECO-06");
  assert.match(manifest.canonicalPayloadSha256, sha256Pattern);
  assert.equal(payloadDigest(manifest), manifest.canonicalPayloadSha256);
  assert.deepEqual(manifest, await buildEco06ResolvedManifest(root));
  return true;
}

export async function loadEco06ResolvedManifest(root = projectRoot) {
  const file = await readEco06BoundFile(resolvedManifestPath, { root, field: "ECO-06 resolved manifest" });
  const manifest = JSON.parse(file.bytes.toString("utf8"));
  await validateEco06ResolvedManifest(manifest, root);
  return Object.freeze({ manifest, sha256: file.sha256 });
}

export function serializeEco06ResolvedManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
