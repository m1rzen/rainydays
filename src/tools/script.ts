// ===========================================
// script —— SEC-02 CWD authority + SEC-03 E3 isolated runtimes
// ===========================================

import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { ExecutionDeniedError } from "../execution-isolation.js";
import { isRunCancellation } from "../run-cancellation.js";
import { parseScriptTimeout, type ScriptLanguage } from "../script-runtime.js";

function initialCwd(
  args: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>> | undefined,
  invocation: ToolInvocationServices | undefined,
): { gateway: ScopedPathGateway; input: string; defaultRootId: string } {
  if (!invocation) throw new Error("Path gateway is required");
  const explicit = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : null;
  for (const key of ["WORKSPACE_ROOT", "DATA_ROOT"] as const) {
    const rootId = invocation.path.rootIdForEnv(key);
    if (!rootId) continue;
    if (explicit) return { gateway: invocation.path, input: explicit, defaultRootId: rootId };
    const input = env?.[key];
    if (input) return { gateway: invocation.path, input, defaultRootId: rootId };
  }
  throw new Error("Path root is unavailable for process CWD");
}

function scriptLanguage(value: unknown): ScriptLanguage {
  const lang = value === undefined ? "node" : value;
  if (lang !== "node" && lang !== "node-cjs") {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Python requires a separately leased interpreter and is unavailable in this build");
  }
  return lang;
}

export const scriptDef: ToolDefinition = {
  type: "function",
  function: {
    name: "script",
    description:
      "在 SEC-03 隔离 runner 中执行脚本。默认 Node.js ESM（支持 top-level await）；node-cjs 提供 CommonJS require。cwd 必须在能力根内，timeout 由原生 Job 强制。沙箱内提供冻结的 lux.readText/writeText/readJson/writeJson/done bridge。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          minLength: 1,
          maxLength: 122880,
          description: "脚本代码。Node ESM 使用 import；node-cjs 可使用 require。用 console.log() 或 lux.done() 输出。",
        },
        lang: {
          type: "string",
          enum: ["node", "node-cjs", "python"],
          description: "运行时；默认 node。python 仅在存在受租约 interpreter 的构建中可用。",
        },
        cwd: {
          type: "string",
          minLength: 1,
          description: "初始工作目录；相对路径按当前能力根解析，且必须通过 SEC-02 身份校验。",
        },
        timeout: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          description: "原生隔离进程超时（毫秒），默认 10000。",
        },
      },
      required: ["code"],
    },
  },
};

export const scriptExec: ToolExecutor = async (args, env, invocation) => {
  const code = args.code as string;
  const lang = scriptLanguage(args.lang);
  const timeoutMs = parseScriptTimeout(args.timeout);
  const cwd = initialCwd(args, env, invocation);
  if (!invocation) throw new Error("Execution gateway is required");
  try {
    const result = await cwd.gateway.withExecutionRoot(
      cwd.input,
      { defaultRootId: cwd.defaultRootId },
      (_canonicalCwd, rootLease) => invocation.execution.executeScript({ code, lang, timeoutMs, rootLease }),
    );
    let output = result.stdout || "(代码执行完成，无输出)";
    if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
    const failed = result.exitCode !== 0 || result.reason !== "completed";
    if (failed) output += `\n[execution ${result.reason}; exit ${result.exitCode ?? "none"}]`;
    if (result.outputTruncated) output += "\n(输出超过保留上限，已截断)";
    if (failed) throw new Error(output);
    return output;
  } catch (error) {
    if (isRunCancellation(error)) throw error;
    throw new Error(`代码执行出错:\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};
