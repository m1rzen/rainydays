import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sourceManifestPath = "tests/manifests/tool-01.json";
export const resolvedManifestPath = "tests/manifests/tool-01-resolved.json";
const baseline = Object.freeze({
  product: "Lux Desktop",
  version: "0.1.898",
  manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df",
});
const personaChain = Object.freeze(["architect", "developer", "reviewer"]);
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

const MAX_BOUND_FILE_BYTES = 16 * 1024 * 1024;

function fileIdentity(info) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function pathSnapshot(relative, root, field) {
  const nodes = [];
  let cursor = root;
  const rootInfo = await lstat(root, { bigint: true });
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `${field} project root is not a real directory`);
  nodes.push({ relative: "", identity: fileIdentity(rootInfo) });
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    const names = await readdir(cursor);
    assert(names.includes(segment), `${field} casing differs on disk: ${relative}`);
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    assert(!info.isSymbolicLink(), `${field} traverses a symbolic link: ${relative}`);
    if (index === segments.length - 1) {
      assert(info.isFile(), `${field} is not a regular file: ${relative}`);
      assert.equal(info.nlink, 1n, `${field} must not be hardlinked: ${relative}`);
    } else {
      assert(info.isDirectory(), `${field} ancestor is not a directory: ${relative}`);
    }
    nodes.push({ relative: segments.slice(0, index + 1).join("/"), identity: fileIdentity(info) });
  }
  return { cursor, nodes };
}

async function boundFile(relative, root, field, hooks = {}) {
  safeRelativePath(relative, field);
  const before = await pathSnapshot(relative, root, field);
  if (hooks.afterSnapshot !== undefined) {
    assert.equal(typeof hooks.afterSnapshot, "function", `${field} afterSnapshot hook is invalid`);
    await hooks.afterSnapshot({ absolutePath: before.cursor });
  }
  const containment = path.relative(await realpath(root), await realpath(before.cursor));
  assert(containment && containment !== ".." && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes the project: ${relative}`);
  const handle = await open(before.cursor, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    assert(opened.isFile(), `${field} opened object is not a regular file: ${relative}`);
    if (hooks.afterOpen !== undefined) {
      assert.equal(typeof hooks.afterOpen, "function", `${field} afterOpen hook is invalid`);
      await hooks.afterOpen({ absolutePath: before.cursor, openedIdentity: fileIdentity(opened) });
    }
    assert.equal(opened.nlink, 1n, `${field} opened object must not be hardlinked: ${relative}`);
    assert.equal(fileIdentity(opened), before.nodes.at(-1).identity, `${field} changed before open: ${relative}`);
    assert(opened.size > 0n && opened.size <= BigInt(MAX_BOUND_FILE_BYTES), `${field} size is invalid: ${relative}`);
    const bytes = await handle.readFile();
    assert.equal(BigInt(bytes.length), opened.size, `${field} read length differs: ${relative}`);
    const afterRead = await handle.stat({ bigint: true });
    assert.equal(fileIdentity(afterRead), fileIdentity(opened), `${field} changed while reading: ${relative}`);
    const after = await pathSnapshot(relative, root, field);
    assert.deepEqual(after.nodes, before.nodes, `${field} ancestor or leaf identity changed: ${relative}`);
    assert.equal(fileIdentity(afterRead), after.nodes.at(-1).identity, `${field} pathname no longer names the opened object: ${relative}`);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function readTool01BoundFile(relative, { root = projectRoot, field = "TOOL-01 governed file", afterSnapshot, afterOpen } = {}) {
  return boundFile(relative, root, field, { afterSnapshot, afterOpen });
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
  const sourceFile = await boundFile(sourceManifestPath, root, "TOOL-01 source manifest");
  const source = JSON.parse(sourceFile.bytes.toString("utf8"));
  exactKeys(source, ["schemaVersion", "taskId", "baseline", "personaChain", "runtimeFiles", "coverageExemptions", "tests"], "TOOL-01 source manifest");
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.taskId, "TOOL-01");
  assert.deepEqual(source.baseline, baseline);
  assert.deepEqual(source.personaChain, personaChain);
  assert(Array.isArray(source.runtimeFiles) && source.runtimeFiles.length > 0, "TOOL-01 runtimeFiles are empty");
  uniquePaths(source.runtimeFiles, "TOOL-01 runtime file");
  assert(source.coverageExemptions && typeof source.coverageExemptions === "object" && !Array.isArray(source.coverageExemptions), "TOOL-01 coverageExemptions must be an object");
  uniquePaths(Object.keys(source.coverageExemptions), "TOOL-01 coverage exemption");
  for (const [exactCasePath, exemption] of Object.entries(source.coverageExemptions)) {
    assert(source.runtimeFiles.includes(exactCasePath), `TOOL-01 coverage exemption is not an exact runtime file: ${exactCasePath}`);
    exactKeys(exemption, ["reason", "evidenceLayer", "evidence"], `TOOL-01 coverage exemption ${exactCasePath}`);
    assert.equal(typeof exemption.reason, "string");
    assert(exemption.reason.trim().length >= 12, `TOOL-01 coverage exemption reason is too short: ${exactCasePath}`);
    assert(layers.has(exemption.evidenceLayer), `TOOL-01 coverage exemption layer is invalid: ${exactCasePath}`);
    assert(Array.isArray(exemption.evidence) && exemption.evidence.length > 0, `TOOL-01 coverage exemption evidence is empty: ${exactCasePath}`);
    uniquePaths(exemption.evidence.map(entry => entry?.exactCasePath), `TOOL-01 coverage exemption evidence ${exactCasePath}`);
    for (const evidence of exemption.evidence) {
      exactKeys(evidence, ["exactCasePath", "layer"], `TOOL-01 coverage exemption evidence ${exactCasePath}`);
      assert.equal(evidence.layer, exemption.evidenceLayer, `TOOL-01 coverage exemption evidence layer differs: ${exactCasePath}`);
    }
  }
  assert(Array.isArray(source.tests) && source.tests.length > 0, "TOOL-01 tests are empty");
  uniquePaths(source.tests.map(entry => entry?.exactCasePath), "TOOL-01 test");
  for (const entry of source.tests) {
    exactKeys(entry, ["exactCasePath", "layer"], "TOOL-01 test entry");
    assert(layers.has(entry.layer), `TOOL-01 test layer is invalid: ${entry.layer}`);
  }
  const testsByPath = new Map(source.tests.map(entry => [entry.exactCasePath, entry]));
  for (const [runtimePath, exemption] of Object.entries(source.coverageExemptions)) {
    for (const evidence of exemption.evidence) {
      const testEntry = testsByPath.get(evidence.exactCasePath);
      assert(testEntry, `TOOL-01 coverage exemption evidence is not a governed test: ${runtimePath}`);
      assert.equal(testEntry.layer, evidence.layer, `TOOL-01 coverage exemption evidence test layer differs: ${runtimePath}`);
    }
  }
  return { source, sourceFile };
}

export async function buildTool01ResolvedManifest({ root = projectRoot, sourceSnapshot = null } = {}) {
  const { source, sourceFile } = sourceSnapshot ?? await loadSource(root);
  const runtimeEntries = [];
  for (const exactCasePath of source.runtimeFiles) {
    const file = await boundFile(exactCasePath, root, "TOOL-01 runtime file");
    runtimeEntries.push({ exactCasePath, sha256: file.sha256, owner: "TOOL-01" });
  }
  const testEntries = [];
  for (const entry of source.tests) {
    const file = await boundFile(entry.exactCasePath, root, "TOOL-01 test");
    testEntries.push({ exactCasePath: entry.exactCasePath, sha256: file.sha256, kind: "test", layer: entry.layer, owner: "TOOL-01" });
  }
  const resolved = {
    schemaVersion: 1,
    taskId: "TOOL-01",
    sourceManifest: { exactCasePath: sourceManifestPath, sha256: sourceFile.sha256 },
    runtimeEntries,
    testEntries,
    canonicalPayloadSha256: "",
  };
  resolved.canonicalPayloadSha256 = payloadDigest(resolved);
  return resolved;
}

export async function validateTool01ResolvedManifest(manifest, { root = projectRoot, sourceSnapshot = null } = {}) {
  exactKeys(manifest, ["schemaVersion", "taskId", "sourceManifest", "runtimeEntries", "testEntries", "canonicalPayloadSha256"], "TOOL-01 resolved manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, "TOOL-01");
  assert.match(manifest.canonicalPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.canonicalPayloadSha256, payloadDigest(manifest), "TOOL-01 resolved payload digest differs");
  const exactSource = sourceSnapshot ?? await loadSource(root);
  assert.deepEqual(manifest, await buildTool01ResolvedManifest({ root, sourceSnapshot: exactSource }), "TOOL-01 resolved manifest differs from governed inputs");
  return manifest;
}

export async function loadTool01ResolvedManifest({ root = projectRoot } = {}) {
  const sourceSnapshot = await loadSource(root);
  const file = await boundFile(resolvedManifestPath, root, "TOOL-01 resolved manifest");
  const manifest = JSON.parse(file.bytes.toString("utf8"));
  await validateTool01ResolvedManifest(manifest, { root, sourceSnapshot });
  return {
    manifest,
    source: structuredClone(sourceSnapshot.source),
    filePath: path.join(root, ...resolvedManifestPath.split("/")),
  };
}

export function serializeTool01ResolvedManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
