import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-lux-cloud-parity-"));
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)),
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks"),
});

const { closeDb, insertSession, insertMessage } = await import("../../src/db.ts");
const { saveToolResultBlock } = await import("../../src/lux-cloud-runtime.ts");
const {
  pinExec,
  unpinExec,
  contextUsageExec,
  toolResultReadExec,
  canvasHistoryOverviewExec,
  canvasHistorySearchExec,
  canvasHistoryInspectExec,
  promptInspectExec,
  mapViewExec,
  mapSearchExec,
  mapUpdateExec,
  knowledgeUpdateExec,
  consolidateMemoryExec,
  skillSearchExec,
  skillLoadExec,
  skillReloadExec,
  skillReleaseExec,
  skillStatusExec,
  skillManageExec,
  thinkingEffortGetExec,
  thinkingEffortSetExec,
  mainAgentInspectExec,
  sessionFoldersExec,
  cronScheduleOnIdleExec,
  workerPairingClaimExec,
  workerFileUploadExec,
  workerFileDownloadExec,
  previewWebExec,
  previewListExec,
  previewCloseExec,
} = await import("../../src/tools/lux-cloud-tools.ts");
const { inspectExec, graphExec } = await import("../../src/tools/knowledge-tools.ts");
const { recallExec } = await import("../../src/tools/memory-tools.ts");
const { computerUseExec } = await import("../../src/tools/worker-tools.ts");
const { workerRegistry } = await import("../../src/worker.ts");
const {
  resolveProviderReasoningEffort,
  renderSessionLuxCloudContextBlocks,
} = await import("../../src/lux-cloud-runtime.ts");

test.after(async () => {
  await workerRegistry.dispose();
  closeDb();
  await rm(fixture, { recursive: true, force: true });
});

const sessionEnv = { _SESSION_ID: "session-lc-test-01" };
const nowIso = new Date().toISOString();
insertSession({
  id: sessionEnv._SESSION_ID,
  persona_name: "general",
  title: "Lux-Cloud Parity Verification Session",
  created_at: nowIso,
  updated_at: nowIso,
});
insertMessage({
  session_id: sessionEnv._SESSION_ID,
  role: "user",
  content: "Verify cold/hot canvas history and Agent Map CAS.",
  tool_calls: null,
  tool_call_id: null,
  created_at: nowIso,
});
insertMessage({
  session_id: sessionEnv._SESSION_ID,
  role: "assistant",
  content: "Canvas history message with keyword ALPHA_OMEGA_42 for cold search.",
  tool_calls: null,
  tool_call_id: null,
  created_at: nowIso,
});

test("LC-01: Pin/Unpin, Cold/Hot Canvas Store, Oversized Tool Result Paging & Three-Role Prompt Compiler", async () => {
  const p1 = JSON.parse(await pinExec({ content: "Never modify personas/general.md" }, sessionEnv));
  assert.equal(p1.status, "pinned");
  assert.equal(p1.totalPins, 1);

  const p2 = JSON.parse(await pinExec({ content: "Use edit for existing files" }, sessionEnv));
  assert.equal(p2.totalPins, 2);

  const listed = JSON.parse(await unpinExec({}, sessionEnv));
  assert.equal(listed.action, "list");
  assert.equal(listed.totalPins, 2);

  const removed1 = JSON.parse(await unpinExec({ index: 1 }, sessionEnv));
  assert.equal(removed1.action, "unpin");
  assert.equal(removed1.remainingPins.length, 1);

  const removedAll = JSON.parse(await unpinExec({ all: true }, sessionEnv));
  assert.equal(removedAll.action, "unpin_all");
  assert.equal(removedAll.remainingPins, 0);

  // Oversized tool result paging
  const longText = "0123456789".repeat(250);
  const blockId = saveToolResultBlock(sessionEnv._SESSION_ID, "bash", longText, "blk-oversized-1");
  const page1 = JSON.parse(await toolResultReadExec({ blockId, offset: 0, maxChars: 1000 }, sessionEnv));
  assert.equal(page1.total_chars, 2500);
  assert.equal(page1.has_more, true);
  assert.equal(page1.next_offset, 1000);
  assert.equal(page1.content.length, 1000);

  // Compact context & Cold Canvas history
  const usage = JSON.parse(await contextUsageExec({}, sessionEnv));
  assert.equal(usage.sessionId, sessionEnv._SESSION_ID);
  assert(usage.prepareWatermarkTokens < usage.replaceWatermarkTokens);

  const { getMessagesBySession } = await import("../../src/db.ts");
  const { archiveMessagesToColdStore } = await import("../../src/lux-cloud-runtime.ts");
  assert(archiveMessagesToColdStore(sessionEnv._SESSION_ID, getMessagesBySession(sessionEnv._SESSION_ID), "continuity") >= 2);

  const overview = JSON.parse(await canvasHistoryOverviewExec({ after: 0, limit: 10 }, sessionEnv));
  assert(overview.blocks.length >= 2);

  const search = JSON.parse(await canvasHistorySearchExec({ query: "ALPHA_OMEGA_42" }, sessionEnv));
  assert.equal(search.matches.length, 1);

  const inspected = JSON.parse(
    await canvasHistoryInspectExec({ blockId: search.matches[0].blockId, offset: 0, maxChars: 50 }, sessionEnv),
  );
  assert.match(inspected.content, /Canvas history message/);

  // Prompt inspect for main / scribe / muse
  for (const role of ["main", "scribe", "muse"]) {
    const promptInfo = JSON.parse(await promptInspectExec({ role }, sessionEnv));
    assert.equal(promptInfo.role, role);
    assert.match(promptInfo.frozenPrefixSha256, /^[a-f0-9]{64}$/);
    assert.match(promptInfo.compiledPrompt, /<agent_map>/);
  }
});

test("LC-02: Session Agent Map Single-Root Exploration Tree, Batch $ref & Atomic CAS", async () => {
  const created = JSON.parse(
    await mapUpdateExec(
      {
        expectedMapId: null,
        operations: [
          { op: "add_node", ref: "root", title: "Mini-Lux Evolution", summary: "Root exploration node" },
          { op: "add_node", ref: "child1", parentId: "$root", title: "LC-02 Agent Map", summary: "CAS tree implementation" },
          { op: "focus_node", nodeId: "$child1" },
          {
            op: "create_note",
            ref: "note1",
            nodeId: "$child1",
            kind: "decision",
            scope: "project",
            content: "Agent Map uses expectedMapId and expectedLastActionSeq CAS.",
          },
        ],
      },
      sessionEnv,
    ),
  );
  assert(created.mapId);
  assert.equal(created.mapVersion, 1);
  assert.equal(created.nodeCount, 2);

  const view = JSON.parse(await mapViewExec({ includeNotes: true }, sessionEnv));
  assert.equal(view.mapId, created.mapId);
  assert.equal(view.nodes[0].title, "LC-02 Agent Map");
  assert.equal(view.nodes[0].notes.length, 1);

  const searchRes = JSON.parse(await mapSearchExec({ query: "expectedLastActionSeq" }, sessionEnv));
  assert.equal(searchRes.totalMatches, 1);

  // Verify CAS conflict rolls back atomically
  await assert.rejects(
    () =>
      mapUpdateExec(
        {
          expectedMapId: "wrong-map-id",
          operations: [{ op: "clear_focus" }],
        },
        sessionEnv,
      ),
    /CAS expectedMapId mismatch/,
  );

  await assert.rejects(
    () =>
      mapUpdateExec(
        {
          expectedMapId: created.mapId,
          operations: [
            {
              op: "update_node",
              nodeId: created.focusedNodeId,
              expectedLastActionSeq: 99999,
              summary: "Should fail CAS",
            },
          ],
        },
        sessionEnv,
      ),
    /CAS expectedLastActionSeq mismatch/,
  );
});

test("LC-03: Triplet Knowledge Graph (n_, e_, t_) with expectedRevision CAS & inspect/graph", async () => {
  const n1 = JSON.parse(
    await knowledgeUpdateExec({ op: "create", type: "node", name: "LuxCloudCore", kind: "component", tags: ["core"] }),
  );
  const n2 = JSON.parse(
    await knowledgeUpdateExec({ op: "create", type: "node", name: "ScribeCartographer", kind: "peer", tags: ["map"] }),
  );
  assert.match(n1.entry.id, /^n_/);
  assert.match(n2.entry.id, /^n_/);

  const edge = JSON.parse(
    await knowledgeUpdateExec({
      op: "create",
      type: "edge",
      from: n1.entry.id,
      to: n2.entry.id,
      relation: "orchestrates",
    }),
  );
  assert.match(edge.entry.id, /^e_/);

  const updatedNode = JSON.parse(
    await knowledgeUpdateExec({
      op: "update",
      type: "node",
      id: n1.entry.id,
      expectedRevision: 1,
      kind: "core-service",
    }),
  );
  assert.equal(updatedNode.entry.revision, 2);

  await assert.rejects(
    () =>
      knowledgeUpdateExec({
        op: "update",
        type: "node",
        id: n1.entry.id,
        expectedRevision: 1,
        kind: "stale-update",
      }),
    /CAS revision mismatch/,
  );

  const inspectedNode = JSON.parse(await inspectExec({ id: n1.entry.id }));
  assert.equal(inspectedNode.name, "LuxCloudCore");

  const subgraph = JSON.parse(await graphExec({ id: n1.entry.id, depth: 1 }));
  assert.equal(subgraph.nodes.length, 2);
  assert.equal(subgraph.edges.length, 1);

  const recalledNodes = JSON.parse(await recallExec({ query: "LuxCloudCore", type: "node" }));
  assert.equal(recalledNodes.results.length, 1);

  const consolidated = JSON.parse(await consolidateMemoryExec({ level: "shallow", hint: "test-consolidation" }));
  assert.equal(consolidated.status, "consolidated");
});

test("LC-04: Store-Backed Zero-Preload Skills with ETag CAS, Section Loading & Deduplication", async () => {
  const skillMd = [
    "# Lux Architecture Skill",
    "Core architectural guide for Lux-Cloud.",
    "## Watermark Protocol",
    "50% prepare watermark triggers background Scribe; 90% replace watermark swaps hot window.",
    "## Prefix Cache Rules",
    "Freeze system prompt prefix and snap <env> date to hour.",
  ].join("\n");

  const created = JSON.parse(
    await skillManageExec({
      action: "create",
      id: "lux-arch",
      content: skillMd,
    }),
  );
  assert.equal(created.id, "lux-arch");
  assert(created.etag);

  const searched = JSON.parse(await skillSearchExec({ query: "Watermark" }));
  assert.equal(searched.total, 1);
  assert.deepEqual(searched.skills[0].sections, ["Lux Architecture Skill", "Watermark Protocol", "Prefix Cache Rules"]);

  const loaded1 = JSON.parse(await skillLoadExec({ id: "lux-arch", sections: ["Watermark Protocol"] }, sessionEnv));
  assert.equal(loaded1.deduplicated, false);
  assert.match(loaded1.content, /50% prepare watermark/);

  const loaded2 = JSON.parse(await skillLoadExec({ id: "lux-arch", sections: ["Watermark Protocol"] }, sessionEnv));
  assert.equal(loaded2.deduplicated, true);

  const reloaded = JSON.parse(await skillReloadExec({ id: "lux-arch", sections: ["Watermark Protocol"] }, sessionEnv));
  assert.equal(reloaded.deduplicated, false);

  const status = JSON.parse(await skillStatusExec({}, sessionEnv));
  assert.equal(status.receipts.length, 1);
  assert.equal(status.receipts[0].valid, true);

  // ETag CAS mismatch on update
  await assert.rejects(
    () =>
      skillManageExec({
        action: "update",
        id: "lux-arch",
        etag: 'W/"stale"',
        content: "# Updated",
      }),
    /Skill ETag mismatch/,
  );

  const released = JSON.parse(await skillReleaseExec({ id: "lux-arch" }, sessionEnv));
  assert.equal(released.released, true);
});

test("LC-05: Subagent Sessions, Thinking Effort, Session Folders CAS & Worker/Preview Plane", async () => {
  const effort0 = JSON.parse(await thinkingEffortGetExec({}, sessionEnv));
  assert(effort0.availableEfforts.includes("xhigh"));
  const effort1 = JSON.parse(await thinkingEffortSetExec({ effort: "xhigh" }, sessionEnv));
  assert.equal(effort1.currentEffort, "xhigh");

  // Session folders preview -> apply -> undo
  const folderPreview = JSON.parse(
    await sessionFoldersExec({
      action: "preview",
      expected_revision: 1,
      request_id: "req-fld-1",
      operations: [{ op: "create", id: "fld_core", name: "Core Architecture" }],
    }),
  );
  assert(folderPreview.plan_id);

  const folderApply = JSON.parse(
    await sessionFoldersExec({
      action: "apply",
      plan_id: folderPreview.plan_id,
      request_id: "req-fld-2",
      dry_run: false,
    }),
  );
  assert.equal(folderApply.committed, true);
  assert.equal(folderApply.revision, 2);

  const folderUndo = JSON.parse(await sessionFoldersExec({ action: "undo", undo_id: folderApply.undo_id }));
  assert.equal(folderUndo.restored, true);

  // Idle cron, Worker transfer & Web preview
  const idleCron = JSON.parse(
    await cronScheduleOnIdleExec({ delay: "30m", message: "Check build", tag: "ci-check" }, sessionEnv),
  );
  assert.equal(idleCron.delivery_mode, "on_idle");

  await assert.rejects(workerPairingClaimExec({ code: "ABC" }), /单机版/u);
  await assert.rejects(workerFileUploadExec({ file_path: "/workspace/report.md" }), /单机版/u);
  await assert.rejects(workerFileDownloadExec({ file_id: "x", output_path: "/workspace/out.md" }), /单机版/u);

  const closedPort = await new Promise(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const preview = JSON.parse(await previewWebExec({ ports: [closedPort], ttl_seconds: 600 }));
  assert.equal(preview.target_ready, false);
  assert.equal(preview.local_only, true);
  assert.equal(preview.targets[0].tunnel_connected, false);
  const previewListed = JSON.parse(await previewListExec({}));
  assert.equal(previewListed.previews.length, 1);
  const previewClosed = JSON.parse(await previewCloseExec({ id: preview.id }));
  assert.equal(previewClosed.closed, true);
});

test("LC-06: Main Loop Deep Wiring (50% Scribe Watermark, Reasoning Effort, Prompt Blocks) & OS-Level Desktop Computer Use", async () => {
  // 1. Reasoning effort provider mapping
  await thinkingEffortSetExec({ effort: "xhigh" }, sessionEnv);
  assert.equal(resolveProviderReasoningEffort(sessionEnv._SESSION_ID), "high");
  await thinkingEffortSetExec({ effort: "minimal" }, sessionEnv);
  assert.equal(resolveProviderReasoningEffort(sessionEnv._SESSION_ID), "low");

  // 2. A real compaction summary reaches the Agent Map and prompt context blocks
  const { recordCompactionCheckpoint } = await import("../../src/lux-cloud-runtime.ts");
  const checkpoint = recordCompactionCheckpoint(sessionEnv._SESSION_ID, "Model summary: cold store audit finished.");
  assert(checkpoint.mapId);

  const renderedBlocks = renderSessionLuxCloudContextBlocks(sessionEnv._SESSION_ID).join("\n\n");
  assert.match(renderedBlocks, /<agent_map>/);
  assert.match(renderedBlocks, /<coverage>/);

  // 3. Real OS-level Desktop GUI Computer Use (screen_info, window_list, screenshot, clipboard)
  const invocation = { capabilityContext: { sessionId: sessionEnv._SESSION_ID } };
  const screenInfo = JSON.parse(await computerUseExec({ action: "screen_info" }, sessionEnv, invocation));
  assert.equal(screenInfo.action, "screen_info");
  assert(Array.isArray(screenInfo.screens) && screenInfo.screens.length >= 1);
  assert(screenInfo.screens[0].width > 0 && screenInfo.screens[0].height > 0);

  const windowList = JSON.parse(await computerUseExec({ action: "window_list" }, sessionEnv, invocation));
  assert.equal(windowList.action, "window_list");
  assert(Array.isArray(windowList.windows));

  const screenshotPath = path.join(fixture, "desktop-capture.png");
  const shot = JSON.parse(
    await computerUseExec(
      { action: "screenshot", x: 0, y: 0, width: 320, height: 180, output_path: screenshotPath },
      sessionEnv,
      invocation,
    ),
  );
  assert.equal(shot.action, "screenshot");
  assert.equal(shot.width, 320);
  assert.equal(shot.height, 180);
  assert(shot.bytes > 100);
});
