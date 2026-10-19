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
export function estimateProjectedRequestTokens(messages: unknown, tools?: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, ...(tools ? { tools } : {}) }), "utf8") / 2) + 128;
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";
  constructor(readonly report?: RequestBudgetReport) {
    super("当前资料超过上下文容量，尚未继续生成回答。请缩小读取范围、分段取回历史或在模型设置中调整已确认的请求预算；原始会话记录仍保留。" +
      (report ? `（输入估算${report.estimatedInputTokens} + 回复预留${report.outputReserveTokens} > 预算${report.contextWindowTokens}）` : ""));
    this.name = "ContextBudgetExceededError";
  }
}
