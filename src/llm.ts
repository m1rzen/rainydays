// ===========================================
// LLM 客户端 —— 与大模型通信的统一接口
// 使用 OpenAI 兼容 SDK，支持 DeepSeek/OpenAI/通义等
// 包含：指数退避重试、超时、速率限制处理、错误恢复
// ===========================================

import OpenAI from "openai";
import type { LLMConfig, Message, ToolDefinition } from "./types.js";

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

/**
 * 睡眠
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0, // 我们自己管理重试
    });
    this.model = config.model;
  }

  /**
   * 发送对话请求（非流式），支持工具调用
   * 包含重试逻辑
   */
  async chat(
    messages: Message[],
    tools?: ToolDefinition[]
  ): Promise<Message> {
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create(params);
        const choice = response.choices[0];
        const message = choice.message;

        return {
          role: "assistant",
          content: message.content || "",
          tool_calls: message.tool_calls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      } catch (err) {
        lastError = err;
        const { retry, rateLimit, reason } = isRetryableError(err);

        if (!retry || attempt === MAX_RETRIES) {
          // 不可重试或已耗尽重试次数
          throw new Error(`LLM 请求失败: ${reason}${attempt > 0 ? ` (已重试 ${attempt} 次)` : ""}`);
        }

        // 计算等待时间
        const waitMs = rateLimit
          ? RATE_LIMIT_WAIT_MS
          : BASE_BACKOFF_MS * Math.pow(2, attempt); // 1s, 2s, 4s

        console.warn(
          `⚠️ LLM 请求失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}): ${reason}，` +
          `${waitMs}ms 后重试...`
        );

        await sleep(waitMs);
      }
    }

    throw new Error(
      `LLM 请求失败: 已耗尽 ${MAX_RETRIES + 1} 次尝试。` +
      `最后错误: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
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
    tools?: ToolDefinition[]
  ): AsyncGenerator<StreamEvent> {
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    let lastError: unknown = null;

    // 重试只在流建立阶段（create 调用），流开始后不重试
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = await this.client.chat.completions.create(params);

        let fullContent = "";
        const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

        for await (const chunk of stream) {
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

        // 构建最终 message
        const toolCalls = Array.from(toolCallMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => tc)
          .filter((tc) => tc.name);

        const finalMessage: Message = {
          role: "assistant",
          content: fullContent,
          tool_calls: toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              }))
            : undefined,
        };

        yield { type: "result", message: finalMessage };
        return; // 成功，退出重试循环

      } catch (err) {
        lastError = err;
        const { retry, rateLimit, reason } = isRetryableError(err);

        if (!retry || attempt === MAX_RETRIES) {
          throw new Error(`LLM 流式请求失败: ${reason}${attempt > 0 ? ` (已重试 ${attempt} 次)` : ""}`);
        }

        const waitMs = rateLimit
          ? RATE_LIMIT_WAIT_MS
          : BASE_BACKOFF_MS * Math.pow(2, attempt);

        console.warn(
          `⚠️ LLM 流式请求失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}): ${reason}，` +
          `${waitMs}ms 后重试...`
        );

        await sleep(waitMs);
      }
    }

    throw new Error(
      `LLM 流式请求失败: 已耗尽 ${MAX_RETRIES + 1} 次尝试。` +
      `最后错误: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
}

/** 流式事件类型 */
export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "result"; message: Message };
