// ===========================================
// Lux-Cloud Runtime State & Engines (LC-01 .. LC-05)
// 1. Session Agent Map (single-root exploration tree + 11 CAS ops + $ref)
// 2. Triplet Knowledge Graph (Node n_, Edge e_, Note t_ + expectedRevision CAS)
// 3. Cold/Hot Canvas Store & Oversized Tool Result Paging (tool_result_read, canvas_history_*)
// 4. Store-Backed Zero-Preload Skills (skill_search/load/reload/release/status/manage + ETag CAS)
// 5. Three-Role Prompt Compiler (main | scribe | muse) & Thinking Effort / Session Folders
// ===========================================

import { createHash, randomUUID } from "node:crypto";
import {
  upsertEntity,
  getEntityByName,
  getMessagesBySession,
  getPinsBySession,
  insertPin,
  deletePin,
  listSessions,
  getRecentMemories,
  insertMemory,
} from "./db.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

function loadJsonRecord<T>(key: string, kind: string, fallback: () => T): T {
  const row = getEntityByName(key);
  if (!row || !row.props) return fallback();
  try {
    return JSON.parse(row.props) as T;
  } catch {
    return fallback();
  }
}

function saveJsonRecord<T>(key: string, kind: string, value: T): void {
  upsertEntity(key, kind, value as unknown as Record<string, unknown>);
}

// ===========================================
// 1. Triplet Knowledge Graph (n_, e_, t_) with expectedRevision CAS
// ===========================================

export interface KnowledgeNodeRecord {
  id: string; // n_<16hex>
  scope: "project" | "global";
  name: string;
  kind: string;
  tags: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeEdgeRecord {
  id: string; // e_<16hex>
  scope: "project" | "global";
  from: string;
  to: string;
  relation: string;
  tags: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeNoteRecord {
  id: string; // t_<32hex>
  scope: "project" | "global";
  kind: string;
  content: string;
  tags: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface KnowledgeGraphStoreState {
  nodes: Record<string, KnowledgeNodeRecord>;
  edges: Record<string, KnowledgeEdgeRecord>;
  notes: Record<string, KnowledgeNoteRecord>;
}

const KG_STORE_KEY = "__lux_cloud_knowledge_graph__:v1";
const KG_STORE_KIND = "__lux_knowledge_graph__";

function loadKnowledgeGraphState(): KnowledgeGraphStoreState {
  return loadJsonRecord<KnowledgeGraphStoreState>(KG_STORE_KEY, KG_STORE_KIND, () => ({
    nodes: {},
    edges: {},
    notes: {},
  }));
}

function saveKnowledgeGraphState(state: KnowledgeGraphStoreState): void {
  saveJsonRecord(KG_STORE_KEY, KG_STORE_KIND, state);
}

export function createOrUpdateKnowledge(input: {
  op?: "create" | "update";
  type?: "node" | "edge" | "note";
  scope?: "project" | "global";
  id?: string;
  expectedRevision?: number;
  name?: string;
  kind?: string;
  from?: string;
  to?: string;
  relation?: string;
  content?: string;
  tags?: string[];
}): Record<string, unknown> {
  const op = input.op ?? (input.id ? "update" : "create");
  const type = input.type ?? (input.relation || input.from || input.to ? "edge" : input.name ? "node" : "note");
  const scope = input.scope ?? "project";
  const now = Date.now();
  const state = loadKnowledgeGraphState();

  if (op === "create") {
    if (type === "node") {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("knowledge_update create node requires non-empty name");
      const id = `n_${sha256Hex(`${name}:${now}:${randomUUID()}`).slice(0, 16)}`;
      const record: KnowledgeNodeRecord = {
        id,
        scope,
        name,
        kind: input.kind ?? "entity",
        tags: Array.isArray(input.tags) ? [...input.tags] : [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.nodes[id] = record;
      saveKnowledgeGraphState(state);
      return { status: "created", type: "node", entry: record };
    }
    if (type === "edge") {
      const from = (input.from ?? "").trim();
      const to = (input.to ?? "").trim();
      const relation = (input.relation ?? "").trim();
      if (!from || !to || !relation) throw new Error("knowledge_update create edge requires from, to, and relation");
      const id = `e_${sha256Hex(`${from}->${to}:${relation}:${now}:${randomUUID()}`).slice(0, 16)}`;
      const record: KnowledgeEdgeRecord = {
        id,
        scope,
        from,
        to,
        relation,
        tags: Array.isArray(input.tags) ? [...input.tags] : [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.edges[id] = record;
      saveKnowledgeGraphState(state);
      return { status: "created", type: "edge", entry: record };
    }
    const content = (input.content ?? "").trim();
    if (!content) throw new Error("knowledge_update create note requires non-empty content");
    const id = `t_${randomUUID().replaceAll("-", "")}`;
    const record: KnowledgeNoteRecord = {
      id,
      scope,
      kind: input.kind ?? "observation",
      content,
      tags: Array.isArray(input.tags) ? [...input.tags] : [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    state.notes[id] = record;
    saveKnowledgeGraphState(state);
    insertMemory(content, record.kind, record.tags, null);
    return { status: "created", type: "note", entry: record };
  }

  // op === "update"
  const id = (input.id ?? "").trim();
  if (!id) throw new Error("knowledge_update update requires id");
  if (typeof input.expectedRevision !== "number") {
    throw new Error("knowledge_update update requires expectedRevision");
  }

  if (id.startsWith("n_") || type === "node") {
    const existing = state.nodes[id];
    if (!existing) throw new Error(`Knowledge node not found: ${id}`);
    if (existing.revision !== input.expectedRevision) {
      throw new Error(`CAS revision mismatch for ${id}: expected ${input.expectedRevision}, actual ${existing.revision}`);
    }
    if (input.name !== undefined) existing.name = input.name.trim() || existing.name;
    if (input.kind !== undefined) existing.kind = input.kind;
    if (input.scope !== undefined) existing.scope = input.scope;
    if (Array.isArray(input.tags)) existing.tags = [...input.tags];
    existing.revision += 1;
    existing.updatedAt = now;
    saveKnowledgeGraphState(state);
    return { status: "updated", type: "node", entry: existing };
  }

  if (id.startsWith("e_") || type === "edge") {
    const existing = state.edges[id];
    if (!existing) throw new Error(`Knowledge edge not found: ${id}`);
    if (existing.revision !== input.expectedRevision) {
      throw new Error(`CAS revision mismatch for ${id}: expected ${input.expectedRevision}, actual ${existing.revision}`);
    }
    if (input.from !== undefined) existing.from = input.from;
    if (input.to !== undefined) existing.to = input.to;
    if (input.relation !== undefined) existing.relation = input.relation;
    if (input.scope !== undefined) existing.scope = input.scope;
    if (Array.isArray(input.tags)) existing.tags = [...input.tags];
    existing.revision += 1;
    existing.updatedAt = now;
    saveKnowledgeGraphState(state);
    return { status: "updated", type: "edge", entry: existing };
  }

  const existing = state.notes[id];
  if (!existing) throw new Error(`Knowledge note not found: ${id}`);
  if (existing.revision !== input.expectedRevision) {
    throw new Error(`CAS revision mismatch for ${id}: expected ${input.expectedRevision}, actual ${existing.revision}`);
  }
  if (input.content !== undefined) existing.content = input.content;
  if (input.kind !== undefined) existing.kind = input.kind;
  if (input.scope !== undefined) existing.scope = input.scope;
  if (Array.isArray(input.tags)) existing.tags = [...input.tags];
  existing.revision += 1;
  existing.updatedAt = now;
  saveKnowledgeGraphState(state);
  return { status: "updated", type: "note", entry: existing };
}

export function inspectKnowledgeEntryById(id: string): KnowledgeNodeRecord | KnowledgeEdgeRecord | KnowledgeNoteRecord | null {
  const state = loadKnowledgeGraphState();
  return state.nodes[id] ?? state.edges[id] ?? state.notes[id] ?? null;
}

export function expandKnowledgeGraphById(id: string, depth = 1, edgeType?: string): Record<string, unknown> | null {
  const state = loadKnowledgeGraphState();
  const rootNode = state.nodes[id] ?? Object.values(state.nodes).find(n => n.name === id);
  if (!rootNode) return null;
  const maxDepth = Math.max(1, Math.min(3, depth));
  const visitedNodes = new Set<string>([rootNode.id]);
  const collectedEdges: KnowledgeEdgeRecord[] = [];
  let frontier = [rootNode.id];

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      for (const edge of Object.values(state.edges)) {
        if (edgeType && edge.relation !== edgeType) continue;
        if (edge.from === currentId || edge.to === currentId) {
          if (!collectedEdges.some(e => e.id === edge.id)) collectedEdges.push(edge);
          const otherId = edge.from === currentId ? edge.to : edge.from;
          if (!visitedNodes.has(otherId)) {
            visitedNodes.add(otherId);
            nextFrontier.push(otherId);
          }
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return {
    center: rootNode,
    depth: maxDepth,
    nodes: [...visitedNodes].map(nid => state.nodes[nid]).filter(Boolean),
    edges: collectedEdges,
  };
}

export function searchKnowledgeTriplets(input: {
  query?: string;
  type?: "node" | "edge" | "note";
  scope?: "current" | "global";
  limit?: number;
}): Array<KnowledgeNodeRecord | KnowledgeEdgeRecord | KnowledgeNoteRecord> {
  const state = loadKnowledgeGraphState();
  const q = (input.query ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const wantScope = input.scope === "global" ? "global" : null;
  const results: Array<KnowledgeNodeRecord | KnowledgeEdgeRecord | KnowledgeNoteRecord> = [];

  if (!input.type || input.type === "node") {
    for (const node of Object.values(state.nodes)) {
      if (wantScope && node.scope !== wantScope) continue;
      if (!q || node.name.toLowerCase().includes(q) || node.kind.toLowerCase().includes(q) || node.tags.some(t => t.toLowerCase().includes(q))) {
        results.push(node);
      }
    }
  }
  if (!input.type || input.type === "edge") {
    for (const edge of Object.values(state.edges)) {
      if (wantScope && edge.scope !== wantScope) continue;
      if (!q || edge.relation.toLowerCase().includes(q) || edge.from.toLowerCase().includes(q) || edge.to.toLowerCase().includes(q)) {
        results.push(edge);
      }
    }
  }
  if (!input.type || input.type === "note") {
    for (const note of Object.values(state.notes)) {
      if (wantScope && note.scope !== wantScope) continue;
      if (!q || note.content.toLowerCase().includes(q) || note.kind.toLowerCase().includes(q) || note.tags.some(t => t.toLowerCase().includes(q))) {
        results.push(note);
      }
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

// ===========================================
// 2. Session Agent Map (Exploration Tree + Atomic CAS)
// ===========================================

export interface AgentMapNode {
  nodeId: string;
  parentId: string | null;
  title: string;
  summary: string;
  lastActionSeq: number;
  noteIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionAgentMapState {
  sessionId: string;
  mapId: string | null;
  mapVersion: number;
  rootNodeId: string | null;
  focusedNodeId: string | null;
  actionSeqCounter: number;
  nodes: Record<string, AgentMapNode>;
  updatedAt: number;
}

export interface AgentMapOperation {
  op:
    | "add_node"
    | "update_node"
    | "move_node"
    | "remove_node"
    | "focus_node"
    | "clear_focus"
    | "create_note"
    | "attach_note"
    | "detach_note"
    | "update_note"
    | "refresh_projection";
  ref?: string | null;
  nodeId?: string | null;
  parentId?: string | null;
  title?: string | null;
  summary?: string | null;
  expectedLastActionSeq?: number | null;
  noteId?: string | null;
  content?: string;
  kind?: string;
  scope?: "project" | "global";
  tags?: string[];
  expectedRevision?: number;
  reason?: string | null;
  requestFingerprint?: string | null;
}

function mapStoreKey(sessionId: string): string {
  return `__lux_agent_map__:${sessionId}`;
}

export function loadSessionAgentMap(sessionId: string): SessionAgentMapState {
  return loadJsonRecord<SessionAgentMapState>(mapStoreKey(sessionId), "__lux_agent_map__", () => ({
    sessionId,
    mapId: null,
    mapVersion: 0,
    rootNodeId: null,
    focusedNodeId: null,
    actionSeqCounter: 0,
    nodes: {},
    updatedAt: Date.now(),
  }));
}

function saveSessionAgentMap(state: SessionAgentMapState): void {
  saveJsonRecord(mapStoreKey(state.sessionId), "__lux_agent_map__", state);
}

function resolveBatchRef(raw: string | null | undefined, refs: Map<string, string>): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("$")) {
    const refName = trimmed.slice(1);
    const resolved = refs.get(refName);
    if (!resolved) throw new Error(`Unresolved batch reference: ${trimmed}`);
    return resolved;
  }
  return trimmed;
}

function assertSingleRootAndAcyclic(nodes: Record<string, AgentMapNode>): string | null {
  const entries = Object.values(nodes);
  if (entries.length === 0) return null;
  const roots = entries.filter(n => n.parentId === null);
  if (roots.length !== 1) {
    throw new Error(`Agent Map atomic result must have exactly one root node (found ${roots.length})`);
  }
  for (const node of entries) {
    const seen = new Set<string>([node.nodeId]);
    let curr = node.parentId;
    while (curr !== null) {
      if (seen.has(curr)) throw new Error(`Agent Map cycle detected involving node ${curr}`);
      const parent = nodes[curr];
      if (!parent) throw new Error(`Agent Map parent node ${curr} does not exist`);
      seen.add(curr);
      curr = parent.parentId;
    }
  }
  return roots[0].nodeId;
}

export function executeAgentMapUpdate(
  sessionId: string,
  expectedMapId: string | null,
  operations: readonly AgentMapOperation[],
  options: { allowNoteMutations?: boolean } = {},
): Record<string, unknown> {
  const allowNoteMutations = options.allowNoteMutations ?? true;
  const current = loadSessionAgentMap(sessionId);
  if (current.mapId !== expectedMapId) {
    throw new Error(
      `CAS expectedMapId mismatch: expected ${JSON.stringify(expectedMapId)}, actual ${JSON.stringify(current.mapId)}`,
    );
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("map_update requires a non-empty operations array");
  }

  // Deep clone for atomic rollback on any error
  const next: SessionAgentMapState = JSON.parse(JSON.stringify(current));
  const kgState = loadKnowledgeGraphState();
  const nextKg: KnowledgeGraphStoreState = JSON.parse(JSON.stringify(kgState));
  const refs = new Map<string, string>();
  const appliedReceipts: Array<Record<string, unknown>> = [];
  const now = Date.now();

  const registerRef = (ref: string | null | undefined, targetId: string) => {
    if (!ref) return;
    const clean = ref.trim().replace(/^\$/, "");
    if (!clean) return;
    if (refs.has(clean)) throw new Error(`Duplicate batch ref: ${clean}`);
    refs.set(clean, targetId);
  };

  const requireExistingNode = (rawId: string | null | undefined, expectedSeq: number | null | undefined, opName: string): AgentMapNode => {
    const id = resolveBatchRef(rawId, refs);
    if (!id) throw new Error(`${opName} requires a target nodeId`);
    const node = next.nodes[id];
    if (!node) throw new Error(`${opName} target node does not exist: ${id}`);
    const wasCreatedInThisBatch = [...refs.values()].includes(id);
    if (!wasCreatedInThisBatch) {
      if (typeof expectedSeq !== "number" || expectedSeq !== node.lastActionSeq) {
        throw new Error(
          `CAS expectedLastActionSeq mismatch on node ${id} in ${opName}: expected ${String(expectedSeq)}, actual ${node.lastActionSeq}`,
        );
      }
    }
    return node;
  };

  for (const op of operations) {
    next.actionSeqCounter += 1;
    const seq = next.actionSeqCounter;

    switch (op.op) {
      case "add_node": {
        const title = (op.title ?? "").trim();
        if (!title) throw new Error("add_node requires a non-empty title");
        const parentId = resolveBatchRef(op.parentId, refs);
        if (parentId !== null && !next.nodes[parentId]) {
          throw new Error(`add_node parentId does not exist: ${parentId}`);
        }
        const nodeId = randomUUID();
        const node: AgentMapNode = {
          nodeId,
          parentId,
          title,
          summary: (op.summary ?? "").trim(),
          lastActionSeq: seq,
          noteIds: [],
          createdAt: now,
          updatedAt: now,
        };
        next.nodes[nodeId] = node;
        registerRef(op.ref, nodeId);
        appliedReceipts.push({ op: "add_node", nodeId, parentId, lastActionSeq: seq });
        break;
      }

      case "update_node": {
        const node = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "update_node");
        if (op.title !== undefined && op.title !== null && op.title.trim()) {
          node.title = op.title.trim();
        }
        if (op.summary !== undefined && op.summary !== null) {
          node.summary = op.summary.trim();
        }
        node.lastActionSeq = seq;
        node.updatedAt = now;
        appliedReceipts.push({ op: "update_node", nodeId: node.nodeId, lastActionSeq: seq });
        break;
      }

      case "move_node": {
        const node = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "move_node");
        const newParentId = resolveBatchRef(op.parentId, refs);
        if (newParentId === node.nodeId) throw new Error("move_node cannot parent a node to itself");
        if (newParentId !== null && !next.nodes[newParentId]) {
          throw new Error(`move_node target parentId does not exist: ${newParentId}`);
        }
        node.parentId = newParentId;
        node.lastActionSeq = seq;
        node.updatedAt = now;
        appliedReceipts.push({ op: "move_node", nodeId: node.nodeId, parentId: newParentId, lastActionSeq: seq });
        break;
      }

      case "remove_node": {
        const node = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "remove_node");
        const toDelete = new Set<string>([node.nodeId]);
        let added = true;
        while (added) {
          added = false;
          for (const candidate of Object.values(next.nodes)) {
            if (candidate.parentId && toDelete.has(candidate.parentId) && !toDelete.has(candidate.nodeId)) {
              toDelete.add(candidate.nodeId);
              added = true;
            }
          }
        }
        for (const delId of toDelete) {
          delete next.nodes[delId];
          if (next.focusedNodeId === delId) next.focusedNodeId = null;
        }
        appliedReceipts.push({ op: "remove_node", nodeId: node.nodeId, removedCount: toDelete.size });
        break;
      }

      case "focus_node": {
        const node = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "focus_node");
        next.focusedNodeId = node.nodeId;
        node.lastActionSeq = seq;
        node.updatedAt = now;
        appliedReceipts.push({ op: "focus_node", nodeId: node.nodeId, lastActionSeq: seq });
        break;
      }

      case "clear_focus": {
        next.focusedNodeId = null;
        appliedReceipts.push({ op: "clear_focus" });
        break;
      }

      case "create_note": {
        if (!allowNoteMutations) throw new Error("Current role is not permitted to create or mutate Notes");
        const content = (op.content ?? "").trim();
        if (!content) throw new Error("create_note requires non-empty content");
        const noteId = `t_${randomUUID().replaceAll("-", "")}`;
        const note: KnowledgeNoteRecord = {
          id: noteId,
          scope: op.scope ?? "project",
          kind: op.kind ?? "observation",
          content,
          tags: Array.isArray(op.tags) ? [...op.tags] : [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        nextKg.notes[noteId] = note;
        registerRef(op.ref, noteId);

        const attachTargetId = resolveBatchRef(op.nodeId, refs);
        if (attachTargetId) {
          const targetNode = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "create_note(attach)");
          if (!targetNode.noteIds.includes(noteId)) targetNode.noteIds.push(noteId);
          targetNode.lastActionSeq = seq;
          targetNode.updatedAt = now;
        }
        appliedReceipts.push({ op: "create_note", noteId, attachedNodeId: attachTargetId, revision: 1 });
        break;
      }

      case "attach_note": {
        if (!allowNoteMutations) throw new Error("Current role is not permitted to attach Notes");
        const targetNode = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "attach_note");
        const noteId = resolveBatchRef(op.noteId, refs);
        if (!noteId || !nextKg.notes[noteId]) throw new Error(`attach_note noteId does not exist: ${String(op.noteId)}`);
        if (!targetNode.noteIds.includes(noteId)) targetNode.noteIds.push(noteId);
        targetNode.lastActionSeq = seq;
        targetNode.updatedAt = now;
        appliedReceipts.push({ op: "attach_note", nodeId: targetNode.nodeId, noteId, lastActionSeq: seq });
        break;
      }

      case "detach_note": {
        if (!allowNoteMutations) throw new Error("Current role is not permitted to detach Notes");
        const targetNode = requireExistingNode(op.nodeId, op.expectedLastActionSeq, "detach_note");
        const noteId = resolveBatchRef(op.noteId, refs);
        if (!noteId) throw new Error("detach_note requires noteId");
        targetNode.noteIds = targetNode.noteIds.filter(id => id !== noteId);
        targetNode.lastActionSeq = seq;
        targetNode.updatedAt = now;
        appliedReceipts.push({ op: "detach_note", nodeId: targetNode.nodeId, noteId, lastActionSeq: seq });
        break;
      }

      case "update_note": {
        if (!allowNoteMutations) throw new Error("Current role is not permitted to update Notes");
        const noteId = resolveBatchRef(op.noteId, refs);
        if (!noteId || !nextKg.notes[noteId]) throw new Error(`update_note noteId does not exist: ${String(op.noteId)}`);
        const note = nextKg.notes[noteId];
        if (typeof op.expectedRevision === "number" && note.revision !== op.expectedRevision) {
          throw new Error(`CAS expectedRevision mismatch on note ${noteId}: expected ${op.expectedRevision}, actual ${note.revision}`);
        }
        if (op.content !== undefined) note.content = op.content;
        if (op.kind !== undefined) note.kind = op.kind;
        if (op.scope !== undefined) note.scope = op.scope;
        if (Array.isArray(op.tags)) note.tags = [...op.tags];
        note.revision += 1;
        note.updatedAt = now;
        appliedReceipts.push({ op: "update_note", noteId, revision: note.revision });
        break;
      }

      case "refresh_projection": {
        appliedReceipts.push({ op: "refresh_projection" });
        break;
      }

      default:
        throw new Error(`Unsupported map_update operation: ${String((op as { op?: unknown }).op)}`);
    }
  }

  next.rootNodeId = assertSingleRootAndAcyclic(next.nodes);
  if (!next.mapId) next.mapId = randomUUID();
  next.mapVersion += 1;
  next.updatedAt = now;

  saveKnowledgeGraphState(nextKg);
  saveSessionAgentMap(next);

  return {
    mapId: next.mapId,
    mapVersion: next.mapVersion,
    rootNodeId: next.rootNodeId,
    focusedNodeId: next.focusedNodeId,
    nodeCount: Object.keys(next.nodes).length,
    applied: appliedReceipts,
    projection: renderAgentMapProjection(sessionId),
  };
}

export function viewSessionAgentMap(
  sessionId: string,
  options: { nodeId?: string | null; depth?: number | null; includeNotes?: boolean | null; cursor?: string | number | null } = {},
): Record<string, unknown> {
  const state = loadSessionAgentMap(sessionId);
  const kg = loadKnowledgeGraphState();
  const startNodeId = (options.nodeId && options.nodeId.trim()) || state.focusedNodeId || state.rootNodeId;
  const maxDepth = options.depth !== undefined && options.depth !== null ? Math.max(0, options.depth) : 4;
  const includeNotes = options.includeNotes ?? true;

  if (!startNodeId || !state.nodes[startNodeId]) {
    return {
      mapId: state.mapId,
      mapVersion: state.mapVersion,
      rootNodeId: state.rootNodeId,
      focusedNodeId: state.focusedNodeId,
      nodes: [],
      has_more: false,
      next_cursor: null,
    };
  }

  const childrenMap = new Map<string, AgentMapNode[]>();
  for (const node of Object.values(state.nodes)) {
    if (node.parentId) {
      const list = childrenMap.get(node.parentId) ?? [];
      list.push(node);
      childrenMap.set(node.parentId, list);
    }
  }

  const resultNodes: Array<Record<string, unknown>> = [];
  const queue: Array<{ id: string; level: number }> = [{ id: startNodeId, level: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    const node = state.nodes[item.id];
    if (!node) continue;
    const attachedNotes = includeNotes
      ? node.noteIds.map(nid => kg.notes[nid]).filter(Boolean).map(n => ({
          id: n.id,
          kind: n.kind,
          scope: n.scope,
          revision: n.revision,
          preview: n.content.slice(0, 240),
        }))
      : undefined;
    resultNodes.push({
      nodeId: node.nodeId,
      parentId: node.parentId,
      title: node.title,
      summary: node.summary,
      lastActionSeq: node.lastActionSeq,
      depth: item.level,
      ...(includeNotes ? { notes: attachedNotes } : {}),
    });
    if (item.level < maxDepth) {
      for (const child of childrenMap.get(node.nodeId) ?? []) {
        queue.push({ id: child.nodeId, level: item.level + 1 });
      }
    }
  }

  const offset = typeof options.cursor === "string" && options.cursor.trim() && options.cursor !== "0"
    ? Number.parseInt(options.cursor, 10) || 0
    : 0;
  const pageSize = 50;
  const page = resultNodes.slice(offset, offset + pageSize);
  const nextCursor = offset + pageSize < resultNodes.length ? String(offset + pageSize) : null;

  return {
    mapId: state.mapId,
    mapVersion: state.mapVersion,
    rootNodeId: state.rootNodeId,
    focusedNodeId: state.focusedNodeId,
    nodes: page,
    totalNodes: Object.keys(state.nodes).length,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

export function searchSessionAgentMap(
  sessionId: string,
  query: string,
  limit = 20,
  cursor?: string | number | null,
): Record<string, unknown> {
  const state = loadSessionAgentMap(sessionId);
  const kg = loadKnowledgeGraphState();
  const q = query.trim().toLowerCase();
  const matches: Array<Record<string, unknown>> = [];

  for (const node of Object.values(state.nodes)) {
    const nodeHit = !q || node.title.toLowerCase().includes(q) || node.summary.toLowerCase().includes(q);
    const matchingNotes = node.noteIds
      .map(id => kg.notes[id])
      .filter((n): n is KnowledgeNoteRecord => Boolean(n && (!q || n.content.toLowerCase().includes(q))));
    if (nodeHit || matchingNotes.length > 0) {
      matches.push({
        nodeId: node.nodeId,
        parentId: node.parentId,
        title: node.title,
        summary: node.summary,
        lastActionSeq: node.lastActionSeq,
        matchingNotes: matchingNotes.map(n => ({ id: n.id, kind: n.kind, revision: n.revision, snippet: n.content.slice(0, 200) })),
      });
    }
  }

  const offset = typeof cursor === "string" && cursor.trim() && cursor !== "0" ? Number.parseInt(cursor, 10) || 0 : 0;
  const maxItems = Math.max(1, Math.min(100, limit));
  const slice = matches.slice(offset, offset + maxItems);
  const nextCursor = offset + maxItems < matches.length ? String(offset + maxItems) : null;

  return {
    mapId: state.mapId,
    mapVersion: state.mapVersion,
    query,
    matches: slice,
    totalMatches: matches.length,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

export function renderAgentMapProjection(sessionId: string): string {
  const state = loadSessionAgentMap(sessionId);
  if (!state.rootNodeId || !state.nodes[state.rootNodeId]) {
    return "No Agent Map recorded for this Session yet.";
  }
  const kg = loadKnowledgeGraphState();
  const root = state.nodes[state.rootNodeId];
  const focus = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null;
  const lines: string[] = [
    "Map/Notes snapshot for this context epoch. Navigation only; current user request, live corrections and pins take precedence. Use live tools for newer state. Details: map_view/map_search; full Notes: inspect.",
    `Root [${root.nodeId}] ${root.title}${root.summary ? ` — ${root.summary.slice(0, 180)}` : ""}`,
  ];
  if (focus && focus.nodeId !== root.nodeId) {
    lines.push(`Focus [${focus.nodeId}] ${focus.title}${focus.summary ? ` — ${focus.summary.slice(0, 180)}` : ""} (parent [${focus.parentId ?? "none"}])`);
  }
  const branches = Object.values(state.nodes).filter(n => n.nodeId !== root.nodeId && n.nodeId !== focus?.nodeId).slice(0, 6);
  for (const b of branches) {
    lines.push(`Branch [${b.nodeId}] ${b.title}${b.summary ? ` — ${b.summary.slice(0, 140)}` : ""} (parent [${b.parentId ?? "none"}])`);
  }
  for (const node of Object.values(state.nodes)) {
    for (const noteId of node.noteIds.slice(-2)) {
      const note = kg.notes[noteId];
      if (note) {
        lines.push(`Note [${note.id}] @ [${node.nodeId}]: ${note.content.replace(/\s+/g, " ").slice(0, 220)}`);
      }
    }
  }
  return lines.join("\n");
}

// ===========================================
// 3. Cold/Hot Canvas Store & Oversized Tool Results
// ===========================================

export interface CanvasColdBlock {
  blockId: string;
  ordinal: number;
  role: string;
  toolName?: string;
  content: string;
  summary: string;
  createdAt: string;
}

export interface SessionCanvasStoreState {
  sessionId: string;
  nextOrdinal: number;
  continuitySummary: string;
  coldBlocks: CanvasColdBlock[];
  toolResultBlocks: Record<string, { blockId: string; toolName: string; content: string; createdAt: string }>;
}

function canvasStoreKey(sessionId: string): string {
  return `__lux_canvas_store__:${sessionId}`;
}

export function loadSessionCanvasStore(sessionId: string): SessionCanvasStoreState {
  return loadJsonRecord<SessionCanvasStoreState>(canvasStoreKey(sessionId), "__lux_canvas_store__", () => ({
    sessionId,
    nextOrdinal: 1,
    continuitySummary: "",
    coldBlocks: [],
    toolResultBlocks: {},
  }));
}

export function saveSessionCanvasStore(state: SessionCanvasStoreState): void {
  saveJsonRecord(canvasStoreKey(state.sessionId), "__lux_canvas_store__", state);
}

export function saveToolResultBlock(sessionId: string, toolName: string, content: string, explicitBlockId?: string): string {
  const store = loadSessionCanvasStore(sessionId);
  const blockId = explicitBlockId ?? randomUUID();
  store.toolResultBlocks[blockId] = {
    blockId,
    toolName,
    content,
    createdAt: new Date().toISOString(),
  };
  saveSessionCanvasStore(store);
  return blockId;
}

export function readToolResultBlock(
  sessionId: string,
  blockId: string,
  offset = 0,
  maxChars = 6000,
): Record<string, unknown> {
  const store = loadSessionCanvasStore(sessionId);
  let fullText = store.toolResultBlocks[blockId]?.content;

  if (fullText === undefined) {
    // Also check cold blocks and session messages by id or tool_call_id
    const cold = store.coldBlocks.find(b => b.blockId === blockId);
    if (cold) {
      fullText = cold.content;
    } else {
      const msgs = getMessagesBySession(sessionId);
      const msg = msgs.find(m => String(m.id) === blockId || m.tool_call_id === blockId || `msg-${m.id}` === blockId);
      if (msg) fullText = msg.content;
    }
  }

  if (fullText === undefined) {
    throw new Error(`Tool-result block not found in this Session: ${blockId}`);
  }

  const chars = Array.from(fullText);
  const start = Math.max(0, Math.min(chars.length, offset));
  const limit = Math.max(1, Math.min(12000, maxChars));
  const slice = chars.slice(start, start + limit).join("");
  const nextOffset = start + limit < chars.length ? start + limit : null;

  return {
    blockId,
    offset: start,
    maxChars: limit,
    total_chars: chars.length,
    has_more: nextOffset !== null,
    next_offset: nextOffset,
    content: slice,
  };
}

export function archiveMessagesToColdStore(
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content: string; created_at?: string }>,
  continuitySummary?: string,
): number {
  const store = loadSessionCanvasStore(sessionId);
  const existingSignatures = new Set(store.coldBlocks.map(b => `${b.role}:${b.content.slice(0, 120)}:${b.content.length}`));
  let added = 0;

  for (const msg of messages) {
    if (msg.role === "system") continue;
    const sig = `${msg.role}:${msg.content.slice(0, 120)}:${msg.content.length}`;
    if (existingSignatures.has(sig)) continue;
    existingSignatures.add(sig);
    const ordinal = store.nextOrdinal++;
    store.coldBlocks.push({
      blockId: `blk_${sessionId.slice(0, 8)}_${ordinal}`,
      ordinal,
      role: msg.role,
      content: msg.content,
      summary: msg.content.replace(/\s+/g, " ").slice(0, 180),
      createdAt: msg.created_at ?? new Date().toISOString(),
    });
    added++;
  }
  if (continuitySummary !== undefined) {
    store.continuitySummary = continuitySummary;
  }
  saveSessionCanvasStore(store);
  return added;
}

function getEffectiveColdBlocks(sessionId: string): CanvasColdBlock[] {
  const store = loadSessionCanvasStore(sessionId);
  if (store.coldBlocks.length > 0) return store.coldBlocks;
  // Sync historical messages from DB as inspectable blocks without mutating hot memory
  const dbMessages = getMessagesBySession(sessionId);
  return dbMessages.map((m, idx) => ({
    blockId: `msg-${m.id}`,
    ordinal: idx + 1,
    role: m.role,
    content: m.content,
    summary: m.content.replace(/\s+/g, " ").slice(0, 180),
    createdAt: m.created_at,
  }));
}

export function canvasHistoryOverview(sessionId: string, after = 0, limit = 20): Record<string, unknown> {
  const blocks = getEffectiveColdBlocks(sessionId).filter(b => b.ordinal > after);
  const maxItems = Math.max(1, Math.min(100, limit));
  const slice = blocks.slice(0, maxItems);
  const nextAfter = slice.length > 0 && blocks.length > maxItems ? slice[slice.length - 1].ordinal : null;

  return {
    sessionId,
    blocks: slice.map(b => ({
      blockId: b.blockId,
      ordinal: b.ordinal,
      role: b.role,
      summary: b.summary,
      total_chars: Array.from(b.content).length,
      createdAt: b.createdAt,
    })),
    totalColdBlocks: blocks.length,
    has_more: nextAfter !== null,
    next_after: nextAfter,
  };
}

export function canvasHistorySearch(sessionId: string, query: string, after = 0, limit = 20): Record<string, unknown> {
  const q = query.trim().toLowerCase();
  const blocks = getEffectiveColdBlocks(sessionId).filter(
    b => b.ordinal > after && (!q || b.content.toLowerCase().includes(q) || b.summary.toLowerCase().includes(q)),
  );
  const maxItems = Math.max(1, Math.min(100, limit));
  const slice = blocks.slice(0, maxItems);
  const nextAfter = slice.length > 0 && blocks.length > maxItems ? slice[slice.length - 1].ordinal : null;

  return {
    sessionId,
    query,
    matches: slice.map(b => {
      const idx = q ? b.content.toLowerCase().indexOf(q) : 0;
      const snippetStart = Math.max(0, idx - 60);
      return {
        blockId: b.blockId,
        ordinal: b.ordinal,
        role: b.role,
        snippet: b.content.slice(snippetStart, snippetStart + 240),
        total_chars: Array.from(b.content).length,
      };
    }),
    has_more: nextAfter !== null,
    next_after: nextAfter,
  };
}

export function canvasHistoryInspect(
  sessionId: string,
  blockId: string,
  offset = 0,
  maxChars = 6000,
): Record<string, unknown> {
  const blocks = getEffectiveColdBlocks(sessionId);
  const target = blocks.find(b => b.blockId === blockId);
  if (!target) {
    throw new Error(`Cold Canvas block not found: ${blockId}`);
  }
  const chars = Array.from(target.content);
  const start = Math.max(0, Math.min(chars.length, offset));
  const limit = Math.max(1, Math.min(12000, maxChars));
  const slice = chars.slice(start, start + limit).join("");
  const nextOffset = start + limit < chars.length ? start + limit : null;

  return {
    blockId: target.blockId,
    ordinal: target.ordinal,
    role: target.role,
    offset: start,
    maxChars: limit,
    total_chars: chars.length,
    has_more: nextOffset !== null,
    next_offset: nextOffset,
    content: slice,
  };
}

// ===========================================
// 4. Store-Backed Zero-Preload Skills Engine
// ===========================================

export interface SkillPackageRevision {
  revision: string;
  etag: string;
  content: string;
  files: Record<string, string>;
  updatedAt: number;
}

export interface SkillPackageRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  etag: string;
  revision: string;
  content: string;
  files: Record<string, string>;
  sections: Array<{ heading: string; level: number; content: string }>;
  history: SkillPackageRevision[];
  deleted?: boolean;
  updatedAt: number;
}

export interface SessionSkillReceipt {
  id: string;
  key: string;
  etag: string;
  sections: string[];
  loadedAt: number;
}

interface SkillStoreState {
  packages: Record<string, SkillPackageRecord>;
  sessionReceipts: Record<string, Record<string, SessionSkillReceipt>>;
}

const SKILL_STORE_KEY = "__lux_cloud_skill_store__:v1";
const SKILL_STORE_KIND = "__lux_skill_store__";

export function parseMarkdownSections(markdown: string): {
  title: string;
  description: string;
  sections: Array<{ heading: string; level: number; content: string }>;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = "Untitled Skill";
  let description = "";
  const sections: Array<{ heading: string; level: number; content: string }> = [];
  let currentHeading = "Overview";
  let currentLevel = 1;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (match) {
      if (currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentLines.join("\n").trim(),
        });
      }
      currentLevel = match[1].length;
      currentHeading = match[2];
      if (title === "Untitled Skill" && currentLevel === 1) {
        title = currentHeading;
      }
      currentLines = [line];
    } else {
      currentLines.push(line);
      if (!description && line.trim() && !line.trim().startsWith("---") && !line.trim().startsWith("#")) {
        description = line.trim().slice(0, 200);
      }
    }
  }
  if (currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentLines.join("\n").trim(),
    });
  }
  return { title, description, sections };
}

function loadSkillStoreState(): SkillStoreState {
  return loadJsonRecord<SkillStoreState>(SKILL_STORE_KEY, SKILL_STORE_KIND, () => ({
    packages: {},
    sessionReceipts: {},
  }));
}

function saveSkillStoreState(state: SkillStoreState): void {
  saveJsonRecord(SKILL_STORE_KEY, SKILL_STORE_KIND, state);
}

export function searchStoreSkills(query: string, limit = 20, cursor?: string): Record<string, unknown> {
  const state = loadSkillStoreState();
  const q = query.trim().toLowerCase();
  const active = Object.values(state.packages).filter(p => !p.deleted);
  const matched = active.filter(
    p =>
      !q ||
      p.id.toLowerCase().includes(q) ||
      p.title.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.sections.some(s => s.heading.toLowerCase().includes(q)),
  );
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const maxItems = Math.max(1, Math.min(100, limit || 20));
  const page = matched.slice(offset, offset + maxItems);
  const nextCursor = offset + maxItems < matched.length ? String(offset + maxItems) : null;

  return {
    query,
    skills: page.map(p => ({
      id: p.id,
      key: p.key,
      title: p.title,
      description: p.description,
      etag: p.etag,
      sections: p.sections.map(s => s.heading),
    })),
    total: matched.length,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

export function loadStoreSkillForSession(
  sessionId: string,
  idOrKey: string,
  sections?: string[],
  maxTokens = 4000,
  forceReload = false,
): Record<string, unknown> {
  const state = loadSkillStoreState();
  const pkg = state.packages[idOrKey] ?? Object.values(state.packages).find(p => p.key === idOrKey);
  if (!pkg || pkg.deleted) {
    throw new Error(`Skill package not found: ${idOrKey}`);
  }
  const sessionMap = (state.sessionReceipts[sessionId] ??= {});
  const requestedSections = Array.isArray(sections) && sections.length > 0 ? sections : pkg.sections.map(s => s.heading);
  const existing = sessionMap[pkg.id];

  if (
    !forceReload &&
    existing &&
    existing.etag === pkg.etag &&
    requestedSections.every(sec => existing.sections.includes(sec))
  ) {
    return {
      id: pkg.id,
      key: pkg.key,
      etag: pkg.etag,
      deduplicated: true,
      loadedSections: existing.sections,
      notice: "Skill sections already resident in this Session; use skill_reload to force re-reading.",
    };
  }

  const matchedSections = pkg.sections.filter(s =>
    requestedSections.some(req => s.heading.toLowerCase() === req.toLowerCase() || s.heading.toLowerCase().includes(req.toLowerCase())),
  );
  const selected = matchedSections.length > 0 ? matchedSections : pkg.sections;
  const maxChars = Math.max(256, Math.min(8000, maxTokens) * 4);
  const combined = selected.map(s => s.content).join("\n\n").slice(0, maxChars);

  sessionMap[pkg.id] = {
    id: pkg.id,
    key: pkg.key,
    etag: pkg.etag,
    sections: selected.map(s => s.heading),
    loadedAt: Date.now(),
  };
  saveSkillStoreState(state);

  return {
    id: pkg.id,
    key: pkg.key,
    etag: pkg.etag,
    deduplicated: false,
    loadedSections: selected.map(s => s.heading),
    content: combined,
  };
}

export function releaseStoreSkillForSession(sessionId: string, id: string): Record<string, unknown> {
  const state = loadSkillStoreState();
  const sessionMap = state.sessionReceipts[sessionId] ?? {};
  const existed = Boolean(sessionMap[id]);
  delete sessionMap[id];
  saveSkillStoreState(state);
  return { id, released: existed };
}

export function listStoreSkillReceipts(sessionId: string): Record<string, unknown> {
  const state = loadSkillStoreState();
  const sessionMap = state.sessionReceipts[sessionId] ?? {};
  const receipts = Object.values(sessionMap).map(r => {
    const pkg = state.packages[r.id];
    return {
      ...r,
      valid: Boolean(pkg && !pkg.deleted && pkg.etag === r.etag),
      residency: "store-backed",
    };
  });
  return { sessionId, receipts };
}

export function manageStoreSkill(input: {
  action: "list" | "read" | "create" | "update" | "delete" | "history" | "restore";
  id?: string;
  key?: string;
  etag?: string;
  expected_absent?: boolean;
  content?: string;
  file?: string;
  files?: Record<string, string>;
  remove_files?: string[];
  revision?: string;
  query?: string;
  limit?: number;
  offset?: number;
  max_bytes?: number;
}): Record<string, unknown> {
  const state = loadSkillStoreState();
  const now = Date.now();
  const resolveId = (): string => {
    const raw = (input.id ?? input.key ?? "").trim().replace(/\/SKILL\.md$/i, "");
    if (!raw) throw new Error(`skill_manage ${input.action} requires id or key`);
    return raw;
  };

  switch (input.action) {
    case "list": {
      const q = (input.query ?? "").trim().toLowerCase();
      const items = Object.values(state.packages)
        .filter(p => !p.deleted && (!q || p.id.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)))
        .slice(0, input.limit ?? 20)
        .map(p => ({
          id: p.id,
          key: p.key,
          title: p.title,
          description: p.description,
          etag: p.etag,
          revision: p.revision,
          updatedAt: p.updatedAt,
        }));
      return { action: "list", skills: items, total: items.length };
    }

    case "read": {
      const id = resolveId();
      const pkg = state.packages[id];
      if (!pkg || pkg.deleted) throw new Error(`Skill not found: ${id}`);
      const targetRev = input.revision
        ? pkg.history.find(h => h.revision === input.revision)
        : { revision: pkg.revision, etag: pkg.etag, content: pkg.content, files: pkg.files };
      if (!targetRev) throw new Error(`Skill revision not found: ${String(input.revision)}`);
      const relFile = (input.file ?? "SKILL.md").trim();
      const text = relFile === "SKILL.md" ? targetRev.content : targetRev.files[relFile];
      if (text === undefined) throw new Error(`Skill file not found: ${relFile}`);
      const byteOffset = input.offset ?? 0;
      const maxBytes = Math.min(65536, input.max_bytes ?? 32768);
      const buf = Buffer.from(text, "utf8");
      const slice = buf.subarray(byteOffset, byteOffset + maxBytes).toString("utf8");
      return {
        action: "read",
        id: pkg.id,
        key: pkg.key,
        etag: targetRev.etag,
        revision: targetRev.revision,
        file: relFile,
        content: slice,
        total_bytes: buf.length,
        next_offset: byteOffset + maxBytes < buf.length ? byteOffset + maxBytes : null,
      };
    }

    case "create": {
      const id = resolveId();
      if (state.packages[id] && !state.packages[id].deleted) {
        throw new Error(`Skill already exists: ${id}`);
      }
      const files = { ...(input.files ?? {}) };
      const content = input.content ?? files["SKILL.md"] ?? "";
      if (!content.trim()) throw new Error("skill_manage create requires SKILL.md content");
      files["SKILL.md"] = content;
      const etag = `W/"${sha256Hex(JSON.stringify(files)).slice(0, 24)}"`;
      const revision = `rev_${now}_1`;
      const parsed = parseMarkdownSections(content);
      const history = state.packages[id]?.history ?? [];
      history.push({ revision, etag, content, files, updatedAt: now });
      state.packages[id] = {
        id,
        key: `${id}/SKILL.md`,
        title: parsed.title,
        description: parsed.description,
        etag,
        revision,
        content,
        files,
        sections: parsed.sections,
        history,
        deleted: false,
        updatedAt: now,
      };
      saveSkillStoreState(state);
      return { action: "create", id, key: `${id}/SKILL.md`, etag, revision };
    }

    case "update": {
      const id = resolveId();
      const pkg = state.packages[id];
      if (!pkg || pkg.deleted) throw new Error(`Skill not found: ${id}`);
      if (!input.etag || input.etag !== pkg.etag) {
        throw new Error(`Skill ETag mismatch for ${id}: expected ${String(input.etag)}, actual ${pkg.etag}`);
      }
      const files = { ...pkg.files, ...(input.files ?? {}) };
      if (input.content !== undefined) files["SKILL.md"] = input.content;
      for (const rem of input.remove_files ?? []) {
        if (rem === "SKILL.md") throw new Error("Cannot remove SKILL.md from a Skill package");
        delete files[rem];
      }
      const content = files["SKILL.md"];
      const etag = `W/"${sha256Hex(JSON.stringify(files)).slice(0, 24)}"`;
      const revision = `rev_${now}_${pkg.history.length + 1}`;
      const parsed = parseMarkdownSections(content);
      pkg.content = content;
      pkg.files = files;
      pkg.title = parsed.title;
      pkg.description = parsed.description;
      pkg.sections = parsed.sections;
      pkg.etag = etag;
      pkg.revision = revision;
      pkg.updatedAt = now;
      pkg.history.push({ revision, etag, content, files, updatedAt: now });
      saveSkillStoreState(state);
      return { action: "update", id, key: pkg.key, etag, revision };
    }

    case "delete": {
      const id = resolveId();
      const pkg = state.packages[id];
      if (!pkg || pkg.deleted) throw new Error(`Skill not found: ${id}`);
      if (!input.etag || input.etag !== pkg.etag) {
        throw new Error(`Skill ETag mismatch on delete for ${id}: expected ${String(input.etag)}, actual ${pkg.etag}`);
      }
      pkg.deleted = true;
      pkg.updatedAt = now;
      saveSkillStoreState(state);
      return { action: "delete", id, key: pkg.key, deleted: true };
    }

    case "history": {
      const id = resolveId();
      const pkg = state.packages[id];
      if (!pkg) throw new Error(`Skill not found: ${id}`);
      return {
        action: "history",
        id: pkg.id,
        key: pkg.key,
        deleted: Boolean(pkg.deleted),
        revisions: pkg.history.map(h => ({
          revision: h.revision,
          etag: h.etag,
          updatedAt: h.updatedAt,
        })),
      };
    }

    case "restore": {
      const id = resolveId();
      const pkg = state.packages[id];
      if (!pkg) throw new Error(`Skill history not found: ${id}`);
      if (!input.revision) throw new Error("skill_manage restore requires revision");
      if (pkg.deleted) {
        if (input.expected_absent !== true) {
          throw new Error("Restoring a deleted Skill requires expected_absent: true");
        }
      } else if (!input.etag || input.etag !== pkg.etag) {
        throw new Error(`Restoring over an existing Skill requires current etag (${pkg.etag})`);
      }
      const target = pkg.history.find(h => h.revision === input.revision);
      if (!target) throw new Error(`Skill revision not found: ${input.revision}`);
      const revision = `rev_${now}_${pkg.history.length + 1}`;
      const etag = `W/"${sha256Hex(JSON.stringify(target.files) + ":" + revision).slice(0, 24)}"`;
      const parsed = parseMarkdownSections(target.content);
      pkg.deleted = false;
      pkg.content = target.content;
      pkg.files = { ...target.files };
      pkg.title = parsed.title;
      pkg.description = parsed.description;
      pkg.sections = parsed.sections;
      pkg.etag = etag;
      pkg.revision = revision;
      pkg.updatedAt = now;
      pkg.history.push({ revision, etag, content: pkg.content, files: pkg.files, updatedAt: now });
      saveSkillStoreState(state);
      return { action: "restore", id: pkg.id, key: pkg.key, restoredFrom: input.revision, revision, etag };
    }
  }
}

// ===========================================
// 5. Three-Role Prompt Compiler (main | scribe | muse) & Thinking Effort / Folders
// ===========================================

import {
  getSessionThinkingEffort,
  setSessionThinkingEffort,
  hasExplicitSessionThinkingEffort,
  resolveProviderReasoningEffort,
  type ThinkingEffortLevel,
} from "./request-budget.js";
export {
  getSessionThinkingEffort,
  setSessionThinkingEffort,
  hasExplicitSessionThinkingEffort,
  resolveProviderReasoningEffort,
  type ThinkingEffortLevel,
};

export function inspectCompiledPrompt(sessionId: string, role: "main" | "scribe" | "muse" = "main"): Record<string, unknown> {
  const memories = getRecentMemories(10);
  const pins = getPinsBySession(sessionId);
  const mapProjection = renderAgentMapProjection(sessionId);
  const hourSnap = new Date().toISOString().slice(0, 13) + ":00 UTC";

  const roleHeader =
    role === "scribe"
      ? "# Scribe: context cartographer\nRead immutable frozen Canvas history, update Session Agent Map via map_update, and finish with scribe_complete(continuity)."
      : role === "muse"
        ? "# Muse: restricted independent reflection peer\nInspect bounded action slice via muse_snapshot, optionally update Map node structure, and finish with muse_inject or muse_noop."
        : "# Lux: action-oriented general assistant (YOLO execution, frozen prefix cache aligned)";

  const compiled = [
    roleHeader,
    `<memory>\n${memories.map(m => `- [${m.id}] ${m.kind}: ${m.content.slice(0, 140)}`).join("\n") || "(empty)"}\n</memory>`,
    `<agent_map>\n${mapProjection}\n</agent_map>`,
    `<pins>\n${pins.map((p, idx) => `${idx + 1}. [pin-${p.id}] ${p.content}`).join("\n") || "(none)"}\n</pins>`,
    `<env>\ndate: ${hourSnap}\nsession_id: ${sessionId}\nrole: ${role}\nexecution: YOLO\n</env>`,
  ].join("\n\n");

  return {
    role,
    sessionId,
    frozenPrefixSha256: sha256Hex(compiled),
    estimatedTokens: estimateTokens(compiled),
    watermarks: { prepare: 0.5, replace: 0.9 },
    compiledPrompt: compiled,
  };
}

// ===========================================
// 6. Session Folders (Pure-Display Organization with CAS & Plan/Undo)
// ===========================================

interface SessionFolderItem {
  id: string;
  name: string;
  createdAt: number;
}

interface SessionFoldersState {
  revision: number;
  folders: Record<string, SessionFolderItem>;
  assignments: Record<string, string | null>;
  plans: Record<string, { planId: string; expectedRevision: number; operations: Array<Record<string, unknown>> }>;
  undos: Record<string, { undoId: string; revisionBefore: number; folders: Record<string, SessionFolderItem>; assignments: Record<string, string | null> }>;
  requestReceipts: Record<string, Record<string, unknown>>;
}

const FOLDERS_STORE_KEY = "__lux_cloud_session_folders__:v1";
const FOLDERS_STORE_KIND = "__lux_session_folders__";

export function manageSessionFolders(input: {
  action: "list" | "preview" | "apply" | "undo";
  folder?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  expected_revision?: number;
  request_id?: string;
  plan_id?: string;
  undo_id?: string;
  dry_run?: boolean;
  compact?: boolean;
  operations?: Array<{
    op: "create" | "rename" | "delete" | "assign" | "assign_many";
    id?: string;
    name?: string;
    target_id?: string;
    target_ids?: string[];
    folder_id?: string | null;
  }>;
}): Record<string, unknown> {
  const state = loadJsonRecord<SessionFoldersState>(FOLDERS_STORE_KEY, FOLDERS_STORE_KIND, () => ({
    revision: 1,
    folders: {},
    assignments: {},
    plans: {},
    undos: {},
    requestReceipts: {},
  }));

  if (input.request_id && state.requestReceipts[input.request_id]) {
    return state.requestReceipts[input.request_id];
  }

  const allSessions = listSessions();

  if (input.action === "list") {
    const q = (input.query ?? "").trim().toLowerCase();
    const filtered = allSessions.filter(s => {
      const assigned = state.assignments[s.id] ?? null;
      if (input.folder === "unfiled" && assigned !== null) return false;
      if (input.folder && input.folder !== "all" && input.folder !== "unfiled" && assigned !== input.folder) return false;
      if (q && !s.title.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      action: "list",
      revision: state.revision,
      folders: Object.values(state.folders),
      sessions: filtered.slice(0, input.limit ?? 50).map(s => ({
        id: s.id,
        title: s.title,
        folder_id: state.assignments[s.id] ?? null,
        updated_at: s.updated_at,
      })),
      total: filtered.length,
    };
  }

  if (input.action === "preview") {
    if (typeof input.expected_revision === "number" && input.expected_revision !== state.revision) {
      throw new Error(`Session folders revision mismatch: expected ${input.expected_revision}, actual ${state.revision}`);
    }
    const planId = `plan_${randomUUID().slice(0, 12)}`;
    state.plans[planId] = {
      planId,
      expectedRevision: state.revision,
      operations: (input.operations ?? []) as Array<Record<string, unknown>>,
    };
    saveJsonRecord(FOLDERS_STORE_KEY, FOLDERS_STORE_KIND, state);
    const receipt = {
      action: "preview",
      plan_id: planId,
      expected_revision: state.revision,
      operation_count: (input.operations ?? []).length,
    };
    if (input.request_id) state.requestReceipts[input.request_id] = receipt;
    saveJsonRecord(FOLDERS_STORE_KEY, FOLDERS_STORE_KIND, state);
    return receipt;
  }

  if (input.action === "apply") {
    const plan = input.plan_id ? state.plans[input.plan_id] : null;
    const expectedRev = plan ? plan.expectedRevision : input.expected_revision;
    if (typeof expectedRev === "number" && expectedRev !== state.revision) {
      throw new Error(`Session folders revision mismatch on apply: expected ${expectedRev}, actual ${state.revision}`);
    }
    const ops = (plan ? plan.operations : input.operations ?? []) as NonNullable<typeof input.operations>;
    if (input.dry_run === true && !input.plan_id) {
      return { action: "apply", dry_run: true, revision: state.revision, operation_count: ops.length };
    }
    const undoId = `undo_${randomUUID().slice(0, 12)}`;
    state.undos[undoId] = {
      undoId,
      revisionBefore: state.revision,
      folders: JSON.parse(JSON.stringify(state.folders)),
      assignments: JSON.parse(JSON.stringify(state.assignments)),
    };

    for (const op of ops) {
      if (op.op === "create") {
        const fid = op.id ?? `fld_${randomUUID().slice(0, 8)}`;
        state.folders[fid] = { id: fid, name: op.name ?? "Untitled Folder", createdAt: Date.now() };
      } else if (op.op === "rename" && op.id && state.folders[op.id] && op.name) {
        state.folders[op.id].name = op.name;
      } else if (op.op === "delete" && op.id) {
        delete state.folders[op.id];
        for (const [sid, fid] of Object.entries(state.assignments)) {
          if (fid === op.id) state.assignments[sid] = null;
        }
      } else if (op.op === "assign" && op.target_id) {
        state.assignments[op.target_id] = op.folder_id ?? null;
      } else if (op.op === "assign_many" && Array.isArray(op.target_ids)) {
        for (const tid of op.target_ids) state.assignments[tid] = op.folder_id ?? null;
      }
    }
    state.revision += 1;
    const receipt = {
      action: "apply",
      committed: true,
      revision: state.revision,
      undo_id: undoId,
      folder_count: Object.keys(state.folders).length,
    };
    if (input.request_id) state.requestReceipts[input.request_id] = receipt;
    saveJsonRecord(FOLDERS_STORE_KEY, FOLDERS_STORE_KIND, state);
    return receipt;
  }

  // undo
  if (!input.undo_id || !state.undos[input.undo_id]) {
    throw new Error(`Undo snapshot not found: ${String(input.undo_id)}`);
  }
  const snap = state.undos[input.undo_id];
  state.folders = snap.folders;
  state.assignments = snap.assignments;
  state.revision += 1;
  saveJsonRecord(FOLDERS_STORE_KEY, FOLDERS_STORE_KIND, state);
  return { action: "undo", restored: true, revision: state.revision };
}

export function autoScribePrepareWatermark(
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content: string; historyId?: number }>,
): { mapId: string | null; mapVersion: number; nodeAdded: boolean; cutoffOrdinal: number } {
  const mapState = loadSessionAgentMap(sessionId);
  const nonSystem = messages.filter(m => m.role !== "system");
  if (nonSystem.length === 0) {
    return { mapId: mapState.mapId, mapVersion: mapState.mapVersion, nodeAdded: false, cutoffOrdinal: 0 };
  }
  const latestUser = [...nonSystem].reverse().find(m => m.role === "user")?.content.slice(0, 120) ?? "Ongoing work";
  const summaryText = `Scribe 50% watermark checkpoint (${nonSystem.length} turns): ${latestUser}`;
  if (!mapState.rootNodeId) {
    const updated = executeAgentMapUpdate(sessionId, mapState.mapId, [
      {
        op: "add_node",
        ref: "root",
        title: `Session ${sessionId.slice(0, 8)} Exploration Root`,
        summary: summaryText,
      },
      {
        op: "focus_node",
        nodeId: "$root",
      },
    ]);
    return {
      mapId: updated.mapId as string,
      mapVersion: updated.mapVersion as number,
      nodeAdded: true,
      cutoffOrdinal: nonSystem.length,
    };
  }
  return {
    mapId: mapState.mapId,
    mapVersion: mapState.mapVersion,
    nodeAdded: false,
    cutoffOrdinal: nonSystem.length,
  };
}

export function renderSessionLuxCloudContextBlocks(sessionId: string): string[] {
  const blocks: string[] = [];
  const mapState = loadSessionAgentMap(sessionId);
  if (mapState.rootNodeId && Object.keys(mapState.nodes).length > 0) {
    blocks.push(`<agent_map>\n${renderAgentMapProjection(sessionId)}\n</agent_map>`);
  }
  const canvasStore = loadSessionCanvasStore(sessionId);
  if (canvasStore.coldBlocks.length > 0 || canvasStore.continuitySummary) {
    const coverage = {
      cutoff: canvasStore.coldBlocks.length,
      map_id: mapState.mapId,
      map_version: mapState.mapVersion,
    };
    blocks.push(`<coverage>\n已提交的历史覆盖 watermark：${JSON.stringify(coverage)}${canvasStore.continuitySummary ? `\n${canvasStore.continuitySummary}` : ""}\n</coverage>`);
  }
  const skillReceipts = listStoreSkillReceipts(sessionId).receipts as Array<{ id: string; key: string; etag: string; sections: string[]; valid: boolean }>;
  if (Array.isArray(skillReceipts) && skillReceipts.length > 0) {
    const lines = skillReceipts.map(r => `- [${r.id}] (${r.key}, etag=${r.etag}, valid=${r.valid}) sections: ${r.sections.join(", ")}`);
    blocks.push(`<loaded_skills>\n${lines.join("\n")}\n</loaded_skills>`);
  }
  return blocks;
}

export { insertPin, getPinsBySession, deletePin };
