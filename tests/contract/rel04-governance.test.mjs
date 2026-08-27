import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildRel04ResolvedManifest,
  loadRel04ResolvedManifest,
  readRel04BoundFile,
  validateRel04ResolvedManifest,
} from "../../scripts/rel04-governance.mjs";
import { publishRel04ResolvedBytes } from "../../scripts/generate-rel04-resolved-manifest.mjs";
import { makeTempDir, removeFixture } from "../helpers.mjs";

test("REL-04 resolved governance binds exact observability runtime and evidence identities", async () => {
  const built = await buildRel04ResolvedManifest();
  const loaded = await loadRel04ResolvedManifest();
  assert.deepEqual(loaded.manifest, built);
  await validateRel04ResolvedManifest(loaded.manifest);
  assert(loaded.manifest.runtimeEntries.every(entry => entry.owner === "REL-04"));
  assert(loaded.manifest.testEntries.every(entry => entry.owner === "REL-04"));
});

test("REL-04 report contract registers the exact authority review chain", async () => {
  const source = await readRel04BoundFile("scripts/report-schema.mjs", { field: "REL-04 report schema" });
  const text = source.bytes.toString("utf8");
  assert.match(text, /"REL-04": Object\.freeze\(\["architect", "developer", "reviewer"\]\)/u);
});

test("REL-04 governed runtime binds correlation, probes, metrics and bounded diagnostics", async () => {
  const files = Object.fromEntries(await Promise.all([
    "src/observability.ts",
    "src/logger.ts",
    "src/index.ts",
    "src/llm.ts",
    "src/agent.ts",
    "src/db.ts",
    "src/terminal.ts",
    "src/daemon.ts",
  ].map(async exactCasePath => {
    const source = await readRel04BoundFile(exactCasePath, { field: `REL-04 runtime ${exactCasePath}` });
    return [exactCasePath, source.bytes.toString("utf8")];
  })));
  assert.match(files["src/observability.ts"], /AsyncLocalStorage<MutableObservabilityContext>/u);
  assert.match(files["src/observability.ts"], /serializeDiagnosticBundle/u);
  assert.match(files["src/logger.ts"], /currentObservabilityContext/u);
  assert.match(files["src/index.ts"], /\/api\/health\/live/u);
  assert.match(files["src/index.ts"], /\/api\/health\/ready/u);
  assert.match(files["src/index.ts"], /serializeDiagnosticBundle\(bundle\)/u);
  assert.match(files["src/llm.ts"], /beginObservation\("llm"\)/u);
  assert.match(files["src/agent.ts"], /beginObservation\("tool"\)/u);
  assert.match(files["src/db.ts"], /beginObservation\("database"\)/u);
  assert.match(files["src/terminal.ts"], /beginObservation\("pty"\)/u);
  assert.match(files["src/daemon.ts"], /\/api\/health\/ready/u);
});

test("REL-04 resolved governance rejects payload and file identity substitution", async () => {
  const built = await buildRel04ResolvedManifest();
  const payloadTamper = structuredClone(built);
  payloadTamper.testEntries[0].owner = "GOV-03";
  await assert.rejects(() => validateRel04ResolvedManifest(payloadTamper), /payload digest differs/u);

  const hashTamper = structuredClone(built);
  hashTamper.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateRel04ResolvedManifest(hashTamper), /payload digest differs/u);

  const canonicalJson = value => Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  const resigned = structuredClone(built);
  resigned.runtimeEntries[0].owner = "GOV-03";
  const { canonicalPayloadSha256: _old, ...payload } = resigned;
  resigned.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(() => validateRel04ResolvedManifest(resigned), /differs from governed inputs/u);
});

test("REL-04 governed reads reject hardlinks and pathname replacement after open", async () => {
  const root = await makeTempDir("mini-lux-rel04-bound-file-");
  try {
    const hardlinked = path.join(root, "hardlinked.json");
    await writeFile(hardlinked, "{\"hardlink\":true}");
    await link(hardlinked, path.join(root, "alias.json"));
    await assert.rejects(
      () => readRel04BoundFile("hardlinked.json", { root, field: "hardlink fixture" }),
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
      () => readRel04BoundFile("live/manifest.json", {
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

test("REL-04 resolved publication rejects temporary pathname replacement before atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rel04-temp-replace-");
  const parent = path.join(root, "manifests");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRel04ResolvedBytes(output, "{\"trusted\":true}\n", {
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

test("REL-04 resolved publication pins its parent identity across the atomic rename", async () => {
  const root = await makeTempDir("mini-lux-rel04-publish-");
  const parent = path.join(root, "manifests");
  const retired = path.join(root, "retired");
  const output = path.join(parent, "resolved.json");
  await mkdir(parent);
  try {
    await assert.rejects(
      () => publishRel04ResolvedBytes(output, "{\"candidate\":true}\n", {
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
