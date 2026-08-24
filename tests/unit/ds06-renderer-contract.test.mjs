import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const [html, renderer, css, service, packageJson, prepareElectron] = await Promise.all([
  fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../../public/renderer.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../../public/renderer.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../../src/file-viewer.ts", import.meta.url), "utf8"),
  fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
  fs.readFile(new URL("../../scripts/prepare-electron-app.mjs", import.meta.url), "utf8"),
]);

test("DS-06 File Tab renderer exposes offline source, preview, edit and conflict controls", () => {
  for (const id of ["file-source-mode", "file-preview-mode", "file-edit", "file-save", "file-reload"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(renderer, /expectedRevision: data\.revision/u);
  assert.match(renderer, /response\.status === 409/u);
  assert.match(renderer, /fileEditConflict = true/u);
  assert.match(renderer, /const operation = Object\.freeze\(\{/u);
  assert.match(renderer, /operation\.generation === filePreviewGeneration/u);
  assert.match(renderer, /operation\.preview === selectedFilePreview/u);
  assert.match(renderer, /blockDirtyFileNavigation\(\)/u);
  assert.match(renderer, /disabled = !fileEditDirty \|\| fileSaving \|\| fileEditConflict/u);
  assert.match(renderer, /generation !== filePreviewGeneration/u);
  assert.match(renderer, /activeFileOwnerSessionId !== ownerSessionId/u);
  assert.match(renderer, /new EventSource\(`\/api\/files\/events\?/u);
  assert.match(css, /\.file-editor/u);
});

test("DS-06 HTML preview is an inert srcdoc and source rendering remains text-only", () => {
  assert.match(renderer, /frame\.setAttribute\("sandbox", ""\)/u);
  assert.match(renderer, /default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'/u);
  assert.match(renderer, /frame\.referrerPolicy = "no-referrer"/u);
  assert.match(renderer, /frame\.srcdoc =/u);
  assert.match(renderer, /code\.textContent = data\.text \|\| ""/u);
  assert.match(renderer, /article\.innerHTML = renderMarkdown/u);
  assert.doesNotMatch(service, /kind: "html"[^\n]*contentUrl/u);
});

test("DS-06 media uses retained Session-scoped content URLs without online assets", () => {
  assert.match(renderer, /document\.createElement\("audio"\)/u);
  assert.match(renderer, /document\.createElement\("video"\)/u);
  assert.match(renderer, /url\.searchParams\.set\("sessionId", activeFileOwnerSessionId \|\| ""\)/u);
  assert.match(service, /AUDIO_MIME\[extension\]/u);
  assert.match(service, /VIDEO_MIME\[extension\]/u);
  const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => match[1]);
  assert(assetReferences.length > 0);
  assert(assetReferences.every(value => value.startsWith("/")), JSON.stringify(assetReferences));
  const packageModel = JSON.parse(packageJson);
  assert(packageModel.build.files.includes("public/**/*"));
  assert(packageModel.build.asarUnpack.includes("public/**/*"));
  assert.match(prepareElectron, /\["dist", "electron", "public", "personas", "skills", "models", "scripts", "build"\]\.map\(copyDirectory\)/u);
  assert.equal(projectRoot.endsWith("mini-lux"), true);
});
