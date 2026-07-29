// ===========================================
// subagent 工具 —— 派遣子 agent 执行任务
// 子 agent 有独立上下文，执行完返回结果给主 agent
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { LLMClient } from "../llm.js";
import type { PersonaDefinition } from "../types.js";
import { runSubAgent } from "../subagent.js";

// 工具需要访问 LLM 和 persona，通过 env 注入
// env._LLM_CLIENT 和 env._PERSONA 由 agent.ts 在执行时注入

export const subagentDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent",
    description:
      "派遣一个子 agent 独立执行任务。子 agent 有自己的上下文，不干扰当前对话。适合需要多步骤完成且与主任务相对独立的子任务。子 agent 执行完毕后返回结果。注意：子 agent 不能再派遣子 agent。",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "子 agent 的任务描述。3-5 个词，用于标识。如 '读取项目文件' 或 '分析数据'。",
        },
        prompt: {
          type: "string",
          description: "给子 agent 的详细指令。应包含完整的任务说明，因为子 agent 看不到当前对话的历史。如 '读取 data2.csv 文件，计算 MAE 和 RMSE，返回结果'。",
        },
      },
      required: ["description", "prompt"],
    },
  },
};

export function createSubagentExec(
  llm: LLMClient,
  persona: PersonaDefinition
): ToolExecutor {
  return async (args, _env, invocation) => {
    const description = args.description as string;
    const prompt = args.prompt as string;

    if (!prompt) {
      return "错误：缺少 prompt 参数";
    }

    console.log(`🤖 子 agent 启动: ${description}`);

    if (!invocation) throw new Error("缺少受控工具调用服务");
    const child = invocation.deriveChild({ principal: "subagent" });
    try {
      const result = await runSubAgent({
        llm,
        persona,
        prompt,
        capabilityContext: child,
        invocation,
      });

      console.log(`✅ 子 agent 完成: ${description}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ 子 agent 失败: ${description}: ${msg}`);
      return `子 agent 执行失败: ${msg}`;
    } finally {
      invocation.finishChild(child);
    }
  };
}
