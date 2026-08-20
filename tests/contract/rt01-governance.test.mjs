import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRt01ResolvedManifest,
  loadRt01ResolvedManifest,
  validateRt01ResolvedManifest,
} from "../../scripts/rt01-governance.mjs";

test("RT-01 resolved governance binds exact runtime and evidence identities", async () => {
  const built = await buildRt01ResolvedManifest();
  const loaded = await loadRt01ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateRt01ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "RT-01"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "RT-01"));
});

test("RT-01 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildRt01ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateRt01ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateRt01ResolvedManifest(hashTamper), /payload digest differs/u);
});
