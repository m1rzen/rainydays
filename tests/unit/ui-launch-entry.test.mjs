import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { projectRoot } from "../helpers.mjs";

const [html, guard] = await Promise.all([
  readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
  readFile(path.join(projectRoot, "public", "launch-check.js"), "utf8"),
]);

test("opening the HTML file replaces the unstyled application with usable launch instructions", () => {
  const { document } = parseHTML(html);
  vm.runInNewContext(guard, { document, window: { location: { protocol: "file:" } } });
  assert(document.documentElement.classList.contains("file-launch"));
  document.dispatchEvent(new document.defaultView.Event("DOMContentLoaded"));
  assert.equal(document.body.children.length, 1);
  assert.equal(document.querySelector("svg"), null);
  assert.match(document.body.textContent, /从桌面应用开始/u);
  assert.match(document.body.textContent, /启动 RainyDays\.cmd/u);
});

test("the launch check preserves the application when served by the desktop service", () => {
  const { document } = parseHTML(html);
  const before = document.toString();
  vm.runInNewContext(guard, { document, window: { location: { protocol: "http:" } } });
  document.dispatchEvent(new document.defaultView.Event("DOMContentLoaded"));
  assert.equal(document.toString(), before);
});
