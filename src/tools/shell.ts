// ===========================================
// Shell 命令执行工具 —— SEC-02 只治理进程初始 CWD
// 进程启动后的文件系统隔离由 SEC-03 负责
// ===========================================

import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { isRunCancellation } from "../run-cancellation.js";
import { formatDeveloperResult, isDeveloperModeEnabled, parseDeveloperTimeout, runDeveloperCommand } from "../developer-execution.js";

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
      "执行一条 cmd 命令（如 git、npm、python、dir）。工作目录必须位于授权根内。返回 stdout/stderr 与真实退出码。同事模式在系统隔离中运行、限时30秒；开发模式以用户身份和用户工具链运行，timeout 可设（默认120秒，最长600秒），stdin 关闭。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令，如 'git status'。" },
        cwd: { type: "string", description: "初始工作目录（可选），必须位于受权根内。" },
        timeout: { type: "number", description: "开发模式下的超时秒数（可选，默认120，最长600）；同事模式忽略。" },
      },
      required: ["command"],
    },
  },
};

export const executeCommandExec: ToolExecutor = async (args, env, invocation) => {
  const command = args.command as string;
  const cwd = initialCwd(args, env, invocation);
  if (!invocation) throw new Error("Execution gateway is required");

  if (isDeveloperModeEnabled()) {
    const timeoutSeconds = parseDeveloperTimeout(args.timeout);
    const result = await cwd.gateway.withExecutionRoot(
      cwd.input,
      { defaultRootId: cwd.defaultRootId },
      (canonicalCwd) => runDeveloperCommand({ command, cwd: canonicalCwd, timeoutSeconds, signal: invocation.signal, owner: invocation.resourceOwner })
    );
    const formatted = formatDeveloperResult(result, timeoutSeconds);
    if (formatted.failed) throw new Error(formatted.text);
    return formatted.text;
  }

  try {
    const { stdout, stderr, reason, exitCode } = await cwd.gateway.withExecutionRoot(
      cwd.input,
      { defaultRootId: cwd.defaultRootId },
      (_canonicalCwd, rootLease) => invocation.execution.executeCommand({ command, rootLease })
    );

    let result = "";
    if (stdout) result += stdout;
    if (stderr) result += `\n[stderr]\n${stderr}`;
    const failed = exitCode !== 0 || reason !== "completed";
    if (failed) result += `\n[execution ${reason}; exit ${exitCode ?? "none"}]`;
    if (!result) result = "(命令执行完成，无输出)";
    if (failed) throw new Error(result);
    return result;
  } catch (error: unknown) {
    if (isRunCancellation(error)) throw error;
    const failure = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    let result = "";
    if (failure.stdout) result += failure.stdout;
    if (failure.stderr) result += `\n[stderr]\n${failure.stderr}`;
    if (failure.killed) result += "\n(命令超时，已终止)";
    if (!result) result = failure.message ?? String(error);
    throw new Error(`命令执行出错:\n${result}`, { cause: error });
  }
};
