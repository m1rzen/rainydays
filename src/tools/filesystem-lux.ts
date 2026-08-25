import path from "node:path";
import { throwIfCancelled } from "../run-cancellation.js";
import { ToolArgumentsError } from "../tool-pipeline.js";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { parseDocumentIsolated } from "../document-parser.js";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_GLOB_RESULTS = 500;
const SEARCH_TIME_BUDGET_MS = 8_000;
const IMAGE_MIME_BY_EXTENSION = Object.freeze<Record<string, string>>({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
});

function requireInvocation(invocation?: ToolInvocationServices): ToolInvocationServices {
  if (!invocation) throw new Error("Tool invocation services are required");
  return invocation;
}

function requireRootId(gateway: ScopedPathGateway, envKey: "DATA_ROOT" | "OUTPUT_DIR"): string {
  const rootId = gateway.rootIdForEnv(envKey);
  if (!rootId) throw new Error(`Path root is unavailable: ${envKey}`);
  return rootId;
}

function positiveInteger(value: unknown, fallback: number | null, name: string): number | null {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ToolArgumentsError(`${name} 必须是正整数`);
  return value as number;
}

export function decodeUtf8Text(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new ToolArgumentsError("二进制文件不能按文本处理");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ToolArgumentsError("文件不是有效 UTF-8 文本，不能安全编辑或搜索"); }
}

function imageMime(filePath: string, bytes: Buffer): string | null {
  const mime = IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!mime) return null;
  const valid = mime === "image/png"
    ? bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
    : mime === "image/jpeg"
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : mime === "image/gif"
        ? bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
        : bytes.length >= 16 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new ToolArgumentsError(`图片签名与扩展名不匹配: ${filePath}`);
  return mime;
}

export function parsePdfPageRange(value: unknown): readonly number[] | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new ToolArgumentsError("pages 必须是 PDF 页码或页码范围");
  const pages = new Set<number>();
  for (const token of value.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(token);
    if (!match) throw new ToolArgumentsError(`PDF pages 无效: ${value}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > 100_000) {
      throw new ToolArgumentsError(`PDF pages 无效: ${value}`);
    }
    if (last - first + 1 + pages.size > 100) throw new ToolArgumentsError("单次最多读取 100 个 PDF 页面");
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) pages.add(pageNumber);
  }
  return Object.freeze([...pages].sort((left, right) => left - right));
}

function numberedLines(text: string, offsetValue: unknown, limitValue: unknown): string {
  const offset = positiveInteger(offsetValue, 1, "offset")!;
  const limit = positiveInteger(limitValue, null, "limit");
  const lines = text.split(/\r?\n/u);
  const start = Math.min(lines.length, offset - 1);
  const end = limit === null ? lines.length : Math.min(lines.length, start + limit);
  const selected = lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(6, " ")} | ${line}`);
  const range = selected.length === 0 ? "无可显示行" : `第 ${start + 1}-${end} 行`;
  const more = end < lines.length ? `；下一页 offset=${end + 1}` : "；已到末尾";
  return `${selected.join("\n")}\n\n--- 共 ${lines.length} 行，${range}${more} ---`;
}

export const readDef: ToolDefinition = {
  type: "function",
  function: {
    name: "read",
    description: "读取文本、文档、图片或 PDF。文本按 1-based offset/limit 分页并返回行号；PDF 可用 pages 选择页面。",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "绝对路径，或相对于 DATA_ROOT 的路径。" },
        offset: { type: "integer", minimum: 1, description: "起始行（1-based），默认 1。" },
        limit: { type: "integer", minimum: 1, description: "最多返回的行数；省略则读取全部。" },
        pages: { type: "string", description: "PDF 页码范围，如 1-5、3、1-3,8。" },
      },
      required: ["file_path"],
    },
  },
};

export const readExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  const defaultRootId = requireRootId(invocation.path, "DATA_ROOT");
  const filePath = args.file_path as string;
  const extension = path.extname(filePath).toLowerCase();
  if (args.pages !== undefined && extension !== ".pdf") throw new ToolArgumentsError("pages 仅适用于 PDF 文件");
  const pdfPages = parsePdfPageRange(args.pages);
  const authorized = await invocation.path.readFile(filePath, { defaultRootId, maxBytes: MAX_DOCUMENT_BYTES });
  const mime = imageMime(filePath, authorized.bytes);
  if (mime) {
    if (args.offset !== undefined || args.limit !== undefined || args.pages !== undefined) throw new ToolArgumentsError("图片读取不支持 offset、limit 或 pages");
    return `[Image: ${filePath}]\nMIME: ${mime}\nBytes: ${authorized.bytes.length}\nUse image_helper with the same authorized path for visual analysis.`;
  }
  const parsed = await parseDocumentIsolated(filePath, authorized.bytes, invocation.resourceOwner, invocation.signal, { pdfPages });
  let text: string;
  if (parsed.success) text = parsed.text;
  else if (parsed.error?.startsWith("不支持的文件格式:")) {
    try { text = decodeUtf8Text(authorized.bytes); }
    catch { throw new ToolArgumentsError(`读取失败: ${parsed.error}`); }
  } else throw new ToolArgumentsError(`读取失败: ${parsed.error ?? "不支持的二进制格式"}`);
  const pageSummary = extension === ".pdf" && parsed.pageCount
    ? `\nPDF: ${parsed.pageCount} 页；已读取 ${parsed.renderedPages?.join(", ") || "全部页面"}` : "";
  return `文件: ${filePath}${pageSummary}\n\n${numberedLines(text, args.offset, args.limit)}`;
};

export const writeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "write",
    description: "创建或完整覆盖文本文件；父目录由受管 Path gateway 创建。修改局部内容应使用 edit。",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "绝对路径，或相对于 OUTPUT_DIR 的路径。" },
        content: { type: "string", description: "完整 UTF-8 文本内容。" },
      },
      required: ["file_path", "content"],
    },
  },
};

export const writeExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  const defaultRootId = requireRootId(invocation.path, "OUTPUT_DIR");
  const bytes = Buffer.from(args.content as string, "utf8");
  if (bytes.length > MAX_TEXT_BYTES) throw new ToolArgumentsError("写入内容超过 8 MiB 上限");
  throwIfCancelled(invocation.signal);
  await invocation.path.writeFile(args.file_path as string, bytes, { defaultRootId, maxBytes: MAX_TEXT_BYTES });
  return `✅ 文件已生成: ${args.file_path as string}`;
};

export const editDef: ToolDefinition = {
  type: "function",
  function: {
    name: "edit",
    description: "精确替换 UTF-8 文本。默认要求 old_string 恰好出现一次；replace_all=true 时替换全部。",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "绝对路径，或相对于 OUTPUT_DIR 的路径。" },
        old_string: { type: "string", minLength: 1, description: "要查找的精确文本。" },
        new_string: { type: "string", description: "替换文本。" },
        replace_all: { type: "boolean", description: "替换所有匹配；默认 false。" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
};

export const replaceDef: ToolDefinition = {
  ...editDef,
  function: { ...editDef.function, name: "replace", description: "edit 的同契约兼容动作：精确替换 UTF-8 文本。" },
};

type EditOutcome = { readonly state: "missing"; readonly count: 0 }
  | { readonly state: "ambiguous"; readonly count: number }
  | { readonly state: "written"; readonly count: number };

function occurrenceCount(content: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = content.indexOf(needle, cursor)) >= 0) { count += 1; cursor += needle.length; }
  return count;
}

export const editExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  const defaultRootId = requireRootId(invocation.path, "OUTPUT_DIR");
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = args.replace_all === true;
  if (oldString.length === 0) throw new ToolArgumentsError("old_string 不能为空");
  const edited = await invocation.path.replaceFile<EditOutcome>(filePath, bytes => {
    throwIfCancelled(invocation.signal);
    const content = decodeUtf8Text(bytes);
    const count = occurrenceCount(content, oldString);
    if (count === 0) return { bytes: null, value: { state: "missing" as const, count: 0 } };
    if (!replaceAll && count !== 1) return { bytes: null, value: { state: "ambiguous" as const, count } };
    const output = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    const outputBytes = Buffer.from(output, "utf8");
    if (outputBytes.length > MAX_TEXT_BYTES) throw new ToolArgumentsError("替换结果超过 8 MiB 上限");
    return { bytes: outputBytes, value: { state: "written" as const, count: replaceAll ? count : 1 } };
  }, { defaultRootId, maxBytes: MAX_TEXT_BYTES });
  if (edited.value.state === "missing") return `未找到要替换的文本。\n文件: ${filePath}`;
  if (edited.value.state === "ambiguous") return `old_string 在文件中出现了 ${edited.value.count} 次；请提供唯一上下文或设置 replace_all=true。`;
  return `✅ 已修改: ${filePath}（替换 ${edited.value.count} 处）`;
};

export const replaceExec = editExec;

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/gu, character => `\\${character}`);
}

export function compileGlob(patternValue: unknown): RegExp {
  if (typeof patternValue !== "string" || patternValue.length < 1 || patternValue.length > 1024 || patternValue.includes("\0")) throw new ToolArgumentsError("glob pattern 无效");
  const pattern = patternValue.replaceAll("\\", "/");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { source += "(?:.*/)?"; index += 1; } else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end < 0) throw new ToolArgumentsError("glob brace 未闭合");
      const choices = pattern.slice(index + 1, end).split(",");
      if (choices.length < 2 || choices.some(choice => !choice || /[{}]/u.test(choice))) throw new ToolArgumentsError("glob brace 选项无效");
      source += `(?:${choices.map(escapeRegex).join("|")})`;
      index = end;
    } else source += escapeRegex(character);
  }
  return new RegExp(pattern.includes("/") ? `^${source}$` : `(?:^|/)${source}$`, "iu");
}

export const globDef: ToolDefinition = {
  type: "function",
  function: {
    name: "glob",
    description: "按文件名 glob 查找文件。支持 *、**、? 和 {a,b}；basename-only pattern 会递归匹配。最多返回 500 项。",
    parameters: { type: "object", properties: {
      pattern: { type: "string", description: "例如 *.ts、**/*.ts、src/*.{js,ts}。" },
      path: { type: "string", description: "搜索根目录；默认 DATA_ROOT。" },
    }, required: ["pattern"] },
  },
};

export const globExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  const defaultRootId = requireRootId(invocation.path, "DATA_ROOT");
  const matcher = compileGlob(args.pattern);
  const basePath = typeof args.path === "string" ? args.path : "";
  const matches: string[] = [];
  const started = Date.now();
  let timedOut = false;
  const walk = async (directory: string, relative: string): Promise<void> => {
    throwIfCancelled(invocation.signal);
    if (matches.length >= MAX_GLOB_RESULTS || Date.now() - started > SEARCH_TIME_BUDGET_MS) { timedOut = Date.now() - started > SEARCH_TIME_BUDGET_MS; return; }
    const entries = await invocation.path.searchDirectory(directory, { defaultRootId, maxEntries: MAX_DIRECTORY_ENTRIES });
    for (const entry of entries) {
      if (matches.length >= MAX_GLOB_RESULTS) break;
      const child = directory ? path.join(directory, entry.name) : entry.name;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === "file") { if (matcher.test(childRelative)) matches.push(child); }
      else await walk(child, childRelative);
    }
  };
  await walk(basePath, "");
  matches.sort((left, right) => left.localeCompare(right));
  if (matches.length === 0) return `No files found for pattern: ${args.pattern as string}`;
  return `${matches.join("\n")}${matches.length === MAX_GLOB_RESULTS ? "\n... result limit reached (500)" : ""}${timedOut ? "\n... search timed out" : ""}`;
};
