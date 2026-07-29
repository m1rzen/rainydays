// ===========================================
// Playbook —— 自动化任务脚本
// 定义多步骤任务序列，一次性执行
// ===========================================

import type { LLMClient } from "./llm.js";
import type { CapabilityContext } from "./capability-broker.js";
import { getManagedPathStore, validateManagedIdentifier } from "./managed-path-store.js";
import { PathDeniedError } from "./path-policy.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "./types.js";

export interface PlaybookStep {
  message: string;
  description?: string;
}

export interface Playbook {
  name: string;
  description: string;
  steps: PlaybookStep[];
}

/** 运行中的 playbook 状态 */
export interface PlaybookOwner {
  readonly sessionId: string;
  readonly runId: string;
}

export interface PlaybookRun {
  id: string;
  ownerSessionId: string;
  ownerRunId: string;
  playbookName: string;
  currentStep: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "aborted";
  results: string[];
  startedAt: string;
}

const activeRuns = new Map<string, PlaybookRun>();

function parsePlaybook(name: string, bytes: Uint8Array): Playbook {
  const safeName = validateManagedIdentifier(name);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Playbook ${safeName} 格式无效`);
  const value = parsed as Record<string, unknown>;
  if (value.name !== safeName || typeof value.description !== "string" || !Array.isArray(value.steps)) {
    throw new Error(`Playbook ${safeName} 定义无效`);
  }
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Playbook ${safeName} 步骤 ${index + 1} 无效`);
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.message !== "string" || !candidate.message) throw new Error(`Playbook ${safeName} 步骤 ${index + 1} 无效`);
    if (candidate.description !== undefined && typeof candidate.description !== "string") throw new Error(`Playbook ${safeName} 步骤 ${index + 1} 无效`);
    return Object.freeze({ message: candidate.message, ...(candidate.description === undefined ? {} : { description: candidate.description }) });
  });
  return Object.freeze({ name: safeName, description: value.description, steps: Object.freeze(steps) }) as Playbook;
}

/** 列出所有 playbook。损坏定义不发布，但根权限错误必须向上传播。 */
export async function listPlaybooks(): Promise<{ name: string; description: string; steps: number }[]> {
  const store = await getManagedPathStore();
  const results: { name: string; description: string; steps: number }[] = [];
  for (const name of await store.listNames("playbooks", ".json")) {
    try {
      const pb = parsePlaybook(name, await store.readNamed("playbooks", name, ".json"));
      results.push({ name: pb.name, description: pb.description, steps: pb.steps.length });
    } catch (error) {
      if (error instanceof PathDeniedError) throw error;
      console.error(`加载 Playbook 失败: ${name}.json:`, error);
    }
  }
  return results;
}

/** 获取单个 playbook。仅文件不存在返回 null。 */
export async function getPlaybook(name: string): Promise<Playbook | null> {
  const safeName = validateManagedIdentifier(name);
  const store = await getManagedPathStore();
  try {
    return parsePlaybook(safeName, await store.readNamed("playbooks", safeName, ".json"));
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
    throw error;
  }
}

/** 使用exclusive create创建playbook，不覆盖既有定义。 */
export async function createPlaybook(pb: Playbook): Promise<string> {
  const normalized = parsePlaybook(validateManagedIdentifier(pb.name), Buffer.from(JSON.stringify(pb), "utf8"));
  const store = await getManagedPathStore();
  await store.createNamed("playbooks", normalized.name, ".json", Buffer.from(JSON.stringify(normalized, null, 2), "utf8"));
  return `✅ Playbook "${normalized.name}" 已创建，包含 ${normalized.steps.length} 个步骤`;
}

/** 列出活跃的运行 */
export function listActiveRuns(owner: PlaybookOwner): PlaybookRun[] {
  return Array.from(activeRuns.values()).filter((run) => run.ownerSessionId === owner.sessionId && run.ownerRunId === owner.runId);
}

/** 获取运行状态 */
export function getRunStatus(runId: string, owner: PlaybookOwner): PlaybookRun | undefined {
  const run = activeRuns.get(runId);
  return run?.ownerSessionId === owner.sessionId && run.ownerRunId === owner.runId ? run : undefined;
}

/** 创建运行实例 */
export function createRun(playbookName: string, totalSteps: number, owner: PlaybookOwner): PlaybookRun {
  const run: PlaybookRun = {
    id: `run_${Date.now()}`,
    ownerSessionId: owner.sessionId,
    ownerRunId: owner.runId,
    playbookName,
    currentStep: 0,
    totalSteps,
    status: "running",
    results: [],
    startedAt: new Date().toISOString(),
  };
  activeRuns.set(run.id, run);
  return run;
}

/** 更新运行状态 */
export function updateRun(runId: string, step: number, result: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.currentStep = step;
  // 按步骤号覆盖写入，保证 N 步只保留 N 条结果；重复更新不会产生重复行。
  run.results[step - 1] = result;
  if (step >= run.totalSteps) {
    run.status = "completed";
  }
}

/** 中止运行 */
export function abortRun(runId: string, owner: PlaybookOwner): boolean {
  const run = getRunStatus(runId, owner);
  if (!run) return false;
  run.status = "aborted";
  return true;
}

// ===========================================
// 执行引擎 —— 真正按步骤执行 playbook
// ===========================================

/** 执行回调类型：每步执行时调用，传入步骤消息和结果 */
export type PlaybookStepCallback = (run: PlaybookRun, stepIndex: number, message: string, result: string) => void;

/**
 * 执行 playbook：按步骤依次向 LLM 发送消息，收集结果
 * @param playbookName 要执行的 playbook 名称
 * @param llm LLM 客户端
 * @param persona 当前 persona（提供 system prompt 和工具）
 * @param onStep 每步回调（可选，用于 SSE 推送）
 * @returns 运行结果
 */
export async function executePlaybook(
  playbookName: string,
  llm: LLMClient,
  persona: { systemPrompt: string },
  capabilityContext: CapabilityContext,
  invocation: ToolInvocationServices,
  onStep?: PlaybookStepCallback
): Promise<PlaybookRun> {
  const owner = { sessionId: capabilityContext.sessionId, runId: capabilityContext.runId };
  const pb = await getPlaybook(playbookName);
  if (!pb) {
    const run = createRun(playbookName, 0, owner);
    run.status = "failed";
    run.results.push(`Playbook 不存在: ${playbookName}`);
    return run;
  }

  const run = createRun(playbookName, pb.steps.length, owner);
  const tools = invocation.getToolDefinitions(capabilityContext);

  for (let i = 0; i < pb.steps.length; i++) {
    // 检查是否被中止
    if (run.status === "aborted") break;

    const step = pb.steps[i];
    run.currentStep = i + 1;

    try {
      // 向 LLM 发送步骤消息
      const messages = [
        { role: "system" as const, content: persona.systemPrompt },
        { role: "user" as const, content: step.message },
      ];

      const response = await llm.chat(messages, tools);

      // 如果 LLM 决定调用工具，执行工具
      let resultText = response.content || "";
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const tc of response.tool_calls) {
          let parsed: unknown;
          try { parsed = JSON.parse(tc.function.arguments); } catch { throw new Error(`工具参数不是合法 JSON: ${tc.function.name}`); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`工具参数必须是 object: ${tc.function.name}`);
          const toolResult = await invocation.executeTool(capabilityContext, tc.function.name, parsed as Record<string, unknown>);
          resultText += `\n[工具 ${tc.function.name}]: ${toolResult.slice(0, 500)}`;
        }
      }

      updateRun(run.id, i + 1, resultText);
      if (onStep) onStep(run, i, step.message, resultText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      run.results.push(`步骤 ${i + 1} 失败: ${errMsg}`);
      run.status = "failed";
      if (onStep) onStep(run, i, step.message, `错误: ${errMsg}`);
      break;
    }
  }

  if (run.status === "running") {
    run.status = "completed";
  }

  return run;
}

// ===========================================
// Playbook 工具定义
// ===========================================

export const playbookExecuteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "playbook_execute",
    description: "执行指定的 Playbook 自动化脚本。按步骤依次执行，返回每步结果。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要执行的 playbook 名称" },
      },
      required: ["name"],
    },
  },
};

export function createPlaybookExecuteExec(llm: LLMClient, persona: { systemPrompt: string }): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("缺少受控工具调用服务");
    const name = args.name as string;
    const child = invocation.deriveChild({ principal: "playbook" });
    try {
      const run = await executePlaybook(name, llm, persona, child, invocation);
      const lines = run.results.map((r, i) => `步骤 ${i + 1}: ${r.slice(0, 200)}`);
      return `Playbook "${name}" 执行${run.status === "completed" ? "完成" : run.status === "failed" ? "失败" : "中止"} (${run.currentStep}/${run.totalSteps} 步):\n\n${lines.join("\n\n")}`;
    } finally {
      invocation.finishChild(child);
    }
  };
}

export const playbookAbortDef: ToolDefinition = {
  type: "function",
  function: {
    name: "playbook_abort",
    description: "中止正在运行的 Playbook。",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "运行 ID" },
      },
      required: ["runId"],
    },
  },
};

export const playbookAbortExec: ToolExecutor = async (args, env) => {
  const runId = args.runId as string;
  const sessionId = env?._SESSION_ID;
  const ownerRunId = env?._CAPABILITY_RUN_ID;
  if (!sessionId || !ownerRunId) throw new Error("缺少Broker签发的Playbook owner");
  return abortRun(runId, { sessionId, runId: ownerRunId })
    ? `✅ Playbook 运行 ${runId} 已中止`
    : "运行不存在";
};
