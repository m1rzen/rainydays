import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildTool06ResolvedManifest,
  loadTool06ResolvedManifest,
  readTool06BoundFile,
  validateTool06ResolvedManifest,
} from "../../scripts/tool06-governance.mjs";
import { publishTool06ResolvedBytes } from "../../scripts/generate-tool06-resolved-manifest.mjs";
import { makeTempDir, removeFixture } from "../helpers.mjs";

test("TOOL-06 resolved governance binds exact streaming download runtime and evidence identities", async () => {
  const built = await buildTool06ResolvedManifest();
  const loaded = await loadTool06ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateTool06ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "TOOL-06"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "TOOL-06"));
});

test("TOOL-06 report contract registers the exact authority review chain", async () => {
  const source = await readTool06BoundFile("scripts/report-schema.mjs", { field: "TOOL-06 report schema" });
  assert.match(source.bytes.toString("utf8"), /"TOOL-06": Object\.freeze\(\["developer", "debugger", "reviewer"\]\)/u);
});

test("TOOL-06 governed runtime binds detached streaming, Range controls and all task operations", async () => {
  const paths = [
    "src/path-policy.ts",
    "src/capability-broker.ts",
    "src/tools/download-tool.ts",
    "src/tools/index.ts",
    "src/tool-policies.ts",
    "scripts/sec02-sink-inventory.mjs",
    "personas/default.md",
    "personas/general.md",
    "personas/rds-assistant.md",
    "tests/manifests/sec-02.json",
    "tests/sec02-sink-inventory.json",
    "tests/sec02-sink-policy.json",
  ];
  const files = Object.fromEntries(await Promise.all(paths.map(async exactCasePath => {
    const source = await readTool06BoundFile(exactCasePath, { field: `TOOL-06 runtime ${exactCasePath}` });
    return [exactCasePath, source.bytes.toString("utf8")];
  })));
  assert.match(files["src/path-policy.ts"], /async beginStreamingWrite\(/u);
  assert.match(files["src/path-policy.ts"], /\.rainydays-stream-\$\{resumeId\}-\$\{targetDigest\}\.part/u);
  assert.match(files["src/path-policy.ts"], /bytes\.length > 4 \* 1024 \* 1024/u);
  assert.match(files["src/path-policy.ts"], /await this\.#barrier\("beforeFinalCreate"/u);
  assert.match(files["src/capability-broker.ts"], /reserveDetachedStreamingFile\(/u);
  assert.match(files["src/capability-broker.ts"], /registerDetachedResource\(/u);
  assert.match(files["src/tools/download-tool.ts"], /Range: `bytes=\$\{offset\}-`/u);
  assert.match(files["src/tools/download-tool.ts"], /"If-Range": validator\.validatorValue/u);
  assert.match(files["src/tools/download-tool.ts"], /name: "download_status"/u);
  assert.match(files["src/tools/download-tool.ts"], /name: "download_wait"/u);
  assert.match(files["src/tools/download-tool.ts"], /name: "download_cancel"/u);
  for (const name of ["download", "download_status", "download_wait", "download_cancel"]) {
    assert.match(files["src/tools/index.ts"], new RegExp(`name: "${name}"`, "u"));
    assert.match(files["src/tool-policies.ts"], new RegExp(`\\b${name}:`, "u"));
    for (const persona of ["default", "general", "rds-assistant"]) {
      assert.match(files[`personas/${persona}.md`], new RegExp(`  - ${name}(?:\\r?\\n|$)`, "u"));
    }
  }
  assert.match(files["scripts/sec02-sink-inventory.mjs"], /id: "download-streaming"/u);
  assert(JSON.parse(files["tests/manifests/sec-02.json"]).layers.integration.includes("tests/integration/tool06-download.test.mjs"));
  const inventory = JSON.parse(files["tests/sec02-sink-inventory.json"]);
  const policy = JSON.parse(files["tests/sec02-sink-policy.json"]);
  assert(inventory.files.some(entry => entry.sourcePath === "src/path-policy.ts"));
  assert(inventory.files.some(entry => entry.sourcePath === "src/tools/download-tool.ts"));
  assert.equal(inventory.reviewPolicySha256, policy.canonicalPayloadSha256);
});

test("TOOL-06 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildTool06ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateTool06ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateTool06ResolvedManifest(hashTamper), /payload digest differs/u);

  const canonicalJson = value => Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  const resigned = structuredClone(built);
  resigned.runtimeEntries[0].owner = "GOV-03";
  const { canonicalPayloadSha256: _old, ...payload } = resigned;
  resigned.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(() => validateTool06ResolvedManifest(resigned), /differs from governed inputs/u);
});

test("TOOL-06 governed reads reject hardlinks and pathname replacement after open", async () => {
  const root = await makeTempDir("mini-lux-tool06-bound-file-");
  try {
    const hardlinked = path.join(root, "hardlinked.json");
    await writeFile(hardlinked, "{\"hardlink\":true}");
    await link(hardlinked, path.join(root, "alias.json"));
    await assert.rejects(
      () => readTool06BoundFile("hardlinked.json", { root, field: "hardlink fixture" }),
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
      () => readTool06BoundFile("live/manifest.json", {
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

test("TOOL-06 resolved publication rejects temporary pathname replacement before atomic rename", async () => {
  const root = await makeTempDir("mini-lux-tool06-temp-replace-");
  const parent = path.join(root, "manifests");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishTool06ResolvedBytes(output, "{\"trusted\":true}\n", {
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

test("TOOL-06 resolved publication pins its parent identity across the atomic rename", async () => {
  const root = await makeTempDir("mini-lux-tool06-publish-");
  const parent = path.join(root, "manifests");
  const retired = path.join(root, "retired");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishTool06ResolvedBytes(output, "{\"candidate\":true}\n", {
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
