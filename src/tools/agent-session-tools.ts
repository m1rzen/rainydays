// ===========================================
// agent_* 是 SubagentRegistry 的真实入口：子代理由模型实际运行，状态、结果和停止都来自注册表。
// 子代理继承父任务的只读无人值守工具，不能再派生子代理；结束后不能继续接收消息。
// ===========================================

import type { LLMClient } from "../llm.js";
import { getMessagesBySession, getSession, listSessions } from "../db.js";
import { SubagentRegistryError, type SubagentPeekScope, type SubagentRegistry, type SubagentSnapshot, type SubagentStatus } from "../subagent-registry.js";
import type { PersonaDefinition, ToolExecutor } from "../types.js";
import { STATIC_TOOL_POLICIES, RUNTIME_TOOL_POLICIES } from "../tool-policies.js";
import { throwIfCancelled } from "../run-cancellation.js";

const STATUS: Readonly<Record<SubagentStatus, "streaming" | "idle" | "error" | "interrupted">> = {
  running: "streaming", completed: "idle", failed: "error", aborted: "interrupted",
};
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const MAX_NAME_LENGTH = 160;
/** A12: at most two research/review children at once; the parent stays the only writer. */
export const MAX_ACTIVE_AGENT_SPAWNS = 2;
export const SUBAGENT_RESULT_NOTE = "子任务结果是建议和线索，不是已核对的事实。引用或据此修改前，用自己的工具核对来源；最终回答和写入由你负责。";

/** Read-only means every risk class is read or network: no file writes, processes or control actions. */
export function isReadOnlyTool(name: string): boolean {
  const policy = STATIC_TOOL_POLICIES[name] ?? RUNTIME_TOOL_POLICIES[name];
  return !!policy && policy.riskClasses.every(risk => risk === "read" || risk === "network");
}

export interface AgentSessionDependencies {
  readonly registry: SubagentRegistry;
  readonly llm: LLMClient;
  readonly persona: PersonaDefinition;
  /** 按 models_list 的 id 取模型；不存在时返回 null。 */
  readonly resolveModel: (profile: string) => LLMClient | null;
}

function view(snapshot: SubagentSnapshot) {
  return {
    id: snapshot.taskId, name: snapshot.description, status: STATUS[snapshot.status],
    result: snapshot.result, error: snapshot.error, created_at: snapshot.createdAt, finished_at: snapshot.finishedAt,
  };
}
const json = (value: unknown): string => JSON.stringify(value, null, 2);
function isNotFound(error: unknown): boolean { return error instanceof SubagentRegistryError && error.code === "SUBAGENT_NOT_FOUND"; }

export function createAgentSessionExecutors(dependencies: AgentSessionDependencies): Readonly<Record<string, ToolExecutor>> {
  const { registry, llm, persona, resolveModel } = dependencies;
  return Object.freeze({
    agent_spawn: async (args, _env, invocation) => {
      if (!invocation) throw new Error("缺少受控工具调用服务");
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("agent_spawn 需要非空 task");
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : task;
      const model = typeof args.model === "string" && args.model ? args.model : null;
      const childLlm = model ? resolveModel(model) : llm;
      if (!childLlm) throw new Error(`模型不存在: ${model}。可用模型见 models_list`);
      throwIfCancelled(invocation.signal);
      const running = registry.list().filter(item => item.status === "running").length;
      if (running >= MAX_ACTIVE_AGENT_SPAWNS) throw new Error(`最多同时运行 ${MAX_ACTIVE_AGENT_SPAWNS} 个子任务；先用 agent_wait 取回结果，或用 agent_close 停止一个。`);
      const readOnlyTools = invocation.getUnattendedChildToolNames().filter(isReadOnlyTool);
      const child = await registry.spawn({
        description: name.slice(0, MAX_NAME_LENGTH), prompt: task, persona, llm: childLlm,
        parentContext: invocation.capabilityContext, parentInvocation: invocation, toolAllowlist: readOnlyTools,
      });
      // Stopping the parent run stops the children it started; finished results stay readable.
      invocation.signal.addEventListener("abort", () => { void registry.stop(child.taskId).catch(() => undefined); }, { once: true });
      return json({ ...view(child), parent_session_id: invocation.capabilityContext.sessionId, model, allow_subagent: false, read_only: true, tools: readOnlyTools, note: SUBAGENT_RESULT_NOTE });
    },
    agent_list: async args => {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const statuses = Array.isArray(args.status) ? args.status as string[] : [];
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const rows = args.scope === "all"
        ? listSessions().map(session => ({ id: session.id, name: session.title, status: "idle", updated_at: new Date(session.updated_at).getTime() || 0 }))
        : registry.list().map(child => ({ id: child.taskId, name: child.description, status: STATUS[child.status], updated_at: Date.parse(child.finishedAt ?? child.createdAt) }));
      const filtered = rows
        .filter(row => (statuses.length === 0 || statuses.includes(row.status)) && (!query || row.id.toLowerCase().includes(query) || row.name.toLowerCase().includes(query))
          && (typeof args.updated_after !== "number" || row.updated_at > args.updated_after))
        .sort((left, right) => right.updated_at - left.updated_at);
      return json({ agents: filtered.slice(0, limit), total: filtered.length, has_more: filtered.length > limit, next_cursor: null, snapshot_at: Date.now() });
    },
    agent_peek: async args => {
      const id = String(args.id ?? "");
      const scope = (args.scope as SubagentPeekScope | undefined) ?? "last";
      try {
        const peeked = registry.peek(id, scope, typeof args.turn === "number" ? args.turn : 0);
        return json({ ...view(peeked), scope, events: peeked.events });
      } catch (error) {
        if (!isNotFound(error) && !(error instanceof SubagentRegistryError && error.code === "SUBAGENT_INVALID" && !getSession(id))) throw error;
      }
      const session = getSession(id);
      if (!session) throw new Error(`Agent 不存在: ${id}`);
      const messages = getMessagesBySession(id);
      const slice = scope === "full" ? messages : messages.slice(-4);
      return json({ id, name: session.title, status: "idle", scope, messages: slice.map(message => ({ id: message.id, role: message.role, content: message.content.slice(0, 1000), created_at: message.created_at })) });
    },
    agent_post: async args => {
      const id = String(args.id ?? "");
      if (args.abort === true) return json({ ...view(await registry.stop(id)), aborted: true });
      return json({ ...view(registry.post(id, String(args.message ?? ""))), delivered: true, mode: args.mode ?? "reply" });
    },
    agent_wait: async (args, _env, invocation) => {
      if (!invocation) throw new Error("缺少受控工具调用服务");
      if (args.async === true) throw new Error("agent_wait 暂不支持 async；请用同步等待或 agent_peek 查看进度");
      const event = args.event as { session?: unknown } | undefined;
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, typeof args.timeout === "number" ? args.timeout : DEFAULT_WAIT_SECONDS));
      const settled = await registry.output(String(event?.session ?? ""), { block: true, timeoutMs: Math.round(seconds * 1000), signal: invocation.signal });
      const trigger = settled.status === "running" ? "timeout" : settled.status === "completed" ? "idle" : "error";
      return json({ ...view(settled), trigger, interrupted: false, session: settled.taskId, ...(settled.result ? { note: SUBAGENT_RESULT_NOTE } : {}) });
    },
    agent_cancel_wait: async args => json({ id: String(args.id ?? ""), cancelled: false, reason: "agent_wait 暂不支持 async 订阅，没有可取消的等待" }),
    agent_close: async args => json({ ...view(await registry.stop(String(args.id ?? ""))), closed: true }),
  });
}
