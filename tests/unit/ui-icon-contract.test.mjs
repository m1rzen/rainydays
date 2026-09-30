import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
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

test("all shell icon references resolve to square, untransformed geometry", async () => {
  const html = await readPublic("index.html");
  const { document } = parseHTML(html);
  const symbols = [...document.querySelectorAll("symbol")];
  assert(symbols.length > 30, "the common icon vocabulary must cover generated controls too");
  const ids = new Set(symbols.map(symbol => symbol.id));
  assert.equal(ids.size, symbols.length, "icon ids must be unique");
  for (const symbol of symbols) {
    const [, , width, height] = symbol.getAttribute("viewBox").split(" ").map(Number);
    assert.equal(width, height, `${symbol.id} must have a square viewBox`);
    assert.equal(symbol.querySelector("[transform]"), null, `${symbol.id} has transformed geometry`);
  }
  for (const use of document.querySelectorAll("use")) {
    assert(ids.has(use.getAttribute("href").slice(1)), "unresolved shell icon");
  }
});

test("tool receipts preserve arguments and results while their collapsed status changes", async () => {
  const [html, renderer] = await Promise.all([readPublic("index.html"), readPublic("renderer.js")]);
  const { document } = parseHTML(html);
  const iconFunctions = renderer.slice(renderer.indexOf("function createUiIcon"), renderer.indexOf("function renderWelcomeState"));
  const toolFunctions = renderer.slice(renderer.indexOf("function addToolCard"), renderer.indexOf("async function clearChat"));
  const context = vm.createContext({ document, setTimeout: callback => callback(), enhanceLocalFileLinks: () => {} });
  vm.runInContext(iconFunctions + toolFunctions, context);
  const host = document.createElement("div");
  context.addToolCard(host, { toolName:"read_file", toolArgs:{ path:"notes.md" } });
  const card = host.querySelector(".tool-card");
  assert.equal(card.tagName, "DETAILS");
  assert.equal(card.hasAttribute("open"), false);
  assert.equal(card.querySelector(".tool-card-status").textContent, "执行中");
  context.updateLastToolCard(host, { toolName:"read_file", toolStatus:"success", content:"Source material" });
  assert.equal(card.querySelector(".tool-card-status").textContent, "完成");
  assert.equal(card.querySelector(".label").textContent, "读取文件");
  assert.match(card.querySelector(".tool-card-body").textContent, /notes\.md[\s\S]*Source material/u);
  assert.equal(card.querySelector(".icon use").getAttribute("href"), "#i-check");
  context.updateLastToolCard(host, { toolName:"read_file", toolStatus:"error", content:"Missing source" });
  assert.equal(card.querySelector(".tool-card-status").textContent, "未完成");
  assert.equal(card.querySelector(".icon use").getAttribute("href"), "#i-alert");
});
