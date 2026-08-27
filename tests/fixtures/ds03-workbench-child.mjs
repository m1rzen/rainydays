import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [mode, fixture] = process.argv.slice(2);
assert(["write", "read"].includes(mode));
assert(path.isAbsolute(fixture));
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
await fs.mkdir(path.join(fixture, "data"), { recursive: true });

const db = await import("../../dist/db.js");
const layoutModel = await import("../../dist/workbench-layout.js");
try {
  assert.equal(db.getDatabaseSchemaVersion(), 11);
  if (mode === "write") {
    assert.equal(db.getWorkbenchLayoutSnapshot(), null);
    const firstLayout = layoutModel.createWorkbenchLayout({ id: "tab-session", kind: "session", title: "Session", sessionId: "session-one" });
    const first = db.saveWorkbenchLayoutSnapshot(layoutModel.encodeWorkbenchLayout(firstLayout), 0);
    assert.equal(first.revision, 1);
    const secondLayout = layoutModel.restoreWorkbenchTab(firstLayout, "pane-main", {
      id: "tab-file", kind: "file", title: "File", sessionId: "session-one", rootId: "workspace", path: "src/index.ts",
    });
    const second = db.saveWorkbenchLayoutSnapshot(layoutModel.encodeWorkbenchLayout(secondLayout), 1);
    assert.equal(second.revision, 2);
    assert.throws(() => db.saveWorkbenchLayoutSnapshot(layoutModel.encodeWorkbenchLayout(firstLayout), 1), error => {
      assert.equal(error?.code, "WORKBENCH_LAYOUT_CONFLICT");
      assert.equal(error?.currentRevision, 2);
      return true;
    });
    assert.throws(() => db.saveWorkbenchLayoutSnapshot("{", 2));
    assert.throws(() => db.saveWorkbenchLayoutSnapshot("{}", 2));
    assert.equal(db.getWorkbenchLayoutSnapshot()?.revision, 2);
    console.log(JSON.stringify({ mode, schemaVersion: 11, revision: 2, tabs: secondLayout.root.tabs.length }));
  } else {
    const snapshot = db.getWorkbenchLayoutSnapshot();
    assert.equal(snapshot?.revision, 2);
    const layout = layoutModel.parseWorkbenchLayout(JSON.parse(snapshot.layoutJson));
    assert.equal(layout.root.type, "pane");
    assert.deepEqual(layout.root.tabs.map(tab => tab.kind), ["session", "file"]);
    console.log(JSON.stringify({ mode, schemaVersion: 11, revision: snapshot.revision, tabs: layout.root.tabs.length }));
  }
} finally {
  await db.closeDb();
}
