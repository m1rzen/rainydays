import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const root = await mkdtemp(path.join(os.tmpdir(), "eco08-cdp-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
if (chrome) process.env.RAINYDAYS_CHROME_PATH = chrome;
const { BrowserSessionManager } = await import("../../src/browser.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

function page(body, title = "ECO-08") {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

async function serverFixture() {
  const server = http.createServer((request, response) => {
    const host = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/api") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, cookie: request.headers.cookie ?? null }));
      return;
    }
    if (request.url === "/frame") {
      response.setHeader("content-type", "text/html");
      response.end(page('<button aria-label="Frame action">Frame action</button>', "Frame"));
      return;
    }
    if (request.url === "/second") {
      response.setHeader("content-type", "text/html");
      response.end(page('<h1>Second Page</h1><a href="/">Home</a>', "Second"));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(page(`
      <h1>Browser Fixture</h1>
      <input aria-label="Name" id="name">
      <button aria-label="Apply" onclick="document.querySelector('#output').textContent=document.querySelector('#name').value">Apply</button>
      <div id="output">empty</div>
      <div role="dialog" aria-label="Modal"><button aria-label="Modal action">Modal action</button></div>
      <iframe src="${host}/frame"></iframe>
      <a href="/second">Second</a>
    `));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function refFor(snapshot, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return snapshot.match(new RegExp(`"${escaped}" \\[ref=(e\\d+)\\]`, "u"))?.[1];
}

test("ECO-08 performs a real headless CDP flow with refs, SPA-safe invalidation, tabs, history, fetch, iframe/modal snapshot, and artifact screenshot", { skip: !chrome }, async () => {
  const server = await serverFixture();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const manager = new BrowserSessionManager();
  try {
    const opened = await manager.open("eco08-real", { url: base, backend: "cdp", headless: true });
    assert.equal(opened.title, "ECO-08");
    let snapshot = await manager.snapshot("eco08-real", {});
    assert.match(snapshot, /Browser Fixture/u);
    assert.match(snapshot, /Modal action/u);
    assert.match(snapshot, /Frame action/u);
    const inputRef = refFor(snapshot, "Name");
    assert(inputRef);
    await manager.fill("eco08-real", inputRef, "RainyDays");
    await assert.rejects(() => manager.fill("eco08-real", inputRef, "stale"), /stale or unknown/u);
    snapshot = await manager.snapshot("eco08-real", { interactive: true });
    const applyRef = refFor(snapshot, "Apply");
    assert(applyRef);
    await manager.click("eco08-real", applyRef);
    assert.equal(await manager.evaluate("eco08-real", "document.querySelector('#output').textContent"), "RainyDays");

    const second = await manager.newTab("eco08-real", `${base}/second`);
    assert.equal(second.title, "Second");
    assert.equal((await manager.tabs("eco08-real")).length, 2);
    await manager.open("eco08-real", { url: base, backend: "cdp", headless: true, tab: second.id });
    await manager.open("eco08-real", { url: `${base}/second`, backend: "cdp", headless: true, tab: second.id });
    assert.match((await manager.back("eco08-real", second.id)).url, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/?$`, "u"));
    assert.match((await manager.forward("eco08-real", second.id)).url, /\/second$/u);

    const fetched = await manager.fetch("eco08-real", `${base}/api`, { tab: second.id });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.includes('"ok":true'), true);
    const screenshot = await manager.screenshot("eco08-real", false, second.id);
    assert.equal(screenshot.mimeType, "image/png");
    assert(screenshot.bytes > 100);
    assert(existsSync(screenshot.path));
    await manager.closeTab("eco08-real", second.id);
    assert.equal((await manager.tabs("eco08-real")).length, 1);
  } finally {
    await manager.close("eco08-real").catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
  }
});
