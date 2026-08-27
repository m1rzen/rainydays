import assert from "node:assert/strict";
import test from "node:test";
import {
  activateWorkbenchTab,
  applyWorkbenchOperation,
  closeWorkbenchTab,
  createWorkbenchLayout,
  encodeWorkbenchLayout,
  moveWorkbenchTab,
  parseWorkbenchDragPayload,
  parseWorkbenchLayout,
  restoreWorkbenchTab,
  splitWorkbenchPane,
} from "../../dist/workbench-layout.js";

const sessionTab = (id = "session-one") => ({ id: `tab-${id}`, kind: "session", title: `Session ${id}`, sessionId: id });
const terminalTab = (id = "terminal-one") => ({ id: `tab-${id}`, kind: "terminal", title: `Terminal ${id}`, sessionId: "session-one", terminalId: id });
const fileTab = (id = "file-one") => ({ id: `tab-${id}`, kind: "file", title: `File ${id}`, sessionId: "session-one", rootId: "workspace", path: `src/${id}.ts` });

function panes(node, output = []) {
  if (node.type === "pane") output.push(node);
  else { panes(node.first, output); panes(node.second, output); }
  return output;
}

test("DS-03 WorkbenchLayout validates and canonically freezes every typed tab", () => {
  const tabs = [
    sessionTab(), terminalTab(), fileTab(),
    { id: "tab-browser", kind: "browser", title: "Browser", url: "https://example.test/docs" },
    { id: "tab-prism", kind: "prism", title: "Prism", module: "erp" },
  ];
  let layout = createWorkbenchLayout(tabs[0]);
  for (let index = 1; index < tabs.length; index += 1) layout = restoreWorkbenchTab(layout, "pane-main", tabs[index]);
  assert.equal(layout.root.type, "pane");
  assert.deepEqual(layout.root.tabs.map(tab => tab.kind), ["session", "terminal", "file", "browser", "prism"]);
  assert.equal(layout.root.tabs[3].url, "https://example.test/docs");
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.root), true);
  assert.equal(Object.isFrozen(layout.root.tabs), true);
  assert.equal(Object.isFrozen(layout.root.tabs[0]), true);
  assert.deepEqual(JSON.parse(encodeWorkbenchLayout(layout)), layout);
});

test("DS-03 WorkbenchLayout supports recursive split, activation, cross-pane move and reorder", () => {
  let layout = createWorkbenchLayout(sessionTab());
  layout = restoreWorkbenchTab(layout, "pane-main", terminalTab());
  layout = splitWorkbenchPane(layout, "pane-main", "horizontal", fileTab(), { splitId: "split-root", paneId: "pane-files" }, 0.6);
  layout = splitWorkbenchPane(layout, "pane-files", "vertical", { id: "tab-browser", kind: "browser", title: "Browser", url: "https://example.test/" }, { splitId: "split-right", paneId: "pane-browser" });
  assert.equal(layout.focusedPaneId, "pane-browser");
  assert.deepEqual(panes(layout.root).map(pane => pane.id), ["pane-main", "pane-files", "pane-browser"]);

  layout = activateWorkbenchTab(layout, "pane-main", "tab-terminal-one");
  assert.equal(layout.focusedPaneId, "pane-main");
  layout = moveWorkbenchTab(layout, "tab-terminal-one", "pane-files", 1);
  assert.deepEqual(panes(layout.root).find(pane => pane.id === "pane-files").tabs.map(tab => tab.id), ["tab-file-one", "tab-terminal-one"]);
  assert.equal(panes(layout.root).find(pane => pane.id === "pane-files").activeTabId, "tab-terminal-one");
  layout = moveWorkbenchTab(layout, "tab-terminal-one", "pane-files", 0);
  assert.deepEqual(panes(layout.root).find(pane => pane.id === "pane-files").tabs.map(tab => tab.id), ["tab-terminal-one", "tab-file-one"]);
});

test("DS-03 WorkbenchLayout close never leaves an empty pane and restore is bounded", () => {
  let layout = createWorkbenchLayout(sessionTab());
  layout = restoreWorkbenchTab(layout, "pane-main", terminalTab());
  layout = closeWorkbenchTab(layout, "tab-terminal-one", sessionTab("fallback"));
  assert.deepEqual(layout.root.tabs.map(tab => tab.id), ["tab-session-one"]);
  layout = closeWorkbenchTab(layout, "tab-session-one", sessionTab("fallback"));
  assert.deepEqual(layout.root.tabs.map(tab => tab.id), ["tab-fallback"]);
  layout = restoreWorkbenchTab(layout, "pane-main", fileTab(), 0);
  assert.deepEqual(layout.root.tabs.map(tab => tab.id), ["tab-file-one", "tab-fallback"]);
  assert.equal(layout.root.activeTabId, "tab-file-one");
  assert.throws(() => restoreWorkbenchTab(layout, "pane-main", fileTab()), /restore is invalid/iu);

  const split = splitWorkbenchPane(createWorkbenchLayout(sessionTab()), "pane-main", "vertical", fileTab(), { splitId: "split-close", paneId: "pane-close" });
  const collapsed = closeWorkbenchTab(split, "tab-file-one", sessionTab("unused"));
  assert.equal(collapsed.root.type, "pane");
  assert.equal(collapsed.root.id, "pane-main");
  assert.equal(collapsed.focusedPaneId, "pane-main");
});

test("DS-03 WorkbenchLayout rejects ambiguous identities and hostile resources while collapsing empty panes", () => {
  const base = createWorkbenchLayout(sessionTab());
  for (const invalid of [
    { ...base, extra: true },
    { ...base, focusedPaneId: "pane-absent" },
    { ...base, root: { ...base.root, activeTabId: "tab-absent" } },
    { ...base, root: { ...base.root, tabs: [sessionTab(), sessionTab()] } },
    { ...base, root: { ...base.root, tabs: [{ id: "tab-file", kind: "file", title: "File", sessionId: "session-one", rootId: "workspace", path: "../secret" }], activeTabId: "tab-file" } },
    { ...base, root: { ...base.root, tabs: [{ id: "tab-browser", kind: "browser", title: "Browser", url: "file:///secret" }], activeTabId: "tab-browser" } },
    { ...base, root: { ...base.root, tabs: [{ id: "tab-browser", kind: "browser", title: "Browser", url: "https://user:pass@example.test/" }], activeTabId: "tab-browser" } },
  ]) assert.throws(() => parseWorkbenchLayout(invalid), TypeError);

  const split = splitWorkbenchPane(base, "pane-main", "horizontal", fileTab(), { splitId: "split-root", paneId: "pane-files" });
  const moved = moveWorkbenchTab(split, "tab-session-one", "pane-files", 0);
  assert.equal(moved.root.type, "pane");
  assert.equal(moved.root.id, "pane-files");
  assert.deepEqual(moved.root.tabs.map(tab => tab.id), ["tab-session-one", "tab-file-one"]);
  assert.throws(() => splitWorkbenchPane(moved, "pane-files", "horizontal", sessionTab(), { splitId: "split-duplicate", paneId: "pane-more" }), /split target is invalid/iu);
});

test("DS-03 WorkbenchLayout enforces pane, tab, depth and encoded-size limits", () => {
  let layout = createWorkbenchLayout(sessionTab());
  for (let index = 0; index < 8; index += 1) {
    layout = splitWorkbenchPane(layout, index === 0 ? "pane-main" : `pane-${index}`, "horizontal", fileTab(`file-${index}`), {
      splitId: `split-${index}`,
      paneId: `pane-${index + 1}`,
    });
  }
  assert.throws(() => splitWorkbenchPane(layout, "pane-8", "horizontal", fileTab("too-deep"), { splitId: "split-too-deep", paneId: "pane-too-deep" }), /depth exceeds/iu);

  let manyTabs = createWorkbenchLayout(sessionTab());
  for (let index = 0; index < 63; index += 1) manyTabs = restoreWorkbenchTab(manyTabs, "pane-main", fileTab(`many-${index}`));
  assert.equal(manyTabs.root.tabs.length, 64);
  assert.throws(() => restoreWorkbenchTab(manyTabs, "pane-main", fileTab("overflow")), /tab count exceeds/iu);

  const huge = createWorkbenchLayout({ id: "tab-huge", kind: "session", title: "x", sessionId: "s".repeat(256) });
  const raw = JSON.parse(JSON.stringify(huge));
  raw.root.tabs[0].title = "x".repeat(200);
  for (let index = 0; index < 63; index += 1) raw.root.tabs.push({ id: `tab-huge-${index}`, kind: "file", title: "x".repeat(200), sessionId: "session-one", rootId: "workspace", path: `p/${"x".repeat(900)}-${index}` });
  assert.throws(() => parseWorkbenchLayout(raw), /byte limit/iu);
});

test("DS-03 server operation reducer is pure and rejects unknown operation fields", () => {
  const base = createWorkbenchLayout(sessionTab());
  const before = JSON.stringify(base);
  const split = applyWorkbenchOperation(base, {
    type: "split", paneId: "pane-main", direction: "horizontal", newTab: fileTab(),
    splitId: "split-operation", newPaneId: "pane-operation", ratio: 0.5,
  });
  assert.equal(JSON.stringify(base), before);
  const moved = applyWorkbenchOperation(split, { type: "move", tabId: "tab-session-one", targetPaneId: "pane-operation", targetIndex: 1 });
  assert.equal(moved.root.type, "pane");
  assert.deepEqual(moved.root.tabs.map(tab => tab.kind), ["file", "session"]);
  assert.throws(() => applyWorkbenchOperation(base, { type: "activate", paneId: "pane-main", tabId: "tab-session-one", admin: true }), /fields are invalid/iu);
});

test("DS-03 canonical encoding ignores input key order and normalizes URLs", () => {
  const ordered = createWorkbenchLayout({ id: "tab-browser", kind: "browser", title: "Docs", url: "https://example.test/docs" });
  const shuffled = {
    root: { activeTabId: "tab-browser", tabs: [{ url: "https://example.test/docs", title: "Docs", kind: "browser", id: "tab-browser" }], id: "pane-main", type: "pane" },
    focusedPaneId: "pane-main",
    schemaVersion: 1,
  };
  assert.equal(encodeWorkbenchLayout(shuffled), encodeWorkbenchLayout(ordered));
  assert.throws(() => parseWorkbenchLayout({ ...ordered, root: { ...ordered.root, tabs: [{ id: "tab-control", kind: "session", title: "bad\nlabel", sessionId: "session-one" }], activeTabId: "tab-control" } }), /title is invalid/iu);
});

test("DS-03 drag payload is exact, versioned and untrusted", () => {
  assert.deepEqual(parseWorkbenchDragPayload({ schemaVersion: 1, tabId: "tab-one", sourcePaneId: "pane-main" }), {
    schemaVersion: 1, tabId: "tab-one", sourcePaneId: "pane-main",
  });
  for (const payload of [
    { schemaVersion: 2, tabId: "tab-one", sourcePaneId: "pane-main" },
    { schemaVersion: 1, tabId: "../tab", sourcePaneId: "pane-main" },
    { schemaVersion: 1, tabId: "tab-one", sourcePaneId: "pane-main", targetPaneId: "pane-admin" },
    Object.assign(Object.create({ inherited: true }), { schemaVersion: 1, tabId: "tab-one", sourcePaneId: "pane-main" }),
  ]) assert.throws(() => parseWorkbenchDragPayload(payload), TypeError);
});
