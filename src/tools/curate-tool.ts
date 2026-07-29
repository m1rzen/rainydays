// ===========================================
// curate 工具 —— 手动触发画布压缩
// 支持带 hint 引导压缩重点（仿 Lux /compact [hint]）
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { ConversationMemory } from "../memory.js";
import type { LLMClient } from "../llm.js";

export const curateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "curate",
    description:
      "手动触发对话历史压缩，释放上下文空间。当对话变长、上下文拥挤时使用。可以提供 hint 指定保留重点。",
    parameters: {
      type: "object",
      properties: {
        hint: {
          type: "string",
          description: "压缩提示词，指定需要保留的内容。如 '保留所有和数据库相关的内容' 或 '保留项目文件路径'。",
        },
      },
    },
  },
};

export function createCurateExec(memory: ConversationMemory, llm: LLMClient): ToolExecutor {
  return async (args) => {
    const hint = args.hint as string | undefined;

    // 如果有 hint，临时修改摘要器的指令
    if (hint) {
      // 在 compact 调用前，把 hint 注入到 memory 的 system 消息中
      const msgs = memory.getAll();
      const hintMsg = {
        role: "system" as const,
        content: `压缩提示：请重点保留以下内容：${hint}`,
      };
      memory.add(hintMsg);
    }

    const beforeTokens = memory.getTokenEstimate();
    const beforeCount = memory.getMessageCount();
    const compacted = await memory.compact(llm);
    const afterTokens = memory.getTokenEstimate();
    const afterCount = memory.getMessageCount();

    if (compacted) {
      return `✅ 画布已压缩: ${beforeCount}→${afterCount} 条消息, ${beforeTokens}→${afterTokens} tokens${hint ? ` (保留重点: ${hint})` : ""}`;
    } else {
      return `画布无需压缩（当前 ${beforeTokens} tokens, ${beforeCount} 条消息，在预算内）`;
    }
  };
}
