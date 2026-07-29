// ===========================================
// Oracle 工具 —— oracle_query
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { LLMClient } from "../llm.js";
import { queryOracle, saveOracle, getOracleStatus } from "../oracle.js";

export const oracleQueryDef: ToolDefinition = {
  type: "function",
  function: {
    name: "oracle_query",
    description:
      "向项目知识库 Oracle 提问。Oracle 是一个只读的项目快照，包含目录结构和关键文件内容。用于了解项目架构、模块关系、设计意图。",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "关于项目的问题。如 '这个项目的架构是什么' 或 '入口文件在哪里'。",
        },
      },
      required: ["question"],
    },
  },
};

export function createOracleQueryExec(llm: LLMClient): ToolExecutor {
  return async (args) => {
    const question = args.question as string;
    return await queryOracle(llm, question);
  };
}
