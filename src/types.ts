// ===========================================
// 类型定义 —— Mini-Lux 核心数据结构
// ===========================================

import type { CapabilityContext, ChildCapabilityRequest, ToolPolicy } from "./capability-broker.js";
import type { ResourceOwner } from "./resource-owner.js";
import type { ScopedExecutionGateway } from "./execution-runtime.js";
import type { ExecutionRootLease, PathCreateResult, PathDirectoryEntry, PathReadResult, PathReplaceResult, PathTransformResult, PathWatchEvent } from "./path-policy.js";

/** 对话角色 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 一条对话消息 */
export interface Message {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具的函数定义（给 LLM 看的 schema） */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ScopedOutputReservation {
  readonly commit: (bytes: Uint8Array) => Promise<PathCreateResult | PathReplaceResult<null>>;
}

export interface ScopedWatchLease {
  readonly rootId: string;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
  readonly isOpen: () => boolean;
}

export interface ScopedPathGateway {
  readonly rootIdForEnv: (envKey: string) => string | null;
  readonly withInitialCwd: <T>(
    input: string,
    options: Readonly<{ defaultRootId?: string }>,
    use: (canonicalCwd: string) => T | Promise<T>
  ) => Promise<T>;
  readonly withExecutionRoot: <T>(
    input: string,
    options: Readonly<{ defaultRootId?: string }>,
    use: (canonicalCwd: string, lease: ExecutionRootLease) => T | Promise<T>
  ) => Promise<T>;
  readonly watchDirectory: (
    input: string,
    options: Readonly<{ defaultRootId?: string }>,
    publish: (event: PathWatchEvent) => void | Promise<void>
  ) => Promise<ScopedWatchLease>;
  readonly readFile: (
    input: string,
    options: Readonly<{ defaultRootId?: string; maxBytes: number }>
  ) => Promise<PathReadResult>;
  readonly listDirectory: (
    input: string,
    options?: Readonly<{ defaultRootId?: string; maxEntries?: number }>
  ) => Promise<readonly PathDirectoryEntry[]>;
  readonly searchFile: (
    input: string,
    options: Readonly<{ defaultRootId?: string; maxBytes: number }>
  ) => Promise<PathReadResult>;
  readonly searchDirectory: (
    input: string,
    options?: Readonly<{ defaultRootId?: string; maxEntries?: number }>
  ) => Promise<readonly PathDirectoryEntry[]>;
  readonly createFile: (
    input: string,
    bytes: Uint8Array,
    options?: Readonly<{ defaultRootId?: string; maxBytes?: number }>
  ) => Promise<PathCreateResult>;
  readonly writeFile: (
    input: string,
    bytes: Uint8Array,
    options?: Readonly<{ defaultRootId?: string; maxBytes?: number }>
  ) => Promise<PathCreateResult | PathReplaceResult<null>>;
  readonly reserveFile: (
    input: string,
    options?: Readonly<{ defaultRootId?: string; maxBytes?: number; requiredExtension?: string }>
  ) => Promise<ScopedOutputReservation>;
  readonly replaceFile: <T>(
    input: string,
    transform: (bytes: Buffer) => PathTransformResult<T> | Promise<PathTransformResult<T>>,
    options?: Readonly<{ defaultRootId?: string; maxBytes?: number }>
  ) => Promise<PathReplaceResult<T>>;
}

export interface ToolInvocationServices {
  readonly path: ScopedPathGateway;
  readonly execution: ScopedExecutionGateway;
  readonly resourceOwner: ResourceOwner;
  readonly deriveChild: (request: ChildCapabilityRequest) => CapabilityContext;
  readonly finishChild: (context: CapabilityContext) => void;
  readonly listCurrentToolDefinitions: () => ToolDefinition[];
  readonly getToolDefinitions: (context: CapabilityContext) => ToolDefinition[];
  readonly executeTool: (context: CapabilityContext, name: string, args: Record<string, unknown>) => Promise<string>;
}

/** 工具的实际执行函数 */
export type ToolExecutor = (
  args: Readonly<Record<string, unknown>>,
  env?: Readonly<Record<string, string>>,
  invocation?: ToolInvocationServices
) => Promise<string>;

/** 注册的工具 */
export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly executor: ToolExecutor;
  readonly policy: ToolPolicy;
  /** 工具名，用于 persona 中按名引用 */
  readonly name: string;
}

/** LLM 请求配置 */
export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** agent 运行中的一步 */
export interface AgentStep {
  type: "thinking" | "tool_call" | "tool_result" | "answer_chunk" | "answer_done" | "error"
    | "task_created" | "task_update";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** 任务相关事件时的任务快照 */
  tasks?: TaskSnapshot[];
  timestamp: number;
}

// ===========================================
// 任务系统
// ===========================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

/** 任务快照（给前端展示用） */
export interface TaskSnapshot {
  id: number;
  subject: string;
  status: TaskStatus;
  activeForm: string | null;
}

// ===========================================
// Persona 系统
// ===========================================

/**
 * Persona 定义 —— 从 markdown+frontmatter 文件加载
 * 文件格式：
 *   ---
 *   name: rds-assistant
 *   display_name: 产品研发室助理
 *   tools: [list_directory, read_file, ...]
 *   env:
 *     DATA_ROOT: "Z:\\产品研发室"
 *   ---
 *   # System Prompt 内容...
 */
export type PersonaNetworkPolicy =
  | { readonly mode: "deny" }
  | { readonly mode: "loopback" }
  | { readonly mode: "allowlist"; readonly origins: readonly string[] }
  | { readonly mode: "unrestricted" };

export interface PersonaDefinition {
  /** 内部名称 */
  readonly name: string;
  /** 显示名称 */
  readonly displayName: string;
  /** 描述 */
  readonly description: string;
  /** 该 persona 可用的工具名列表 */
  readonly tools: readonly string[];
  /** 该 persona 的环境变量（如 DATA_ROOT, OUTPUT_DIR 等） */
  readonly env: Readonly<Record<string, string>>;
  /** SEC-01 绑定但由 SEC-02 完整规范化的允许根目录 */
  readonly allowedRoots: readonly string[];
  /** SEC-01 网络能力包络；实际 socket 隔离由 SEC-03 完成 */
  readonly networkPolicy: PersonaNetworkPolicy;
  /** 安全相关有效快照的 SHA-256 */
  readonly digest: string;
  /** system prompt（markdown body 部分） */
  readonly systemPrompt: string;
}
