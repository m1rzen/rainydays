import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitFor } from "../helpers.mjs";

const moduleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-ds06-module-"));
process.env.RAINYDAYS_USER_DATA_DIR = moduleRoot;
process.env.RAINYDAYS_DATA_DIR = path.join(moduleRoot, "data");
const [
  { capabilityBroker },
  { FileEditConflictError, FileViewerService },
  { pathPolicy },
  { issueResourceOwner, retireResourceOwner },
  { closeDb },
] = await Promise.all([
  import("../../dist/tools/index.js"),
  import("../../dist/file-viewer.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/resource-owner.js"),
  import("../../dist/db.js"),
]);

const permissions = Object.freeze([
  "read-file", "read-directory", "search-tree", "create-file", "replace-file",
  "create-directory", "watch-directory", "initial-cwd", "reveal",
]);
const audit = Object.freeze({ sessionId: "ds06-session", runId: "ds06-integration", principal: "local-user-api" });

test.after(async () => {
  closeDb();
  await fs.rm(moduleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-ds06-"));
  const workspace = path.join(base, "workspace");
  await fs.mkdir(workspace);
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { base, workspace };
}

async function bindViewer(workspace) {
  const authorityPath = await pathPolicy.createAuthority([
    { rootId: "workspace", role: "workspace", configuredPath: workspace, permissions },
  ]);
  const authority = capabilityBroker.createRuntimeAuthority({
    name: "ds06-file-tab",
    tools: [],
    env: { WORKSPACE_ROOT: workspace },
    systemPrompt: "DS-06 File Tab integration",
    allowedRoots: [workspace],
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: authorityPath,
    networkPolicy: { mode: "deny" },
  });
  const owner = issueResourceOwner({
    authorityId: authority.authorityId,
    authorityEpoch: 1,
    sessionId: "ds06-session",
    principal: "local-user-api",
    rootIds: ["workspace"],
  });
  const viewer = new FileViewerService();
  viewer.bindAuthority(authority, authorityPath, [
    { id: "workspace", name: "Workspace", configuredPath: workspace, available: true },
  ]);
  return { authority, owner, viewer };
}

test("DS-06 text editing is revision-CAS bound and external changes are watched", async t => {
  const { workspace } = await fixture(t);
  const notePath = path.join(workspace, "note.md");
  await fs.writeFile(notePath, "# Original\n");
  const { authority, owner, viewer } = await bindViewer(workspace);
  t.after(async () => {
    await retireResourceOwner(owner).catch(() => undefined);
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
  });

  const original = await viewer.preview(authority, audit, owner, "workspace", "note.md", 1, 500);
  assert.equal(original.kind, "markdown");
  assert.equal(original.editable, true);
  assert.equal(original.fullText, "# Original\n");
  assert.match(original.revision, /^[a-f0-9]{64}$/u);

  const events = [];
  const watch = await viewer.watch(authority, audit, owner, "workspace", "note.md", event => events.push(event));
  await fs.writeFile(notePath, "# External\n");
  await waitFor(() => events.some(event => event.type === "file_changed"), { timeoutMs: 5000, label: "DS-06 external file event" });

  await assert.rejects(
    () => viewer.saveText(authority, audit, owner, "workspace", "note.md", original.revision, "# Editor\n", "utf-8"),
    error => error instanceof FileEditConflictError && /^[a-f0-9]{64}$/u.test(error.currentRevision || ""),
  );
  assert.equal(await fs.readFile(notePath, "utf8"), "# External\n");

  const current = await viewer.preview(authority, audit, owner, "workspace", "note.md", 1, 500);
  const saved = await viewer.saveText(authority, audit, owner, "workspace", "note.md", current.revision, "# Saved\n", "utf-8");
  assert.match(saved.revision, /^[a-f0-9]{64}$/u);
  assert.equal(await fs.readFile(notePath, "utf8"), "# Saved\n");
  await watch.close();
});

test("DS-06 previews HTML safely as data and streams audio/video through retained ranges", async t => {
  const { workspace } = await fixture(t);
  const html = "<h1>Preview</h1><script>globalThis.pwned=true</script>";
  const audio = Buffer.from("ID3-DS06-AUDIO-CONTENT");
  const video = Buffer.from("DS06-VIDEO-CONTENT");
  await Promise.all([
    fs.writeFile(path.join(workspace, "preview.html"), html),
    fs.writeFile(path.join(workspace, "sample.mp3"), audio),
    fs.writeFile(path.join(workspace, "sample.mp4"), video),
  ]);
  const { authority, owner, viewer } = await bindViewer(workspace);
  t.after(async () => {
    await retireResourceOwner(owner).catch(() => undefined);
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
  });

  const htmlPreview = await viewer.preview(authority, audit, owner, "workspace", "preview.html");
  assert.equal(htmlPreview.kind, "html");
  assert.equal(htmlPreview.html, html);
  assert.equal(htmlPreview.editable, true);
  const audioPreview = await viewer.preview(authority, audit, owner, "workspace", "sample.mp3");
  const videoPreview = await viewer.preview(authority, audit, owner, "workspace", "sample.mp4");
  assert.deepEqual({ kind: audioPreview.kind, mime: audioPreview.mime }, { kind: "audio", mime: "audio/mpeg" });
  assert.deepEqual({ kind: videoPreview.kind, mime: videoPreview.mime }, { kind: "video", mime: "video/mp4" });

  const lease = await viewer.content(authority, audit, owner, "workspace", "sample.mp3");
  try {
    assert.equal(lease.mime, "audio/mpeg");
    assert.equal((await lease.readRange(4, 7)).toString("utf8"), "DS06");
  } finally {
    await lease.close();
  }
});

test("DS-06 large text stays paged and cannot enter the editor", async t => {
  const { workspace } = await fixture(t);
  const large = `${"0123456789abcdef".repeat(70_000)}\nlast`;
  await fs.writeFile(path.join(workspace, "large.txt"), large);
  const { authority, owner, viewer } = await bindViewer(workspace);
  t.after(async () => {
    await retireResourceOwner(owner).catch(() => undefined);
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
  });
  const preview = await viewer.preview(authority, audit, owner, "workspace", "large.txt", 1, 1);
  assert.equal(preview.kind, "text");
  assert.equal(preview.editable, false);
  assert.equal(preview.fullText, null);
  assert.equal(preview.lineOffset, 1);
  assert.equal(preview.lineEnd, 1);
  assert.equal(preview.hasMore, true);
});
