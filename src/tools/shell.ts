// ===========================================
// Shell 命令执行工具 —— SEC-02 只治理进程初始 CWD
// 进程启动后的文件系统隔离由 SEC-03 负责
// ===========================================

import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

function initialCwd(
  args: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>> | undefined,
  invocation: ToolInvocationServices | undefined
): { gateway: ScopedPathGateway; input: string; defaultRootId: string } {
  if (!invocation) throw new Error("Path gateway is required");
  const explicit = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : null;
  const keys = ["WORKSPACE_ROOT", "DATA_ROOT"] as const;
  if (explicit) {
    for (const key of keys) {
      const rootId = invocation.path.rootIdForEnv(key);
      if (rootId) return { gateway: invocation.path, input: explicit, defaultRootId: rootId };
    }
    throw new Error("Path root is unavailable for process CWD");
  }
  for (const key of keys) {
    const rootId = invocation.path.rootIdForEnv(key);
    const value = env?.[key];
    if (rootId && value) return { gateway: invocation.path, input: value, defaultRootId: rootId };
  }
  throw new Error("Path root is unavailable for process CWD");
}

export const executeCommandDef: ToolDefinition = {
  type: "function",
  function: {
    name: "execute_command",
    description:
      "执行系统 Shell 命令（如 git、npm、dir 等）。初始工作目录必须位于当前能力允许的根内；进程启动后的隔离由系统安全策略负责。返回 stdout 和 stderr，超时 30 秒。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令，如 'git status'。" },
        cwd: { type: "string", description: "初始工作目录（可选），必须位于受权根内。" },
      },
      required: ["command"],
    },
  },
};

export const executeCommandExec: ToolExecutor = async (args, env, invocation) => {
  const command = args.command as string;
  const cwd = initialCwd(args, env, invocation);
  if (!invocation) throw new Error("Execution gateway is required");

  try {
    const { stdout, stderr, reason, exitCode } = await cwd.gateway.withExecutionRoot(
      cwd.input,
      { defaultRootId: cwd.defaultRootId },
      (_canonicalCwd, rootLease) => invocation.execution.executeCommand({ command, rootLease })
    );

    let result = "";
    if (stdout) result += stdout;
    if (stderr) result += `\n[stderr]\n${stderr}`;
    if (exitCode !== 0 || reason !== "completed") result += `\n[execution ${reason}; exit ${exitCode ?? "none"}]`;
    if (!result) result = "(命令执行完成，无输出)";
    if (result.length > 4000) result = result.slice(0, 4000) + `\n\n... (输出已截断，共 ${result.length} 字符)`;
    return result;
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; message: string; killed?: boolean };
    let result = "";
    if (failure.stdout) result += failure.stdout;
    if (failure.stderr) result += `\n[stderr]\n${failure.stderr}`;
    if (failure.killed) result += "\n(命令超时，已终止)";
    if (!result) result = failure.message;
    return `命令执行出错:\n${result}`;
  }
};
