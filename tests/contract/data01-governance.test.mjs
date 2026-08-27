import assert from "node:assert/strict";
import test from "node:test";
import {
  buildData01ResolvedManifest,
  loadData01ResolvedManifest,
  validateData01ResolvedManifest,
} from "../../scripts/data01-governance.mjs";

test("DATA-01 resolved governance binds the exact source, runtime and test identities", async () => {
  const built = await buildData01ResolvedManifest();
  const loaded = await loadData01ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateData01ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "DATA-01"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "DATA-01"));
});

test("DATA-01 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildData01ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateData01ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateData01ResolvedManifest(hashTamper), /payload digest differs/u);
});
