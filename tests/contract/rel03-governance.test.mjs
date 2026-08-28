import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildRel03ResolvedManifest,
  loadRel03ResolvedManifest,
  readRel03BoundFile,
  validateRel03ResolvedManifest,
} from "../../scripts/rel03-governance.mjs";
import { publishRel03ResolvedBytes } from "../../scripts/generate-rel03-resolved-manifest.mjs";
import { makeTempDir, removeFixture } from "../helpers.mjs";

test("REL-03 resolved governance binds exact safe-mode runtime and fault-injection evidence identities", async () => {
  const built = await buildRel03ResolvedManifest();
  const loaded = await loadRel03ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateRel03ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "REL-03"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "REL-03"));
});

test("REL-03 report contract registers the exact authority review chain", async () => {
  const source = await readRel03BoundFile("scripts/report-schema.mjs", { field: "REL-03 report schema" });
  const text = source.bytes.toString("utf8");
  assert.match(text, /"REL-03": Object\.freeze\(\["architect", "developer", "debugger", "reviewer"\]\)/u);
});

test("REL-03 governed runtime binds crash ledger, backend-free recovery UI and graded crash loops", async () => {
  const files = Object.fromEntries(await Promise.all([
    "electron/main.cjs",
    "electron/recovery-state.cjs",
    "tests/sec02-sink-inventory.json",
    "tests/sec02-sink-policy.json",
  ].map(async exactCasePath => {
    const source = await readRel03BoundFile(exactCasePath, { field: `REL-03 runtime ${exactCasePath}` });
    return [exactCasePath, source.bytes.toString("utf8")];
  })));
  assert.match(files["electron/main.cjs"], /recoveryStateStore\.beginLaunch\(\{/u);
  assert.match(files["electron/main.cjs"], /createRecoveryWindow\("integrity-failure"\)/u);
  assert.match(files["electron/main.cjs"], /activateSafeMode\("service-crash-loop"\)/u);
  assert.match(files["electron/main.cjs"], /activateSafeMode\("renderer-crash-loop"\)/u);
  assert.match(files["electron/main.cjs"], /default-src 'none'; style-src 'unsafe-inline'/u);
  assert.match(files["electron/main.cjs"], /if \(!recoveryRelaunchRequested\) recoveryState = recoveryStateStore\?\.markCleanExit\(\)/u);
  assert.match(files["electron/recovery-state.cjs"], /const MAIN_CRASH_THRESHOLD = 3/u);
  assert.match(files["electron/recovery-state.cjs"], /const beginLaunch = \(\{ time, forceSafeMode = false, normalRetry = false \} = \{\}\)/u);
  assert.match(files["electron/recovery-state.cjs"], /const requestNormalRetry = time =>/u);
  assert.match(files["electron/recovery-state.cjs"], /io\.renameSync\(temporary, statePath\)/u);
  assert.match(files["tests/sec02-sink-policy.json"], /sink-15a15790a430f152fc1b41b6/u);
  const inventory = JSON.parse(files["tests/sec02-sink-inventory.json"]);
  const policy = JSON.parse(files["tests/sec02-sink-policy.json"]);
  assert(inventory.files.some(entry => entry.sourcePath === "electron/recovery-state.cjs"));
  assert.equal(inventory.reviewPolicySha256, policy.canonicalPayloadSha256);
});

test("REL-03 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildRel03ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateRel03ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateRel03ResolvedManifest(hashTamper), /payload digest differs/u);

  const canonicalJson = value => Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  const resigned = structuredClone(built);
  resigned.runtimeEntries[0].owner = "GOV-03";
  const { canonicalPayloadSha256: _old, ...payload } = resigned;
  resigned.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(() => validateRel03ResolvedManifest(resigned), /differs from governed inputs/u);
});

test("REL-03 governed reads reject hardlinks and pathname replacement after open", async () => {
  const root = await makeTempDir("mini-lux-rel03-bound-file-");
  try {
    const hardlinked = path.join(root, "hardlinked.json");
    await writeFile(hardlinked, "{\"hardlink\":true}");
    await link(hardlinked, path.join(root, "alias.json"));
    await assert.rejects(
      () => readRel03BoundFile("hardlinked.json", { root, field: "hardlink fixture" }),
      /must not be hardlinked/u,
    );

    const liveDirectory = path.join(root, "live");
    const replacementDirectory = path.join(root, "replacement");
    await Promise.all([mkdir(liveDirectory), mkdir(replacementDirectory)]);
    await Promise.all([
      writeFile(path.join(liveDirectory, "manifest.json"), "{\"identity\":\"original\"}"),
      writeFile(path.join(replacementDirectory, "manifest.json"), "{\"identity\":\"replacement\"}"),
    ]);
    await assert.rejects(
      () => readRel03BoundFile("live/manifest.json", {
        root,
        field: "ancestor swap fixture",
        afterSnapshot: async () => {
          await rename(liveDirectory, path.join(root, "retired"));
          await rename(replacementDirectory, liveDirectory);
        },
      }),
      /changed before open|ancestor or leaf identity changed|pathname no longer names/u,
    );
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 resolved publication rejects temporary pathname replacement before atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rel03-temp-replace-");
  const parent = path.join(root, "manifests");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRel03ResolvedBytes(output, "{\"trusted\":true}\n", {
        root,
        beforeRename: async ({ temporary }) => {
          await rm(temporary);
          await writeFile(temporary, "{\"substituted\":true}\n");
        },
      }),
      /EPERM|operation not permitted|temporary identity changed before publication/iu,
    );
  } finally {
    await removeFixture(root);
  }
});

test("REL-03 resolved publication pins its parent identity across the atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rel03-publish-");
  const parent = path.join(root, "manifests");
  const retired = path.join(root, "retired");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRel03ResolvedBytes(output, "{\"candidate\":true}\n", {
        root,
        beforeRename: async () => {
          await rename(parent, retired);
          await mkdir(parent);
        },
      }),
      /operation not permitted|EPERM|parent changed during publication/iu,
    );
  } finally {
    await removeFixture(root);
  }
});
