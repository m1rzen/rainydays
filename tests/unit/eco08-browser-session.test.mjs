import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "eco08-unit-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const { BrowserSessionManager } = await import("../../src/browser.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

class FakeBackend {
  constructor(kind, sessionId) { this.kind = kind; this.sessionId = sessionId; this.closed = false; this.calls = []; }
  async open(options) { this.calls.push(["open", options.url]); return { id: 1, targetId: this.sessionId, url: options.url, title: this.kind, active: true }; }
  async close() { this.closed = true; }
  async tabs() { return [{ id: 1, targetId: this.sessionId, url: `https://${this.sessionId}`, title: this.kind, active: true }]; }
  async newTab(url) { this.calls.push(["newTab", url]); return { id: 2, targetId: `${this.sessionId}-2`, url, title: "new", active: true }; }
  async closeTab(tab) { this.calls.push(["closeTab", tab]); }
  async snapshot(options) { return `${this.sessionId}:${this.kind}:${options.interactive === true}`; }
  async click(ref, tab) { this.calls.push(["click", ref, tab]); }
  async fill(ref, value, tab) { this.calls.push(["fill", ref, value, tab]); }
  async type(ref, text, delay, tab) { this.calls.push(["type", ref, text, delay, tab]); }
  async press(key, tab) { this.calls.push(["press", key, tab]); }
  async scroll(direction, amount, ref, tab) { this.calls.push(["scroll", direction, amount, ref, tab]); }
  async screenshot() { return { mimeType: "image/png", bytes: Buffer.from("png"), tab: (await this.tabs())[0] }; }
  async evaluate(expression) { return `${this.sessionId}:${expression}`; }
  async back() { return (await this.tabs())[0]; }
  async forward() { return (await this.tabs())[0]; }
  async fetch(url) { return { sessionId: this.sessionId, url }; }
}

test("ECO-08 routes CDP and Extension backends through isolated Session state", async () => {
  const backends = [];
  const manager = new BrowserSessionManager((sessionId, kind) => {
    const backend = new FakeBackend(kind, sessionId);
    backends.push(backend);
    return backend;
  });
  const cdp = await manager.open("session-a", { url: "https://a.test", backend: "cdp" });
  const extension = await manager.open("session-b", { url: "https://b.test", backend: "extension", extensionUrl: "ws://fixture" });
  assert.equal(cdp.title, "cdp");
  assert.equal(extension.title, "extension");
  assert.equal(manager.kind("session-a"), "cdp");
  assert.equal(manager.kind("session-b"), "extension");
  assert.match(await manager.snapshot("session-a", { interactive: true }), /^session-a:cdp:true$/u);
  assert.match(await manager.snapshot("session-b", {}), /^session-b:extension:false$/u);
  assert.equal((await manager.tabs("session-a"))[0].targetId, "session-a");
  assert.equal((await manager.tabs("session-b"))[0].targetId, "session-b");
  await manager.close("session-a");
  assert.equal(backends[0].closed, true);
  assert.equal(backends[1].closed, false);
  assert.throws(() => manager.tabs("session-a"), /call browser_open first/u);
  await manager.close("session-b");
});

test("ECO-08 switches backend explicitly without leaking the previous connection", async () => {
  const backends = [];
  const manager = new BrowserSessionManager((sessionId, kind) => {
    const backend = new FakeBackend(kind, sessionId);
    backends.push(backend);
    return backend;
  });
  await manager.open("session-switch", { url: "https://one.test", backend: "cdp" });
  await manager.open("session-switch", { url: "https://two.test", backend: "extension", extensionUrl: "ws://fixture" });
  assert.equal(backends.length, 2);
  assert.equal(backends[0].closed, true);
  assert.equal(manager.kind("session-switch"), "extension");
  await manager.close("session-switch");
});
