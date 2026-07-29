// ===========================================
// script 工具 —— Node.js ESM 子进程
// SEC-02 治理初始 CWD；SEC-03 负责进程启动后的 OS 隔离
// ===========================================

import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

function initialCwd(
  env: Readonly<Record<string, string>> | undefined,
  invocation: ToolInvocationServices | undefined
): { gateway: ScopedPathGateway; input: string; defaultRootId: string } {
  if (!invocation) throw new Error("Path gateway is required");
  for (const key of ["WORKSPACE_ROOT", "DATA_ROOT"] as const) {
    const rootId = invocation.path.rootIdForEnv(key);
    const input = env?.[key];
    if (rootId && input) return { gateway: invocation.path, input, defaultRootId: rootId };
  }
  throw new Error("Path root is unavailable for process CWD");
}

export const scriptDef: ToolDefinition = {
  type: "function",
  function: {
    name: "script",
    description:
      "在Node.js ESM子进程中执行数据处理代码，支持top-level await与标准库import。初始CWD受能力根约束；进程启动后的隔离由SEC-03负责。超时10秒。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          maxLength: 131072,
          description: "Node.js ESM代码。用console.log()输出结果。",
        },
      },
      required: ["code"],
    },
  },
};

export const scriptExec: ToolExecutor = async (args, env, invocation) => {
  const code = args.code as string;
  const cwd = initialCwd(env, invocation);
  if (!invocation) throw new Error("Execution gateway is required");
  try {
    const result = await cwd.gateway.withExecutionRoot(
      cwd.input,
      { defaultRootId: cwd.defaultRootId },
      (_canonicalCwd, rootLease) => invocation.execution.executeScript({ code, rootLease })
    );
    let output = result.stdout || "(代码执行完成，无输出)";
    if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
    if (result.exitCode !== 0 || result.reason !== "completed") output += `\n[execution ${result.reason}; exit ${result.exitCode ?? "none"}]`;
    if (result.outputTruncated) output += "\n(输出超过保留上限，已截断)";
    if (output.length > 4000) output = output.slice(0, 4000) + `\n\n...(输出已截断，共 ${output.length} 字符)`;
    return output;
  } catch (error) {
    return `代码执行出错:\n${error instanceof Error ? error.message : String(error)}`;
  }
};
