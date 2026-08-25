// ===========================================
// 通用文件系统工具 —— agent 读写文件的眼睛和手
// 通用版：可访问任意路径，由 persona 的 env 决定根目录
// ===========================================

import path from "path";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { throwIfCancelled } from "../run-cancellation.js";
import { editExec as luxEditExec, readExec as luxReadExec, writeExec as luxWriteExec } from "./filesystem-lux.js";

const MAX_DIRECTORY_ENTRIES = 10_000;

function requirePathGateway(invocation?: ToolInvocationServices): ScopedPathGateway {
  if (!invocation) throw new Error("Path gateway is required");
  return invocation.path;
}

function requireRootId(gateway: ScopedPathGateway, envKey: "DATA_ROOT" | "OUTPUT_DIR"): string {
  const rootId = gateway.rootIdForEnv(envKey);
  if (!rootId) throw new Error(`Path root is unavailable: ${envKey}`);
  return rootId;
}

function childInput(parent: string, name: string): string {
  return parent ? path.join(parent, name) : name;
}

// ===========================================
// 工具 1: list_directory
// ===========================================
export const listDirectoryDef: ToolDefinition = {
  type: "function",
  function: {
    name: "list_directory",
    description:
      "列出指定目录下的文件和子目录。如果不传 path，默认列出当前工作根目录。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径。可以是相对路径（相对于工作根目录）或绝对路径。",
        },
      },
    },
  },
};

export const listDirectoryExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "DATA_ROOT");
  const inputPath = typeof args.path === "string" ? args.path : "";
  const entries = await gateway.listDirectory(inputPath, { defaultRootId, maxEntries: MAX_DIRECTORY_ENTRIES });
  const items = entries.map((entry) => `${entry.type === "directory" ? "📁" : "📄"} ${entry.name}`);
  if (items.length === 0) return `目录为空: ${inputPath || "(根目录)"}`;
  return `目录: ${inputPath || "(根目录)"}\n共 ${items.length} 项:\n\n${items.join("\n")}`;
};

// ===========================================
// 工具 2: read_file
// ===========================================
export const readFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "读取文件内容。支持 txt/md/csv/docx/xlsx/pdf 格式，会自动解析文档返回文本，带行号输出。路径是相对于工作根目录的相对路径。默认返回前 200 行，可用 offset 和 limit 翻页。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于工作根目录的文件路径。例如 '产品研发室跟进项目统计表.xlsx' 或 '政企项目/2025江门市中心医院/方案.docx'。不要包含盘符。",
        },
        offset: {
          type: "number",
          description: "起始行号（从 1 开始），默认 1。用于翻页读取大文件。",
        },
        limit: {
          type: "number",
          description: "读取的行数，默认 200。大文件可分段读取。",
        },
      },
      required: ["path"],
    },
  },
};

export const readFileExec: ToolExecutor = async (args, env, invocation) => luxReadExec({
  file_path: args.path,
  ...(args.offset === undefined ? {} : { offset: args.offset }),
  ...(args.limit === undefined ? { limit: 200 } : { limit: args.limit }),
}, env, invocation);

// ===========================================
// 工具 3: search_files
// ===========================================
export const searchFilesDef: ToolDefinition = {
  type: "function",
  function: {
    name: "search_files",
    description:
      "按文件名或目录名关键词搜索文件，递归搜索所有子目录。返回匹配的文件路径列表。这是查找文件最有效的工具，一次搜索就能递归找到所有子目录中的匹配结果。",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "搜索关键词，不区分大小写。如 '医院' 或 '高考'。",
        },
        path: {
          type: "string",
          description: "限定搜索范围（相对路径），留空则搜索整个工作根目录。",
        },
      },
      required: ["keyword"],
    },
  },
};

export const searchFilesExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "DATA_ROOT");
  const keyword = String(args.keyword || "").toLowerCase();
  const searchPath = typeof args.path === "string" ? args.path : "";

  const results: string[] = [];
  const startTime = Date.now();
  const timeBudgetMs = 8_000;
  let timedOut = false;

  async function walk(directoryInput: string): Promise<void> {
    if (invocation) throwIfCancelled(invocation.signal);
    if (timedOut || Date.now() - startTime > timeBudgetMs) {
      timedOut = true;
      return;
    }
    const entries = await gateway.searchDirectory(directoryInput, { defaultRootId, maxEntries: MAX_DIRECTORY_ENTRIES });
    for (const entry of entries) {
      const logicalPath = childInput(directoryInput, entry.name);
      if (entry.name.toLowerCase().includes(keyword)) {
        results.push(`${entry.type === "directory" ? "📁" : "📄"} ${logicalPath}`);
      }
    }
    const subdirectories = entries.filter((entry) => entry.type === "directory" && !entry.name.startsWith("."));
    await Promise.all(subdirectories.map((entry) => walk(childInput(directoryInput, entry.name))));
  }

  await walk(searchPath);
  const elapsed = Date.now() - startTime;
  const output = results.length === 0
    ? `未找到包含 "${keyword}" 的文件或目录${timedOut ? `（搜索已超时，可能部分目录未覆盖，耗时 ${elapsed}ms）` : ""}`
    : `找到 ${results.length} 个匹配结果:${timedOut ? `（搜索已超时，可能部分目录未覆盖，耗时 ${elapsed}ms）` : ""}\n\n${results.slice(0, 50).join("\n")}${results.length > 50 ? `\n\n... 还有 ${results.length - 50} 个结果` : ""}`;
  return output;
};

// ===========================================
// 工具 4: write_file —— 通用写文件
// ===========================================
export const writeFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "将文本内容写入文件。支持 txt/md/csv/log/json 格式。文件会保存到输出目录。如文件已存在会被覆盖。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "输出文件名或路径，如 'report.md' 或 'reports/summary.csv'。",
        },
        content: {
          type: "string",
          description: "文件内容（纯文本）。",
        },
      },
      required: ["path", "content"],
    },
  },
};

export const writeFileExec: ToolExecutor = async (args, env, invocation) => luxWriteExec({
  file_path: args.path,
  content: args.content,
}, env, invocation);

// ===========================================
// 工具 5: edit_file —— 精确查找替换
// ===========================================
export const editFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "精确编辑文件：查找文件中的 old_string 并替换为 new_string。old_string 必须在文件中唯一出现（除非 replace_all=true）。适合修改文件的某一部分而不重写整个文件。只能编辑输出目录中的文件。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "输出目录中的文件路径，如 'config.json' 或 'reports/summary.md'。",
        },
        old_string: {
          type: "string",
          description: "要查找的文本。必须在文件中存在且（默认）唯一。包含足够上下文以确保唯一性。",
        },
        new_string: {
          type: "string",
          description: "替换后的文本。",
        },
        replace_all: {
          type: "boolean",
          description: "如果 true，替换所有匹配项。默认 false（只替换第一个，且要求唯一）。",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

export const editFileExec: ToolExecutor = async (args, env, invocation) => luxEditExec({
  file_path: args.path,
  old_string: args.old_string,
  new_string: args.new_string,
  ...(args.replace_all === undefined ? {} : { replace_all: args.replace_all }),
}, env, invocation);

// grep 已升级为 Lux 完整契约；从此处 re-export 仅供旧 import 路径兼容。
export { grepDef, grepExec } from "./filesystem-grep.js";
