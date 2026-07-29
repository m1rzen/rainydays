// ===========================================
// 子 Agent —— 独立执行的轻量 agent
// 共享 LLM 客户端和工具注册表
// 独立 memory（不写入数据库，不污染主对话）
// 不能再 spawn 子 agent（防递归）
// ===========================================

import type { LLMClient } from "./llm.js";
import { ConversationMemory } from "./memory.js";
import type { CapabilityContext } from "./capability-broker.js";
import type { PersonaDefinition, Message, ToolInvocationServices } from "./types.js";

const SUBAGENT_MAX_ITERATIONS = 10;

/** 子 agent 配置 */
export interface SubAgentConfig {
  llm: LLMClient;
  persona: PersonaDefinition;
  /** 传递给子 agent 的 prompt */
  prompt: string;
  /** 额外的上下文信息（如父 agent 的任务说明） */
  context?: string;
  /** Broker 衰减签发的子上下文；普通参数不能替代。 */
  capabilityContext: CapabilityContext;
  invocation: ToolInvocationServices;
}

/**
 * 执行一个子 agent 任务
 * @returns 子 agent 的完整回复文本
 */
export async function runSubAgent(config: SubAgentConfig): Promise<string> {
  const { llm, persona, prompt, context, capabilityContext, invocation } = config;

  // 创建独立的 memory（不绑定 session，不写数据库）
  const memory = new ConversationMemory(40);

  // 构造 system prompt：persona prompt + 禁止再 spawn 子 agent
  const subAgentPrompt = persona.systemPrompt +
    "\n\n## 重要约束\n你是一个子 agent，专注于执行分配给你的任务。你没有 subagent 工具——不能再派遣子 agent。请高效完成任务并返回结果。" +
    (context ? `\n\n## 上下文\n${context}` : "");

  memory.setSystemPrompt(subAgentPrompt);
  memory.add({ role: "user", content: prompt });

  const tools = invocation.getToolDefinitions(capabilityContext);

  for (let i = 0; i < SUBAGENT_MAX_ITERATIONS; i++) {
    let finalMessage: Message | null = null;

    // 子 agent 用非流式调用（不需要流式输出到前端）
    try {
      finalMessage = await llm.chat(memory.getAll(), tools);
    } catch (err) {
      return `子 agent 执行失败: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!finalMessage) {
      return "子 agent 返回为空";
    }

    // 调用工具
    if (finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
      memory.add(finalMessage);

      for (const toolCall of finalMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let parsed: unknown;
        try {
          parsed = JSON.parse(toolCall.function.arguments);
        } catch {
          return `子 agent 工具参数不是合法 JSON: ${toolName}`;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `子 agent 工具参数必须是 object: ${toolName}`;
        const result = await invocation.executeTool(capabilityContext, toolName, parsed as Record<string, unknown>);

        memory.add({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }

      continue;
    }

    // 最终回答
    return finalMessage.content || "(子 agent 无回复)";
  }

  return "子 agent 达到最大循环次数，未能完成任务。";
}
