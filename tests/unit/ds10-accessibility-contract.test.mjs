import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const [html, renderer, css] = await Promise.all([
  fs.readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
  fs.readFile(path.join(projectRoot, "public", "renderer.js"), "utf8"),
  fs.readFile(path.join(projectRoot, "public", "renderer.css"), "utf8"),
]);

test("DS-10 static landmarks dialogs and live regions are explicit", () => {
  assert.match(html, /id="messages"[^>]*role="log"[^>]*aria-live="polite"/u);
  assert.match(html, /id="settings-modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="settings-title"/u);
  assert.match(html, /id="ask-modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="ask-title"/u);
  assert.match(html, /id="settings-domain-nav"[^>]*role="tablist"/u);
  assert.match(html, /id="terminal-tabs"[^>]*role="tablist"/u);
  assert.match(html, /id="terminal-output-panel"[^>]*role="tabpanel"/u);
  assert.match(html, /id="response-announcer"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(html, /id="file-list"[^>]*role="listbox"/u);
  assert.match(html, /id="settings-message"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(html, /<span[^>]*role="button"/u);
});

test("DS-10 renderer uses native interactive elements and managed focus", () => {
  assert.match(renderer, /function showAccessibleDialog\(modal, initialFocus\)/u);
  assert.match(renderer, /function hideAccessibleDialog\(modal\)/u);
  assert.match(renderer, /function syncDialogInertState\(\)/u);
  assert.match(renderer, /event\.key !== "Tab"/u);
  assert.match(renderer, /dialogStack\.at\(-1\) === settingsModal/u);
  assert.match(renderer, /modal\.contains\(upperReturnTarget\)/u);
  assert.match(renderer, /completeAccessibleResponse\(fullText \|\| bubbleEl\.textContent\)/u);
  assert.match(renderer, /bubbleEl\.setAttribute\("aria-live", "off"\)/u);
  assert.doesNotMatch(renderer, /row\.setAttribute\("role", "option"\)/u);
  assert.match(renderer, /document\.createElement\("button"\)[\s\S]*?className = "ask-option"/u);
  assert.match(renderer, /document\.createElement\("button"\)[\s\S]*?className = `file-entry/u);
  assert.match(renderer, /button\.setAttribute\("role", "tab"\)/u);
  assert.match(renderer, /content\.setAttribute\("role", "tabpanel"\)/u);
  assert.match(renderer, /button\.setAttribute\("aria-controls", `settings-panel-/u);
  assert.match(renderer, /settingsModal\.addEventListener\("input", markSettingsDirty\)/u);
});

test("DS-10 CSS guarantees visible focus reduced motion high contrast and narrow reflow", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:3px/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /animation-duration:\.01ms !important/u);
  assert.match(css, /@media \(forced-colors: active\)/u);
  assert.match(css, /\.new-chat-btn[^}]*background: var\(--accent-fill\)/u);
  assert.match(css, /#submit[^}]*background: var\(--accent-fill\)/u);
  assert.match(css, /@media \(max-width:520px\)/u);
  assert.match(css, /#sidebar \{ width:min\(96px,30vw\)/u);
  assert.doesNotMatch(css, /:focus\s*\{\s*outline:\s*none/u);
});
