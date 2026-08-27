import type { LLMClient } from "./llm.js";
import { ConversationMemory } from "./memory.js";
import type { CapabilityContext } from "./capability-broker.js";
import type { PersonaDefinition, Message, ToolInvocationServices } from "./types.js";
import { isRunCancellation, throwIfCancelled } from "./run-cancellation.js";

const SUBAGENT_MAX_ITERATIONS = 10;

export type SubagentRunEventType = "assistant" | "tool_call" | "tool_result" | "sideband";

export interface SubagentRunEvent {
  readonly type: SubagentRunEventType;
  readonly content: string;
  readonly toolName?: string;
  readonly timestamp: number;
}

export interface SubAgentConfig {
  llm: LLMClient;
  persona: PersonaDefinition;
  prompt: string;
  context?: string;
  capabilityContext: CapabilityContext;
  invocation: ToolInvocationServices;
  initialMessages?: readonly Message[];
  inheritCanvas?: boolean;
  takeSideband?: () => readonly string[];
  onEvent?: (event: SubagentRunEvent) => void;
}

function copiedMessage(message: Message): Message {
  return {
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({
        ...call,
        function: { ...call.function },
      })),
    } : {}),
  };
}

function injectSideband(
  memory: ConversationMemory,
  takeSideband: SubAgentConfig["takeSideband"],
  onEvent: SubAgentConfig["onEvent"],
): boolean {
  const messages = takeSideband?.() ?? [];
  if (messages.length === 0) return false;
  for (const content of messages) {
    memory.add({ role: "system", content: `[Subagent sideband instruction]\n${content}` });
    onEvent?.({ type: "sideband", content, timestamp: Date.now() });
  }
  return true;
}

export async function runSubAgent(config: SubAgentConfig): Promise<string> {
  const {
    llm,
    persona,
    prompt,
    context,
    capabilityContext,
    invocation,
    initialMessages = [],
    inheritCanvas = false,
    takeSideband,
    onEvent,
  } = config;
  const memory = new ConversationMemory(80);
  const subAgentPrompt = persona.systemPrompt
    + "\n\n## 重要约束\n你是一个子 agent，专注于执行分配给你的任务。你不能派遣子 agent。请高效完成任务并返回结果。"
    + (context ? `\n\n## 上下文\n${context}` : "");
  memory.setSystemPrompt(subAgentPrompt);
  if (inheritCanvas && initialMessages.length > 0) {
    memory.addMany(initialMessages.filter(message => message.role !== "system").map(copiedMessage));
    memory.add({
      role: "user",
      content: "[Synthetic canvas fork notice] 以上是父运行在派遣时的画布快照。只完成下面分配的任务，不要继续父任务的其他工作。",
    });
  }
  memory.add({ role: "user", content: prompt });
  const tools = invocation.getToolDefinitions(capabilityContext);

  for (let iteration = 0; iteration < SUBAGENT_MAX_ITERATIONS; iteration += 1) {
    throwIfCancelled(invocation.signal);
    injectSideband(memory, takeSideband, onEvent);
    let finalMessage: Message | null = null;
    try {
      finalMessage = await llm.chat(memory.getAll(), tools, invocation.signal, invocation.network.fetch);
    } catch (error) {
      if (isRunCancellation(error) || invocation.signal.aborted) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!finalMessage) throw new Error("子 agent 返回为空");

    if (injectSideband(memory, takeSideband, onEvent)) continue;
    if (finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
      const toolMessages: Message[] = [];
      for (const toolCall of finalMessage.tool_calls) {
        throwIfCancelled(invocation.signal);
        const toolName = toolCall.function.name;
        onEvent?.({ type: "tool_call", content: toolCall.function.arguments, toolName, timestamp: Date.now() });
        const result = await invocation.executeTool(
          capabilityContext,
          toolName,
          toolCall.function.arguments,
          toolCall.id,
        );
        onEvent?.({ type: "tool_result", content: result, toolName, timestamp: Date.now() });
        toolMessages.push({ role: "tool", content: result, tool_call_id: toolCall.id });
      }
      memory.addMany([finalMessage, ...toolMessages]);
      continue;
    }

    const result = finalMessage.content || "(子 agent 无回复)";
    onEvent?.({ type: "assistant", content: result, timestamp: Date.now() });
    return result;
  }
  throw new Error("子 agent 达到最大循环次数，未能完成任务");
}
