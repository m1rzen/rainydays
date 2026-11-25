import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getBootstrapPathStore, type BootstrapRuntimeFileLease } from "./bootstrap-path-store.js";
import { PathDeniedError, type PathAuthority, type PathRequest } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { terminateProcessTree } from "./process-tree.js";
import { USER_DATA_DIR } from "./runtime-paths.js";
import { pngSize, registerObservation, type ToolObservation } from "./observations.js";

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
  /** CSS size of the captured area; image pixels = CSS pixels × scale. */
  readonly cssWidth?: number;
  readonly cssHeight?: number;
  readonly scale?: number;
  readonly viewport?: boolean;
}

/** Longest image edge sent to a model; larger pages are scaled down and the scale is recorded. */
export const SCREENSHOT_MAX_EDGE = 1280;

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
  waitFor?(condition: BrowserWaitCondition, tab?: BrowserTabSelector, signal?: AbortSignal): Promise<BrowserWaitResult>;
  upload?(ref: string, hostFile: string, tab?: BrowserTabSelector): Promise<void>;
  uploadDirectory?(): Promise<string>;
  downloads?(): BrowserDownload[];
  readDownload?(id: number, maximumBytes: number): Promise<Readonly<{ name: string; bytes: Buffer }>>;
  handoff?(tab?: BrowserTabSelector): Promise<BrowserTab>;
  clickPoint?(x: number, y: number, tab?: BrowserTabSelector): Promise<void>;
}

export interface BrowserWaitCondition {
  readonly text?: string;
  readonly textGone?: string;
  readonly urlIncludes?: string;
  readonly timeoutMs?: number;
}

export interface BrowserWaitResult { readonly met: boolean; readonly url: string; readonly title: string; readonly waitedMs: number }

export interface BrowserDownload {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly state: "inProgress" | "completed" | "canceled";
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

interface DownloadRecord { id: number; guid: string; name: string; url: string; state: BrowserDownload["state"]; receivedBytes: number; totalBytes: number }

/** Real key events: Enter submits native forms and Tab moves focus, unlike synthetic KeyboardEvent objects. */
const NAMED_KEYS: Readonly<Record<string, Readonly<{ key: string; code: string; keyCode: number; text?: string }>>> = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
});
const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ Esc: "Escape", Return: "Enter", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", " ": "Space", Spacebar: "Space" });
const MODIFIERS: Readonly<Record<string, number>> = Object.freeze({ alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 });

export function parseBrowserKey(input: string): Readonly<{ key: string; code: string; keyCode: number; text?: string; modifiers: number }> {
  const parts = input === "+" ? ["+"] : input.split("+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.trim().toLowerCase()];
    if (!bit) throw new TypeError(`Unknown key modifier: ${part}`);
    modifiers |= bit;
  }
  const canonical = KEY_ALIASES[name] ?? name;
  const named = NAMED_KEYS[canonical];
  const shortcut = (modifiers & (1 | 2 | 4)) !== 0;
  if (named) return Object.freeze({ ...named, ...(shortcut ? { text: undefined } : {}), modifiers });
  if ([...name].length !== 1) throw new TypeError(`Unsupported browser key: ${name}`);
  const upper = name.toUpperCase();
  const letter = /^[A-Z]$/u.test(upper), digit = /^[0-9]$/u.test(name);
  const text = shortcut ? undefined : (modifiers & 8) && letter ? upper : name;
  return Object.freeze({ key: (modifiers & 8) && letter ? upper : name, code: letter ? `Key${upper}` : digit ? `Digit${name}` : "", keyCode: letter || digit ? upper.charCodeAt(0) : 0, ...(text !== undefined ? { text } : {}), modifiers });
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
  #listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    let set = this.#listeners.get(method);
    if (!set) { set = new Set(); this.#listeners.set(method, set); }
    set.add(listener);
  }

  constructor(url: string) {
    this.url = url;
    this.socket = new WebSocket(loopbackWebSocket(url));
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`CDP WebSocket failed: ${url}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message: unknown;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const record = message as Record<string, unknown>;
      if (typeof record.method === "string" && typeof record.id !== "number") {
        for (const listener of this.#listeners.get(record.method) ?? []) { try { listener((record.params ?? {}) as Record<string, unknown>); } catch { /* listener errors stay local */ } }
        return;
      }
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

function loopbackWebSocket(input: string, endpoint?: string): string {
  const url = new URL(exactText(input, "Browser WebSocket URL", 8_192));
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
      url.username || url.password || url.hash) {
    throw new Error("Browser WebSocket must use a numeric loopback address without credentials or fragments");
  }
  if (endpoint && (url.protocol !== "ws:" || url.host !== new URL(endpoint).host)) {
    throw new Error("CDP target WebSocket does not match the selected browser endpoint");
  }
  return url.href;
}

function requestCdp(baseUrl: string, endpoint: string, method?: "PUT"): Promise<Response> {
  return fetch(`${baseUrl}${endpoint}`, { method, redirect: "error", signal: AbortSignal.timeout(2_000) });
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

async function firstExecutable(): Promise<BootstrapRuntimeFileLease> {
  for (const candidate of browserCandidates()) {
    try { return await getBootstrapPathStore().openBrowserExecutable(candidate); }
    catch (error) {
      if (!(error instanceof PathDeniedError) || !["PATH_NOT_FOUND", "PATH_ROOT_UNAVAILABLE"].includes(error.code)) throw error;
    }
  }
  throw new Error("Chrome/Chromium was not found; provide cdpUrl, cdpPort, extensionUrl, or RAINYDAYS_CHROME_PATH");
}

interface BrowserTemporaryDirectory {
  readonly canonicalPath: string;
  readonly authority: PathAuthority;
  dispose(removeContents: boolean): Promise<void>;
}

function browserTempRequest(input: string, operation: PathRequest["operation"]): PathRequest {
  return { input, operation, defaultRootId: "browser-temp" };
}

async function openBrowserTemporaryDirectory(prefix: "profile" | "io"): Promise<BrowserTemporaryDirectory> {
  const parentPath = os.tmpdir();
  const parent = await pathPolicy.createAuthority([{
    rootId: "browser-temp", role: "browser-temporary-parent", configuredPath: parentPath, permissions: ["create-directory"],
  }]);
  try {
    const name = `rainydays-browser-${prefix}-${randomUUID()}`;
    const enrollment = await pathPolicy.createDirectoryEnrollment(parent, browserTempRequest(name, "create-directory"));
    try {
      if (enrollment.createdDirectories !== 1) throw new Error("Browser temporary directory already exists");
      const authority = await pathPolicy.createAuthority([{
        rootId: "browser-temp", role: "browser-temporary", configuredPath: path.join(parentPath, name),
        permissions: ["read-file", "read-directory", "create-directory", "create-file", "replace-file"],
      }]);
      const { canonicalPath } = await pathPolicy.qualifyExisting(authority, browserTempRequest("", "read-directory"), "directory");
      let remaining = 10_000;
      const empty = async (input: string, depth: number): Promise<void> => {
        if (depth > 32 || remaining < 1) throw new Error("Browser temporary directory cleanup exceeded its limit");
        const entries = await pathPolicy.listDirectory(authority, browserTempRequest(input, "read-directory"), remaining);
        remaining -= entries.length;
        for (const entry of entries) {
          const child = path.join(input, entry.name);
          if (entry.type === "directory") {
            await empty(child, depth + 1);
            await pathPolicy.removeDirectory(authority, browserTempRequest(child, "create-directory"));
          } else await pathPolicy.removeFile(authority, browserTempRequest(child, "replace-file"));
        }
      };
      return { canonicalPath, authority, async dispose(removeContents) {
        try {
          if (removeContents) { await empty("", 0); await enrollment.rollback(); }
        }
        finally { pathPolicy.revoke(authority); }
      } };
    } catch (error) {
      await enrollment.rollback().catch(() => undefined);
      throw error;
    }
  } finally { pathPolicy.revoke(parent); }
}

async function waitForOwnedEndpoint(profile: BrowserTemporaryDirectory, child: ChildProcess): Promise<{ baseUrl: string; socketPath: string }> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const { bytes } = await pathPolicy.readFile(profile.authority, browserTempRequest("DevToolsActivePort", "read-file"), 1_024);
      const [portText, socketPath] = Buffer.from(bytes).toString("utf8").trim().split(/\r?\n/u);
      const port = Number(portText);
      if (Number.isInteger(port) && port >= 1_024 && port <= 65_535 && /^\/devtools\/browser\/[0-9a-f-]+$/iu.test(socketPath ?? "")) {
        return { baseUrl: `http://127.0.0.1:${port}`, socketPath };
      }
    } catch (error) {
      if (!(error instanceof PathDeniedError) || error.code !== "PATH_NOT_FOUND") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The owned browser did not publish its CDP endpoint");
}

async function waitForEndpoint(baseUrl: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await requestCdp(baseUrl, "/json/version");
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
    const value = typeof item.value === "string" ? ` value=${JSON.stringify(item.value)}` : "";
    const checked = typeof item.checked === "boolean" ? (item.checked ? " [checked]" : " [unchecked]") : "";
    const files = typeof item.files === "string" ? ` files=${JSON.stringify(item.files)}` : "";
    const focused = item.focused === true ? " [focused]" : "";
    return `${"  ".repeat(depth)}- ${role}${name ? ` \"${name}\"` : ""}${value}${checked}${files}${focused}${ref}`;
  });
  const content = typeof record.content === "string" ? record.content.slice(0, maximum) : "";
  return `${lines.join("\n")}\n\n--- Page Content ---\n${content}`.trim();
}

export class CdpBrowserBackend implements BrowserBackend {
  readonly kind = "cdp" as const;
  #baseUrl: string | null = null;
  #connecting: Promise<void> | null = null;
  #directTarget: CdpTarget | null = null;
  #spawned: ChildProcess | null = null;
  #profile: BrowserTemporaryDirectory | null = null;
  #ownedSocketPath: string | null = null;
  #connections = new Map<string, CdpConnection>();
  #tabNumbers = new Map<string, number>();
  #nextTabNumber = 1;
  #activeTargetId: string | null = null;
  #refs = new Map<string, Set<string>>();
  /** Attached to a browser the user already runs: only tabs this Session opened (and their popups) are visible. */
  #attached = false;
  #owned = new Set<string>();
  #browserConnection: CdpConnection | null = null;
  #ioDirectory: Promise<BrowserTemporaryDirectory> | null = null;
  #downloads = new Map<string, DownloadRecord>();
  #nextDownloadId = 1;
  #downloadsEnabled = false;
  #downloadAuthority: PathAuthority | null = null;
  #headless = false;
  /** Per tab: the latest viewport screenshot geometry, used to map image points back to page points. */
  #lastViewportShot = new Map<string, { scale: number; cssWidth: number; cssHeight: number }>();

  async #connect(options: BrowserOpenOptions): Promise<void> {
    if (this.#baseUrl || this.#directTarget) return;
    if (options.cdpUrl) {
      const wsUrl = loopbackWebSocket(options.cdpUrl);
      this.#directTarget = { id: "direct", type: "page", url: "about:blank", title: "Direct CDP", webSocketDebuggerUrl: wsUrl };
      this.#owned.add("direct");
      return;
    }
    const requestedPort = safePort(options.cdpPort) ?? safePort(Number(process.env.LUX_CDP_PORT) || undefined);
    if (requestedPort) {
      const candidate = `http://127.0.0.1:${requestedPort}`;
      await waitForEndpoint(candidate, 500);
      this.#baseUrl = candidate;
      this.#attached = true;
      await this.#connectBrowser();
      return;
    }
    const profile = this.#profile = await openBrowserTemporaryDirectory("profile");
    const executable = await firstExecutable();
    const args = [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile.canonicalPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-background-networking",
    ];
    this.#headless = options.headless === true;
    if (options.headless) args.push("--headless=new", "--disable-gpu");
    args.push("about:blank");
    try {
      await pathPolicy.qualifyExisting(profile.authority, browserTempRequest("", "read-directory"), "directory");
      await executable.assertCurrent("beforeProcessSpawn");
      const child = this.#spawned = spawn(executable.canonicalPath, args, { shell: false, stdio: "ignore", windowsHide: Boolean(options.headless) });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.on("error", reject);
      });
    } finally { await executable.close(); }
    const { baseUrl, socketPath } = await waitForOwnedEndpoint(profile, this.#spawned);
    this.#baseUrl = baseUrl;
    this.#ownedSocketPath = socketPath;
    await this.#connectBrowser();
  }

  /** Browser-level channel: popup ownership and, for a browser this Session launched, downloads into a private folder. */
  async #connectBrowser(): Promise<void> {
    if (!this.#baseUrl || this.#browserConnection) return;
    try {
      const version = await (await requestCdp(this.#baseUrl, "/json/version")).json() as { webSocketDebuggerUrl?: string };
      if (!version.webSocketDebuggerUrl) return;
      const socket = loopbackWebSocket(version.webSocketDebuggerUrl, this.#baseUrl);
      if (this.#ownedSocketPath && new URL(socket).pathname !== this.#ownedSocketPath) throw new Error("CDP browser does not match the launched profile");
      const connection = new CdpConnection(socket);
      await connection.ready;
      this.#browserConnection = connection;
      if (this.#attached) return; // Never change download behaviour of a browser the user owns.
      const directory = await this.#io();
      const enrollment = await pathPolicy.createDirectoryEnrollment(directory.authority, browserTempRequest("downloads", "create-directory"));
      enrollment.commit();
      const { canonicalPath: downloadPath } = await pathPolicy.qualifyExisting(directory.authority, browserTempRequest("downloads", "read-directory"), "directory");
      const authority = await pathPolicy.createAuthority([{
        rootId: "browser-downloads",
        role: "browser-downloads",
        configuredPath: downloadPath,
        permissions: ["read-file"],
      }]);
      if (this.#browserConnection !== connection) {
        pathPolicy.revoke(authority);
        return;
      }
      this.#downloadAuthority = authority;
      connection.on("Browser.downloadWillBegin", params => {
        const guid = String(params.guid ?? "");
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(guid) || this.#downloads.has(guid)) return;
        this.#downloads.set(guid, { id: this.#nextDownloadId++, guid, name: String(params.suggestedFilename ?? "download").slice(0, 200), url: String(params.url ?? "").slice(0, 2048), state: "inProgress", receivedBytes: 0, totalBytes: 0 });
      });
      connection.on("Browser.downloadProgress", params => {
        const record = this.#downloads.get(String(params.guid ?? ""));
        if (!record) return;
        if (params.state === "completed" || params.state === "canceled" || params.state === "inProgress") record.state = params.state;
        if (typeof params.receivedBytes === "number") record.receivedBytes = params.receivedBytes;
        if (typeof params.totalBytes === "number") record.totalBytes = params.totalBytes;
      });
      try {
        await connection.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath, eventsEnabled: true });
        this.#downloadsEnabled = this.#downloadAuthority === authority;
      } catch (error) {
        if (this.#downloadAuthority === authority) {
          pathPolicy.revoke(authority);
          this.#downloadAuthority = null;
        }
        throw error;
      }
    } catch (error) {
      if (!this.#attached && !this.#browserConnection) throw error;
      // Downloads stay unavailable when the browser-level connection is usable.
    }
  }

  #io(): Promise<BrowserTemporaryDirectory> {
    this.#ioDirectory ??= openBrowserTemporaryDirectory("io");
    return this.#ioDirectory;
  }

  async #adoptPopups(targets: CdpTarget[]): Promise<void> {
    if (!this.#attached || !this.#browserConnection) return;
    if (!targets.some(target => !this.#owned.has(target.id))) return;
    try {
      const { targetInfos } = await this.#browserConnection.send<{ targetInfos: Array<{ targetId: string; openerId?: string }> }>("Target.getTargets");
      let changed = true;
      while (changed) {
        changed = false;
        for (const info of targetInfos) if (info.openerId && this.#owned.has(info.openerId) && !this.#owned.has(info.targetId)) { this.#owned.add(info.targetId); changed = true; }
      }
    } catch { /* ownership stays as it was */ }
  }

  async #targets(): Promise<CdpTarget[]> {
    if (this.#directTarget) return [this.#directTarget];
    if (!this.#baseUrl) throw new Error("Browser is not connected");
    const response = await requestCdp(this.#baseUrl, "/json/list");
    if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
    const values = (await response.json() as CdpTarget[]).filter(target => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
    if (!this.#attached) return values;
    await this.#adoptPopups(values);
    return values.filter(target => this.#owned.has(target.id));
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
      connection = new CdpConnection(loopbackWebSocket(target.webSocketDebuggerUrl, this.#baseUrl ?? undefined));
      this.#connections.set(target.id, connection);
      const targetId = target.id;
      connection.on("Page.frameNavigated", params => { const frame = params.frame as { parentId?: string } | undefined; if (!frame?.parentId) this.#invalidate(targetId); });
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

  #invalidate(targetId: string): void { this.#refs.delete(targetId); this.#lastViewportShot.delete(targetId); }

  async open(options: BrowserOpenOptions): Promise<BrowserTab> {
    const connecting = this.#connecting ??= this.#connect(options);
    try { await connecting; }
    finally { if (this.#connecting === connecting) this.#connecting = null; }
    const url = normalizeUrl(options.url);
    let target = await this.#target(options.tab).catch(async () => {
      if (!this.#baseUrl) throw new Error("Direct CDP target is unavailable");
      const response = await requestCdp(this.#baseUrl, `/json/new?${encodeURIComponent("about:blank")}`, "PUT");
      if (!response.ok) throw new Error(`Creating browser tab failed: HTTP ${response.status}`);
      const created = await response.json() as CdpTarget;
      this.#owned.add(created.id);
      return this.#target(this.#number(created.id));
    });
    const connection = await this.#connection(target);
    await connection.send("Page.navigate", { url });
    this.#activeTargetId = target.id;
    this.#invalidate(target.id);
    return this.#settled(this.#number(target.id));
  }

  async close(): Promise<void> {
    await this.#connecting?.catch(() => undefined);
    if (this.#attached && this.#baseUrl) {
      for (const targetId of this.#owned) await requestCdp(this.#baseUrl, `/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
    }
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    this.#browserConnection?.close();
    this.#browserConnection = null;
    this.#owned.clear();
    this.#attached = false;
    this.#downloads.clear();
    this.#downloadsEnabled = false;
    if (this.#downloadAuthority) pathPolicy.revoke(this.#downloadAuthority);
    this.#downloadAuthority = null;
    const child = this.#spawned;
    this.#spawned = null;
    const profile = this.#profile;
    this.#profile = null;
    const io = this.#ioDirectory;
    this.#ioDirectory = null;
    this.#ownedSocketPath = null;
    this.#baseUrl = null;
    this.#directTarget = null;
    this.#activeTargetId = null;
    this.#refs.clear();
    let canClean = !child?.pid;
    try {
      if (child?.pid) await terminateProcessTree(child);
      canClean = true;
    } finally {
      const cleaned = await Promise.allSettled([profile?.dispose(canClean), io?.then(directory => directory.dispose(canClean))]);
      if (canClean) for (const result of cleaned) if (result.status === "rejected") throw result.reason;
    }
  }

  async tabs(): Promise<BrowserTab[]> { return this.#tabValues(); }

  async newTab(urlInput: string): Promise<BrowserTab> {
    const url = normalizeUrl(urlInput);
    if (!this.#baseUrl) throw new Error("New tabs require a browser-level CDP endpoint");
    const response = await requestCdp(this.#baseUrl, `/json/new?${encodeURIComponent(url)}`, "PUT");
    if (!response.ok) throw new Error(`Creating browser tab failed: HTTP ${response.status}`);
    const target = await response.json() as CdpTarget;
    this.#owned.add(target.id);
    this.#activeTargetId = target.id;
    return this.#settled(this.#number(target.id));
  }

  async closeTab(tab?: BrowserTabSelector): Promise<void> {
    const target = await this.#target(tab);
    const connection = this.#connections.get(target.id);
    connection?.close();
    this.#connections.delete(target.id);
    if (this.#baseUrl) {
      const response = await requestCdp(this.#baseUrl, `/json/close/${encodeURIComponent(target.id)}`);
      if (!response.ok) throw new Error(`Closing browser tab failed: HTTP ${response.status}`);
    } else connection?.close();
    this.#refs.delete(target.id);
    this.#owned.delete(target.id);
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
          const field = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
          const kind = String(element.type || '').toLowerCase();
          const state = {};
          if (field && !['checkbox','radio','button','submit','reset','file','image','hidden'].includes(kind)) state.value = kind === 'password' ? (element.value ? '••••' : '') : String(element.value ?? '').slice(0, 200);
          if (kind === 'checkbox' || kind === 'radio') state.checked = Boolean(element.checked);
          if (kind === 'file') state.files = Array.from(element.files || []).map(file => file.name).join(', ').slice(0, 200);
          if (document.activeElement === element) state.focused = true;
          if (!interactiveOnly || isInteractive) elements.push({ role, name: String(field ? (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.name || element.placeholder || '') : name).trim().slice(0, 240), ref, depth, ...state });
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

  /** Resolves a ref of the latest snapshot in its own tab; a missing node means the page changed and must be observed again. */
  async #resolveRef(refInput: string, tab: BrowserTabSelector): Promise<Readonly<{ target: CdpTarget; selector: string }>> {
    const ref = exactText(refInput, "Browser ref", 80);
    const target = await this.#target(tab);
    if (!this.#refs.get(target.id)?.has(ref)) throw new Error(`Browser ref is stale or unknown: ${ref}; run browser_snapshot again`);
    const selector = `[data-rainydays-ref=${JSON.stringify(ref)}]`;
    const exists = await this.#evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, this.#number(target.id));
    if (!exists) { this.#refs.get(target.id)?.delete(ref); throw new Error(`Browser ref no longer exists: ${ref}; the page changed, run browser_snapshot again`); }
    return Object.freeze({ target, selector });
  }

  async #withRef(refInput: string, tab: BrowserTabSelector, operation: (selector: string) => string): Promise<void> {
    const { target, selector } = await this.#resolveRef(refInput, tab);
    const result = await this.#evaluate<boolean>(operation(selector), this.#number(target.id));
    if (!result) throw new Error(`Browser ref no longer exists: ${refInput}; run browser_snapshot again`);
  }

  async #focusRef(refInput: string, tab: BrowserTabSelector, selectContents: boolean): Promise<CdpTarget> {
    const { target, selector } = await this.#resolveRef(refInput, tab);
    const focused = await this.#evaluate<boolean>(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.scrollIntoView({block:'center',inline:'center'}); e.focus(); if(document.activeElement!==e && !e.contains(document.activeElement))return false; if(${selectContents}){ if(typeof e.select==='function')e.select(); else if(e.isContentEditable){ const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); } } return true; })()`, this.#number(target.id));
    if (!focused) throw new Error(`Browser element cannot take keyboard focus: ${refInput}`);
    return target;
  }

  async #key(connection: CdpConnection, parsed: ReturnType<typeof parseBrowserKey>): Promise<void> {
    const base = { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.keyCode, nativeVirtualKeyCode: parsed.keyCode, modifiers: parsed.modifiers };
    await connection.send("Input.dispatchKeyEvent", { type: parsed.text ? "keyDown" : "rawKeyDown", ...base, ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}) });
    await connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** A real mouse click at the element's visible centre; refuses when another element covers that point. */
  async click(ref: string, tab?: BrowserTabSelector): Promise<void> {
    const { target, selector } = await this.#resolveRef(ref, tab);
    const point = await this.#evaluate<{ x: number; y: number; covered: string | null } | null>(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; e.scrollIntoView({block:'center',inline:'center'}); const r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0)return null; const x=r.left+r.width/2, y=r.top+r.height/2; const hit=document.elementFromPoint(x,y); const covered=hit && hit!==e && !e.contains(hit) && !hit.contains(e) ? (hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:'')+(hit.className&&typeof hit.className==='string'?'.'+hit.className.split(/\\s+/).filter(Boolean).join('.'):'')).slice(0,120) : null; return {x,y,covered}; })()`, this.#number(target.id));
    if (!point) throw new Error(`Browser element is not visible: ${ref}; scroll or run browser_snapshot again`);
    if (point.covered) throw new Error(`Browser element is covered by ${point.covered}; close the overlay or choose another element`);
    const connection = await this.#connection(target);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Replaces the field's content through real text input, then reports what the page actually kept. */
  async fill(ref: string, valueInput: string, tab?: BrowserTabSelector): Promise<void> {
    const value = exactText(valueInput, "Fill value", 1_000_000, true);
    const target = await this.#focusRef(ref, tab, true);
    const connection = await this.#connection(target);
    if (value) await connection.send("Input.insertText", { text: value });
    else await this.#key(connection, parseBrowserKey("Backspace"));
    const kept = await this.#evaluate<string | null>(`(() => { const e=document.activeElement; return e && 'value' in e ? String(e.value) : null; })()`, this.#number(target.id));
    if (kept !== null && kept !== value) throw new Error(`Browser field kept a different value (${JSON.stringify(kept.slice(0, 80))}); it may limit length or format input`);
  }

  async type(ref: string, textInput: string, delayInput = 50, tab?: BrowserTabSelector): Promise<void> {
    const text = exactText(textInput, "Typed text", 100_000, true);
    const delay = Math.max(0, Math.min(2_000, Number.isFinite(delayInput) ? delayInput : 50));
    const target = await this.#focusRef(ref, tab, false);
    const connection = await this.#connection(target);
    if (!delay) { if (text) await connection.send("Input.insertText", { text }); return; }
    for (const character of text) {
      await connection.send("Input.insertText", { text: character });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /** Sends a real key (optionally with modifiers such as Control+A) to the focused element of the tab. */
  async press(keyInput: string, tab?: BrowserTabSelector): Promise<void> {
    const parsed = parseBrowserKey(exactText(keyInput, "Browser key", 40));
    const target = await this.#target(tab);
    await this.#key(await this.#connection(target), parsed);
  }

  async waitFor(condition: BrowserWaitCondition, tab?: BrowserTabSelector, signal?: AbortSignal): Promise<BrowserWaitResult> {
    const timeoutMs = Math.max(100, Math.min(60_000, condition.timeoutMs ?? 10_000));
    if (!condition.text && !condition.textGone && !condition.urlIncludes) throw new TypeError("browser_wait needs text, textGone or urlIncludes");
    const started = Date.now();
    const probe = `(() => { const body=(document.body?.innerText||''); return { url: location.href, title: document.title, text: ${condition.text ? `body.includes(${JSON.stringify(condition.text)})` : "true"}, gone: ${condition.textGone ? `!body.includes(${JSON.stringify(condition.textGone)})` : "true"}, urlOk: ${condition.urlIncludes ? `location.href.includes(${JSON.stringify(condition.urlIncludes)})` : "true"} }; })()`;
    let last = { url: "", title: "" };
    while (Date.now() - started < timeoutMs) {
      signal?.throwIfAborted();
      try {
        const state = await this.#evaluate<{ url: string; title: string; text: boolean; gone: boolean; urlOk: boolean }>(probe, tab);
        last = state;
        if (state.text && state.gone && state.urlOk) return Object.freeze({ met: true, url: state.url, title: state.title, waitedMs: Date.now() - started });
      } catch { /* navigating */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return Object.freeze({ met: false, url: last.url, title: last.title, waitedMs: Date.now() - started });
  }

  async uploadDirectory(): Promise<string> {
    const io = await this.#io();
    const relative = path.join("uploads", randomUUID());
    const enrollment = await pathPolicy.createDirectoryEnrollment(io.authority, browserTempRequest(relative, "create-directory"));
    enrollment.commit();
    return (await pathPolicy.qualifyExisting(io.authority, browserTempRequest(relative, "read-directory"), "directory")).canonicalPath;
  }

  async upload(ref: string, hostFile: string, tab?: BrowserTabSelector): Promise<void> {
    const { target, selector } = await this.#resolveRef(ref, tab);
    const connection = await this.#connection(target);
    const found = await connection.send<{ result: { objectId?: string; subtype?: string } }>("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e && e.tagName==='INPUT' && e.type==='file' ? e : null; })()`, returnByValue: false });
    if (!found.result.objectId) throw new Error(`Browser ref is not a file input: ${ref}`);
    await connection.send("DOM.setFileInputFiles", { files: [hostFile], objectId: found.result.objectId });
  }

  downloads(): BrowserDownload[] {
    if (!this.#downloadsEnabled) throw new Error(this.#attached ? "Downloads are only managed in a browser RainyDays launched; reopen without cdpPort/cdpUrl" : "Downloads are unavailable for this browser connection");
    return [...this.#downloads.values()].map(({ guid: _guid, ...visible }) => Object.freeze({ ...visible }));
  }

  async readDownload(id: number, maximumBytes: number): Promise<Readonly<{ name: string; bytes: Buffer }>> {
    const authority = this.#downloadAuthority;
    if (!this.#downloadsEnabled || !authority) throw new Error("Downloads are unavailable for this browser connection");
    const record = [...this.#downloads.values()].find(item => item.id === id);
    if (!record) throw new Error(`Browser download was not found: ${id}`);
    if (record.state !== "completed") throw new Error(`Browser download ${id} is ${record.state}; wait until it completes`);
    const { bytes } = await pathPolicy.readFile(authority, {
      input: record.guid,
      operation: "read-file",
      defaultRootId: "browser-downloads",
    }, maximumBytes);
    return Object.freeze({ name: record.name, bytes: Buffer.from(bytes) });
  }

  /** Hands the visible tab to the user (login, verification). Every ref is dropped so work resumes from a fresh observation. */
  async handoff(tab?: BrowserTabSelector): Promise<BrowserTab> {
    if (this.#spawned && this.#headless) throw new Error("A headless browser cannot be handed to the user; reopen with headless:false");
    const target = await this.#target(tab);
    await (await this.#connection(target)).send("Page.bringToFront");
    this.#refs.clear();
    return this.#settled(this.#number(target.id));
  }

  async scroll(direction: "up" | "down" | "left" | "right", amountInput = 400, ref?: string, tab?: BrowserTabSelector): Promise<void> {
    if (!new Set(["up", "down", "left", "right"]).has(direction)) throw new TypeError("Scroll direction is invalid");
    const amount = Math.max(1, Math.min(100_000, Math.abs(amountInput || 400)));
    const x = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const y = direction === "up" ? -amount : direction === "down" ? amount : 0;
    if (ref) await this.#withRef(ref, tab, selector => `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.scrollBy(${x},${y}); return true; })()`);
    else await this.#evaluate(`(() => { window.scrollBy(${x},${y}); return true; })()`, tab);
  }

  /** Captures at most SCREENSHOT_MAX_EDGE pixels on the long edge and reports the CSS size, so image points map back to the page. */
  async screenshot(fullPage = false, tab?: BrowserTabSelector): Promise<BrowserScreenshot> {
    const target = await this.#target(tab);
    const connection = await this.#connection(target);
    const metrics = await this.#evaluate<{ w: number; h: number; sx: number; sy: number; pageW: number; pageH: number }>("({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, pageW: Math.max(document.documentElement.scrollWidth, innerWidth), pageH: Math.max(document.documentElement.scrollHeight, innerHeight) })", this.#number(target.id));
    const cssWidth = Math.max(1, Math.round(fullPage ? metrics.pageW : metrics.w));
    const cssHeight = Math.max(1, Math.round(fullPage ? Math.min(metrics.pageH, 16_384) : metrics.h));
    const requested = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(cssWidth, cssHeight));
    // Clip coordinates are document coordinates: a viewport capture starts at the scroll offset.
    const clip = { x: fullPage ? 0 : metrics.sx, y: fullPage ? 0 : metrics.sy, width: cssWidth, height: cssHeight, scale: requested };
    const result = await connection.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, fromSurface: true, clip });
    const bytes = Buffer.from(result.data, "base64");
    const { width } = pngSize(bytes);
    const settledTab = await this.#settled(this.#number(target.id));
    const shot = Object.freeze({ mimeType: "image/png" as const, bytes, tab: settledTab, cssWidth, cssHeight, scale: width / cssWidth, viewport: !fullPage });
    if (!fullPage) this.#lastViewportShot.set(target.id, { scale: shot.scale, cssWidth, cssHeight });
    return shot;
  }

  /** Clicks a point of the tab's latest viewport screenshot, given in that image's pixels. */
  async clickPoint(x: number, y: number, tab?: BrowserTabSelector): Promise<void> {
    const target = await this.#target(tab);
    const shot = this.#lastViewportShot.get(target.id);
    if (!shot) throw new Error("Take a viewport browser_screenshot of this tab first; full-page screenshots cannot be clicked by position");
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new TypeError("Point must be non-negative image coordinates");
    const pageX = x / shot.scale, pageY = y / shot.scale;
    if (pageX > shot.cssWidth || pageY > shot.cssHeight) throw new RangeError(`Point (${x}, ${y}) is outside the latest screenshot`);
    const connection = await this.#connection(target);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pageX, y: pageY });
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pageX, y: pageY, button: "left", buttons: 1, clickCount: 1 });
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pageX, y: pageY, button: "left", buttons: 0, clickCount: 1 });
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
    this.socket = new WebSocket(loopbackWebSocket(url));
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
    this.rpc = new ExtensionRpc(urlInput);
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

  #capable<K extends "waitFor" | "upload" | "uploadDirectory" | "downloads" | "readDownload" | "handoff" | "clickPoint">(sessionId: string, name: K): NonNullable<BrowserBackend[K]> {
    const backend = this.#backend(sessionId);
    const method = backend[name];
    if (typeof method !== "function") throw new Error(`The ${backend.kind} browser backend does not support ${name}`);
    return (method as (...args: unknown[]) => unknown).bind(backend) as NonNullable<BrowserBackend[K]>;
  }
  waitFor(sessionId: string, condition: BrowserWaitCondition, tab?: BrowserTabSelector, signal?: AbortSignal): Promise<BrowserWaitResult> { return this.#capable(sessionId, "waitFor")(condition, tab, signal); }
  uploadDirectory(sessionId: string): Promise<string> { return this.#capable(sessionId, "uploadDirectory")(); }
  upload(sessionId: string, ref: string, hostFile: string, tab?: BrowserTabSelector): Promise<void> { return this.#capable(sessionId, "upload")(ref, hostFile, tab); }
  downloads(sessionId: string): BrowserDownload[] { return this.#capable(sessionId, "downloads")(); }
  readDownload(sessionId: string, id: number, maximumBytes: number): Promise<Readonly<{ name: string; bytes: Buffer }>> { return this.#capable(sessionId, "readDownload")(id, maximumBytes); }
  handoff(sessionId: string, tab?: BrowserTabSelector): Promise<BrowserTab> { return this.#capable(sessionId, "handoff")(tab); }
  clickPoint(sessionId: string, x: number, y: number, tab?: BrowserTabSelector): Promise<void> { return this.#capable(sessionId, "clickPoint")(x, y, tab); }

  async screenshot(sessionIdInput: string, fullPage?: boolean, tab?: BrowserTabSelector): Promise<Readonly<{ path: string; sha256: string; bytes: number; mimeType: string; tab: BrowserTab; observation?: ToolObservation }>> {
    const sessionId = this.#sessionId(sessionIdInput);
    const screenshot = await this.#backend(sessionId).screenshot(fullPage, tab);
    const sessionDirectory = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const directory = path.join("browser-artifacts", sessionDirectory);
    const authority = await pathPolicy.createAuthority([{
      rootId: "browser-artifacts", role: "browser-artifacts", configuredPath: USER_DATA_DIR,
      permissions: ["create-directory", "create-file"],
    }]);
    const relative = path.join(directory, `screenshot-${Date.now()}-${randomUUID()}.png`);
    try {
      const enrollment = await pathPolicy.createDirectoryEnrollment(authority, { input: directory, operation: "create-directory", defaultRootId: "browser-artifacts" });
      enrollment.commit();
      await pathPolicy.createFile(authority, { input: relative, operation: "create-file", defaultRootId: "browser-artifacts" }, screenshot.bytes);
    } finally { pathPolicy.revoke(authority); }
    const filePath = path.join(USER_DATA_DIR, relative);
    const observation = screenshot.cssWidth && screenshot.cssHeight && screenshot.scale ? await registerObservation(sessionId, screenshot.bytes, {
      sourceWidth: screenshot.cssWidth, sourceHeight: screenshot.cssHeight, scale: screenshot.scale, source: "browser_screenshot",
      target: `${screenshot.tab.title} <${screenshot.tab.url}>`.slice(0, 300), viewport: screenshot.viewport === true,
    }) : undefined;
    return Object.freeze({ path: filePath, sha256: createHash("sha256").update(screenshot.bytes).digest("hex"), bytes: screenshot.bytes.length, mimeType: screenshot.mimeType, tab: screenshot.tab, ...(observation ? { observation } : {}) });
  }
}

export const browserSessions = new BrowserSessionManager();
