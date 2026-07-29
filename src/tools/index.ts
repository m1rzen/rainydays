// ===========================================
// 工具注册中心 —— 统一注册所有工具
// 按 persona 的 tools 列表动态加载
// ===========================================

import Ajv, { type ValidateFunction } from "ajv";
import type { RegisteredTool, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { CapabilityBroker, CapabilityDeniedError, type CapabilityContext, type InspectedToolCall, type RuntimeAuthority } from "../capability-broker.js";
import { DIRECT_OPERATION_POLICIES, RUNTIME_TOOL_POLICIES, STATIC_TOOL_POLICIES } from "../tool-policies.js";
import { getSessionInfo } from "../session.js";
import { PathDeniedError } from "../path-policy.js";
import { pathPolicy } from "../path-runtime.js";
import { createScopedExecutionGateway } from "../execution-runtime.js";
import {
  listDirectoryDef, listDirectoryExec,
  readFileDef, readFileExec,
  searchFilesDef, searchFilesExec,
  writeFileDef, writeFileExec,
  editFileDef, editFileExec,
  grepDef, grepExec,
} from "./filesystem.js";
import {
  createDocxDef, createDocxExec,
  createXlsxDef, createXlsxExec,
} from "./writer.js";
import {
  executeCommandDef, executeCommandExec,
} from "./shell.js";
import {
  shellStartDef, shellStartExec,
  shellInputDef, shellInputExec,
  shellOutputDef, shellOutputExec,
  shellListDef, shellListExec,
  shellKillDef, shellKillExec,
} from "./terminal-tools.js";
import {
  fetchUrlDef, fetchUrlExec,
} from "./web.js";
import {
  rememberDef, rememberExec,
  recallDef, recallExec,
  listMemoriesDef, listMemoriesExec,
} from "./memory-tools.js";
import {
  createTasksDef, createTasksExec,
  updateTaskDef, updateTaskExec,
  listTasksDef, listTasksExec,
} from "./task-tools.js";
import {
  scriptDef, scriptExec,
} from "./script.js";
import {
  getCurrentTimeDef, getCurrentTimeExec,
} from "./system.js";
import {
  subagentDef,
} from "./subagent-tools.js";
import type { LLMClient } from "../llm.js";
import type { PersonaDefinition } from "../types.js";
import { createSubagentExec } from "./subagent-tools.js";
import {
  cronScheduleDef, cronListDef, cronCancelDef, cronListExec,
  createCronScheduleExec, createCronCancelExec,
} from "./cron-tools.js";
import {
  inspectDef, inspectExec,
  graphDef, graphExec,
  consolidateDef,
} from "./knowledge-tools.js";
import { createConsolidateExec } from "./knowledge-tools.js";
import { curateDef } from "./curate-tool.js";
import { webSearchDef, webSearchExec } from "./search-tool.js";
import { downloadDef, downloadExec } from "./download-tool.js";
import { askUserDef, askUserExec } from "./ask-user-tool.js";
import {
  oracleQueryDef,
  oracleSaveDef, oracleSaveExec,
  oracleStatusDef, oracleStatusExec,
  playbookListDef, playbookListExec,
  playbookCreateDef, playbookCreateExec,
  playbookStatusDef, playbookStatusExec,
  linkDiscoverDef, linkDiscoverExec,
  linkPeekDef, linkPeekExec,
  linkPostDef, linkPostExec,
  pollSubscribeDef, pollSubscribeExec,
  pollUnsubscribeDef, pollUnsubscribeExec,
  pollListDef, pollListExec,
  superviseDef, superviseExec,
} from "./advanced-tools.js";
import { createOracleQueryExec } from "./advanced-tools.js";
import {
  memoAddDef, memoAddExec, memoListDef, memoListExec, memoDoneDef, memoDoneExec,
  mascotNotifyDef, mascotNotifyExec, museDef,
  searchToolsDef, searchToolsExec, setNotifyCallback,
} from "./phase1-tools.js";
import { imageHelperDef, imageHelperExec } from "./image-helper.js";
import { readRepoDef, readRepoExec } from "./read-repo.js";
import { savePersonaDef, createSavePersonaExec } from "./save-persona.js";
import type { CronJobRow } from "../db.js";

/** 全部已注册的工具（按名索引） */
const rawStaticTools: Omit<RegisteredTool, "policy">[] = [
  { name: "list_directory",  definition: listDirectoryDef,  executor: listDirectoryExec },
  { name: "read_file",       definition: readFileDef,        executor: readFileExec },
  { name: "search_files",    definition: searchFilesDef,     executor: searchFilesExec },
  { name: "write_file",      definition: writeFileDef,       executor: writeFileExec },
  { name: "edit_file",       definition: editFileDef,        executor: editFileExec },
  { name: "grep",            definition: grepDef,             executor: grepExec },
  { name: "create_docx",     definition: createDocxDef,      executor: createDocxExec },
  { name: "create_xlsx",     definition: createXlsxDef,      executor: createXlsxExec },
  { name: "execute_command", definition: executeCommandDef,  executor: executeCommandExec },
  { name: "shell_start",     definition: shellStartDef,       executor: shellStartExec },
  { name: "shell_input",     definition: shellInputDef,       executor: shellInputExec },
  { name: "shell_output",    definition: shellOutputDef,      executor: shellOutputExec },
  { name: "shell_list",      definition: shellListDef,        executor: shellListExec },
  { name: "shell_kill",      definition: shellKillDef,        executor: shellKillExec },
  { name: "fetch_url",       definition: fetchUrlDef,        executor: fetchUrlExec },
  { name: "remember",        definition: rememberDef,        executor: rememberExec },
  { name: "recall",          definition: recallDef,          executor: recallExec },
  { name: "list_memories",   definition: listMemoriesDef,    executor: listMemoriesExec },
  { name: "create_tasks",    definition: createTasksDef,     executor: createTasksExec },
  { name: "update_task",     definition: updateTaskDef,      executor: updateTaskExec },
  { name: "list_tasks",      definition: listTasksDef,       executor: listTasksExec },
  { name: "script",          definition: scriptDef,           executor: scriptExec },
  { name: "get_current_time", definition: getCurrentTimeDef,  executor: getCurrentTimeExec },
  { name: "cron_list",        definition: cronListDef,         executor: cronListExec },
  { name: "inspect",          definition: inspectDef,          executor: inspectExec },
  { name: "graph",            definition: graphDef,             executor: graphExec },
  { name: "web_search",       definition: webSearchDef,         executor: webSearchExec },
  { name: "download",         definition: downloadDef,          executor: downloadExec },
  { name: "ask_user",         definition: askUserDef,           executor: askUserExec },
  { name: "oracle_save",      definition: oracleSaveDef,        executor: oracleSaveExec },
  { name: "oracle_status",    definition: oracleStatusDef,      executor: oracleStatusExec },
  { name: "playbook_list",    definition: playbookListDef,      executor: playbookListExec },
  { name: "playbook_create",  definition: playbookCreateDef,    executor: playbookCreateExec },
  { name: "playbook_status",  definition: playbookStatusDef,    executor: playbookStatusExec },
  { name: "link_discover",    definition: linkDiscoverDef,      executor: linkDiscoverExec },
  { name: "link_peek",        definition: linkPeekDef,           executor: linkPeekExec },
  { name: "link_post",        definition: linkPostDef,           executor: linkPostExec },
  { name: "poll_subscribe",   definition: pollSubscribeDef,     executor: pollSubscribeExec },
  { name: "poll_unsubscribe", definition: pollUnsubscribeDef,   executor: pollUnsubscribeExec },
  { name: "poll_list",        definition: pollListDef,           executor: pollListExec },
  { name: "supervise",        definition: superviseDef,          executor: superviseExec },
  { name: "memo_add",         definition: memoAddDef,             executor: memoAddExec },
  { name: "memo_list",        definition: memoListDef,            executor: memoListExec },
  { name: "memo_done",        definition: memoDoneDef,            executor: memoDoneExec },
  { name: "mascot_notify",    definition: mascotNotifyDef,        executor: mascotNotifyExec },
  { name: "search_tools",     definition: searchToolsDef,         executor: searchToolsExec },
  { name: "image_helper",     definition: imageHelperDef,         executor: imageHelperExec },
  { name: "read_repo",        definition: readRepoDef,            executor: readRepoExec },
];

const staticNames = rawStaticTools.map((tool) => tool.name).sort();
const staticPolicyNames = Object.keys(STATIC_TOOL_POLICIES).sort();
if (JSON.stringify(staticNames) !== JSON.stringify(staticPolicyNames)) {
  throw new Error("SEC-01 static tool policy manifest does not exactly match the registry");
}

const runtimePolicyNames = Object.keys(RUNTIME_TOOL_POLICIES).sort();
if (new Set([...staticNames, ...runtimePolicyNames]).size !== staticNames.length + runtimePolicyNames.length) {
  throw new Error("SEC-01 static and runtime tool names collide");
}

const allTools: RegisteredTool[] = rawStaticTools.map((tool) => ({
  ...tool,
  policy: STATIC_TOOL_POLICIES[tool.name],
}));

export const capabilityBroker = new CapabilityBroker({
  resolveSessionPersona: (sessionId) => getSessionInfo(sessionId)?.persona_name ?? null,
  pathPolicy,
});
for (const tool of allTools) capabilityBroker.registerStaticTool(tool);
for (const [operation, policy] of Object.entries(DIRECT_OPERATION_POLICIES)) capabilityBroker.registerDirectOperation(operation, policy);

const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, strict: false });
const validators = new WeakMap<ToolDefinition, ValidateFunction>();

export class ToolArgumentsError extends Error {
  readonly code = "TOOL_ARGUMENTS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentsError";
  }
}

/** 所有声明工具名；仅用于 Persona 完整性检查和设置 UI，不构成执行授权。 */
export function getAllToolNames(): string[] {
  return [...staticNames, ...runtimePolicyNames];
}

export function registerDynamicTool(authority: RuntimeAuthority, tool: Omit<RegisteredTool, "policy">): void {
  const policy = RUNTIME_TOOL_POLICIES[tool.name];
  if (!policy) throw new Error(`SEC-01 runtime tool is absent from the frozen policy manifest: ${tool.name}`);
  capabilityBroker.registerRuntimeTool(authority, { ...tool, policy });
}

export function getToolDefinitions(context: CapabilityContext): ToolDefinition[] {
  return capabilityBroker.getToolDefinitions(context);
}

function validateArguments(definition: ToolDefinition, args: Record<string, unknown>): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolArgumentsError("工具参数必须是普通 JSON object");
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) throw new ToolArgumentsError("工具参数必须是普通 JSON object");
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.compile(definition.function.parameters);
    validators.set(definition, validate);
  }
  if (!validate(args)) {
    const details = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
    throw new ToolArgumentsError(`工具参数不符合 Schema: ${details}`);
  }
}

export function inspectToolCall(
  context: CapabilityContext,
  name: string,
  args: Record<string, unknown>
): InspectedToolCall {
  let inspected: InspectedToolCall;
  try {
    inspected = capabilityBroker.inspectToolCall(context, name, args);
  } catch (error) {
    if (error instanceof CapabilityDeniedError) throw error;
    throw new ToolArgumentsError("工具参数必须是普通 JSON object，且仅包含可复制的 JSON 数据");
  }
  const definition = getToolDefinitions(context).find((entry) => entry.function.name === inspected.name);
  if (!definition) throw new ToolArgumentsError(`工具定义不可用: ${name}`);
  validateArguments(definition, inspected.args as Record<string, unknown>);
  return inspected;
}

function invocationServices(executionContext: CapabilityContext, inspected: InspectedToolCall): {
  readonly services: ToolInvocationServices;
  readonly close: () => void;
} {
  const issuedPath = capabilityBroker.issueToolPathGateway(executionContext, inspected);
  const resourceOwner = capabilityBroker.getResourceOwner(executionContext);
  const services: ToolInvocationServices = {
    path: issuedPath.gateway,
    execution: createScopedExecutionGateway({ context: executionContext, inspected, owner: resourceOwner }),
    resourceOwner,
    deriveChild: (request) => capabilityBroker.deriveInvocationChild(executionContext, request),
    finishChild: (context) => capabilityBroker.finishContext(context),
    listCurrentToolDefinitions: () => getToolDefinitions(executionContext),
    getToolDefinitions: (context) => getToolDefinitions(context),
    executeTool: (context, name, args) => executeTool(context, name, args),
  };
  return Object.freeze({ services: Object.freeze(services), close: issuedPath.close });
}

export async function executeInspectedTool(
  context: CapabilityContext,
  inspected: InspectedToolCall
): Promise<string> {
  const name = inspected.name;
  const timeoutMs = name === "execute_command" || name === "script" ? 60_000 : 30_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const invocation = invocationServices(context, inspected);
  try {
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`工具 ${name} 执行超时 (${timeoutMs / 1000}s)`)), timeoutMs);
      timeoutHandle.unref?.();
    });
    return await Promise.race([
      capabilityBroker.invokeTool(context, inspected, invocation.services),
      timeoutPromise,
    ]);
  } catch (error) {
    if (error instanceof CapabilityDeniedError || error instanceof ToolArgumentsError || error instanceof PathDeniedError) throw error;
    return `工具执行出错: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    invocation.close();
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** 唯一工具 dispatcher：context 缺失、伪造、过期或越权时在 executor 前抛出。 */
export async function executeTool(
  context: CapabilityContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const inspected = inspectToolCall(context, name, args);
  return executeInspectedTool(context, inspected);
}
