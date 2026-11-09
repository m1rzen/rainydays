// ===========================================
// Lux-Cloud Native Tools Suite (LC-01 .. LC-05)
// Implements the 39 Lux-Cloud native tools missing or aliased in RainyDays
// ===========================================

import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { LLMClient } from "../llm.js";
import type { ConversationMemory } from "../memory.js";
import type { ToolDefinition, ToolExecutor } from "../types.js";
import {
  getMessagesBySession,
  insertCronJob,
  listSessions,
  getSession,
  listMemories,
} from "../db.js";
import { parseCronDurationMs } from "../cron.js";
import { listProfiles } from "../config.js";
import {
  insertPin,
  getPinsBySession,
  deletePin,
  createOrUpdateKnowledge,
  executeAgentMapUpdate,
  viewSessionAgentMap,
  searchSessionAgentMap,
  readToolResultBlock,
  archiveMessagesToColdStore,
  canvasHistoryOverview,
  canvasHistorySearch,
  canvasHistoryInspect,
  searchStoreSkills,
  loadStoreSkillForSession,
  releaseStoreSkillForSession,
  listStoreSkillReceipts,
  manageStoreSkill,
  getSessionThinkingEffort,
  setSessionThinkingEffort,
  inspectCompiledPrompt,
  manageSessionFolders,
  type AgentMapOperation,
  type ThinkingEffortLevel,
} from "../lux-cloud-runtime.js";

function resolveSessionId(env?: Record<string, string>): string {
  return env?._SESSION_ID || "default-session";
}

// ===========================================
// 1. Canvas & Context Tools: pin, unpin, context_usage, compact_context, tool_result_read, canvas_history_*, prompt_inspect
// ===========================================

export const pinDef: ToolDefinition = {
  type: "function",
  function: {
    name: "pin",
    description: "Persist Session-only context. content:string.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Semantic constraint or decision to pin in this Session." },
      },
      required: ["content"],
    },
  },
};

export const pinExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("pin requires non-empty content");
  const id = insertPin(sessionId, content);
  const pins = getPinsBySession(sessionId);
  return JSON.stringify({
    status: "pinned",
    blockId: `pin-${id}`,
    index: pins.findIndex(p => p.id === id) + 1,
    totalPins: pins.length,
    content,
  }, null, 2);
};

export const unpinDef: ToolDefinition = {
  type: "function",
  function: {
    name: "unpin",
    description: "List pins with no selector ({} or null selectors). Remove one with blockId:string or index:1-based integer. Set all:true to remove every pin in this Session.",
    parameters: {
      type: "object",
      properties: {
        blockId: { type: ["string", "null"], description: "Pin block ID to remove (e.g. pin-1); omit or null when using index or listing." },
        index: { type: ["integer", "null"], minimum: 1, description: "1-based pin index to remove; omit or null when using blockId or listing." },
        all: { type: ["boolean", "null"], description: "Set true to remove all pins in this Session." },
      },
    },
  },
};

export const unpinExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const pins = getPinsBySession(sessionId);
  const blockId = typeof args.blockId === "string" ? args.blockId.trim() : null;
  const index = typeof args.index === "number" ? args.index : null;
  const all = args.all === true;

  if (!blockId && index === null && !all) {
    return JSON.stringify({
      action: "list",
      totalPins: pins.length,
      pins: pins.map((p, idx) => ({
        index: idx + 1,
        blockId: `pin-${p.id}`,
        content: p.content,
        created_at: p.created_at,
      })),
    }, null, 2);
  }

  if (all) {
    for (const p of pins) deletePin(p.id);
    return JSON.stringify({ action: "unpin_all", removedCount: pins.length, remainingPins: 0 }, null, 2);
  }

  let target = null;
  if (blockId) {
    const numericId = Number.parseInt(blockId.replace(/^pin-/i, ""), 10);
    target = pins.find(p => p.id === numericId || `pin-${p.id}` === blockId) ?? null;
  } else if (index !== null) {
    target = pins[index - 1] ?? null;
  }

  if (!target) {
    throw new Error(`Pin not found for selector: ${blockId ?? `index=${index}`}`);
  }
  deletePin(target.id);
  const remaining = getPinsBySession(sessionId);
  return JSON.stringify({
    action: "unpin",
    removedBlockId: `pin-${target.id}`,
    removedContent: target.content,
    remainingPins: remaining.map((p, idx) => ({ index: idx + 1, blockId: `pin-${p.id}`, content: p.content })),
  }, null, 2);
};

export const contextUsageDef: ToolDefinition = {
  type: "function",
  function: {
    name: "context_usage",
    description: "Current context usage (measured at the latest model request) and tokens left before automatic compaction. Compaction keeps history recoverable.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const contextUsageExec: ToolExecutor = async (_args, env) => {
  const sessionId = resolveSessionId(env);
  const messages = getMessagesBySession(sessionId);
  const pins = getPinsBySession(sessionId);
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0) + pins.reduce((sum, p) => sum + p.content.length, 0);
  const usedTokens = Math.ceil(totalChars / 3.2);
  const contextWindowTokens = 28000;
  const prepareWatermarkTokens = Math.floor(contextWindowTokens * 0.5);
  const replaceWatermarkTokens = Math.floor(contextWindowTokens * 0.9);
  return JSON.stringify({
    sessionId,
    messageCount: messages.length,
    pinCount: pins.length,
    usedTokens,
    contextWindowTokens,
    prepareWatermarkTokens,
    replaceWatermarkTokens,
    tokensLeftBeforeCompaction: Math.max(0, replaceWatermarkTokens - usedTokens),
  }, null, 2);
};

export const compactContextDef: ToolDefinition = {
  type: "function",
  function: {
    name: "compact_context",
    description: "Run an isolated curator agent that progressively inspects and summarizes the completed working context, then continue with its replacement window.",
    parameters: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "What the next stage needs: facts, decisions, constraints and evidence to retain. Never overrides user instructions or pins.",
        },
      },
    },
  },
};

export function createCompactContextExec(memory: ConversationMemory, llm: LLMClient): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("Tool invocation services are required");
    const focus = typeof args.focus === "string" ? args.focus.trim() : "";
    const tokensBefore = memory.getTokenEstimate();
    const compacted = await memory.compact(llm, invocation.signal, invocation.network.fetch, { force: true, ...(focus ? { focus } : {}) });
    return JSON.stringify({ status: compacted ? "compacted" : "nothing_to_compact", focus: focus || null, tokens_before: tokensBefore, tokens_after: memory.getTokenEstimate(), summary_generation: memory.getSummaryGeneration() }, null, 2);
  };
}

export const toolResultReadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "tool_result_read",
    description: "Read a saved tool-result block from this Session only, including oversized results represented by previews. blockId:string, offset?:Unicode character offset, maxChars?:1..12000.",
    parameters: {
      type: "object",
      properties: {
        blockId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 12000 },
      },
      required: ["blockId"],
    },
  },
};

export const toolResultReadExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const blockId = String(args.blockId ?? "");
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const maxChars = typeof args.maxChars === "number" ? args.maxChars : 6000;
  return JSON.stringify(readToolResultBlock(sessionId, blockId, offset, maxChars), null, 2);
};

export const canvasHistoryOverviewDef: ToolDefinition = {
  type: "function",
  function: {
    name: "canvas_history_overview",
    description: "Cold-only indexed page, after?:ordinal, limit?:int; never rehydrates hot context.",
    parameters: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 0 },
      },
    },
  },
};

export const canvasHistoryOverviewExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const after = typeof args.after === "number" ? args.after : 0;
  const limit = typeof args.limit === "number" ? args.limit : 20;
  return JSON.stringify(canvasHistoryOverview(sessionId, after, limit), null, 2);
};

export const canvasHistorySearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "canvas_history_search",
    description: "Cold-only bounded scan query:string, after?:ordinal, limit?:int. Continue using next_after.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        after: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 0 },
      },
      required: ["query"],
    },
  },
};

export const canvasHistorySearchExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const query = String(args.query ?? "");
  const after = typeof args.after === "number" ? args.after : 0;
  const limit = typeof args.limit === "number" ? args.limit : 20;
  return JSON.stringify(canvasHistorySearch(sessionId, query, after, limit), null, 2);
};

export const canvasHistoryInspectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "canvas_history_inspect",
    description: "Cold-only blockId:string, offset?:character offset, maxChars?:int; private payload excluded.",
    parameters: {
      type: "object",
      properties: {
        blockId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 12000 },
      },
      required: ["blockId"],
    },
  },
};

export const canvasHistoryInspectExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const blockId = String(args.blockId ?? "");
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const maxChars = typeof args.maxChars === "number" ? args.maxChars : 6000;
  return JSON.stringify(canvasHistoryInspect(sessionId, blockId, offset, maxChars), null, 2);
};

export const promptInspectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "prompt_inspect",
    description: "Inspect compiled external prompt and budgets, role?:main|scribe|muse.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["main", "scribe", "muse"] },
      },
    },
  },
};

export const promptInspectExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const role = (args.role as "main" | "scribe" | "muse" | undefined) ?? "main";
  return JSON.stringify(inspectCompiledPrompt(sessionId, role), null, 2);
};

// ===========================================
// 2. Session Agent Map Tools: map_view, map_search, map_update
// ===========================================

export const mapViewDef: ToolDefinition = {
  type: "function",
  function: {
    name: "map_view",
    description: "Read exploration tree: nodeId?, depth?, includeNotes?, cursor?. Not a task state machine.",
    parameters: {
      type: "object",
      properties: {
        nodeId: { type: ["string", "null"] },
        depth: { type: ["integer", "null"], minimum: 0 },
        includeNotes: { type: ["boolean", "null"] },
        cursor: { type: ["string", "integer", "null"] },
      },
    },
  },
};

export const mapViewExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(
    viewSessionAgentMap(sessionId, {
      nodeId: args.nodeId as string | null | undefined,
      depth: args.depth as number | null | undefined,
      includeNotes: args.includeNotes as boolean | null | undefined,
      cursor: args.cursor as string | number | null | undefined,
    }),
    null,
    2,
  );
};

export const mapSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "map_search",
    description: "Search Session Map nodes and referenced Notes. query:string, limit?:int.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: ["integer", "null"], minimum: 0 },
        cursor: { type: ["string", "integer", "null"] },
      },
      required: ["query"],
    },
  },
};

export const mapSearchExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const query = String(args.query ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 20;
  return JSON.stringify(searchSessionAgentMap(sessionId, query, limit, args.cursor as string | number | null | undefined), null, 2);
};

export const mapUpdateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "map_update",
    description: "Atomic node CAS: expectedMapId:null|string, operations:array; each existing target node requires expectedLastActionSeq from map_view/search.",
    parameters: {
      type: "object",
      properties: {
        expectedMapId: { type: ["string", "null"] },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "add_node",
                  "update_node",
                  "move_node",
                  "remove_node",
                  "focus_node",
                  "clear_focus",
                  "create_note",
                  "attach_note",
                  "detach_note",
                  "update_note",
                  "refresh_projection",
                ],
              },
              ref: { type: ["string", "null"] },
              nodeId: { type: ["string", "null"] },
              parentId: { type: ["string", "null"] },
              title: { type: ["string", "null"] },
              summary: { type: ["string", "null"] },
              expectedLastActionSeq: { type: ["integer", "null"], minimum: 0 },
              noteId: { type: ["string", "null"] },
              content: { type: "string" },
              kind: { type: "string" },
              scope: { type: "string", enum: ["project", "global"] },
              tags: { type: "array", items: { type: "string" } },
              expectedRevision: { type: "integer", minimum: 0 },
              reason: { type: ["string", "null"] },
              requestFingerprint: { type: ["string", "null"] },
            },
            required: ["op"],
          },
        },
      },
      required: ["expectedMapId", "operations"],
    },
  },
};

export const mapUpdateExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const expectedMapId = (args.expectedMapId as string | null) ?? null;
  const operations = (args.operations as AgentMapOperation[]) ?? [];
  return JSON.stringify(executeAgentMapUpdate(sessionId, expectedMapId, operations), null, 2);
};

// ===========================================
// 3. Knowledge Graph CAS & Consolidation Tools: knowledge_update, consolidate_memory
// ===========================================

export const knowledgeUpdateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "knowledge_update",
    description: "Create or CAS-update private knowledge. op:create|update, type:node|edge|note, scope:global|project; update requires id and expectedRevision.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "update"] },
        type: { type: "string", enum: ["node", "edge", "note"] },
        scope: { type: "string", enum: ["project", "global"] },
        id: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
        name: { type: "string" },
        kind: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        relation: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export const knowledgeUpdateExec: ToolExecutor = async (args) => {
  return JSON.stringify(
    createOrUpdateKnowledge({
      op: args.op as "create" | "update" | undefined,
      type: args.type as "node" | "edge" | "note" | undefined,
      scope: args.scope as "project" | "global" | undefined,
      id: args.id as string | undefined,
      expectedRevision: args.expectedRevision as number | undefined,
      name: args.name as string | undefined,
      kind: args.kind as string | undefined,
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      relation: args.relation as string | undefined,
      content: args.content as string | undefined,
      tags: args.tags as string[] | undefined,
    }),
    null,
    2,
  );
};

export const consolidateMemoryDef: ToolDefinition = {
  type: "function",
  function: {
    name: "consolidate_memory",
    description: "Run an ordinary memory peer now. Deep extracts entities/relations and can browse scoped Sessions; shallow saves/anchors notes only.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["shallow", "deep"] },
        hint: { type: "string" },
      },
    },
  },
};

const CONSOLIDATE_PROMPT = `从以下记忆中提取实体和关系，只使用明确出现的信息，不要猜测。只返回 JSON：{"entities":[{"name":"实体名","kind":"person|project|org|tech|product|concept"}],"edges":[{"src":"源实体名","dst":"目标实体名","relation":"动词关系"}]}`;

function parseExtraction(text: string): { entities: Array<{ name?: unknown; kind?: unknown }>; edges: Array<{ src?: unknown; dst?: unknown; relation?: unknown }> } {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return { entities: Array.isArray(value.entities) ? value.entities : [], edges: Array.isArray(value.edges) ? value.edges : [] };
  } catch { throw new Error("模型没有返回有效的 JSON，知识图谱未写入"); }
}

/** shallow 只把近期记忆锚定为 Note；deep 由模型提取实体和关系后写入图谱。 */
export function createConsolidateMemoryExec(llm?: LLMClient): ToolExecutor {
  return async (args, _env, invocation) => {
    const level = (args.level as "shallow" | "deep" | undefined) ?? "deep";
    const hint = typeof args.hint === "string" ? args.hint.trim() : "";
    const recent = listMemories(10);
    if (level === "deep" && (!llm || !invocation)) throw new Error("deep 整理需要可用的模型");
    const createdNotes: string[] = [], createdNodes: string[] = [], createdEdges: string[] = [];
    if (level === "deep" && recent.length > 0) {
      const response = await llm!.chat([
        { role: "system", content: CONSOLIDATE_PROMPT },
        { role: "user", content: `${hint ? `关注点：${hint}\n` : ""}${recent.map((memory, index) => `[${index + 1}] (${memory.kind}) ${memory.content}`).join("\n")}` },
      ], undefined, invocation!.signal, invocation!.network.fetch);
      const extraction = parseExtraction(typeof response.content === "string" ? response.content : "");
      const ids = new Map<string, string>();
      for (const entity of extraction.entities) {
        if (typeof entity.name !== "string" || !entity.name.trim() || ids.has(entity.name)) continue;
        const id = (createOrUpdateKnowledge({ op: "create", type: "node", scope: "project", name: entity.name, kind: typeof entity.kind === "string" ? entity.kind : "concept", tags: [] }).entry as { id: string }).id;
        ids.set(entity.name, id); createdNodes.push(id);
      }
      for (const edge of extraction.edges) {
        const from = ids.get(String(edge.src)), to = ids.get(String(edge.dst));
        if (!from || !to || typeof edge.relation !== "string" || !edge.relation.trim()) continue;
        createdEdges.push((createOrUpdateKnowledge({ op: "create", type: "edge", scope: "project", from, to, relation: edge.relation, tags: [] }).entry as { id: string }).id);
      }
    }
    for (const memory of recent.slice(0, 5)) {
      let tags: string[] = [];
      try { tags = JSON.parse(memory.tags || "[]"); } catch { /* ignore */ }
      createdNotes.push((createOrUpdateKnowledge({ op: "create", type: "note", scope: "project", kind: memory.kind || "observation", content: hint ? `[${hint}] ${memory.content}` : memory.content, tags }).entry as { id: string }).id);
    }
    return JSON.stringify({ status: "consolidated", level, hint: hint || null, anchoredNotes: createdNotes, extractedNodes: createdNodes, extractedEdges: createdEdges }, null, 2);
  };
}
export const consolidateMemoryExec = createConsolidateMemoryExec();

// ===========================================
// 4. Store-Backed Zero-Preload Skill Tools: skill_search, skill_load, skill_reload, skill_release, skill_status, skill_manage
// ===========================================

export const skillSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_search",
    description: "Discover external Markdown Skill metadata/sections only. query:string, limit:int.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["query"],
    },
  },
};

export const skillSearchExec: ToolExecutor = async (args) => {
  return JSON.stringify(
    searchStoreSkills(String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 20, args.cursor as string | undefined),
    null,
    2,
  );
};

export const skillLoadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_load",
    description: "Explicitly load id:string, sections?:string[], maxTokens?:int; Store-backed context projected into model prompts; repeat loads deduplicate.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        sections: { type: "array", items: { type: "string" } },
        maxTokens: { type: "integer", minimum: 1, maximum: 8000 },
      },
      required: ["id"],
    },
  },
};

export const skillLoadExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(
    loadStoreSkillForSession(
      sessionId,
      String(args.id ?? ""),
      args.sections as string[] | undefined,
      typeof args.maxTokens === "number" ? args.maxTokens : 4000,
      false,
    ),
    null,
    2,
  );
};

export const skillReloadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_reload",
    description: "Explicitly re-read a Skill. Same arguments as skill_load.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        sections: { type: "array", items: { type: "string" } },
        maxTokens: { type: "integer", minimum: 1, maximum: 8000 },
      },
      required: ["id"],
    },
  },
};

export const skillReloadExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(
    loadStoreSkillForSession(
      sessionId,
      String(args.id ?? ""),
      args.sections as string[] | undefined,
      typeof args.maxTokens === "number" ? args.maxTokens : 4000,
      true,
    ),
    null,
    2,
  );
};

export const skillReleaseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_release",
    description: "Release receipt id:string; cannot erase historical tool results.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
};

export const skillReleaseExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(releaseStoreSkillForSession(sessionId, String(args.id ?? "")), null, 2);
};

export const skillStatusDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_status",
    description: "List persisted receipts; does not read files; reports explicit validation and residency.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const skillStatusExec: ToolExecutor = async (_args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(listStoreSkillReceipts(sessionId), null, 2);
};

export const skillManageDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_manage",
    description: "Manage current-user Base Skill packages: list/read/create/update/delete/history/restore. update/delete require current etag.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "create", "update", "delete", "history", "restore"] },
        id: { type: "string", minLength: 1 },
        key: { type: "string", minLength: 1 },
        etag: { type: "string", minLength: 1 },
        expected_absent: { type: "boolean" },
        content: { type: "string" },
        file: { type: "string" },
        files: { type: "object" },
        remove_files: { type: "array", items: { type: "string" } },
        package_base64: { type: "string" },
        revision: { type: "string", minLength: 1 },
        query: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 1, maximum: 65536 },
      },
      required: ["action"],
    },
  },
};

export const skillManageExec: ToolExecutor = async (args) => {
  return JSON.stringify(
    manageStoreSkill({
      action: args.action as "list" | "read" | "create" | "update" | "delete" | "history" | "restore",
      id: args.id as string | undefined,
      key: args.key as string | undefined,
      etag: args.etag as string | undefined,
      expected_absent: args.expected_absent as boolean | undefined,
      content: args.content as string | undefined,
      file: args.file as string | undefined,
      files: args.files as Record<string, string> | undefined,
      remove_files: args.remove_files as string[] | undefined,
      revision: args.revision as string | undefined,
      query: args.query as string | undefined,
      limit: args.limit as number | undefined,
      offset: args.offset as number | undefined,
      max_bytes: args.max_bytes as number | undefined,
    }),
    null,
    2,
  );
};

// ===========================================
// 5. Subagents, Models, Thinking Effort, Session Folders & Idle Cron
// ===========================================

export const modelsListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "models_list",
    description: "List currently available Provider/model profiles for this account.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const modelsListExec: ToolExecutor = async () => {
  try {
    const profiles = listProfiles();
    const def = profiles.find(p => p.isDefault)?.name ?? profiles[0]?.name ?? null;
    return JSON.stringify({
      defaultProfileId: def,
      models: profiles.map(p => ({
        id: p.name,
        display_label: `${p.providerType} / ${p.model}`,
        provider: p.providerType,
        model: p.model,
        isCurrent: p.isCurrent,
        isDefault: p.isDefault,
      })),
    }, null, 2);
  } catch {
    return JSON.stringify({
      defaultProfileId: "default",
      models: [{ id: "default", display_label: "Default / Configured Model" }],
    }, null, 2);
  }
};

export const thinkingEffortGetDef: ToolDefinition = {
  type: "function",
  function: {
    name: "thinking_effort_get",
    description: "Read current thinking effort and the current model's supported levels.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const thinkingEffortGetExec: ToolExecutor = async (_args, env) => {
  const sessionId = resolveSessionId(env);
  return JSON.stringify(getSessionThinkingEffort(sessionId), null, 2);
};

export const thinkingEffortSetDef: ToolDefinition = {
  type: "function",
  function: {
    name: "thinking_effort_set",
    description: "Set thinking effort. First read thinking_effort_get; applies to the next Provider request.",
    parameters: {
      type: "object",
      properties: {
        effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["effort"],
    },
  },
};

export const thinkingEffortSetExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const effort = args.effort as ThinkingEffortLevel;
  return JSON.stringify(setSessionThinkingEffort(sessionId, effort), null, 2);
};


export const agentSpawnDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_spawn",
    description: "Create a child agent Session and start its task.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        name: { type: "string" },
        model: { type: ["string", "null"] },
        allow_subagent: { type: "boolean" },
      },
      required: ["task"],
    },
  },
};

export const agentListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_list",
    description: "List subordinate agents (current, default) or Sessions in this user Base (all), newest activity first.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["current", "all"] },
        status: { type: "array", items: { type: "string", enum: ["streaming", "idle", "error", "interrupted"] } },
        query: { type: "string", maxLength: 256 },
        updated_after: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: ["string", "null"] },
      },
    },
  },
};

export const agentPeekDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_peek",
    description: "Inspect another agent: current state, stored conversation and an unfinished turn.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["status", "brief", "last", "recent", "full"] },
        turn: { type: "number" },
      },
      required: ["id"],
    },
  },
};

export const agentPostDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_post",
    description: "Send guidance to a running subagent, or stop it with abort. A finished subagent cannot receive messages; spawn a new one.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        message: { type: "string" },
        mode: { type: "string", enum: ["reply", "alert"] },
        abort: { type: "boolean" },
      },
      required: ["id", "message"],
    },
  },
};

export const agentWaitDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_wait",
    description: "Wait until a subagent finishes or the timeout (seconds, default 60, max 300) passes. async is not supported.",
    parameters: {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: {
            session: { type: "string" },
            on: { type: "string", enum: ["idle", "error", "any"] },
          },
          required: ["session"],
        },
        async: { type: "boolean" },
        persistent: { type: "boolean" },
        timeout: { type: "number" },
      },
      required: ["event"],
    },
  },
};

export const agentCancelWaitDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_cancel_wait",
    description: "Cancel an async agent_wait subscription by its id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
};

export const agentCloseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_close",
    description: "Close an agent Session by id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
};

export const mainAgentInspectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "main_agent_inspect",
    description: "Inspect the parent/origin agent bound to this subagent.",
    parameters: {
      type: "object",
      properties: {
        depth: { type: "string", enum: ["summary", "evidence"] },
        turn: { type: "number" },
      },
    },
  },
};

export const mainAgentInspectExec: ToolExecutor = async (args, env) => {
  const parentId = resolveSessionId(env);
  const msgs = getMessagesBySession(parentId);
  const depth = (args.depth as "summary" | "evidence" | undefined) ?? "summary";
  if (depth === "summary") {
    return JSON.stringify({
      parent_session_id: parentId,
      messageCount: msgs.length,
      latestMessage: msgs.at(-1)?.content.slice(0, 300) ?? null,
    }, null, 2);
  }
  const turn = typeof args.turn === "number" ? args.turn : 0;
  const targetMsg = msgs[Math.max(0, msgs.length - 1 - turn)] ?? null;
  return JSON.stringify({
    parent_session_id: parentId,
    turn,
    message: targetMsg,
  }, null, 2);
};

export const sessionFoldersDef: ToolDefinition = {
  type: "function",
  function: {
    name: "session_folders",
    description: "Organize pure-display Session folders without waking Sessions or changing projects.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "preview", "apply", "undo"] },
        folder: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
        expected_revision: { type: "integer", minimum: 0 },
        request_id: { type: "string", minLength: 1 },
        plan_id: { type: "string", minLength: 1 },
        undo_id: { type: "string", minLength: 1 },
        dry_run: { type: "boolean" },
        compact: { type: "boolean" },
        operations: {
          type: "array",
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["create", "rename", "delete", "assign", "assign_many"] },
              id: { type: "string" },
              name: { type: "string" },
              target_id: { type: "string" },
              target_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 },
              folder_id: { type: ["string", "null"] },
            },
            required: ["op"],
          },
        },
      },
      required: ["action"],
    },
  },
};

export const sessionFoldersExec: ToolExecutor = async (args) => {
  return JSON.stringify(
    manageSessionFolders({
      action: args.action as "list" | "preview" | "apply" | "undo",
      folder: args.folder as string | undefined,
      query: args.query as string | undefined,
      limit: args.limit as number | undefined,
      cursor: args.cursor as string | undefined,
      expected_revision: args.expected_revision as number | undefined,
      request_id: args.request_id as string | undefined,
      plan_id: args.plan_id as string | undefined,
      undo_id: args.undo_id as string | undefined,
      dry_run: args.dry_run as boolean | undefined,
      compact: args.compact as boolean | undefined,
      operations: args.operations as Parameters<typeof manageSessionFolders>[0]["operations"],
    }),
    null,
    2,
  );
};

export const cronScheduleOnIdleDef: ToolDefinition = {
  type: "function",
  function: {
    name: "cron_schedule_on_idle",
    description: "Schedule a delayed or repeating message for this Session, delivered only when the Session is idle.",
    parameters: {
      type: "object",
      properties: {
        delay: { type: "string" },
        message: { type: "string" },
        repeat: { type: "string" },
        tag: { type: "string" },
      },
      required: ["delay", "message"],
    },
  },
};

export const cronScheduleOnIdleExec: ToolExecutor = async (args, env) => {
  const sessionId = resolveSessionId(env);
  const delay = String(args.delay ?? "");
  const message = String(args.message ?? "");
  const repeat = typeof args.repeat === "string" ? args.repeat : undefined;
  const tag = typeof args.tag === "string" ? args.tag : "on-idle";
  const fireAt = new Date(Date.now() + parseCronDurationMs(delay)).toISOString();
  if (repeat !== undefined) parseCronDurationMs(repeat);
  const id = insertCronJob({
    session_id: sessionId,
    target_session_id: sessionId,
    broadcast: 0,
    message,
    fire_at: fireAt,
    interval: repeat ?? null,
    tag,
  });
  return JSON.stringify({
    id,
    session_id: sessionId,
    delivery_mode: "on_idle",
    fire_at: fireAt,
    repeat: repeat ?? null,
    tag,
  }, null, 2);
};

// ===========================================
// 6. Worker Plane & Web Preview Tools: worker_pairing_claim, worker_file_upload, worker_file_download, preview_web/list/close
// ===========================================

const webPreviews = new Map<string, { id: string; ports: number[]; ttl_seconds: number; worker_id: string; urls: string[]; created_at: number }>();

export const workerPairingClaimDef: ToolDefinition = {
  type: "function",
  function: {
    name: "worker_pairing_claim",
    description: "Claim a device-generated Worker pairing code for this Core's bound user only.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
};

const NO_REMOTE_WORKERS = "RainyDays 目前是单机版，没有远端 Worker 服务，这项操作不可用。请直接使用 read、write 或 execute_command 在本机操作。";

export const workerPairingClaimExec: ToolExecutor = async () => { throw new Error(NO_REMOTE_WORKERS); };

export const workerFileUploadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "worker_file_upload",
    description: "Upload a file to the Session-scoped transfer store.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        worker_id: { type: "string" },
      },
      required: ["file_path"],
    },
  },
};

export const workerFileUploadExec: ToolExecutor = async () => { throw new Error(NO_REMOTE_WORKERS); };

export const workerFileDownloadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "worker_file_download",
    description: "Download a Session-scoped transfer file onto this Worker.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        output_path: { type: "string" },
        overwrite: { type: "boolean" },
        worker_id: { type: "string" },
      },
      required: ["file_id", "output_path"],
    },
  },
};

export const workerFileDownloadExec: ToolExecutor = async () => { throw new Error(NO_REMOTE_WORKERS); };

export const previewWebDef: ToolDefinition = {
  type: "function",
  function: {
    name: "preview_web",
    description: "Register one to four local Web ports and check whether each is listening. Local only: no public tunnel is created.",
    parameters: {
      type: "object",
      properties: {
        ports: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "integer", minimum: 1024, maximum: 65535 },
        },
        ttl_seconds: { type: "integer", minimum: 60, maximum: 3600 },
        worker_id: { type: "string" },
      },
      required: ["ports"],
    },
  },
};

function probeLocalPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** 没有公网隧道：只登记本机地址，并如实探测端口是否有服务在监听。 */
export const previewWebExec: ToolExecutor = async (args) => {
  const ports = (args.ports as number[]) ?? [];
  const ttl = typeof args.ttl_seconds === "number" ? args.ttl_seconds : 3600;
  const workerId = (args.worker_id as string | undefined) ?? "local-worker";
  const id = `prv_${randomUUID().slice(0, 10)}`;
  const urls = ports.map(p => `http://127.0.0.1:${p}`);
  const listening = await Promise.all(ports.map(probeLocalPort));
  webPreviews.set(id, { id, ports, ttl_seconds: ttl, worker_id: workerId, urls, created_at: Date.now() });
  return JSON.stringify({
    id, worker_id: workerId, ports, ttl_seconds: ttl, local_only: true,
    target_ready: listening.length > 0 && listening.every(Boolean),
    targets: ports.map((p, idx) => ({ port: p, url: urls[idx], listening: listening[idx], tunnel_connected: false })),
  }, null, 2);
};

export const previewListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "preview_list",
    description: "List active preview mappings for the selected or specified owned managed Worker.",
    parameters: {
      type: "object",
      properties: {
        worker_id: { type: "string" },
      },
    },
  },
};

export const previewListExec: ToolExecutor = async (args) => {
  const workerId = args.worker_id as string | undefined;
  const list = [...webPreviews.values()].filter(p => !workerId || p.worker_id === workerId);
  return JSON.stringify({ previews: list }, null, 2);
};

export const previewCloseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "preview_close",
    description: "Revoke a preview group and close all its connections.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        worker_id: { type: "string" },
      },
      required: ["id"],
    },
  },
};

export const previewCloseExec: ToolExecutor = async (args) => {
  const id = String(args.id ?? "");
  const closed = webPreviews.delete(id);
  return JSON.stringify({ id, closed }, null, 2);
};
