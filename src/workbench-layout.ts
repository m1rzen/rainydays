export const WORKBENCH_LAYOUT_SCHEMA_VERSION = 1 as const;
export const MAX_WORKBENCH_LAYOUT_BYTES = 65_536;
const MAX_DEPTH = 8;
const MAX_PANES = 16;
const MAX_TABS = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type WorkbenchTab =
  | Readonly<{ id: string; kind: "session"; title: string; sessionId: string }>
  | Readonly<{ id: string; kind: "terminal"; title: string; sessionId: string; terminalId: string }>
  | Readonly<{ id: string; kind: "file"; title: string; sessionId: string; rootId: string; path: string }>
  | Readonly<{ id: string; kind: "browser"; title: string; url: string }>
  | Readonly<{ id: string; kind: "prism"; title: string; module: string }>;

export interface WorkbenchPane {
  readonly type: "pane";
  readonly id: string;
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string;
}

export interface WorkbenchSplit {
  readonly type: "split";
  readonly id: string;
  readonly direction: "horizontal" | "vertical";
  readonly ratio: number;
  readonly first: WorkbenchNode;
  readonly second: WorkbenchNode;
}

export type WorkbenchNode = WorkbenchPane | WorkbenchSplit;
export interface WorkbenchLayout {
  readonly schemaVersion: 1;
  readonly focusedPaneId: string;
  readonly root: WorkbenchNode;
}

export interface WorkbenchDragPayload {
  readonly schemaVersion: 1;
  readonly tabId: string;
  readonly sourcePaneId: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} prototype is invalid`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function text(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function tab(value: unknown): WorkbenchTab {
  const input = object(value, "Workbench tab");
  const common = {
    id: text(input.id, "Workbench tab id", 128, ID_PATTERN),
    title: text(input.title, "Workbench tab title", 200),
  };
  switch (input.kind) {
    case "session":
      exact(input, ["id", "kind", "title", "sessionId"], "Session tab");
      return Object.freeze({ ...common, kind: "session", sessionId: text(input.sessionId, "Session tab resource", 256) });
    case "terminal":
      exact(input, ["id", "kind", "title", "sessionId", "terminalId"], "Terminal tab");
      return Object.freeze({
        ...common, kind: "terminal",
        sessionId: text(input.sessionId, "Terminal tab Session", 256),
        terminalId: text(input.terminalId, "Terminal tab resource", 256),
      });
    case "file": {
      exact(input, ["id", "kind", "title", "sessionId", "rootId", "path"], "File tab");
      const filePath = text(input.path, "File tab path", 4_096);
      if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(filePath) || filePath.split(/[\\/]+/u).includes("..")) {
        throw new TypeError("File tab path is invalid");
      }
      return Object.freeze({
        ...common, kind: "file",
        sessionId: text(input.sessionId, "File tab Session", 256),
        rootId: text(input.rootId, "File tab root", 64, ROOT_PATTERN),
        path: filePath,
      });
    }
    case "browser": {
      exact(input, ["id", "kind", "title", "url"], "Browser tab");
      const rawUrl = text(input.url, "Browser tab URL", 2_048);
      let parsed: URL;
      try { parsed = new URL(rawUrl); }
      catch { throw new TypeError("Browser tab URL is invalid"); }
      if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) throw new TypeError("Browser tab URL is invalid");
      return Object.freeze({ ...common, kind: "browser", url: parsed.href });
    }
    case "prism":
      exact(input, ["id", "kind", "title", "module"], "Prism tab");
      return Object.freeze({ ...common, kind: "prism", module: text(input.module, "Prism module", 64, ROOT_PATTERN) });
    default:
      throw new TypeError("Workbench tab kind is invalid");
  }
}

interface ParseState {
  panes: number;
  tabs: number;
  readonly nodeIds: Set<string>;
  readonly tabIds: Set<string>;
  readonly paneIds: Set<string>;
}

function node(value: unknown, depth: number, state: ParseState): WorkbenchNode {
  if (depth > MAX_DEPTH) throw new TypeError("Workbench split depth exceeds the limit");
  const input = object(value, "Workbench node");
  const id = text(input.id, "Workbench node id", 128, ID_PATTERN);
  if (state.nodeIds.has(id)) throw new TypeError("Workbench node ids must be unique");
  state.nodeIds.add(id);
  if (input.type === "pane") {
    exact(input, ["type", "id", "tabs", "activeTabId"], "Workbench pane");
    state.panes += 1;
    if (state.panes > MAX_PANES || !Array.isArray(input.tabs) || input.tabs.length < 1) throw new TypeError("Workbench pane tabs are invalid");
    const tabs = input.tabs.map(tabValue => tab(tabValue));
    state.tabs += tabs.length;
    if (state.tabs > MAX_TABS) throw new TypeError("Workbench tab count exceeds the limit");
    for (const candidate of tabs) {
      if (state.tabIds.has(candidate.id)) throw new TypeError("Workbench tab ids must be unique");
      state.tabIds.add(candidate.id);
    }
    const activeTabId = text(input.activeTabId, "Workbench active tab", 128, ID_PATTERN);
    if (!tabs.some(candidate => candidate.id === activeTabId)) throw new TypeError("Workbench active tab is absent");
    state.paneIds.add(id);
    return Object.freeze({ type: "pane", id, tabs: Object.freeze(tabs), activeTabId });
  }
  if (input.type === "split") {
    exact(input, ["type", "id", "direction", "ratio", "first", "second"], "Workbench split");
    if (input.direction !== "horizontal" && input.direction !== "vertical") throw new TypeError("Workbench split direction is invalid");
    if (typeof input.ratio !== "number" || !Number.isFinite(input.ratio) || input.ratio < 0.1 || input.ratio > 0.9) {
      throw new TypeError("Workbench split ratio is invalid");
    }
    return Object.freeze({
      type: "split", id, direction: input.direction, ratio: input.ratio,
      first: node(input.first, depth + 1, state), second: node(input.second, depth + 1, state),
    });
  }
  throw new TypeError("Workbench node type is invalid");
}

export function parseWorkbenchLayout(value: unknown): WorkbenchLayout {
  const input = object(value, "Workbench layout");
  exact(input, ["schemaVersion", "focusedPaneId", "root"], "Workbench layout");
  if (input.schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) throw new TypeError("Workbench layout schema is unsupported");
  const state: ParseState = { panes: 0, tabs: 0, nodeIds: new Set(), tabIds: new Set(), paneIds: new Set() };
  const root = node(input.root, 0, state);
  const focusedPaneId = text(input.focusedPaneId, "Workbench focused pane", 128, ID_PATTERN);
  if (!state.paneIds.has(focusedPaneId)) throw new TypeError("Workbench focused pane is absent");
  const layout = Object.freeze({ schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION, focusedPaneId, root });
  if (new TextEncoder().encode(JSON.stringify(layout)).byteLength > MAX_WORKBENCH_LAYOUT_BYTES) throw new TypeError("Workbench layout exceeds the byte limit");
  return layout;
}

export function encodeWorkbenchLayout(value: unknown): string {
  return JSON.stringify(parseWorkbenchLayout(value));
}

export function createWorkbenchLayout(initialTab: WorkbenchTab, paneId = "pane-main"): WorkbenchLayout {
  return parseWorkbenchLayout({ schemaVersion: 1, focusedPaneId: paneId, root: { type: "pane", id: paneId, tabs: [initialTab], activeTabId: initialTab.id } });
}

function replaceNode(root: WorkbenchNode, nodeId: string, replacement: (current: WorkbenchNode) => WorkbenchNode): WorkbenchNode {
  if (root.id === nodeId) return replacement(root);
  if (root.type === "pane") return root;
  const first = replaceNode(root.first, nodeId, replacement);
  const second = replaceNode(root.second, nodeId, replacement);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

function findPane(root: WorkbenchNode, paneId: string): WorkbenchPane | null {
  if (root.type === "pane") return root.id === paneId ? root : null;
  return findPane(root.first, paneId) ?? findPane(root.second, paneId);
}

function locateTab(root: WorkbenchNode, tabId: string): Readonly<{ pane: WorkbenchPane; index: number }> | null {
  if (root.type === "pane") {
    const index = root.tabs.findIndex(candidate => candidate.id === tabId);
    return index < 0 ? null : { pane: root, index };
  }
  return locateTab(root.first, tabId) ?? locateTab(root.second, tabId);
}

function removePane(root: WorkbenchNode, paneId: string): WorkbenchNode | null {
  if (root.type === "pane") return root.id === paneId ? null : root;
  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

function firstPaneId(root: WorkbenchNode): string {
  return root.type === "pane" ? root.id : firstPaneId(root.first);
}

export function activateWorkbenchTab(layout: WorkbenchLayout, paneId: string, tabId: string): WorkbenchLayout {
  const parsed = parseWorkbenchLayout(layout);
  const pane = findPane(parsed.root, paneId);
  if (!pane || !pane.tabs.some(candidate => candidate.id === tabId)) throw new TypeError("Workbench activation target is absent");
  return parseWorkbenchLayout({ ...parsed, focusedPaneId: paneId, root: replaceNode(parsed.root, paneId, current => ({ ...(current as WorkbenchPane), activeTabId: tabId })) });
}

export function moveWorkbenchTab(layout: WorkbenchLayout, tabId: string, targetPaneId: string, targetIndex: number): WorkbenchLayout {
  const parsed = parseWorkbenchLayout(layout);
  const located = locateTab(parsed.root, tabId);
  const target = findPane(parsed.root, targetPaneId);
  if (!located || !target || !Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex > target.tabs.length) throw new TypeError("Workbench tab move is invalid");
  const moving = located.pane.tabs[located.index];
  if (located.pane.id === targetPaneId) {
    const tabs = located.pane.tabs.filter(candidate => candidate.id !== tabId);
    const adjustedIndex = located.index < targetIndex ? targetIndex - 1 : targetIndex;
    tabs.splice(Math.min(adjustedIndex, tabs.length), 0, moving);
    const root = replaceNode(parsed.root, targetPaneId, current => ({ ...(current as WorkbenchPane), tabs, activeTabId: tabId }));
    return parseWorkbenchLayout({ ...parsed, focusedPaneId: targetPaneId, root });
  }

  let root = replaceNode(parsed.root, targetPaneId, current => {
    const pane = current as WorkbenchPane;
    const tabs = [...pane.tabs];
    tabs.splice(Math.min(targetIndex, tabs.length), 0, moving);
    return { ...pane, tabs, activeTabId: tabId };
  });
  if (located.pane.tabs.length === 1) {
    root = removePane(root, located.pane.id) as WorkbenchNode;
  } else {
    root = replaceNode(root, located.pane.id, current => {
      const pane = current as WorkbenchPane;
      const tabs = pane.tabs.filter(candidate => candidate.id !== tabId);
      const activeTabId = pane.activeTabId === tabId ? tabs[Math.min(located.index, tabs.length - 1)].id : pane.activeTabId;
      return { ...pane, tabs, activeTabId };
    });
  }
  return parseWorkbenchLayout({ ...parsed, focusedPaneId: targetPaneId, root });
}

export function splitWorkbenchPane(layout: WorkbenchLayout, paneId: string, direction: "horizontal" | "vertical", newTab: WorkbenchTab, ids: Readonly<{ splitId: string; paneId: string }>, ratio = 0.5): WorkbenchLayout {
  const parsed = parseWorkbenchLayout(layout);
  if (!findPane(parsed.root, paneId) || locateTab(parsed.root, newTab.id)) throw new TypeError("Workbench split target is invalid");
  const root = replaceNode(parsed.root, paneId, current => ({
    type: "split", id: ids.splitId, direction, ratio, first: current,
    second: { type: "pane", id: ids.paneId, tabs: [newTab], activeTabId: newTab.id },
  }));
  return parseWorkbenchLayout({ ...parsed, focusedPaneId: ids.paneId, root });
}

export function closeWorkbenchTab(layout: WorkbenchLayout, tabId: string, fallback: WorkbenchTab): WorkbenchLayout {
  const parsed = parseWorkbenchLayout(layout);
  const located = locateTab(parsed.root, tabId);
  if (!located) throw new TypeError("Workbench close target is absent");
  if (located.pane.tabs.length === 1 && parsed.root.type === "split") {
    const root = removePane(parsed.root, located.pane.id);
    if (!root) throw new TypeError("Workbench pane collapse failed");
    const focusedPaneId = parsed.focusedPaneId === located.pane.id ? firstPaneId(root) : parsed.focusedPaneId;
    return parseWorkbenchLayout({ ...parsed, focusedPaneId, root });
  }
  const root = replaceNode(parsed.root, located.pane.id, current => {
    const pane = current as WorkbenchPane;
    const tabs = pane.tabs.filter(candidate => candidate.id !== tabId);
    if (tabs.length === 0) tabs.push(fallback);
    const activeTabId = pane.activeTabId === tabId ? tabs[Math.min(located.index, tabs.length - 1)].id : pane.activeTabId;
    return { ...pane, tabs, activeTabId };
  });
  return parseWorkbenchLayout({ ...parsed, root });
}

export function restoreWorkbenchTab(layout: WorkbenchLayout, paneId: string, restored: WorkbenchTab, index?: number): WorkbenchLayout {
  const parsed = parseWorkbenchLayout(layout);
  const pane = findPane(parsed.root, paneId);
  if (!pane || locateTab(parsed.root, restored.id) || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index > pane.tabs.length))) {
    throw new TypeError("Workbench tab restore is invalid");
  }
  const root = replaceNode(parsed.root, paneId, current => {
    const target = current as WorkbenchPane;
    const tabs = [...target.tabs];
    tabs.splice(index ?? tabs.length, 0, restored);
    return { ...target, tabs, activeTabId: restored.id };
  });
  return parseWorkbenchLayout({ ...parsed, focusedPaneId: paneId, root });
}

export function removeSessionWorkbenchTabs(layout: WorkbenchLayout, sessionId: string, fallback: WorkbenchTab): WorkbenchLayout {
  let current = parseWorkbenchLayout(layout);
  const targetSessionId = text(sessionId, "Workbench Session resource", 256);
  const tabIds = (function collect(nodeValue: WorkbenchNode): string[] {
    if (nodeValue.type === "pane") return nodeValue.tabs.filter(candidate => candidate.kind === "session" && candidate.sessionId === targetSessionId).map(candidate => candidate.id);
    return [...collect(nodeValue.first), ...collect(nodeValue.second)];
  })(current.root);
  for (const tabId of tabIds) current = closeWorkbenchTab(current, tabId, fallback);
  return current;
}

export function applyWorkbenchOperation(layout: WorkbenchLayout, value: unknown): WorkbenchLayout {
  const operation = object(value, "Workbench operation");
  switch (operation.type) {
    case "activate":
      exact(operation, ["type", "paneId", "tabId"], "Workbench activate operation");
      return activateWorkbenchTab(layout, text(operation.paneId, "Workbench operation pane", 128, ID_PATTERN), text(operation.tabId, "Workbench operation tab", 128, ID_PATTERN));
    case "move":
      exact(operation, ["type", "tabId", "targetPaneId", "targetIndex"], "Workbench move operation");
      return moveWorkbenchTab(layout, text(operation.tabId, "Workbench operation tab", 128, ID_PATTERN), text(operation.targetPaneId, "Workbench operation pane", 128, ID_PATTERN), operation.targetIndex as number);
    case "split":
      exact(operation, ["type", "paneId", "direction", "newTab", "splitId", "newPaneId", "ratio"], "Workbench split operation");
      if (operation.direction !== "horizontal" && operation.direction !== "vertical") throw new TypeError("Workbench split operation direction is invalid");
      return splitWorkbenchPane(
        layout,
        text(operation.paneId, "Workbench operation pane", 128, ID_PATTERN),
        operation.direction,
        tab(operation.newTab),
        {
          splitId: text(operation.splitId, "Workbench split id", 128, ID_PATTERN),
          paneId: text(operation.newPaneId, "Workbench new pane id", 128, ID_PATTERN),
        },
        operation.ratio as number,
      );
    case "close":
      exact(operation, ["type", "tabId", "fallback"], "Workbench close operation");
      return closeWorkbenchTab(layout, text(operation.tabId, "Workbench operation tab", 128, ID_PATTERN), tab(operation.fallback));
    case "restore":
      exact(operation, ["type", "paneId", "tab", "index"], "Workbench restore operation");
      return restoreWorkbenchTab(layout, text(operation.paneId, "Workbench operation pane", 128, ID_PATTERN), tab(operation.tab), operation.index as number);
    case "remove-session":
      exact(operation, ["type", "sessionId", "fallback"], "Workbench remove Session operation");
      return removeSessionWorkbenchTabs(layout, text(operation.sessionId, "Workbench Session resource", 256), tab(operation.fallback));
    default:
      throw new TypeError("Workbench operation type is invalid");
  }
}

export function parseWorkbenchDragPayload(value: unknown): WorkbenchDragPayload {
  const input = object(value, "Workbench drag payload");
  exact(input, ["schemaVersion", "tabId", "sourcePaneId"], "Workbench drag payload");
  if (input.schemaVersion !== 1) throw new TypeError("Workbench drag payload schema is unsupported");
  return Object.freeze({ schemaVersion: 1, tabId: text(input.tabId, "Workbench drag tab", 128, ID_PATTERN), sourcePaneId: text(input.sourcePaneId, "Workbench drag pane", 128, ID_PATTERN) });
}
