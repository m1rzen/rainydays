// ===========================================
// 第四优先工具集合 —— Oracle/Playbook/Link/Wire
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { LLMClient } from "../llm.js";
import {
  saveOracle, queryOracle, getOracleStatus,
} from "../oracle.js";import {
  listPlaybooks, createPlaybook, listActiveRuns, getRunStatus,
  type Playbook, type PlaybookOwner,
} from "../playbook.js";
import { discoverSessions, peekSession } from "../link.js";
import { postSessionLinkMessage } from "../session.js";
import { getDefaultPollManager } from "../poll.js";
import { isSupervisorEnabled, getSupervisorRules } from "../supervisor.js";

// ========== Oracle ==========
export const oracleQueryDef: ToolDefinition = {
  type: "function",
  function: {
    name: "oracle_query",
    description: "向项目知识库 Oracle 提问。Oracle 包含项目目录结构和关键文件内容快照。",
    parameters: { type: "object", properties: { question: { type: "string", description: "关于项目的问题" } }, required: ["question"] },
  },
};

export function createOracleQueryExec(llm: LLMClient): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("Tool invocation services are required");
    return queryOracle(llm, args.question as string, invocation.signal, invocation.network.fetch);
  };
}

export const oracleSaveDef: ToolDefinition = {
  type: "function",
  function: {
    name: "oracle_save",
    description: "保存当前项目的知识快照到 Oracle。之后可以用 oracle_query 查询项目结构信息。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要保存快照的项目根路径" },
      },
      required: ["path"],
    },
  },
};

export const oracleSaveExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Oracle project Path gateway is required");
  const projectPath = args.path as string;
  return await saveOracle(projectPath, invocation.path);
};

export const oracleStatusDef: ToolDefinition = {
  type: "function",
  function: {
    name: "oracle_status",
    description: "查看 Oracle 知识库的状态（是否已加载、项目路径、创建时间）。",
    parameters: { type: "object", properties: {} },
  },
};

export const oracleStatusExec: ToolExecutor = async () => {
  const status = await getOracleStatus();
  if (!status.loaded) return "Oracle 未初始化。请先用 oracle_save 保存项目快照。";
  return `Oracle 已加载\n项目: ${status.projectPath}\n创建时间: ${status.createdAt}`;
};

// ========== Playbook ==========
function playbookOwner(env?: Readonly<Record<string, string>>): PlaybookOwner {
  const sessionId = env?._SESSION_ID;
  const runId = env?._CAPABILITY_RUN_ID;
  if (!sessionId || !runId) throw new Error("缺少Broker签发的Playbook owner");
  return { sessionId, runId };
}

export const playbookListDef: ToolDefinition = {
  type: "function",
  function: { name: "playbook_list", description: "列出所有可用的 Playbook 自动化脚本。", parameters: { type: "object", properties: {} } },
};
export const playbookListExec: ToolExecutor = async () => {
  const pbs = await listPlaybooks();
  if (pbs.length === 0) return "没有 Playbook。";
  return pbs.map(p => `[${p.name}] ${p.description} (${p.steps} 步)`).join("\n");
};

export const playbookCreateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "playbook_create", description: "创建一个新的 Playbook 自动化脚本。",
    parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } }, required: ["name", "steps"] },
  },
};
export const playbookCreateExec: ToolExecutor = async (args) => {
  const pb: Playbook = { name: args.name as string, description: (args.description as string) || "", steps: args.steps as Playbook["steps"] };
  return await createPlaybook(pb);
};

export const playbookStatusDef: ToolDefinition = {
  type: "function",
  function: { name: "playbook_status", description: "查看 Playbook 运行状态。", parameters: { type: "object", properties: { runId: { type: "string" } } } },
};
export const playbookStatusExec: ToolExecutor = async (args, env) => {
  const owner = playbookOwner(env);
  const runId = args.runId as string;
  if (runId) { const r = getRunStatus(runId, owner); return r ? `Run ${r.id}: ${r.status} (${r.currentStep}/${r.totalSteps})` : "运行不存在"; }
  const runs = listActiveRuns(owner);
  if (runs.length === 0) return "没有活跃的 Playbook 运行。";
  return runs.map(r => `[${r.id}] ${r.playbookName}: ${r.status} (${r.currentStep}/${r.totalSteps})`).join("\n");
};

// ========== Link ==========
export const linkDiscoverDef: ToolDefinition = {
  type: "function",
  function: { name: "link_discover", description: "列出所有活跃的 Session。", parameters: { type: "object", properties: {} } },
};
export const linkDiscoverExec: ToolExecutor = async () => {
  const sessions = discoverSessions();
  if (sessions.length === 0) return "没有活跃的 Session。";
  return sessions.map(s => `[${s.id}] ${s.name} — ${s.status}`).join("\n");
};

export const linkPeekDef: ToolDefinition = {
  type: "function",
  function: { name: "link_peek", description: "查看指定 Session 的状态。", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
};
export const linkPeekExec: ToolExecutor = async (args) => {
  const s = peekSession(args.id as string);
  return s ? `Session ${s.id}: ${s.name} — ${s.status}` : "Session 不存在";
};

export const linkPostDef: ToolDefinition = {
  type: "function",
  function: { name: "link_post", description: "向另一个 Session 发送消息。", parameters: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] } },
};
export const linkPostExec: ToolExecutor = async (args, env) => {
  const from = env?._SESSION_ID;
  const success = typeof from === "string" && postSessionLinkMessage(from, args.id as string, args.message as string);
  if (!success) throw new Error(`Session ${args.id} 不存在`);
  return `✅ 消息已发送到 ${args.id}`;
};

// ========== Poll / Wire source adapters (EVT-03) ==========
export const pollSubscribeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "poll_subscribe",
    description: "Subscribe to external events. Matching events wake an idle Session or inject the running flow.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1, maxLength: 128, description: "Source glob, e.g. wechat:message, webhook:* or *." },
        tagFilters: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1, maxLength: 128 },
          description: "Optional key/value glob filters. Every entry must match (AND).",
        },
        mode: { type: "string", enum: ["wake"], description: "Only wake is supported." },
        persistent: { type: "boolean", description: "False removes the subscription after its first delivered batch. Default true." },
        debounceMs: { type: "number", minimum: 0, maximum: 60000, description: "Trailing debounce window in milliseconds." },
      },
      required: ["source"],
    },
  },
};
export const pollSubscribeExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Poll invocation services are required");
  const result = getDefaultPollManager().subscribe(invocation.resourceOwner, {
    source: args.source as string,
    tagFilters: args.tagFilters as Record<string, string> | undefined,
    mode: args.mode as "wake" | undefined,
    persistent: args.persistent as boolean | undefined,
    debounceMs: args.debounceMs as number | undefined,
  });
  return `${result.created ? "✅ 已订阅" : "ℹ️ 订阅已存在"} ${result.subscription.sourcePattern} (ID: ${result.subscription.id})`;
};

export const pollUnsubscribeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "poll_unsubscribe",
    description: "Unsubscribe by subscription ID or source pattern. Omit id to remove all subscriptions for this Session.",
    parameters: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 128 } } },
  },
};
export const pollUnsubscribeExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Poll invocation services are required");
  const count = getDefaultPollManager().unsubscribe(invocation.resourceOwner, args.id as string | undefined);
  return count > 0 ? `✅ 已取消 ${count} 个订阅` : "没有匹配的订阅。";
};

export const pollListDef: ToolDefinition = {
  type: "function",
  function: { name: "poll_list", description: "List active event subscriptions for this Session.", parameters: { type: "object", properties: {} } },
};
export const pollListExec: ToolExecutor = async (_args, _env, invocation) => {
  if (!invocation) throw new Error("Poll invocation services are required");
  const subscriptions = getDefaultPollManager().list(invocation.resourceOwner);
  if (subscriptions.length === 0) return "没有活跃的订阅。";
  return subscriptions.map(subscription =>
    `[${subscription.id}] ${subscription.sourcePattern} · ${subscription.mode} · ${subscription.persistent ? "persistent" : "one-shot"} · debounce=${subscription.debounceMs}ms · filters=${JSON.stringify(subscription.tagFilters)}`
  ).join("\n");
};

// ========== Supervisor ==========
export const superviseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "supervise", description: "查看自动审批 Supervisor 状态。Agent 无权开启、关闭或修改 Supervisor。",
    parameters: { type: "object", properties: {} },
  },
};
export const superviseExec: ToolExecutor = async () =>
  `Supervisor: ${isSupervisorEnabled() ? "开启" : "关闭"}${getSupervisorRules() ? `，规则: ${getSupervisorRules()}` : ""}`;
