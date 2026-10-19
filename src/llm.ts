// ===========================================
// LLM 客户端 —— 与大模型通信的统一接口
// 使用 OpenAI 兼容 SDK，支持 DeepSeek/OpenAI/通义等
// 包含：指数退避重试、超时、速率限制处理、错误恢复
// ===========================================

import OpenAI, { APIUserAbortError } from "openai";
import type { LLMConfig, Message, MessageAttachment, ScopedNetworkGateway, ToolDefinition } from "./types.js";
import { abortableDelay, cancellationError, cancellationFailure, throwIfCancelled } from "./run-cancellation.js";
import { MAX_DRAFT_ATTACHMENT_BYTES, INLINE_ATTACHMENT_BYTES, isDocumentMime } from "./attachment.js";
import { beginObservation } from "./observability.js";
import { ContextBudgetExceededError, estimateProjectedRequestTokens, resolveRequestBudget, type RequestBudget, type RequestBudgetReport } from "./request-budget.js";

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 基础退避时间（毫秒） */
const BASE_BACKOFF_MS = 1000;

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30000;

/** 速率限制等待时间（毫秒） */
const RATE_LIMIT_WAIT_MS = 5000;

/**
 * 判断错误是否可重试
 */
function llmCancellationFailure(signal: AbortSignal, error: unknown, fallback: string): Error {
  return error instanceof APIUserAbortError
    ? cancellationError(signal, fallback)
    : cancellationFailure(signal, error, fallback);
}

function isRetryableError(err: unknown): { retry: boolean; rateLimit?: boolean; reason: string } {
  // OpenAI API 错误
  const e = err as { status?: number; code?: string; message?: string; type?: string };

  // 速率限制
  if (e.status === 429) {
    return { retry: true, rateLimit: true, reason: "速率限制 (429)" };
  }

  // 服务端错误
  if (e.status && e.status >= 500) {
    return { retry: true, reason: `服务端错误 (${e.status})` };
  }

  // 网络错误（无 status 通常是网络层问题）
  if (!e.status) {
    const msg = e.message || "";
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") ||
        msg.includes("fetch failed") || msg.includes("network") || msg.includes("socket hang up") ||
        msg.includes("ECONNREFUSED") || msg.includes("EAI_AGAIN")) {
      return { retry: true, reason: `网络错误: ${msg.slice(0, 80)}` };
    }
  }

  // 其他错误不重试（如 400 参数错误、401 认证失败）
  return { retry: false, reason: e.message || String(err) };
}

export type LLMFetchTransport = ScopedNetworkGateway["fetch"];

export interface LLMUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** Usage is response metadata, never conversation input. Missing means unknown. */
export interface LLMReply extends Message {
  readonly usage?: LLMUsage;
}

function providerUsage(usage: OpenAI.CompletionUsage | null | undefined): LLMUsage | undefined {
  if (!usage) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  if (![prompt_tokens, completion_tokens, total_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  return { prompt_tokens, completion_tokens, total_tokens };
}

export type AttachmentResolver = (
  sessionId: string,
  attachmentId: string,
) => Readonly<{ attachment: MessageAttachment; bytes: Buffer }>;

/** A complete protocol reply is required before any caller can execute its tools. */
function completedMessage(message: Message, finishReason: string | null | undefined): Message {
  if (finishReason !== "stop" && finishReason !== "tool_calls") {
    const reason = finishReason === "length" || finishReason === "content_filter" ? finishReason : "连接提前关闭或未知结束状态";
    throw new Error(`回答未完整结束 (${reason})`);
  }
  if (message.role !== "assistant" || typeof message.content !== "string") {
    throw new Error("模型返回了无效的回答结构");
  }
  const calls = message.tool_calls ?? [];
  if ((calls.length > 0) !== (finishReason === "tool_calls")) {
    throw new Error("工具调用与回答结束状态不一致");
  }
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || ids.has(call.id) || call.type !== "function" || !call.function?.name) {
      throw new Error("模型返回了无效或重复的工具调用标识");
    }
    ids.add(call.id);
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new Error("工具参数不是完整JSON，未执行工具"); }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("工具参数必须是JSON对象，未执行工具");
    }
  }
  return message;
}

export function projectMessagesForProvider(
  sessionId: string | null,
  messages: readonly Message[],
  resolveAttachment: AttachmentResolver | null,
  imageInput: "none" | "data-uri" = "none",
): OpenAI.Chat.ChatCompletionMessageParam[] {
  let attachmentBytes = 0;
  return messages.map(message => {
    const { attachments } = message;
    // Whitelist protocol fields so response metadata cannot leak into later requests.
    const base = {
      role: message.role, content: message.content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    };
    if (!attachments?.length) return base as OpenAI.Chat.ChatCompletionMessageParam;
    if (message.role !== "user") throw new TypeError("Only user messages may contain attachments");
    if (!sessionId || !resolveAttachment) throw new Error("Attachment Provider projection requires a Session-bound resolver");
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const expected of attachments) {
      const resolved = resolveAttachment(sessionId, expected.id);
      const actual = resolved.attachment;
      attachmentBytes += resolved.bytes.length;
      if (attachmentBytes > MAX_DRAFT_ATTACHMENT_BYTES) throw new Error("Provider attachment payload exceeds the request budget");
      if (actual.id !== expected.id || actual.sha256 !== expected.sha256 || actual.size !== expected.size
        || actual.mime !== expected.mime || actual.kind !== expected.kind || resolved.bytes.length !== expected.size) {
        throw new Error("Message attachment identity changed before Provider projection");
      }
      if (actual.kind === "image") {
        if (imageInput !== "data-uri") throw new Error("PROVIDER_IMAGE_INPUT_UNSUPPORTED: current Provider profile does not enable data-uri images");
        content.push({
          type: "image_url",
          image_url: { url: `data:${actual.mime};base64,${resolved.bytes.toString("base64")}`, detail: "auto" },
        });
      } else {
        const label = JSON.stringify({ id: actual.id, name: actual.name, mime: actual.mime, sha256: actual.sha256 });
        content.push({
          type: "text",
          text: isDocumentMime(actual.mime) || actual.size > INLINE_ATTACHMENT_BYTES
            ? `\n<user_attachment metadata=${label}>\n资料尚未读取。使用 read(file_path="attachment:${actual.id}", offset=1, limit=12) 或 read_file(path="attachment:${actual.id}", offset=1, limit=12) 分段读取，根据下一页位置继续。回答请引用文件名及提取行号；未读部分不能当作已知事实。若当前没有读取工具，请明确告知用户切换到通用助手。\n</user_attachment>`
            : `\n<user_attachment metadata=${label}>\n${resolved.bytes.toString("utf8")}\n</user_attachment>`,
        });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "[User supplied attachments]" });
    return { role: "user", content };
  });
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private config: Readonly<LLMConfig>;
  private imageInput: "none" | "data-uri";
  readonly requestBudget: RequestBudget;
  private budgetReport: RequestBudgetReport | null = null;

  constructor(config: LLMConfig) {
    this.requestBudget = resolveRequestBudget(config);
    this.config = Object.freeze({ ...config });
    this.client = this.createClient();
    this.model = config.model;
    this.imageInput = config.providerType === "openai-compatible-vision" ? "data-uri" : "none";
  }

  getBudgetReport(): RequestBudgetReport | null { return this.budgetReport ? { ...this.budgetReport } : null; }

  estimateRequest(messages: Message[], tools?: ToolDefinition[], attachmentSessionId: string | null = null, attachmentResolver: AttachmentResolver | null = null): RequestBudgetReport {
    return { ...this.requestBudget, estimatedInputTokens: estimateProjectedRequestTokens(projectMessagesForProvider(attachmentSessionId, messages, attachmentResolver, this.imageInput), tools) };
  }

  private checkBudget(messages: unknown, tools?: ToolDefinition[]): RequestBudgetReport {
    const report = { ...this.requestBudget, estimatedInputTokens: estimateProjectedRequestTokens(messages, tools) };
    this.budgetReport = report;
    if (report.estimatedInputTokens + report.outputReserveTokens > report.contextWindowTokens) throw new ContextBudgetExceededError(report);
    return report;
  }

  private recordUsage(report: RequestBudgetReport, usage: LLMUsage | undefined): void {
    this.budgetReport = { ...report, ...(usage ? { actualPromptTokens: usage.prompt_tokens, estimationErrorTokens: report.estimatedInputTokens - usage.prompt_tokens } : {}) };
  }

  private createClient(transport?: LLMFetchTransport): OpenAI {
    const scopedFetch: typeof fetch | undefined = transport
      ? (input, init) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : null;
          if (url === null) throw new Error("Scoped LLM transport rejected an unsupported Request input");
          return transport(url, init);
        }
      : undefined;
    return new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0, // 我们自己管理重试
      ...(scopedFetch ? { fetch: scopedFetch } : {}),
    });
  }

  /** Explicit settings check: one bounded request, with no agent history, tools or retries. */
  async probe(signal: AbortSignal): Promise<void> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 16,
    }, { signal });
    if (response.choices?.[0]?.message?.role !== "assistant") throw new Error("Invalid provider response");
  }

  /**
   * 发送对话请求（非流式），支持工具调用
   * 包含重试逻辑
   */
  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    transport?: LLMFetchTransport,
    attachmentSessionId: string | null = null,
    attachmentResolver: AttachmentResolver | null = null,
  ): Promise<LLMReply> {
    const client = transport ? this.createClient(transport) : this.client;
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: projectMessagesForProvider(attachmentSessionId, messages, attachmentResolver, this.imageInput),
      max_tokens: this.requestBudget.outputReserveTokens,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    const budget = this.checkBudget(params.messages, tools);
    let lastError: unknown = null;
    const observation = beginObservation("llm");

    try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (signal) throwIfCancelled(signal);
        const response = await client.chat.completions.create(params, signal ? { signal } : undefined);
        const choice = response.choices[0];
        if (!choice?.message) throw new Error("模型返回了空的回答结构");
        const message = choice.message;

        const result = completedMessage({
          role: message.role,
          content: message.content || "",
          tool_calls: message.tool_calls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        }, choice.finish_reason);
        observation.finish("success", { bytesOut: Buffer.byteLength(result.content, "utf8") });
        const usage = providerUsage(response.usage);
        this.recordUsage(budget, usage);
        return { ...result, ...(usage ? { usage } : {}) };
      } catch (err) {
        if (signal?.aborted) {
          observation.finish("cancelled");
          throw llmCancellationFailure(signal, err, "LLM request was cancelled");
        }
        lastError = err;
        const { retry, rateLimit, reason } = isRetryableError(err);

        if (!retry || attempt === MAX_RETRIES) {
          observation.finish("error");
          throw new Error(`LLM 请求失败: ${reason}${attempt > 0 ? ` (已重试 ${attempt} 次)` : ""}`);
        }
        observation.retry();

        // 计算等待时间
        const waitMs = rateLimit
          ? RATE_LIMIT_WAIT_MS
          : BASE_BACKOFF_MS * Math.pow(2, attempt); // 1s, 2s, 4s

        console.warn(
          `⚠️ LLM 请求失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}): ${reason}，` +
          `${waitMs}ms 后重试...`
        );

        if (signal) await abortableDelay(waitMs, signal);
        else await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    observation.finish("error");
    throw new Error(
      `LLM 请求失败: 已耗尽 ${MAX_RETRIES + 1} 次尝试。` +
      `最后错误: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
    } finally {
      observation.finish(signal?.aborted ? "cancelled" : "error");
    }
  }

  /**
   * 流式对话 —— 边产出文本片段边累积工具调用
   * 包含重试逻辑（流开始前重试，流开始后失败不重试）
   * yield 两种事件：
   *   - { type: "delta", content }      文本片段
   *   - { type: "result", message }      流结束，返回完整 Message
   */
  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    attachmentSessionId: string | null = null,
    attachmentResolver: AttachmentResolver | null = null,
  ): AsyncGenerator<StreamEvent> {
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: projectMessagesForProvider(attachmentSessionId, messages, attachmentResolver, this.imageInput),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.requestBudget.outputReserveTokens,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    const budget = this.checkBudget(params.messages, tools);
    let lastError: unknown = null;
    const observation = beginObservation("llm");
    let fallbackOutcome: "cancelled" | "error" = "cancelled";

    try {
    // 重试只在流建立阶段（create 调用），流开始后不重试
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let streamEstablished = false;
      try {
        if (signal) throwIfCancelled(signal);
        const stream = await this.client.chat.completions.create(params, signal ? { signal } : undefined);
        streamEstablished = true;

        let fullContent = "";
        let finishReason: string | null = null;
        let usage: LLMUsage | undefined;
        const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

        for await (const chunk of stream) {
          if (signal) throwIfCancelled(signal);
          if (chunk.usage) usage = providerUsage(chunk.usage);
          if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            yield { type: "delta", content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: "", name: "", arguments: "" });
              }
              const existing = toolCallMap.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          }
        }

        if (signal) throwIfCancelled(signal);
        // 构建最终 message
        const toolCalls = Array.from(toolCallMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => tc);

        const finalMessage = completedMessage({
          role: "assistant",
          content: fullContent,
          tool_calls: toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              }))
            : undefined,
        }, finishReason);

        observation.finish("success", { bytesOut: Buffer.byteLength(fullContent, "utf8") });
        this.recordUsage(budget, usage);
        yield { type: "result", message: finalMessage, ...(usage ? { usage } : {}) };
        return; // 成功，退出重试循环

      } catch (err) {
        if (signal?.aborted) {
          observation.finish("cancelled");
          throw llmCancellationFailure(signal, err, "LLM stream was cancelled");
        }
        lastError = err;
        const { retry, rateLimit, reason } = isRetryableError(err);

        if (streamEstablished || !retry || attempt === MAX_RETRIES) {
          observation.finish("error");
          throw new Error(`LLM 流式请求失败: ${reason}${attempt > 0 ? ` (已重试 ${attempt} 次)` : ""}`);
        }
        observation.retry();

        const waitMs = rateLimit
          ? RATE_LIMIT_WAIT_MS
          : BASE_BACKOFF_MS * Math.pow(2, attempt);

        console.warn(
          `⚠️ LLM 流式请求失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}): ${reason}，` +
          `${waitMs}ms 后重试...`
        );

        if (signal) await abortableDelay(waitMs, signal);
        else await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    observation.finish("error");
    throw new Error(
      `LLM 流式请求失败: 已耗尽 ${MAX_RETRIES + 1} 次尝试。` +
      `最后错误: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
    } catch (error) {
      fallbackOutcome = signal?.aborted ? "cancelled" : "error";
      throw error;
    } finally {
      observation.finish(fallbackOutcome);
    }
  }
}

/** 流式事件类型 */
export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "result"; message: Message; usage?: LLMUsage };
