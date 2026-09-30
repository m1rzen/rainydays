import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { USER_DATA_DIR } from "./runtime-paths.js";

export type BrowserBackendKind = "cdp" | "extension";
export type BrowserTabSelector = number | string | undefined;

export interface BrowserOpenOptions {
  readonly url: string;
  readonly backend?: BrowserBackendKind;
  readonly cdpPort?: number;
  readonly cdpUrl?: string;
  readonly extensionUrl?: string;
  readonly headless?: boolean;
  readonly tab?: BrowserTabSelector;
}

export interface BrowserTab {
  readonly id: number;
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface BrowserSnapshotOptions {
  readonly tab?: BrowserTabSelector;
  readonly interactive?: boolean;
  readonly maxDepth?: number;
  readonly maxContentLength?: number;
}

export interface BrowserScreenshot {
  readonly mimeType: "image/png";
  readonly bytes: Buffer;
  readonly tab: BrowserTab;
}

export interface BrowserBackend {
  readonly kind: BrowserBackendKind;
  open(options: BrowserOpenOptions): Promise<BrowserTab>;
  close(): Promise<void>;
  tabs(): Promise<BrowserTab[]>;
  newTab(url: string): Promise<BrowserTab>;
  closeTab(tab?: BrowserTabSelector): Promise<void>;
  snapshot(options: BrowserSnapshotOptions): Promise<string>;
  click(ref: string, tab?: BrowserTabSelector): Promise<void>;
  fill(ref: string, value: string, tab?: BrowserTabSelector): Promise<void>;
  type(ref: string, text: string, delay?: number, tab?: BrowserTabSelector): Promise<void>;
  press(key: string, tab?: BrowserTabSelector): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount?: number, ref?: string, tab?: BrowserTabSelector): Promise<void>;
  screenshot(fullPage?: boolean, tab?: BrowserTabSelector): Promise<BrowserScreenshot>;
  evaluate(expression: string, tab?: BrowserTabSelector): Promise<unknown>;
  back(tab?: BrowserTabSelector): Promise<BrowserTab>;
  forward(tab?: BrowserTabSelector): Promise<BrowserTab>;
  fetch(url: string, options?: Readonly<{ method?: string; headers?: Record<string, string>; body?: string; tab?: BrowserTabSelector }>): Promise<unknown>;
}

interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
  readonly webSocketDebuggerUrl: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

class CdpConnection {
  readonly url: string;
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  constructor(url: string) {
    this.url = url;
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`CDP WebSocket failed: ${url}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message: unknown;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const record = message as Record<string, unknown>;
      if (typeof record.id !== "number") return;
      const pending = this.#pending.get(record.id);
      if (!pending) return;
      this.#pending.delete(record.id);
      if (record.error) pending.reject(new Error(`CDP command failed: ${JSON.stringify(record.error)}`));
      else pending.resolve(record.result ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("CDP connection closed"));
      this.#pending.clear();
    });
  }

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP connection is not open");
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve: value => resolve(value as T), reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }
}

function exactText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return value;
}

function normalizeUrl(value: unknown): string {
  let source = exactText(value, "Browser URL", 8_192);
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(source)) source = `https://${source}`;
  const parsed = new URL(source);
  if (!new Set(["http:", "https:", "about:"]).has(parsed.protocol)) throw new Error(`Browser URL scheme is not allowed: ${parsed.protocol}`);
  if (parsed.protocol === "about:" && parsed.href !== "about:blank") throw new Error("Only about:blank is allowed");
  return parsed.href;
}

function safePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_024 || value > 65_535) throw new TypeError("CDP port is invalid");
  return value;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error("Unable to allocate a CDP port");
  return port;
}

function browserCandidates(): string[] {
  if (process.env.RAINYDAYS_CHROME_PATH) return [process.env.RAINYDAYS_CHROME_PATH];
  if (process.platform === "win32") return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

async function firstExecutable(): Promise<string> {
  const { access } = await import("node:fs/promises");
  for (const candidate of browserCandidates()) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new Error("Chrome/Chromium was not found; provide cdpUrl, cdpPort, extensionUrl, or RAINYDAYS_CHROME_PATH");
}

async function waitForEndpoint(baseUrl: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/json/version`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`CDP endpoint did not become ready: ${baseUrl}`, { cause: lastError });
}

function renderSnapshot(value: unknown, maximum: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "(empty browser snapshot)";
  const record = value as Record<string, unknown>;
  const elements = Array.isArray(record.elements) ? record.elements : [];
  const lines = elements.map((entry) => {
    const item = entry as Record<string, unknown>;
    const depth = typeof item.depth === "number" ? Math.max(0, Math.min(20, item.depth)) : 0;
    const role = typeof item.role === "string" ? item.role : "element";
    const name = typeof item.name === "string" ? item.name.replace(/\s+/gu, " ").trim() : "";
    const ref = typeof item.ref === "string" ? ` [ref=${item.ref}]` : "";
    return `${"  ".repeat(depth)}- ${role}${name ? ` \"${name}\"` : ""}${ref}`;
  });
  const content = typeof record.content === "string" ? record.content.slice(0, maximum) : "";
  return `${lines.join("\n")}\n\n--- Page Content ---\n${content}`.trim();
}

export class CdpBrowserBackend implements BrowserBackend {
  readonly kind = "cdp" as const;
  #baseUrl: string | null = null;
  #directTarget: CdpTarget | null = null;
  #spawned: ChildProcess | null = null;
  #profilePath: string | null = null;
  #connections = new Map<string, CdpConnection>();
  #tabNumbers = new Map<string, number>();
  #nextTabNumber = 1;
  #activeTargetId: string | null = null;
  #refs = new Map<string, Set<string>>();

  async #connect(options: BrowserOpenOptions): Promise<void> {
    if (this.#baseUrl || this.#directTarget) return;
    if (options.cdpUrl) {
      const wsUrl = exactText(options.cdpUrl, "CDP URL", 8_192);
      if (!/^wss?:\/\//iu.test(wsUrl)) throw new Error("cdpUrl must use ws:// or wss://");
      this.#directTarget = { id: "direct", type: "page", url: "about:blank", title: "Direct CDP", webSocketDebuggerUrl: wsUrl };
      return;
    }
    const requestedPort = safePort(options.cdpPort) ?? safePort(Number(process.env.LUX_CDP_PORT) || undefined);
    const ports = requestedPort ? [requestedPort] : [9222, 9223];
    for (const port of ports) {
      const candidate = `http://127.0.0.1:${port}`;
      try { await waitForEndpoint(candidate, 500); this.#baseUrl = candidate; return; } catch { /* discover next */ }
    }
    const executable = await firstExecutable();
    const port = requestedPort ?? await freePort();
    this.#profilePath = await mkdtemp(path.join(os.tmpdir(), "rainydays-browser-"));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.#profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-background-networking",
    ];
    if (options.headless) args.push("--headless=new", "--disable-gpu");
    args.push("about:blank");
    this.#spawned = spawn(executable, args, { stdio: "ignore", windowsHide: Boolean(options.headless) });
    this.#baseUrl = `http://127.0.0.1:${port}`;
    try { await waitForEndpoint(this.#baseUrl); } catch (error) { await this.close(); throw error; }
  }

  async #targets(): Promise<CdpTarget[]> {
    if (this.#directTarget) return [this.#directTarget];
    if (!this.#baseUrl) throw new Error("Browser is not connected");
    const response = await fetch(`${this.#baseUrl}/json/list`);
    if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
    const values = await response.json() as CdpTarget[];
    return values.filter(target => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
  }

  #number(targetId: string): number {
    let number = this.#tabNumbers.get(targetId);
    if (!number) { number = this.#nextTabNumber++; this.#tabNumbers.set(targetId, number); }
    return number;
  }

  async #tabValues(): Promise<BrowserTab[]> {
    const targets = await this.#targets();
    if (!this.#activeTargetId && targets[0]) this.#activeTargetId = targets[0].id;
    return targets.map(target => Object.freeze({ id: this.#number(target.id), targetId: target.id, url: target.url, title: target.title, active: target.id === this.#activeTargetId }));
  }

  async #target(selector?: BrowserTabSelector): Promise<CdpTarget> {
    const targets = await this.#targets();
    if (targets.length === 0) throw new Error("No browser tab is available");
    let selected: CdpTarget | undefined;
    if (typeof selector === "number") selected = targets.find(target => this.#number(target.id) === selector);
    else if (typeof selector === "string") {
      const needle = selector.toLocaleLowerCase();
      selected = targets.find(target => target.id === selector) ?? targets.find(target => target.url.toLocaleLowerCase().includes(needle) || target.title.toLocaleLowerCase().includes(needle));
    } else selected = targets.find(target => target.id === this.#activeTargetId) ?? targets[0];
    if (!selected) throw new Error(`Browser tab was not found: ${String(selector)}`);
    this.#activeTargetId = selected.id;
    return selected;
  }

  async #connection(target: CdpTarget): Promise<CdpConnection> {
    let connection = this.#connections.get(target.id);
    if (!connection) {
      connection = new CdpConnection(target.webSocketDebuggerUrl);
      this.#connections.set(target.id, connection);
      await connection.ready;
      await Promise.all([connection.send("Page.enable"), connection.send("Runtime.enable")]);
    }
    return connection;
  }

  async #evaluate<T = unknown>(expression: string, tab?: BrowserTabSelector): Promise<T> {
    const target = await this.#target(tab);
    const connection = await this.#connection(target);
    const response = await connection.send<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value as T;
  }

  async #settled(tab?: BrowserTabSelector): Promise<BrowserTab> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const state = await this.#evaluate<string>("document.readyState", tab);
        if (state === "complete" || state === "interactive") break;
      } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const target = await this.#target(tab);
    const title = await this.#evaluate<string>("document.title", tab).catch(() => target.title);
    const url = await this.#evaluate<string>("location.href", tab).catch(() => target.url);
    return Object.freeze({ id: this.#number(target.id), targetId: target.id, title, url, active: true });
  }

  #invalidate(targetId: string): void { this.#refs.delete(targetId); }

  async open(options: BrowserOpenOptions): Promise<BrowserTab> {
    await this.#connect(options);
    const url = normalizeUrl(options.url);
    let target = await this.#target(options.tab).catch(async () => {
      if (!this.#baseUrl) throw new Error("Direct CDP target is unavailable");
      await fetch(`${this.#baseUrl}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
      return this.#target();
    });
    const connection = await this.#connection(target);
    await connection.send("Page.navigate", { url });
    this.#activeTargetId = target.id;
    this.#invalidate(target.id);
    return this.#settled(this.#number(target.id));
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    if (this.#spawned && this.#spawned.exitCode === null) this.#spawned.kill("SIGTERM");
    this.#spawned = null;
    if (this.#profilePath) await rm(this.#profilePath, { recursive: true, force: true }).catch(() => undefined);
    this.#profilePath = null;
    this.#baseUrl = null;
    this.#directTarget = null;
    this.#activeTargetId = null;
    this.#refs.clear();
  }

  async tabs(): Promise<BrowserTab[]> { return this.#tabValues(); }

  async newTab(urlInput: string): Promise<BrowserTab> {
    const url = normalizeUrl(urlInput);
    if (!this.#baseUrl) throw new Error("New tabs require a browser-level CDP endpoint");
    const response = await fetch(`${this.#baseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok) throw new Error(`Creating browser tab failed: HTTP ${response.status}`);
    const target = await response.json() as CdpTarget;
    this.#activeTargetId = target.id;
    return this.#settled(this.#number(target.id));
  }

  async closeTab(tab?: BrowserTabSelector): Promise<void> {
    const target = await this.#target(tab);
    const connection = this.#connections.get(target.id);
    connection?.close();
    this.#connections.delete(target.id);
    if (this.#baseUrl) {
      const response = await fetch(`${this.#baseUrl}/json/close/${encodeURIComponent(target.id)}`);
      if (!response.ok) throw new Error(`Closing browser tab failed: HTTP ${response.status}`);
    } else connection?.close();
    this.#refs.delete(target.id);
    this.#activeTargetId = null;
  }

  async snapshot(options: BrowserSnapshotOptions): Promise<string> {
    const target = await this.#target(options.tab);
    const maximum = Math.max(100, Math.min(100_000, options.maxContentLength ?? 10_000));
    const maxDepth = Math.max(0, Math.min(100, options.maxDepth ?? 0));
    const expression = `(() => {
      const interactiveOnly = ${options.interactive === true};
      const maxDepth = ${maxDepth};
      let sequence = 0;
      const elements = [];
      const interactive = new Set(['A','BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','OPTION']);
      const visit = (root, depth) => {
        for (const element of root.querySelectorAll(':scope > *')) {
          if (maxDepth && depth > maxDepth) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const tag = element.tagName;
          const role = element.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:element.type || 'textbox',TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',H1:'heading',H2:'heading',H3:'heading'}[tag] || tag.toLowerCase());
          const isInteractive = interactive.has(tag) || element.tabIndex >= 0 || element.hasAttribute('onclick') || ['button','link','textbox','combobox','checkbox','radio','menuitem','tab'].includes(role);
          let ref;
          if (isInteractive) { ref = 'e' + (++sequence); element.setAttribute('data-rainydays-ref', ref); }
          const name = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.innerText || element.value || '';
          if (!interactiveOnly || isInteractive) elements.push({ role, name: String(name).trim().slice(0, 240), ref, depth });
          if (tag === 'IFRAME') { try { if (element.contentDocument) visit(element.contentDocument, depth + 1); } catch {} }
          visit(element, depth + 1);
        }
      };
      document.querySelectorAll('[data-rainydays-ref]').forEach(element => element.removeAttribute('data-rainydays-ref'));
      visit(document, 0);
      return { elements, refs: elements.filter(item => item.ref).map(item => item.ref), content: (document.body?.innerText || '').trim() };
    })()`;
    const value = await this.#evaluate<{ refs: string[]; elements: unknown[]; content: string }>(expression, options.tab);
    this.#refs.set(target.id, new Set(value.refs));
    return renderSnapshot(value, maximum);
  }

  async #withRef(refInput: string, tab: BrowserTabSelector, operation: (selector: string) => string): Promise<void> {
    const ref = exactText(refInput, "Browser ref", 80);
    const target = await this.#target(tab);
    if (!this.#refs.get(target.id)?.has(ref)) throw new Error(`Browser ref is stale or unknown: ${ref}; run browser_snapshot again`);
    const selector = `[data-rainydays-ref=${JSON.stringify(ref)}]`;
    const result = await this.#evaluate<boolean>(operation(selector), this.#number(target.id));
    if (!result) throw new Error(`Browser ref no longer exists: ${ref}; run browser_snapshot again`);
    this.#invalidate(target.id);
  }

  async click(ref: string, tab?: BrowserTabSelector): Promise<void> {
    await this.#withRef(ref, tab, selector => `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.scrollIntoView({block:'center'}); e.click(); return true; })()`);
  }

  async fill(ref: string, valueInput: string, tab?: BrowserTabSelector): Promise<void> {
    const value = exactText(valueInput, "Fill value", 1_000_000, true);
    await this.#withRef(ref, tab, selector => `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.focus(); const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set; if(setter)setter.call(e,${JSON.stringify(value)}); else e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  }

  async type(ref: string, textInput: string, delayInput = 50, tab?: BrowserTabSelector): Promise<void> {
    const text = exactText(textInput, "Typed text", 100_000, true);
    const delay = Math.max(0, Math.min(2_000, Number.isFinite(delayInput) ? delayInput : 50));
    await this.#withRef(ref, tab, selector => `(async () => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.focus(); for(const ch of ${JSON.stringify(text)}) { e.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true})); e.value=(e.value||'')+ch; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new KeyboardEvent('keyup',{key:ch,bubbles:true})); if(${delay})await new Promise(r=>setTimeout(r,${delay})); } return true; })()`);
  }

  async press(keyInput: string, tab?: BrowserTabSelector): Promise<void> {
    const key = exactText(keyInput, "Browser key", 40);
    await this.#evaluate(`(() => { const e=document.activeElement || document.body; for(const type of ['keydown','keypress','keyup'])e.dispatchEvent(new KeyboardEvent(type,{key:${JSON.stringify(key)},bubbles:true,cancelable:true})); return true; })()`, tab);
  }

  async scroll(direction: "up" | "down" | "left" | "right", amountInput = 400, ref?: string, tab?: BrowserTabSelector): Promise<void> {
    if (!new Set(["up", "down", "left", "right"]).has(direction)) throw new TypeError("Scroll direction is invalid");
    const amount = Math.max(1, Math.min(100_000, Math.abs(amountInput || 400)));
    const x = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const y = direction === "up" ? -amount : direction === "down" ? amount : 0;
    if (ref) await this.#withRef(ref, tab, selector => `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.scrollBy(${x},${y}); return true; })()`);
    else await this.#evaluate(`(() => { window.scrollBy(${x},${y}); return true; })()`, tab);
  }

  async screenshot(fullPage = false, tab?: BrowserTabSelector): Promise<BrowserScreenshot> {
    const target = await this.#target(tab);
    const connection = await this.#connection(target);
    const result = await connection.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, fromSurface: true });
    return Object.freeze({ mimeType: "image/png", bytes: Buffer.from(result.data, "base64"), tab: await this.#settled(this.#number(target.id)) });
  }

  async evaluate(expressionInput: string, tab?: BrowserTabSelector): Promise<unknown> {
    const expression = exactText(expressionInput, "Browser expression", 32_768);
    return this.#evaluate(expression, tab);
  }

  async #history(delta: -1 | 1, tab?: BrowserTabSelector): Promise<BrowserTab> {
    const target = await this.#target(tab);
    const connection = await this.#connection(target);
    const history = await connection.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) throw new Error(delta < 0 ? "No previous browser history entry" : "No forward browser history entry");
    await connection.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.#invalidate(target.id);
    return this.#settled(this.#number(target.id));
  }

  async back(tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#history(-1, tab); }
  async forward(tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#history(1, tab); }

  async fetch(urlInput: string, options: Readonly<{ method?: string; headers?: Record<string, string>; body?: string; tab?: BrowserTabSelector }> = {}): Promise<unknown> {
    const url = normalizeUrl(urlInput);
    const method = (options.method ?? "GET").toUpperCase();
    if (!/^[A-Z]+$/u.test(method)) throw new TypeError("Browser fetch method is invalid");
    const headers = options.headers ?? {};
    const expression = `(async () => { const response=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:${JSON.stringify(headers)},body:${options.body === undefined ? "undefined" : JSON.stringify(options.body)},credentials:'include'}); const body=await response.text(); return {status:response.status,statusText:response.statusText,url:response.url,headers:Object.fromEntries(response.headers.entries()),body:body.slice(0,2097152),truncated:body.length>2097152}; })()`;
    return this.#evaluate(expression, options.tab);
  }
}

class ExtensionRpc {
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`Browser Extension bridge failed: ${url}`)), { once: true });
    });
    this.socket.addEventListener("message", event => {
      let value: unknown;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "number") return;
      const pending = this.#pending.get(record.id);
      if (!pending) return;
      this.#pending.delete(record.id);
      if (record.error) pending.reject(new Error(`Extension browser command failed: ${String(record.error)}`));
      else pending.resolve(record.result);
    });
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve: value => resolve(value as T), reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void { this.socket.close(); }
}

export class ExtensionBrowserBackend implements BrowserBackend {
  readonly kind = "extension" as const;
  readonly sessionId: string;
  readonly rpc: ExtensionRpc;

  constructor(sessionId: string, urlInput: string) {
    this.sessionId = exactText(sessionId, "Browser session id", 200);
    const url = exactText(urlInput, "Extension bridge URL", 8_192);
    if (!/^wss?:\/\//iu.test(url)) throw new Error("Extension bridge URL must use ws:// or wss://");
    this.rpc = new ExtensionRpc(url);
  }

  #call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return this.rpc.call<T>(method, { sessionId: this.sessionId, ...params }); }
  open(options: BrowserOpenOptions): Promise<BrowserTab> { return this.#call("browser.open", { ...options, url: normalizeUrl(options.url) }); }
  async close(): Promise<void> { try { await this.#call("browser.close"); } finally { this.rpc.close(); } }
  tabs(): Promise<BrowserTab[]> { return this.#call("browser.tabs"); }
  newTab(url: string): Promise<BrowserTab> { return this.#call("browser.newTab", { url: normalizeUrl(url) }); }
  closeTab(tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.closeTab", { tab }); }
  snapshot(options: BrowserSnapshotOptions): Promise<string> { return this.#call("browser.snapshot", { ...options }); }
  click(ref: string, tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.click", { ref, tab }); }
  fill(ref: string, value: string, tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.fill", { ref, value, tab }); }
  type(ref: string, text: string, delay?: number, tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.type", { ref, text, delay, tab }); }
  press(key: string, tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.press", { key, tab }); }
  scroll(direction: "up" | "down" | "left" | "right", amount?: number, ref?: string, tab?: BrowserTabSelector): Promise<void> { return this.#call("browser.scroll", { direction, amount, ref, tab }); }
  async screenshot(fullPage?: boolean, tab?: BrowserTabSelector): Promise<BrowserScreenshot> {
    const result = await this.#call<{ mimeType: "image/png"; dataBase64: string; tab: BrowserTab }>("browser.screenshot", { fullPage, tab });
    return Object.freeze({ mimeType: result.mimeType, bytes: Buffer.from(result.dataBase64, "base64"), tab: result.tab });
  }
  evaluate(expression: string, tab?: BrowserTabSelector): Promise<unknown> { return this.#call("browser.eval", { expression, tab }); }
  back(tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#call("browser.back", { tab }); }
  forward(tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#call("browser.forward", { tab }); }
  fetch(url: string, options: Readonly<{ method?: string; headers?: Record<string, string>; body?: string; tab?: BrowserTabSelector }> = {}): Promise<unknown> { return this.#call("browser.fetch", { url: normalizeUrl(url), ...options }); }
}

export type BrowserBackendFactory = (sessionId: string, kind: BrowserBackendKind, options: BrowserOpenOptions) => BrowserBackend;

function defaultFactory(sessionId: string, kind: BrowserBackendKind, options: BrowserOpenOptions): BrowserBackend {
  if (kind === "extension") {
    const url = options.extensionUrl ?? process.env.RAINYDAYS_BROWSER_EXTENSION_URL;
    if (!url) throw new Error("Chrome Extension backend is not configured; set extensionUrl or RAINYDAYS_BROWSER_EXTENSION_URL");
    return new ExtensionBrowserBackend(sessionId, url);
  }
  return new CdpBrowserBackend();
}

export class BrowserSessionManager {
  readonly factory: BrowserBackendFactory;
  #sessions = new Map<string, BrowserBackend>();

  constructor(factory: BrowserBackendFactory = defaultFactory) { this.factory = factory; }

  #sessionId(value: string): string { return exactText(value, "Browser session id", 200); }
  #backend(sessionIdInput: string): BrowserBackend {
    const sessionId = this.#sessionId(sessionIdInput);
    const backend = this.#sessions.get(sessionId);
    if (!backend) throw new Error("Browser is not open for this Session; call browser_open first");
    return backend;
  }

  async open(sessionIdInput: string, options: BrowserOpenOptions): Promise<BrowserTab> {
    const sessionId = this.#sessionId(sessionIdInput);
    const kind: BrowserBackendKind = options.backend ?? (options.extensionUrl || process.env.RAINYDAYS_BROWSER_EXTENSION_URL ? "extension" : "cdp");
    let backend = this.#sessions.get(sessionId);
    if (backend && backend.kind !== kind) { await backend.close(); this.#sessions.delete(sessionId); backend = undefined; }
    const created = !backend;
    if (!backend) { backend = this.factory(sessionId, kind, options); this.#sessions.set(sessionId, backend); }
    try {
      return await backend.open(options);
    } catch (error) {
      if (created) {
        this.#sessions.delete(sessionId);
        await backend.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async close(sessionIdInput: string): Promise<void> {
    const sessionId = this.#sessionId(sessionIdInput);
    const backend = this.#backend(sessionId);
    this.#sessions.delete(sessionId);
    await backend.close();
  }

  kind(sessionId: string): BrowserBackendKind { return this.#backend(sessionId).kind; }
  tabs(sessionId: string): Promise<BrowserTab[]> { return this.#backend(sessionId).tabs(); }
  newTab(sessionId: string, url: string): Promise<BrowserTab> { return this.#backend(sessionId).newTab(url); }
  closeTab(sessionId: string, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).closeTab(tab); }
  snapshot(sessionId: string, options: BrowserSnapshotOptions): Promise<string> { return this.#backend(sessionId).snapshot(options); }
  click(sessionId: string, ref: string, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).click(ref, tab); }
  fill(sessionId: string, ref: string, value: string, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).fill(ref, value, tab); }
  type(sessionId: string, ref: string, text: string, delay?: number, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).type(ref, text, delay, tab); }
  press(sessionId: string, key: string, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).press(key, tab); }
  scroll(sessionId: string, direction: "up" | "down" | "left" | "right", amount?: number, ref?: string, tab?: BrowserTabSelector): Promise<void> { return this.#backend(sessionId).scroll(direction, amount, ref, tab); }
  evaluate(sessionId: string, expression: string, tab?: BrowserTabSelector): Promise<unknown> { return this.#backend(sessionId).evaluate(expression, tab); }
  back(sessionId: string, tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#backend(sessionId).back(tab); }
  forward(sessionId: string, tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#backend(sessionId).forward(tab); }
  fetch(sessionId: string, url: string, options: Readonly<{ method?: string; headers?: Record<string, string>; body?: string; tab?: BrowserTabSelector }> = {}): Promise<unknown> { return this.#backend(sessionId).fetch(url, options); }

  async screenshot(sessionIdInput: string, fullPage?: boolean, tab?: BrowserTabSelector): Promise<Readonly<{ path: string; sha256: string; bytes: number; mimeType: string; tab: BrowserTab }>> {
    const sessionId = this.#sessionId(sessionIdInput);
    const screenshot = await this.#backend(sessionId).screenshot(fullPage, tab);
    const sessionDirectory = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const directory = path.join(USER_DATA_DIR, "browser-artifacts", sessionDirectory);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `screenshot-${Date.now()}.png`);
    await writeFile(filePath, screenshot.bytes, { flag: "wx" });
    return Object.freeze({ path: filePath, sha256: createHash("sha256").update(screenshot.bytes).digest("hex"), bytes: screenshot.bytes.length, mimeType: screenshot.mimeType, tab: screenshot.tab });
  }
}

export const browserSessions = new BrowserSessionManager();
