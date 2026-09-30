import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildMedia04ResolvedManifest, validateMedia04ResolvedManifest } from "../../scripts/media04-governance.mjs";

const text = relative => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
const tools = ["generate_image", "generate_video", "media_status", "media_cancel", "media_history"];

test("MEDIA-04 registers generation lifecycle tools with approval and persona access", async () => {
  const [registry, definitions, policies, defaultPersona, generalPersona] = await Promise.all([
    text("src/tools/index.ts"), text("src/tools/media-tools.ts"), text("src/tool-policies.ts"), text("personas/default.md"), text("personas/general.md"),
  ]);
  for (const name of tools) {
    assert.match(registry, new RegExp(`name: ["']${name}["']`, "u"));
    assert.match(definitions, new RegExp(`name: ["']${name}["']`, "u"));
    assert.match(policies, new RegExp(`\\b${name}: policy\\(`, "u"));
    assert.match(defaultPersona, new RegExp(`^  - ${name}$`, "mu"));
    assert.match(generalPersona, new RegExp(`^  - ${name}$`, "mu"));
  }
  for (const name of ["generate_image", "generate_video", "media_cancel"]) assert.match(policies, new RegExp(`\\b${name}: policy\\([^\\n]+"user"`, "u"));
});

test("MEDIA-04 binds independent profiles, async persistence, cancellation, MIME limits, and history recovery", async () => {
  const [settings, config, helper, media] = await Promise.all([
    text("src/settings-schema.ts"), text("src/config.ts"), text("src/tools/image-helper.ts"), text("src/media.ts"),
  ]);
  for (const field of ["visionProfile", "imageProfile", "videoProfile"]) {
    assert.match(settings, new RegExp(`\\b${field}\\b`, "u"));
    assert.match(config, new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.match(helper, /getVisionProfile/u);
  assert.match(helper, /detectImageMime/u);
  assert.match(media, /class MediaJobManager/u);
  assert.match(media, /class OpenAiCompatibleMediaProvider/u);
  assert.match(media, /status === "queued" \|\| value\.status === "running"/u);
  assert.match(media, /active\.controller\.abort/u);
  assert.match(media, /MAX_VIDEO_BYTES/u);
  assert.match(media, /referenceMetadata/u);
});

test("MEDIA-04 governed manifest binds runtime and three evidence layers", async () => {
  const manifest = await buildMedia04ResolvedManifest();
  assert.equal(manifest.taskId, "MEDIA-04");
  assert.equal(manifest.runtimeEntries.length, 14);
  assert.equal(manifest.testEntries.length, 3);
  assert.deepEqual(new Set(manifest.testEntries.map(entry => entry.layer)), new Set(["unit", "integration", "contract"]));
  await validateMedia04ResolvedManifest(manifest);
});
