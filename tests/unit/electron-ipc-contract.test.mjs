import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

const require = createRequire(import.meta.url);
const { assertTrustedJsonDownload, assertTrustedRendererBinding, assertTrustedRendererOrigin, parseDialogRequest, parseNotification, parseWindowAction } = require("../../electron/ipc-contract.cjs");

test("SEC-07 freezes a sandboxed renderer with no inline code and a strict CSP", async () => {
  const [html, renderer, main, server] = await Promise.all([
    readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
    readFile(path.join(projectRoot, "public", "renderer.js"), "utf8"),
    readFile(path.join(projectRoot, "electron", "main.cjs"), "utf8"),
    readFile(path.join(projectRoot, "src", "index.ts"), "utf8"),
  ]);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /<style\b|\son[a-z]+\s*=|\sstyle\s*=/iu);
  assert.doesNotMatch(renderer, /\son[a-z]+\s*=|style\s*=|\.onclick\s*=|\.style\./iu);
  assert.match(html, /<script src="\/renderer\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="\/renderer\.css">/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /webSecurity:\s*true/u);
  assert.match(main, /allowRunningInsecureContent:\s*false/u);
  assert.match(main, /webviewTag:\s*false/u);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/u);
  assert.match(main, /setPermissionRequestHandler/u);
  assert.match(main, /will-attach-webview/u);
  assert.match(main, /will-download/u);
  assert.doesNotMatch(main, /shell\.openExternal/u);
  const csp = server.match(/"default-src 'self';[^"\r\n]+"/u)?.[0] ?? "";
  assert(csp);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u);
  for (const directive of ["script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert(csp.includes(directive), `CSP directive missing: ${directive}`);
  }
});

test("DS-04 xterm renderer assets are pinned, offline and covered by the strict CSP", async () => {
  const [html, copyScript, packageJson, xterm, fit, css] = await Promise.all([
    readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
    readFile(path.join(projectRoot, "scripts", "copy-vendor.mjs"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "public", "vendor", "xterm.js")),
    readFile(path.join(projectRoot, "public", "vendor", "xterm-addon-fit.js")),
    readFile(path.join(projectRoot, "public", "vendor", "xterm.css")),
  ]);
  assert.match(html, /<link rel="stylesheet" href="\/vendor\/xterm\.css">/u);
  assert.match(html, /<script src="\/vendor\/xterm\.js"><\/script>/u);
  assert.match(html, /<script src="\/vendor\/xterm-addon-fit\.js"><\/script>/u);
  assert.doesNotMatch(html, /https?:\/\/[^"']*(?:xterm|unpkg|jsdelivr|cdnjs)/iu);
  assert.match(copyScript, /@xterm\/xterm\/lib\/xterm\.js/u);
  assert.equal(packageJson.dependencies["@xterm/xterm"], "5.5.0");
  assert.equal(packageJson.dependencies["@xterm/addon-fit"], "0.10.0");
  for (const asset of [xterm, fit, css]) assert(asset.byteLength > 100, "xterm vendor asset is empty");
});

test("DS-02 desktop IPC contract binds every privileged sink to the exact renderer origin", () => {
  assert.equal(
    assertTrustedRendererOrigin("http://127.0.0.1:3111/chat?session=one", "http://127.0.0.1:3111"),
    "http://127.0.0.1:3111"
  );
  assert.throws(
    () => assertTrustedRendererOrigin("http://localhost:3111/chat", "http://127.0.0.1:3111"),
    /origin is denied/iu
  );
  assert.throws(
    () => assertTrustedRendererOrigin("http://127.0.0.1:3112/chat", "http://127.0.0.1:3111"),
    /origin is denied/iu
  );
  assert.throws(
    () => assertTrustedRendererOrigin("file:///C:/RainyDays/index.html", "http://127.0.0.1:3111"),
    /origin is denied/iu
  );
  assert.throws(
    () => assertTrustedRendererOrigin("not a url", "http://127.0.0.1:3111"),
    /origin is invalid/iu
  );
});

test("DS-02 privileged IPC binding rejects foreign frames, origins and unfocused windows", () => {
  const mainFrame = { url: "http://127.0.0.1:3111/chat" };
  const webContents = { mainFrame };
  const window = {
    webContents,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
  };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(
    assertTrustedRendererBinding(event, window, "http://127.0.0.1:3111", { label: "Manual terminal consent", requireFocus: true }),
    window
  );
  assert.throws(
    () => assertTrustedRendererBinding({ ...event, sender: {} }, window, "http://127.0.0.1:3111"),
    /main application frame/iu
  );
  assert.throws(
    () => assertTrustedRendererBinding({ ...event, senderFrame: { url: mainFrame.url } }, window, "http://127.0.0.1:3111"),
    /main application frame/iu
  );
  assert.throws(
    () => assertTrustedRendererBinding(event, { ...window, isFocused: () => false }, "http://127.0.0.1:3111", { requireFocus: true }),
    /focused visible main window/iu
  );
  mainFrame.url = "http://localhost:3111/chat";
  assert.throws(
    () => assertTrustedRendererBinding(event, window, "http://127.0.0.1:3111"),
    /origin is denied/iu
  );
});

test("SEC-07 permits only same-origin blob JSON downloads with safe basenames", () => {
  assert.deepEqual(assertTrustedJsonDownload({
    url: "blob:http://127.0.0.1:3111/57e027ec-6ddc-4e88-953b-6ea4df7c4f35",
    mimeType: "application/json",
    filename: "rainydays-diagnostics.json",
  }, "http://127.0.0.1:3111"), { filename: "rainydays-diagnostics.json" });
  for (const request of [
    { url: "https://example.com/export.json", mimeType: "application/json", filename: "export.json" },
    { url: "blob:http://localhost:3111/id", mimeType: "application/json", filename: "export.json" },
    { url: "blob:http://127.0.0.1:3112/id", mimeType: "application/json", filename: "export.json" },
    { url: "blob:http://127.0.0.1:3111/id", mimeType: "text/html", filename: "export.json" },
    { url: "blob:http://127.0.0.1:3111/id", mimeType: "application/json", filename: "../export.json" },
    { url: "blob:http://127.0.0.1:3111/id", mimeType: "application/json", filename: "CON.json" },
    { url: "blob:http://127.0.0.1:3111/id", mimeType: "application/json", filename: "export.exe" },
    { url: "blob:http://127.0.0.1:3111/id", mimeType: "application/json", filename: "export.json", extra: true },
  ]) assert.throws(() => assertTrustedJsonDownload(request, "http://127.0.0.1:3111"), /Download/u);
});

test("DS-02 desktop IPC contract accepts only the frozen request schemas", () => {
  assert.deepEqual(parseDialogRequest({}, "directory"), { title: null });
  assert.deepEqual(parseDialogRequest({ title: "选择工作区" }, "file"), { title: "选择工作区" });
  assert.deepEqual(parseDialogRequest({ title: "导出", defaultName: "session.json" }, "save"), {
    title: "导出",
    defaultName: "session.json",
  });
  assert.deepEqual(parseWindowAction({ action: "toggle-fullscreen" }), { action: "toggle-fullscreen" });
  assert.deepEqual(parseNotification({ id: "run-complete", title: "完成", body: "任务已完成" }), {
    id: "run-complete",
    title: "完成",
    body: "任务已完成",
  });
});

test("DS-02 desktop IPC contract rejects unknown fields and unsafe native inputs", () => {
  assert.throws(() => parseDialogRequest({ path: "C:\\Windows" }, "directory"), /fields are invalid/u);
  assert.throws(() => parseDialogRequest({ title: "bad\ncaption" }, "file"), /title is invalid/iu);
  assert.throws(() => parseDialogRequest({ defaultName: "..\\secret.txt" }, "save"), /file name is invalid/iu);
  assert.throws(() => parseDialogRequest({ defaultName: "CON?.txt" }, "save"), /file name is invalid/iu);
  assert.throws(() => parseWindowAction({ action: "close" }), /action is invalid/iu);
  assert.throws(() => parseWindowAction({ action: "minimize", channel: "shell" }), /fields are invalid/u);
  assert.throws(() => parseNotification({ id: "../escape", title: "x", body: "y" }), /id is invalid/iu);
  assert.throws(() => parseNotification({ id: "ok", title: "x", body: "y", route: "shell" }), /fields are invalid/u);
  assert.throws(() => parseNotification({ id: "ok", title: "x", body: "z".repeat(241) }), /body is invalid/iu);
});
