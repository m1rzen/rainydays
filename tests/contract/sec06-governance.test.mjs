import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSec06ResolvedManifest,
  loadSec06ResolvedManifest,
  validateSec06ResolvedManifest,
} from "../../scripts/sec06-governance.mjs";

test("SEC-06 resolved governance binds the exact runtime and evidence identities", async () => {
  const built = await buildSec06ResolvedManifest();
  const loaded = await loadSec06ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateSec06ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "SEC-06"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "SEC-06"));
});

test("SEC-06 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildSec06ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateSec06ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateSec06ResolvedManifest(hashTamper), /payload digest differs/u);
});
