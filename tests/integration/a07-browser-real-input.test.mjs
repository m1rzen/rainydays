// A07: real CDP input, ref freshness, tab ownership, upload/download and hand-off, against a real local browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const root = await mkdtemp(path.join(os.tmpdir(), "a07-browser-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
if (chrome) process.env.RAINYDAYS_CHROME_PATH = chrome;
const { BrowserSessionManager, parseBrowserKey } = await import("../../src/browser.ts");
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const page = (body, title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const CSV = "城市,销量\n北京,120\n上海,98\n";
async function site() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const html = (body, title) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page(body, title)); };
    if (url.pathname === "/submitted") return html(`<h1>已提交</h1><p id="got">${url.searchParams.get("name")}|${url.searchParams.get("email")}</p>`, "Submitted");
    if (url.pathname === "/download") { response.setHeader("content-type", "text/csv; charset=utf-8"); response.setHeader("content-disposition", "attachment; filename=report.csv"); return response.end(CSV); }
    if (url.pathname === "/upload") return html(`<input type="file" id="file" aria-label="选择文件"><p id="picked">未选择</p><script>file.addEventListener('change',()=>{const f=file.files[0];picked.textContent=f.name+':'+f.size;});</script>`, "Upload");
    if (url.pathname === "/user") return html("<h1>用户自己的标签</h1>", "User tab");
    if (url.pathname === "/popup") return html(`<button id="pop" onclick="window.open('/user?from=popup','_blank')">打开弹窗</button>`, "Popup");
    if (url.pathname === "/covered") return html(`<button id="under" onclick="this.textContent='被点了'">底下的按钮</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.3)">遮罩</div>`, "Covered");
    html(`
      <form action="/submitted" method="get">
        <input id="name" name="name" aria-label="姓名">
        <input id="email" name="email" aria-label="邮箱">
        <button type="submit">提交</button>
      </form>
      <button id="load" onclick="setTimeout(()=>{document.getElementById('status').textContent='加载完成'},400)">加载</button>
      <p id="status">等待中</p>
      <div id="box"><button id="replace" onclick="document.getElementById('box').innerHTML='<button id=&quot;replace&quot;>新按钮</button>'">替换我</button></div>
      <a href="/download">下载报表</a>
    `, "A07 Form");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const refFor = (snapshot, name) => snapshot.match(new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[^"]*"[^\\n]*?\\[ref=(e\\d+)\\]`, "u"))?.[1];

test("A07 key parsing: named keys, single characters and modifiers", () => {
  assert.deepEqual({ ...parseBrowserKey("Enter") }, { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  assert.equal(parseBrowserKey("Shift+Tab").modifiers, 8);
  const selectAll = parseBrowserKey("Control+a");
  assert.equal(selectAll.modifiers, 2); assert.equal(selectAll.text, undefined, "shortcuts carry no text");
  assert.equal(parseBrowserKey("Shift+a").text, "A");
  assert.throws(() => parseBrowserKey("Hyper+x"), /modifier/u);
  assert.throws(() => parseBrowserKey("F13x"), /Unsupported/u);
});

test("B01 real typing, Tab focus, Enter submits a native form, and waiting for an update", { skip: !chrome, timeout: 60000 }, async () => {
  const { server, base } = await site(); const manager = new BrowserSessionManager();
  try {
    await manager.open("b01", { url: base, backend: "cdp", headless: true });
    let snapshot = await manager.snapshot("b01", { interactive: true });
    await manager.fill("b01", refFor(snapshot, "姓名"), "林小雨");
    const afterFill = await manager.snapshot("b01", { interactive: true });
    assert.match(afterFill, /"姓名" value="林小雨" \[focused\]/u, "the snapshot shows what the field holds and where focus is");
    await manager.press("b01", "Tab");
    assert.equal(await manager.evaluate("b01", "document.activeElement.id"), "email", "a real Tab moves focus");
    await manager.type("b01", refFor(snapshot, "邮箱"), "lin@example.com", 0);
    await manager.click("b01", refFor(snapshot, "加载"));
    const waited = await manager.waitFor("b01", { text: "加载完成", timeoutMs: 5000 });
    assert.equal(waited.met, true);
    snapshot = await manager.snapshot("b01", { interactive: true });
    await manager.fill("b01", refFor(snapshot, "邮箱"), "lin@example.com");
    await manager.press("b01", "Enter");
    assert.equal((await manager.waitFor("b01", { urlIncludes: "/submitted", timeoutMs: 5000 })).met, true, "a real Enter submits the form");
    assert.equal(await manager.evaluate("b01", "document.getElementById('got').textContent"), "林小雨|lin@example.com");
    assert.equal((await manager.waitFor("b01", { text: "不会出现", timeoutMs: 300 })).met, false);
  } finally { await manager.close("b01").catch(() => undefined); server.close(); }
});

test("B02 replaced nodes and navigation make old refs fail loudly; covered elements are not clicked", { skip: !chrome, timeout: 60000 }, async () => {
  const { server, base } = await site(); const manager = new BrowserSessionManager();
  try {
    await manager.open("b02", { url: base, backend: "cdp", headless: true });
    let snapshot = await manager.snapshot("b02", { interactive: true });
    const replaceRef = refFor(snapshot, "替换我"), nameRef = refFor(snapshot, "姓名");
    await manager.click("b02", replaceRef);
    await assert.rejects(() => manager.click("b02", replaceRef), /no longer exists/u, "a replaced node is not silently re-targeted");
    await manager.fill("b02", nameRef, "仍然有效");
    await manager.open("b02", { url: base, backend: "cdp", headless: true });
    await assert.rejects(() => manager.fill("b02", nameRef, "x"), /stale or unknown|no longer exists/u, "navigation drops refs");
    await manager.open("b02", { url: `${base}/covered`, backend: "cdp", headless: true });
    snapshot = await manager.snapshot("b02", { interactive: true });
    await assert.rejects(() => manager.click("b02", refFor(snapshot, "底下的按钮")), /covered/u);
    assert.equal(await manager.evaluate("b02", "document.getElementById('under').textContent"), "底下的按钮");
  } finally { await manager.close("b02").catch(() => undefined); server.close(); }
});

test("B03 upload hands over one file copy; downloads land in a private folder until saved", { skip: !chrome, timeout: 60000 }, async () => {
  const { server, base } = await site(); const manager = new BrowserSessionManager();
  try {
    await manager.open("b03", { url: `${base}/upload`, backend: "cdp", headless: true });
    const snapshot = await manager.snapshot("b03", { interactive: true });
    const copy = path.join(await manager.uploadDirectory("b03"), "季度数据.csv");
    await writeFile(copy, CSV);
    await manager.upload("b03", refFor(snapshot, "选择文件"), copy);
    assert.equal((await manager.waitFor("b03", { text: "季度数据.csv:", timeoutMs: 3000 })).met, true);
    assert.equal(await manager.evaluate("b03", "document.getElementById('picked').textContent"), `季度数据.csv:${Buffer.byteLength(CSV)}`);
    await manager.open("b03", { url: base, backend: "cdp", headless: true });
    const home = await manager.snapshot("b03", { interactive: true });
    await manager.click("b03", refFor(home, "下载报表"));
    const deadline = Date.now() + 10000; let list = [];
    while (Date.now() < deadline) { list = manager.downloads("b03"); if (list.some(item => item.state === "completed")) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    const done = list.find(item => item.state === "completed");
    assert(done, JSON.stringify(list)); assert.equal(done.name, "report.csv");
    const saved = await manager.readDownload("b03", done.id, 1024 * 1024);
    assert.equal(saved.bytes.toString("utf8"), CSV);
  } finally { await manager.close("b03").catch(() => undefined); server.close(); }
});

async function launchUserBrowser(base) {
  const port = await new Promise(resolve => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const profile = await mkdtemp(path.join(os.tmpdir(), "a07-user-browser-"));
  const child = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", `${base}/user`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  return { port, child, profile, list: async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(target => target.type === "page") };
}

test("B02/B04 attached to the user's browser: only task tabs are visible, popups are adopted, hand-off drops refs, closing keeps user tabs", { skip: !chrome, timeout: 60000 }, async () => {
  const { server, base } = await site(); const user = await launchUserBrowser(base); const manager = new BrowserSessionManager();
  try {
    const opened = await manager.open("attached", { url: `${base}/popup`, backend: "cdp", cdpPort: user.port });
    assert.equal((await user.list()).length, 2, "the task opened its own tab instead of navigating the user's");
    let tabs = await manager.tabs("attached");
    assert.equal(tabs.length, 1); assert.equal(tabs[0].targetId, opened.targetId);
    await assert.rejects(() => manager.closeTab("attached", "User tab"), /not found/u, "the user's tab cannot be selected");
    const snapshot = await manager.snapshot("attached", { interactive: true });
    await manager.click("attached", refFor(snapshot, "打开弹窗"));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await manager.tabs("attached")).some(tab => tab.url.includes("from=popup"))) await new Promise(resolve => setTimeout(resolve, 100));
    tabs = await manager.tabs("attached");
    assert.equal(tabs.length, 2, "a popup opened by the task tab belongs to the task");
    assert(tabs.some(tab => tab.url.includes("from=popup")));
    const ref = refFor(await manager.snapshot("attached", { interactive: true, tab: opened.id }), "打开弹窗");
    await manager.handoff("attached", opened.id);
    await assert.rejects(() => manager.click("attached", ref, opened.id), /stale or unknown/u, "work resumes only from a fresh observation");
    assert.throws(() => manager.downloads("attached"), /only managed in a browser RainyDays launched/u);
    await manager.close("attached");
    let left = await user.list();
    for (let attempt = 0; attempt < 30 && left.length > 1; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 100)); left = await user.list(); }
    assert.equal(left.length, 1, JSON.stringify(left.map(target => target.url))); assert.match(left[0].url, /\/user$/u, "closing the task keeps the user's own tab");
  } finally {
    await manager.close("attached").catch(() => undefined); server.close();
    user.child.kill(); await new Promise(resolve => setTimeout(resolve, 300));
    await rm(user.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
});

test("B04 a headless browser launched by the task cannot be handed to the user", { skip: !chrome, timeout: 30000 }, async () => {
  const { server, base } = await site(); const manager = new BrowserSessionManager();
  try {
    await manager.open("headless", { url: base, backend: "cdp", headless: true });
    await assert.rejects(() => manager.handoff("headless"), /headless/u);
  } finally { await manager.close("headless").catch(() => undefined); server.close(); }
});

test("A07 observing the page again after a page action is not counted as a loop", async () => {
  const { ToolLoopDetector } = await import("../../src/tool-pipeline.ts");
  const detector = new ToolLoopDetector();
  for (let round = 0; round < 6; round += 1) { detector.observe("browser_snapshot", "same"); detector.noteBrowserChange(); }
  const stuck = new ToolLoopDetector();
  for (let round = 0; round < 3; round += 1) stuck.observe("browser_snapshot", "same");
  assert.throws(() => stuck.observe("browser_snapshot", "same"), /Repeated identical tool call/u, "observing without acting is still a loop");
  const clicking = new ToolLoopDetector();
  for (let round = 0; round < 3; round += 1) { clicking.observe("browser_click", "e1"); clicking.noteBrowserChange(); }
  assert.throws(() => clicking.observe("browser_click", "e1"), /Repeated identical tool call/u, "repeating the same action is still a loop");
});
