import type { LLMClient } from "../llm.js";
import type { ConversationMemory } from "../memory.js";
import type { SubagentPeekScope, SubagentRegistry } from "../subagent-registry.js";
import type { PersonaDefinition, ToolDefinition, ToolExecutor } from "../types.js";

const taskId = { type: "string", minLength: 1, maxLength: 80, description: "Subagent task_id。" };

export const subagentDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent",
    description: "在后台启动独立 Subagent，并立即返回 task_id。使用 output/wait/peek/post/stop/list 管理生命周期。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 160, description: "3-5 个词的任务描述。" },
        prompt: { type: "string", minLength: 1, maxLength: 131072, description: "完整任务指令。" },
        persona: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "可选 Persona；权限只会比父级更窄。" },
        inherit_canvas: { type: "boolean", description: "是否继承派遣时的父画布快照，默认 false。" },
      },
      required: ["description", "prompt"],
    },
  },
};

export const subagentListDef: ToolDefinition = {
  type: "function",
  function: { name: "subagent_list", description: "列出当前 Session 的全部 Subagent。", parameters: { type: "object", properties: {} } },
};

export const subagentOutputDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent_output",
    description: "读取 Subagent 状态和最终输出；可选短时阻塞。等待被取消不会停止 child。",
    parameters: {
      type: "object",
      properties: {
        task_id: taskId,
        block: { type: "boolean", description: "是否等待输出，默认 false。" },
        timeout: { type: "number", minimum: 1, maximum: 300000, description: "阻塞超时毫秒数。" },
      },
      required: ["task_id"],
    },
  },
};

export const subagentPeekDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent_peek",
    description: "非阻塞查看 Subagent 最近事件，支持分页。",
    parameters: {
      type: "object",
      properties: {
        task_id: taskId,
        scope: { type: "string", enum: ["status", "brief", "last", "recent", "full"], description: "事件详细级别。" },
        page: { type: "number", minimum: 0, maximum: 1000, description: "从最新页起的页码。" },
      },
      required: ["task_id"],
    },
  },
};

export const subagentPostDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent_post",
    description: "向运行中的 Subagent 发送 sideband 指令，在下一个 checkpoint 注入。",
    parameters: {
      type: "object",
      properties: {
        task_id: taskId,
        message: { type: "string", minLength: 1, maxLength: 8192, description: "Sideband 指令。" },
      },
      required: ["task_id", "message"],
    },
  },
};

export const subagentStopDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent_stop",
    description: "停止运行中的 Subagent；已结束时幂等返回。",
    parameters: { type: "object", properties: { task_id: taskId }, required: ["task_id"] },
  },
};

export const subagentWaitDef: ToolDefinition = {
  type: "function",
  function: {
    name: "subagent_wait",
    description: "等待 Subagent 结束并返回最终状态。等待取消不会停止 child。",
    parameters: { type: "object", properties: { task_id: taskId }, required: ["task_id"] },
  },
};

export interface SubagentExecutorDependencies {
  readonly registry: SubagentRegistry;
  readonly llm: LLMClient;
  readonly persona: PersonaDefinition;
  readonly memory: ConversationMemory;
  readonly resolvePersona: (name: string) => PersonaDefinition | null;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createSubagentExecutors(dependencies: SubagentExecutorDependencies): Readonly<Record<string, ToolExecutor>> {
  const { registry, llm, persona, memory, resolvePersona } = dependencies;
  const spawn: ToolExecutor = async (args, _env, invocation) => {
    if (!invocation) throw new Error("缺少受控工具调用服务");
    const requestedPersona = args.persona === undefined ? persona : resolvePersona(args.persona as string);
    if (!requestedPersona) throw new Error(`Persona 不存在: ${String(args.persona)}`);
    const child = await registry.spawn({
      description: args.description as string,
      prompt: args.prompt as string,
      persona: requestedPersona,
      llm,
      parentContext: invocation.capabilityContext,
      parentInvocation: invocation,
      inheritCanvas: args.inherit_canvas === true,
      canvasSnapshot: args.inherit_canvas === true ? memory.getAll() : [],
    });
    return json(child);
  };
  return Object.freeze({
    subagent: spawn,
    subagent_list: async () => json(registry.list()),
    subagent_output: async (args, _env, invocation) => {
      if (!invocation) throw new Error("缺少受控工具调用服务");
      return json(await registry.output(args.task_id as string, {
        block: args.block === true,
        ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout as number }),
        signal: invocation.signal,
      }));
    },
    subagent_peek: async args => json(registry.peek(
      args.task_id as string,
      (args.scope as SubagentPeekScope | undefined) ?? "last",
      (args.page as number | undefined) ?? 0,
    )),
    subagent_post: async args => json(registry.post(args.task_id as string, args.message as string)),
    subagent_stop: async args => json(await registry.stop(args.task_id as string)),
    subagent_wait: async (args, _env, invocation) => {
      if (!invocation) throw new Error("缺少受控工具调用服务");
      return json(await registry.wait(args.task_id as string, invocation.signal));
    },
  });
}
