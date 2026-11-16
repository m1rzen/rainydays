import { describeGcableModel, gcableModelCatalog, resolveGcableRequestModel } from "./gcable-models.js";

/** Configured work limits; these do not certify a provider's real context window. */
export interface RequestBudget {
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
}

export interface RequestBudgetReport extends RequestBudget {
  readonly estimatedInputTokens: number;
  readonly actualPromptTokens?: number;
  readonly estimationErrorTokens?: number;
}

export function resolveRequestBudget(value: Readonly<{ contextWindowTokens?: unknown; outputReserveTokens?: unknown }> = {}): RequestBudget {
  const contextWindowTokens = value.contextWindowTokens === undefined ? 32768 : value.contextWindowTokens;
  const outputReserveTokens = value.outputReserveTokens === undefined ? 4096 : value.outputReserveTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || Number(contextWindowTokens) < 512 || Number(contextWindowTokens) > 2_000_000) throw new TypeError("总请求预算必须是512到2000000之间的整数");
  if (!Number.isSafeInteger(outputReserveTokens) || Number(outputReserveTokens) < 16 || Number(outputReserveTokens) >= Number(contextWindowTokens)) throw new TypeError("回复预留必须至少16，且小于总请求预算");
  return Object.freeze({ contextWindowTokens: Number(contextWindowTokens), outputReserveTokens: Number(outputReserveTokens) });
}

/** Deliberately conservative text estimate, including JSON and protocol framing. Usage records the error. */
/** Conservative per-image allowance; inline image bytes are not counted as text. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

export function estimateProjectedRequestTokens(messages: unknown, tools?: unknown): number {
  let images = 0;
  const text = JSON.stringify({ messages, ...(tools ? { tools } : {}) }, (key, value) => {
    if (key === "url" && typeof value === "string" && value.startsWith("data:image/")) { images += 1; return ""; }
    return value;
  });
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2) + 128 + images * IMAGE_TOKEN_ESTIMATE;
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";
  constructor(readonly report?: RequestBudgetReport) {
    super("当前资料超过上下文容量，尚未继续生成回答。请缩小读取范围、分段取回历史或在模型设置中调整已确认的请求预算；原始会话记录仍保留。" +
      (report ? `（输入估算${report.estimatedInputTokens} + 回复预留${report.outputReserveTokens} > 预算${report.contextWindowTokens}）` : ""));
    this.name = "ContextBudgetExceededError";
  }
}

export type ThinkingEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const sessionThinkingEffort = new Map<string, ThinkingEffortLevel>();
const sessionThinkingModel = new Map<string, string>();
const sessionRequestModel = new Map<string, string>();

function explicitEffort(sessionId: string, model?: string): ThinkingEffortLevel | undefined {
  const boundModel = sessionThinkingModel.get(sessionId);
  return boundModel && model && boundModel !== model ? undefined : sessionThinkingEffort.get(sessionId);
}

export function getSessionThinkingEffort(sessionId: string, model = sessionRequestModel.get(sessionId)): {
  currentEffort: ThinkingEffortLevel;
  availableEfforts: ThinkingEffortLevel[];
  thinkingEnabled?: boolean;
} {
  const state = model ? describeGcableModel(model) : undefined;
  if (state) {
    const entry = gcableModelCatalog.find(p => p.model === state.model)!;
    const override = explicitEffort(sessionId, model);
    return {
      currentEffort: (override && entry.efforts.includes(override) ? override : state.effort) as ThinkingEffortLevel,
      availableEfforts: (state.thinking ? entry.efforts : []) as ThinkingEffortLevel[],
      thinkingEnabled: state.thinking,
    };
  }
  return {
    currentEffort: explicitEffort(sessionId, model) ?? "high",
    availableEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  };
}

export function setSessionThinkingEffort(sessionId: string, effort: ThinkingEffortLevel, model = sessionRequestModel.get(sessionId)): {
  previousEffort: ThinkingEffortLevel;
  currentEffort: ThinkingEffortLevel;
  appliesTo: "next_provider_request";
} {
  const state = getSessionThinkingEffort(sessionId, model);
  if (!state.availableEfforts.includes(effort)) throw new TypeError("当前模型未开启思考或不支持此思考强度，请先查看 thinking_effort_get 或修改模型设置。");
  const prev = state.currentEffort;
  sessionThinkingEffort.set(sessionId, effort);
  if (model) sessionThinkingModel.set(sessionId, model);
  else sessionThinkingModel.delete(sessionId);
  return {
    previousEffort: prev,
    currentEffort: effort,
    appliesTo: "next_provider_request",
  };
}

export function hasExplicitSessionThinkingEffort(sessionId: string): boolean {
  return sessionThinkingEffort.has(sessionId);
}

export function resolveRequestModel(model: string, sessionId: string | null): { model: string; reasoning_effort?: "low" | "medium" | "high" } {
  if (sessionId) sessionRequestModel.set(sessionId, model);
  if (describeGcableModel(model)) {
    const effort = sessionId ? explicitEffort(sessionId, model) : undefined;
    // An override from a different model must not prevent switching profiles.
    const state = describeGcableModel(model)!;
    const entry = gcableModelCatalog.find(p => p.model === state.model)!;
    return { model: resolveGcableRequestModel(model, effort && entry.efforts.includes(effort) ? effort : undefined) };
  }
  const effort = sessionId && explicitEffort(sessionId, model) ? resolveProviderReasoningEffort(sessionId) : undefined;
  return { model, ...(effort ? { reasoning_effort: effort } : {}) };
}

export function resolveProviderReasoningEffort(sessionId: string): "low" | "medium" | "high" | undefined {
  const effort = sessionThinkingEffort.get(sessionId);
  if (!effort) return undefined;
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}
