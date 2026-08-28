import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildDs01ResolvedManifest,
  loadDs01ResolvedManifest,
  readDs01BoundFile,
  validateDs01ResolvedManifest,
} from "../../scripts/ds01-governance.mjs";
import { publishDs01ResolvedBytes } from "../../scripts/generate-ds01-resolved-manifest.mjs";
import { makeTempDir, removeFixture } from "../helpers.mjs";

test("DS-01 resolved governance binds exact main-process lifecycle and recovery evidence identities", async () => {
  const built = await buildDs01ResolvedManifest();
  const loaded = await loadDs01ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateDs01ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "DS-01"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "DS-01"));
});

test("DS-01 report contract registers the exact authority review chain", async () => {
  const source = await readDs01BoundFile("scripts/report-schema.mjs", { field: "DS-01 report schema" });
  const text = source.bytes.toString("utf8");
  assert.match(text, /"DS-01": Object\.freeze\(\["architect", "developer", "debugger", "reviewer"\]\)/u);
});

test("DS-01 governed runtime binds display recovery, single-instance routing, renderer recovery and shutdown", async () => {
  const files = Object.fromEntries(await Promise.all([
    "electron/main.cjs",
    "electron/window-lifecycle.cjs",
    "tests/sec02-sink-inventory.json",
    "tests/sec02-sink-policy.json",
  ].map(async exactCasePath => {
    const source = await readDs01BoundFile(exactCasePath, { field: `DS-01 runtime ${exactCasePath}` });
    return [exactCasePath, source.bytes.toString("utf8")];
  })));
  assert.match(files["electron/main.cjs"], /app\.on\("second-instance", \(_event, commandLine\) => handleLaunchIntent\(parseLaunchIntent\(commandLine\)\)\)/u);
  assert.match(files["electron/main.cjs"], /screen\.on\("display-removed", onDisplayTopologyChanged\)/u);
  assert.match(files["electron/main.cjs"], /webContents\.on\("render-process-gone"/u);
  assert.match(files["electron/main.cjs"], /windowStateStore\?\.close\(\)/u);
  assert.match(files["electron/main.cjs"], /new AggregateError\(errors, "RainyDays shutdown cleanup failed"\)/u);
  assert.match(files["electron/window-lifecycle.cjs"], /function resolveWindowState\(value, displayInput\)/u);
  assert.match(files["electron/window-lifecycle.cjs"], /function parseLaunchIntent\(argv\)/u);
  assert.match(files["electron/window-lifecycle.cjs"], /function createWindowStateStore\(\{ root, io, path, randomBytes/u);
  assert.match(files["electron/window-lifecycle.cjs"], /io\.renameSync\(temporary, statePath\)/u);
  assert.match(files["tests/sec02-sink-policy.json"], /sink-54b585ac0ded7689fdb3fc5e/u);
  assert.match(files["tests/sec02-sink-policy.json"], /sink-b77e7f8b41c79781b186d387/u);
  const inventory = JSON.parse(files["tests/sec02-sink-inventory.json"]);
  const policy = JSON.parse(files["tests/sec02-sink-policy.json"]);
  assert(inventory.files.some(entry => entry.sourcePath === "electron/window-lifecycle.cjs"));
  assert.equal(inventory.reviewPolicySha256, policy.canonicalPayloadSha256);
});

test("DS-01 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildDs01ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateDs01ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateDs01ResolvedManifest(hashTamper), /payload digest differs/u);

  const canonicalJson = value => Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  const resigned = structuredClone(built);
  resigned.runtimeEntries[0].owner = "GOV-03";
  const { canonicalPayloadSha256: _old, ...payload } = resigned;
  resigned.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(() => validateDs01ResolvedManifest(resigned), /differs from governed inputs/u);
});

test("DS-01 governed reads reject hardlinks and pathname replacement after open", async () => {
  const root = await makeTempDir("mini-lux-ds01-bound-file-");
  try {
    const hardlinked = path.join(root, "hardlinked.json");
    await writeFile(hardlinked, "{\"hardlink\":true}");
    await link(hardlinked, path.join(root, "alias.json"));
    await assert.rejects(
      () => readDs01BoundFile("hardlinked.json", { root, field: "hardlink fixture" }),
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
      () => readDs01BoundFile("live/manifest.json", {
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

test("DS-01 resolved publication rejects temporary pathname replacement before atomic rename", async () => {
  const root = await makeTempDir("mini-lux-ds01-temp-replace-");
  const parent = path.join(root, "manifests");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishDs01ResolvedBytes(output, "{\"trusted\":true}\n", {
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

test("DS-01 resolved publication pins its parent identity across the atomic rename", async () => {
  const root = await makeTempDir("mini-lux-ds01-publish-");
  const parent = path.join(root, "manifests");
  const retired = path.join(root, "retired");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishDs01ResolvedBytes(output, "{\"candidate\":true}\n", {
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
