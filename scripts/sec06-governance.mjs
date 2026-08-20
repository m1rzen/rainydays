import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sourceManifestPath = "tests/manifests/sec-06.json";
export const resolvedManifestPath = "tests/manifests/sec-06-resolved.json";
const baseline = Object.freeze({
  product: "Lux Desktop",
  version: "0.1.898",
  manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df",
});
const personaChain = Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]);
const layers = new Set(["unit", "contract", "integration", "electron", "packaged"]);

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

function uniquePaths(entries, field) {
  const seen = new Set();
  for (const entry of entries) {
    safeRelativePath(entry, field);
    const identity = entry.toLowerCase();
    assert(!seen.has(identity), `${field} contains a duplicate or case alias: ${entry}`);
    seen.add(identity);
  }
}

async function boundFile(relative, root, field) {
  safeRelativePath(relative, field);
  let cursor = root;
  for (const segment of relative.split("/")) {
    const names = await readdir(cursor);
    assert(names.includes(segment), `${field} casing differs on disk: ${relative}`);
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    assert(!info.isSymbolicLink(), `${field} traverses a symbolic link: ${relative}`);
  }
  assert((await stat(cursor)).isFile(), `${field} is not a regular file: ${relative}`);
  const containment = path.relative(await realpath(root), await realpath(cursor));
  assert(containment && containment !== ".." && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes the project: ${relative}`);
  const bytes = await readFile(cursor);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
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

async function loadSource(root) {
  const sourceFile = await boundFile(sourceManifestPath, root, "SEC-06 source manifest");
  const source = JSON.parse(sourceFile.bytes.toString("utf8"));
  exactKeys(source, ["schemaVersion", "taskId", "baseline", "personaChain", "runtimeFiles", "tests"], "SEC-06 source manifest");
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.taskId, "SEC-06");
  assert.deepEqual(source.baseline, baseline);
  assert.deepEqual(source.personaChain, personaChain);
  assert(Array.isArray(source.runtimeFiles) && source.runtimeFiles.length > 0, "SEC-06 runtimeFiles are empty");
  uniquePaths(source.runtimeFiles, "SEC-06 runtime file");
  assert(Array.isArray(source.tests) && source.tests.length > 0, "SEC-06 tests are empty");
  uniquePaths(source.tests.map(entry => entry?.exactCasePath), "SEC-06 test");
  for (const entry of source.tests) {
    exactKeys(entry, ["exactCasePath", "layer"], "SEC-06 test entry");
    assert(layers.has(entry.layer), `SEC-06 test layer is invalid: ${entry.layer}`);
  }
  return { source, sourceFile };
}

export async function buildSec06ResolvedManifest({ root = projectRoot } = {}) {
  const { source, sourceFile } = await loadSource(root);
  const runtimeEntries = [];
  for (const exactCasePath of source.runtimeFiles) {
    const file = await boundFile(exactCasePath, root, "SEC-06 runtime file");
    runtimeEntries.push({ exactCasePath, sha256: file.sha256, owner: "SEC-06" });
  }
  const testEntries = [];
  for (const entry of source.tests) {
    const file = await boundFile(entry.exactCasePath, root, "SEC-06 test");
    testEntries.push({ exactCasePath: entry.exactCasePath, sha256: file.sha256, kind: "test", layer: entry.layer, owner: "SEC-06" });
  }
  const resolved = {
    schemaVersion: 1,
    taskId: "SEC-06",
    sourceManifest: { exactCasePath: sourceManifestPath, sha256: sourceFile.sha256 },
    runtimeEntries,
    testEntries,
    canonicalPayloadSha256: "",
  };
  resolved.canonicalPayloadSha256 = payloadDigest(resolved);
  return resolved;
}

export async function validateSec06ResolvedManifest(manifest, { root = projectRoot } = {}) {
  exactKeys(manifest, ["schemaVersion", "taskId", "sourceManifest", "runtimeEntries", "testEntries", "canonicalPayloadSha256"], "SEC-06 resolved manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, "SEC-06");
  assert.match(manifest.canonicalPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.canonicalPayloadSha256, payloadDigest(manifest), "SEC-06 resolved payload digest differs");
  assert.deepEqual(manifest, await buildSec06ResolvedManifest({ root }), "SEC-06 resolved manifest differs from governed inputs");
  return manifest;
}

export async function loadSec06ResolvedManifest({ root = projectRoot } = {}) {
  const file = await boundFile(resolvedManifestPath, root, "SEC-06 resolved manifest");
  const manifest = JSON.parse(file.bytes.toString("utf8"));
  await validateSec06ResolvedManifest(manifest, { root });
  return { manifest, filePath: path.join(root, ...resolvedManifestPath.split("/")) };
}

export function serializeSec06ResolvedManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
