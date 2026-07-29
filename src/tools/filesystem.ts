// ===========================================
// 通用文件系统工具 —— agent 读写文件的眼睛和手
// 通用版：可访问任意路径，由 persona 的 env 决定根目录
// ===========================================

import path from "path";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { parseFileBuffer } from "./parsers.js";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
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

export const readFileExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "DATA_ROOT");
  const inputPath = args.path as string;
  const authorized = await gateway.readFile(inputPath, { defaultRootId, maxBytes: MAX_DOCUMENT_BYTES });
  const result = await parseFileBuffer(inputPath, authorized.bytes);
  if (!result.success) return `读取失败: ${result.error}\n文件: ${inputPath}`;

  // 行号 + offset/limit
  const offset = (args.offset as number) || 1; // 从第几行开始（1-based）
  const limit = (args.limit as number) || 200;  // 读几行
  const allLines = result.text.split("\n");
  const totalLines = allLines.length;

  const startIdx = Math.max(0, offset - 1);
  const endIdx = Math.min(totalLines, startIdx + limit);
  const selectedLines = allLines.slice(startIdx, endIdx);

  // 加行号
  const numbered = selectedLines.map((line, i) => {
    const lineNum = startIdx + i + 1;
    return `${String(lineNum).padStart(4, " ")} | ${line}`;
  });

  let text = numbered.join("\n");

  // 如果有更多行，提示
  const hasMore = endIdx < totalLines;
  const footer = hasMore
    ? `\n\n--- 共 ${totalLines} 行，已显示第 ${offset}-${endIdx} 行。用 offset=${endIdx + 1} 继续读取 ---`
    : `\n\n--- 共 ${totalLines} 行，已全部显示 ---`;

  // 如果内容超长（单行很长的情况），做智能截断
  if (text.length > 6000) {
    const lines = text.split("\n");
    const headBudget = Math.floor(6000 * 0.6);
    const tailBudget = Math.floor(6000 * 0.3);

    let head = "";
    let headEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if ((head + lines[i] + "\n").length > headBudget) break;
      head += lines[i] + "\n";
      headEnd = i + 1;
    }

    let tail = "";
    for (let i = lines.length - 1; i > headEnd; i--) {
      const candidate = lines[i] + "\n" + tail;
      if (candidate.length > tailBudget) break;
      tail = candidate;
    }

    text = head + "\n... (省略中间内容) ...\n" + tail;
  }

  return `文件: ${inputPath}\n内容:\n\n${text}${footer}`;
};

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

export const writeFileExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "OUTPUT_DIR");
  const inputPath = args.path as string;
  const content = Buffer.from(args.content as string, "utf8");
  await gateway.writeFile(inputPath, content, { defaultRootId, maxBytes: MAX_TEXT_BYTES });
  return `✅ 文件已生成: ${inputPath}`;
};

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

type EditOutcome =
  | { readonly state: "missing"; readonly count: 0 }
  | { readonly state: "ambiguous"; readonly count: number }
  | { readonly state: "written"; readonly count: number };

export const editFileExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "OUTPUT_DIR");
  const inputPath = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = args.replace_all === true;
  if (oldString.length === 0) return "old_string 不能为空。";

  const edited = await gateway.replaceFile<EditOutcome>(inputPath, (bytes) => {
    const content = bytes.toString("utf8");
    if (!content.includes(oldString)) {
      return { bytes: null, value: { state: "missing" as const, count: 0 } };
    }
    const count = content.split(oldString).length - 1;
    if (!replaceAll && count > 1) {
      return { bytes: null, value: { state: "ambiguous" as const, count } };
    }
    const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    return { bytes: Buffer.from(newContent, "utf8"), value: { state: "written" as const, count: replaceAll ? count : 1 } };
  }, { defaultRootId, maxBytes: MAX_TEXT_BYTES });

  if (edited.value.state === "missing") return `未找到要替换的文本。请确认 old_string 在文件中存在。\n文件: ${inputPath}`;
  if (edited.value.state === "ambiguous") {
    return `old_string 在文件中出现了 ${edited.value.count} 次，不是唯一的。请提供更多上下文使其唯一，或设置 replace_all=true。`;
  }
  return `✅ 已修改: ${inputPath}（${replaceAll ? `替换 ${edited.value.count} 处` : "替换 1 处"}）`;
};

// ===========================================
// 工具 6: grep —— 文件内容搜索
// ===========================================

/** 可搜索的文本文件扩展名 */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".log", ".json", ".js", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".c", ".cpp", ".h", ".html", ".css", ".xml", ".yaml", ".yml",
  ".sh", ".bat", ".ps1", ".sql", ".ini", ".conf", ".toml", ".env",
]);

export const grepDef: ToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description:
      "在文件内容中搜索匹配的行（正则表达式），递归搜索目录下所有文本文件。返回文件名、行号和匹配的行内容。当需要在文件内容中查找信息时，优先使用此工具而不是 execute_command 跑 findstr。",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "正则表达式模式，如 '医院|中心医院' 或 '金额.*万'。",
        },
        path: {
          type: "string",
          description: "搜索范围（相对路径），留空则搜索整个工作根目录。",
        },
        file_pattern: {
          type: "string",
          description: "文件名过滤，如 '*.docx' 或 '*.txt'。留空则搜索所有文本文件。",
        },
      },
      required: ["pattern"],
    },
  },
};

export const grepExec: ToolExecutor = async (args, _env, invocation) => {
  const gateway = requirePathGateway(invocation);
  const defaultRootId = requireRootId(gateway, "DATA_ROOT");
  const pattern = args.pattern as string;
  const searchPath = typeof args.path === "string" ? args.path : "";
  const filePattern = typeof args.file_pattern === "string" ? args.file_pattern : "";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return "无效的正则表达式: " + pattern;
  }

  let fileFilter: ((name: string) => boolean) | null = null;
  if (filePattern) {
    const globRegex = filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
    const fileRegex = new RegExp("^" + globRegex + "$", "i");
    fileFilter = (name) => fileRegex.test(name);
  }

  const results: { file: string; line: number; content: string }[] = [];
  const startTime = Date.now();
  const timeBudgetMs = 8_000;
  let timedOut = false;

  async function grepAuthorizedFile(fileInput: string): Promise<void> {
    const authorized = await gateway.searchFile(fileInput, { defaultRootId, maxBytes: MAX_TEXT_BYTES });
    const lines = authorized.bytes.toString("utf8").split("\n");
    for (let index = 0; index < lines.length && results.length < 200; index += 1) {
      if (regex.test(lines[index])) results.push({ file: fileInput, line: index + 1, content: lines[index] });
    }
  }

  async function walk(directoryInput: string): Promise<void> {
    if (timedOut || Date.now() - startTime > timeBudgetMs) {
      timedOut = true;
      return;
    }
    const entries = await gateway.searchDirectory(directoryInput, { defaultRootId, maxEntries: MAX_DIRECTORY_ENTRIES });
    const tasks: Promise<void>[] = [];
    for (const entry of entries) {
      const logicalPath = childInput(directoryInput, entry.name);
      if (entry.type === "directory") {
        if (!entry.name.startsWith(".")) tasks.push(walk(logicalPath));
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (fileFilter ? fileFilter(entry.name) : TEXT_EXTENSIONS.has(extension)) tasks.push(grepAuthorizedFile(logicalPath));
    }
    await Promise.all(tasks);
  }

  await walk(searchPath);
  const elapsed = Date.now() - startTime;
  if (results.length === 0) {
    return `未找到匹配 "${pattern}" 的内容` + (timedOut ? `（搜索已超时，耗时 ${elapsed}ms）` : "");
  }
  const lines = results.slice(0, 50).map((result) => `📄 ${result.file}:${result.line}: ${result.content.trim().slice(0, 120)}`);
  return `找到 ${results.length} 处匹配:${timedOut ? `（搜索已超时，耗时 ${elapsed}ms）` : ""}\n\n${lines.join("\n")}${results.length > 50 ? `\n\n... 还有 ${results.length - 50} 个结果` : ""}`;
};
