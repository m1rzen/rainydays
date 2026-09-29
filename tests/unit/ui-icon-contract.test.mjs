import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const readPublic = name => readFile(path.join(projectRoot, "public", name), "utf8");

test("desktop shell icons use stable SVG geometry and keep labeled utilities out of the status bar", async () => {
  const [html, renderer, redesign] = await Promise.all([
    readPublic("index.html"),
    readPublic("renderer.js"),
    readPublic("redesign.css"),
  ]);

  const settings = /<symbol id="i-settings"[^>]*>([\s\S]*?)<\/symbol>/u.exec(html)?.[1] || "";
  assert(settings, "settings symbol is missing");
  assert.doesNotMatch(settings, /\btransform=/u, "control icons must not depend on transformed geometry");

  const utilityMenu = /<div class="utility-menu-panel">([\s\S]*?)<\/div><\/details>/u.exec(html)?.[1] || "";
  assert.match(utilityMenu, /id="tts-toggle"/u, "speech playback belongs in the labeled utility menu");
  const statusBar = /<div id="status-bar">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/u.exec(html)?.[1] || "";
  assert.doesNotMatch(statusBar, /id="tts-toggle"/u, "the compact status bar must not carry an unlabeled speech glyph");

  assert.match(renderer, /function renderTtsToggleState\(/u);
  assert.doesNotMatch(renderer, /ttsButton\.innerHTML|btn\.innerHTML/u, "state updates must preserve the labeled control DOM");
  assert.match(redesign, /#tts-toggle svg\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/u);
});
