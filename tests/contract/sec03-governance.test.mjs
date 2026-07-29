import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildSec03ResolvedManifest,
  canonicalPayloadSha256,
  projectRoot,
  resolvedManifestPath,
  serializeResolvedManifest,
  validateSec03ResolvedManifest,
} from "../../scripts/sec03-governance.mjs";

function copy(value) { return structuredClone(value); }
function reseal(value) { value.canonicalPayloadSha256 = canonicalPayloadSha256(value); return value; }
async function current() {
  const filePath = path.join(projectRoot, ...resolvedManifestPath.split("/"));
  return { filePath, manifest: JSON.parse(await readFile(filePath, "utf8")) };
}

await test("SEC-03 resolved manifest is byte-stable and binds the exact cumulative union", async () => {
  const { filePath, manifest } = await current();
  await validateSec03ResolvedManifest(manifest);
  const rebuilt = await buildSec03ResolvedManifest();
  assert.deepEqual(rebuilt, manifest);
  assert.equal(await readFile(filePath, "utf8"), serializeResolvedManifest(rebuilt));
  assert.equal(new Set(manifest.cumulativeEntries.map((entry) => entry.exactCasePath.toLowerCase())).size, manifest.cumulativeEntries.length);
  assert(manifest.deltaEntries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));
  assert(manifest.deltaEntries.filter((entry) => entry.kind === "test").every((entry) => entry.layer && entry.testCaseIds.length > 0));
});

await test("SEC-03 governance rejects predecessor and content-hash mutation", async () => {
  const { manifest } = await current();
  const predecessor = copy(manifest);
  predecessor.predecessor.fileSha256 = "0".repeat(64);
  reseal(predecessor);
  await assert.rejects(() => validateSec03ResolvedManifest(predecessor), /governed inputs/u);
  const hash = copy(manifest);
  hash.deltaEntries[0].sha256 = "f".repeat(64);
  reseal(hash);
  await assert.rejects(() => validateSec03ResolvedManifest(hash), /governed inputs/u);
});

await test("SEC-03 governance rejects missing and duplicate entries", async () => {
  const { manifest } = await current();
  const missing = copy(manifest);
  missing.deltaEntries[0].exactCasePath = "src/does-not-exist.ts";
  missing.canonicalPayloadSha256 = "0".repeat(64);
  await assert.rejects(() => validateSec03ResolvedManifest(missing), /canonical payload|governed inputs/u);
  const duplicate = copy(manifest);
  duplicate.cumulativeEntries.push(copy(duplicate.cumulativeEntries[0]));
  duplicate.canonicalPayloadSha256 = "0".repeat(64);
  await assert.rejects(() => validateSec03ResolvedManifest(duplicate), /canonical payload|governed inputs/u);
});

await test("SEC-03 governance rejects empty native exemption evidence owners", async () => {
  const { manifest } = await current();
  const mutated = copy(manifest);
  const native = mutated.coverageExemptions.find((entry) => entry.exactCasePath.startsWith("native/sandbox-host/"));
  assert(native);
  native.evidenceOwners = [];
  mutated.canonicalPayloadSha256 = "0".repeat(64);
  await assert.rejects(() => validateSec03ResolvedManifest(mutated), /canonical payload|governed inputs/u);
});
