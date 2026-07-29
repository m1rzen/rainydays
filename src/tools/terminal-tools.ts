// ===========================================
// Persistent Terminal tools
// Agent 可创建、输入、读取、列出和终止持久 Shell 会话
// ===========================================

import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import type { TerminalOwner, TerminalShell } from "../terminal.js";
import { terminalFacade } from "../terminal-facade.js";

function terminalOwner(invocation?: ToolInvocationServices): TerminalOwner {
  if (!invocation) throw new Error("终端工具缺少Broker签发的resource owner");
  return invocation.resourceOwner;
}

function initialCwd(args: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string>> | undefined, invocation: ToolInvocationServices) {
  const explicit = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : null;
  for (const key of ["WORKSPACE_ROOT", "DATA_ROOT"] as const) {
    const rootId = invocation.path.rootIdForEnv(key);
    if (!rootId) continue;
    if (explicit) return { input: explicit, rootId };
    const configured = env?.[key];
    if (configured) return { input: configured, rootId };
  }
  throw new Error("Path root is unavailable for Terminal CWD");
}

export const shellStartDef: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_start",
    description: "创建一个持久 Shell 会话。后续用 shell_input 发送命令，CWD 和环境变量会跨命令保留。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "会话名称（可选）" },
        shell: { type: "string", enum: ["cmd", "powershell"], description: "Shell 类型，默认 cmd" },
        cwd: { type: "string", description: "初始工作目录，默认使用 Settings 工作目录" },
      },
    },
  },
};

export const shellStartExec: ToolExecutor = async (args, env, invocation) => {
  if (!invocation) throw new Error("终端工具缺少Broker签发的调用服务");
  const cwd = initialCwd(args, env, invocation);
  const info = await invocation.path.withExecutionRoot(
    cwd.input,
    { defaultRootId: cwd.rootId },
    (authorizedCwd, executionRootLease) => terminalFacade.start(terminalOwner(invocation), {
      name: args.name as string | undefined,
      shell: (args.shell as TerminalShell | undefined) || "cmd",
      authorizedCwd,
      executionRootLease,
      execution: invocation.execution,
    })
  );
  return `✅ 持久终端已创建\nID: ${info.id}\n名称: ${info.name}\nShell: ${info.shell}\n初始目录: ${info.cwd}\nPID: ${info.pid}`;
};

export const shellInputDef: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_input",
    description: "向正在运行的持久 Shell 会话发送命令或输入。命令会在该会话当前目录和环境中执行。",
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "shell_start 返回的终端 ID" },
        input: { type: "string", description: "要发送的命令或输入" },
        appendNewline: { type: "boolean", description: "是否自动追加回车，默认 true" },
      },
      required: ["terminalId", "input"],
    },
  },
};

export const shellInputExec: ToolExecutor = async (args, _env, invocation) => {
  const terminalId = args.terminalId as string;
  if (!invocation) throw new Error("终端工具缺少Broker签发的调用服务");
  await terminalFacade.input(terminalOwner(invocation), terminalId, args.input as string, args.appendNewline !== false, invocation.execution);
  return `✅ 已向 ${terminalId} 发送输入`;
};

export const shellOutputDef: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_output",
    description: "读取持久终端输出。传 offset 可增量读取；返回 nextOffset 供下次继续。",
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "终端 ID" },
        offset: { type: "number", description: "从哪个字符偏移开始读取（可选）" },
        limit: { type: "number", description: "最多读取字符数，默认 20000" },
      },
      required: ["terminalId"],
    },
  },
};

export const shellOutputExec: ToolExecutor = async (args, _env, invocation) => {
  const result = terminalFacade.output(
    terminalOwner(invocation),
    args.terminalId as string,
    typeof args.offset === "number" ? args.offset : undefined,
    typeof args.limit === "number" ? args.limit : 20000
  );
  return `终端: ${result.info.id} (${result.info.status})\n范围: ${result.start}-${result.nextOffset}, nextOffset=${result.nextOffset}${result.truncated ? "，输出有截断" : ""}\n\n${result.data || "(暂无输出)"}`;
};

export const shellListDef: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_list",
    description: "列出所有持久终端会话及运行状态。",
    parameters: { type: "object", properties: {} },
  },
};

export const shellListExec: ToolExecutor = async (_args, _env, invocation) => {
  const sessions = terminalFacade.list(terminalOwner(invocation));
  if (sessions.length === 0) return "当前没有持久终端会话。";
  return sessions.map((s) => `${s.id} | ${s.name} | ${s.shell} | ${s.status} | PID ${s.pid ?? "-"} | ${s.cwd}`).join("\n");
};

export const shellKillDef: ToolDefinition = {
  type: "function",
  function: {
    name: "shell_kill",
    description: "终止一个持久终端及其子进程树。终止后仍可用 shell_output 查看已有输出。",
    parameters: {
      type: "object",
      properties: { terminalId: { type: "string", description: "要终止的终端 ID" } },
      required: ["terminalId"],
    },
  },
};

export const shellKillExec: ToolExecutor = async (args, _env, invocation) => {
  const terminalId = args.terminalId as string;
  await terminalFacade.kill(terminalOwner(invocation), terminalId);
  return `✅ 终端 ${terminalId} 及其子进程已终止`;
};
