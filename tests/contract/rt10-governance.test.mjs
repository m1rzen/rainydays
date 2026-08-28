import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildRt10ResolvedManifest,
  loadRt10ResolvedManifest,
  readRt10BoundFile,
  validateRt10ResolvedManifest,
} from "../../scripts/rt10-governance.mjs";
import { publishRt10ResolvedBytes } from "../../scripts/generate-rt10-resolved-manifest.mjs";
import { makeTempDir, removeFixture } from "../helpers.mjs";

test("RT-10 resolved governance binds exact service lifecycle and recovery evidence identities", async () => {
  const built = await buildRt10ResolvedManifest();
  const loaded = await loadRt10ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateRt10ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "RT-10"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "RT-10"));
});

test("RT-10 report contract registers the exact authority review chain", async () => {
  const source = await readRt10BoundFile("scripts/report-schema.mjs", { field: "RT-10 report schema" });
  const text = source.bytes.toString("utf8");
  assert.match(text, /"RT-10": Object\.freeze\(\["architect", "developer", "debugger", "reviewer"\]\)/u);
});

test("RT-10 governed runtime binds supervision, authenticated readiness and bounded cleanup", async () => {
  const files = Object.fromEntries(await Promise.all([
    "electron/main.cjs",
    "electron/path-bootstrap.cjs",
    "electron/service-supervisor.cjs",
    "src/index.ts",
  ].map(async exactCasePath => {
    const source = await readRt10BoundFile(exactCasePath, { field: `RT-10 runtime ${exactCasePath}` });
    return [exactCasePath, source.bytes.toString("utf8")];
  })));
  assert.match(files["electron/main.cjs"], /new ServiceSupervisor\(\{/u);
  assert.match(files["electron/main.cjs"], /waitForServiceReady\(child\)/u);
  assert.match(files["electron/main.cjs"], /startServiceHealthMonitor\(\)/u);
  assert.match(files["electron/main.cjs"], /terminateServerProcess\(child, reason = "shutdown"\)/u);
  assert.match(files["electron/main.cjs"], /withRuntimeAppRootDirectory\("server-process-cwd"/u);
  assert.match(files["electron/path-bootstrap.cjs"], /async withRuntimeAppRootDirectory\(role, use\)/u);
  assert.match(files["electron/service-supervisor.cjs"], /"crash-loop"/u);
  assert.match(files["electron/service-supervisor.cjs"], /#scheduleRestart\(failure, error = null\)/u);
  assert.match(files["src/index.ts"], /type: "rainydays-service-ready"/u);
  assert.match(files["src/index.ts"], /rainydays-service-shutdown/u);
  assert.match(files["src/index.ts"], /handleServiceControlRequest\(message\)/u);
});

test("RT-10 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildRt10ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateRt10ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateRt10ResolvedManifest(hashTamper), /payload digest differs/u);

  const canonicalJson = value => Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  const resigned = structuredClone(built);
  resigned.runtimeEntries[0].owner = "GOV-03";
  const { canonicalPayloadSha256: _old, ...payload } = resigned;
  resigned.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(() => validateRt10ResolvedManifest(resigned), /differs from governed inputs/u);
});

test("RT-10 governed reads reject hardlinks and pathname replacement after open", async () => {
  const root = await makeTempDir("mini-lux-rt10-bound-file-");
  try {
    const hardlinked = path.join(root, "hardlinked.json");
    await writeFile(hardlinked, "{\"hardlink\":true}");
    await link(hardlinked, path.join(root, "alias.json"));
    await assert.rejects(
      () => readRt10BoundFile("hardlinked.json", { root, field: "hardlink fixture" }),
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
      () => readRt10BoundFile("live/manifest.json", {
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

test("RT-10 resolved publication rejects temporary pathname replacement before atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rt10-temp-replace-");
  const parent = path.join(root, "manifests");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRt10ResolvedBytes(output, "{\"trusted\":true}\n", {
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

test("RT-10 resolved publication pins its parent identity across the atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rt10-publish-");
  const parent = path.join(root, "manifests");
  const retired = path.join(root, "retired");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRt10ResolvedBytes(output, "{\"candidate\":true}\n", {
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
