import path from "node:path";
import { PathDeniedError } from "../path-policy.js";
import { throwIfCancelled } from "../run-cancellation.js";
import { ToolArgumentsError, truncateCodePoints } from "../tool-pipeline.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { compileGlob, decodeUtf8Text } from "./filesystem-lux.js";

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_FILES = 5_000;
const MAX_OUTPUT_ENTRIES = 10_000;
const SEARCH_TIME_BUDGET_MS = 8_000;
const TYPE_EXTENSIONS = Object.freeze<Record<string, readonly string[]>>({
  c: [".c", ".h"], cpp: [".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"],
  css: [".css"], go: [".go"], html: [".htm", ".html"], java: [".java"],
  js: [".cjs", ".js", ".jsx", ".mjs"], json: [".json", ".jsonl"],
  md: [".md", ".markdown"], py: [".py"], rust: [".rs"], sh: [".bash", ".sh"],
  sql: [".sql"], ts: [".ts", ".tsx"], xml: [".xml"], yaml: [".yaml", ".yml"],
});

type OutputMode = "content" | "files_with_matches" | "count";
type FileMatch = Readonly<{ file: string; count: number; lines: readonly number[]; textLines: readonly string[] }>;

function requireInvocation(invocation?: ToolInvocationServices): ToolInvocationServices {
  if (!invocation) throw new Error("Tool invocation services are required");
  return invocation;
}

function nonNegativeInteger(value: unknown, fallback: number, name: string, maximum = MAX_OUTPUT_ENTRIES): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ToolArgumentsError(`${name} 必须是 0-${maximum} 的整数`);
  }
  return value as number;
}

function grepBasicToJavaScript(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      const next = pattern[index + 1];
      if ("|()+?{}".includes(next)) { output += next; index += 1; }
      else { output += `\\${next}`; index += 1; }
    } else if ("|()+?{}".includes(character)) output += `\\${character}`;
    else output += character;
  }
  return output;
}

function assertSafeRegex(source: string): void {
  if (/\\[1-9]/u.test(source) || source.includes("(?=") || source.includes("?!") || source.includes("?<")) {
    throw new ToolArgumentsError("grep pattern 包含不受支持的回溯结构");
  }
  const groups: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [];
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[") { inClass = true; continue; }
    if (character === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (character === "(") {
      if (source[index + 1] === "?" && source[index + 2] !== ":") throw new ToolArgumentsError("grep pattern 包含不受支持的分组结构");
      groups.push({ hasQuantifier: false, hasAlternation: false });
      if (source[index + 1] === "?" && source[index + 2] === ":") index += 2;
      continue;
    }
    if (character === "|") { if (groups.length > 0) groups.at(-1)!.hasAlternation = true; continue; }
    if (character === ")") {
      const group = groups.pop();
      if (!group) continue;
      const next = source[index + 1];
      const quantified = next === "*" || next === "+" || next === "?" || next === "{";
      if (quantified && (group.hasQuantifier || group.hasAlternation)) throw new ToolArgumentsError("grep pattern 包含可能灾难性回溯的嵌套量词");
      if (quantified && groups.length > 0) groups.at(-1)!.hasQuantifier = true;
      continue;
    }
    if (character === "*" || character === "+" || character === "?" || character === "{") {
      if (groups.length > 0) groups.at(-1)!.hasQuantifier = true;
    }
  }
}

function compilePattern(pattern: string, dialect: string, insensitive: boolean, multiline: boolean): RegExp {
  if (pattern.length < 1 || pattern.length > 32_768) throw new ToolArgumentsError("grep pattern 为空或过长");
  const source = dialect === "grep-basic" ? grepBasicToJavaScript(pattern) : pattern;
  assertSafeRegex(source);
  try { return new RegExp(source, `gmu${insensitive ? "i" : ""}${multiline ? "s" : ""}`); }
  catch (error) { throw new ToolArgumentsError(`无效的正则表达式: ${error instanceof Error ? error.message : String(error)}`); }
}

function lineAtOffset(text: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function scanText(file: string, text: string, regex: RegExp, multiline: boolean): FileMatch | null {
  const textLines = text.split(/\r?\n/u);
  const lines = new Set<number>();
  let count = 0;
  if (multiline) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      count += 1;
      const start = lineAtOffset(text, match.index ?? 0);
      const end = lineAtOffset(text, (match.index ?? 0) + Math.max(0, match[0].length - 1));
      for (let line = start; line <= end; line += 1) lines.add(line);
      if (count >= MAX_OUTPUT_ENTRIES) break;
    }
  } else {
    for (let index = 0; index < textLines.length; index += 1) {
      regex.lastIndex = 0;
      let matched = false;
      for (const _match of textLines[index].matchAll(regex)) {
        count += 1;
        matched = true;
        if (count >= MAX_OUTPUT_ENTRIES) break;
      }
      if (matched) lines.add(index);
      if (count >= MAX_OUTPUT_ENTRIES) break;
    }
  }
  return count === 0 ? null : Object.freeze({ file, count, lines: Object.freeze([...lines]), textLines: Object.freeze(textLines) });
}

async function candidateFiles(input: Readonly<{
  invocation: ToolInvocationServices;
  searchPath: string;
  defaultRootId: string;
  globMatcher: RegExp | null;
  extensions: ReadonlySet<string> | null;
  deadline: number;
}>): Promise<Readonly<{ files: string[]; explicitFile: boolean; timedOut: boolean }>> {
  const files: string[] = [];
  let timedOut = false;
  const accept = (file: string): boolean => {
    const portable = file.replaceAll(path.sep, "/");
    if (input.globMatcher && !input.globMatcher.test(portable)) return false;
    return !input.extensions || input.extensions.has(path.extname(file).toLowerCase());
  };
  const walk = async (directory: string): Promise<void> => {
    throwIfCancelled(input.invocation.signal);
    if (files.length >= MAX_FILES || Date.now() > input.deadline) { timedOut = Date.now() > input.deadline; return; }
    const entries = await input.invocation.path.searchDirectory(directory, { defaultRootId: input.defaultRootId, maxEntries: MAX_DIRECTORY_ENTRIES });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const child = directory ? path.join(directory, entry.name) : entry.name;
      if (entry.type === "file") { if (accept(child)) files.push(child); }
      else await walk(child);
    }
  };
  try {
    await walk(input.searchPath);
    return Object.freeze({ files: files.sort((left, right) => left.localeCompare(right)), explicitFile: false, timedOut });
  } catch (error) {
    if (!(error instanceof PathDeniedError) || error.code !== "PATH_TYPE_MISMATCH" || !input.searchPath) throw error;
    if (!accept(input.searchPath)) return Object.freeze({ files: [], explicitFile: true, timedOut: false });
    return Object.freeze({ files: [input.searchPath], explicitFile: true, timedOut: false });
  }
}

function renderContent(matches: readonly FileMatch[], before: number, after: number, lineNumbers: boolean): string[] {
  const output: string[] = [];
  for (const match of matches) {
    const selected = new Set<number>();
    const matched = new Set(match.lines);
    for (const line of match.lines) {
      for (let index = Math.max(0, line - before); index <= Math.min(match.textLines.length - 1, line + after); index += 1) selected.add(index);
    }
    let previous = -2;
    for (const index of [...selected].sort((left, right) => left - right)) {
      if (previous >= 0 && index > previous + 1) output.push("--");
      const marker = matched.has(index) ? ":" : "-";
      const number = lineNumbers ? `${index + 1}${marker}` : "";
      output.push(`${match.file}${marker}${number}${truncateCodePoints(match.textLines[index], 500)}`);
      previous = index;
    }
  }
  return output;
}

export const grepDef: ToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description: "递归搜索 UTF-8 文件内容；支持内容/文件名/计数输出、上下文、文件 glob/type、大小写和 multiline。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式。" },
        path: { type: "string", description: "文件或目录；默认 DATA_ROOT。" },
        glob: { type: "string", description: "文件 glob，如 *.{ts,tsx}。" },
        type: { type: "string", description: "文件类型，如 js、py、ts、rust、go、java。" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "默认 files_with_matches。" },
        regex_dialect: { type: "string", enum: ["auto", "ripgrep", "grep-basic"], description: "默认 auto。" },
        "-i": { type: "boolean", description: "忽略大小写。" },
        "-n": { type: "boolean", description: "content 模式显示行号，默认 true。" },
        "-A": { type: "integer", minimum: 0, maximum: 1000, description: "匹配后上下文行数。" },
        "-B": { type: "integer", minimum: 0, maximum: 1000, description: "匹配前上下文行数。" },
        "-C": { type: "integer", minimum: 0, maximum: 1000, description: "前后上下文行数。" },
        context: { type: "integer", minimum: 0, maximum: 1000, description: "-C 的别名。" },
        head_limit: { type: "integer", minimum: 0, maximum: MAX_OUTPUT_ENTRIES, description: "最多输出项；0 为内部安全上限。" },
        offset: { type: "integer", minimum: 0, maximum: MAX_OUTPUT_ENTRIES, description: "跳过输出项数。" },
        multiline: { type: "boolean", description: "允许 . 匹配换行。" },
      },
      required: ["pattern"],
    },
  },
};

export const grepExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  const defaultRootId = invocation.path.rootIdForEnv("DATA_ROOT");
  if (!defaultRootId) throw new Error("Path root is unavailable: DATA_ROOT");
  const pattern = args.pattern as string;
  const dialect = typeof args.regex_dialect === "string" ? args.regex_dialect : "auto";
  const multiline = args.multiline === true;
  const insensitive = args["-i"] === true;
  const mode = (args.output_mode ?? "files_with_matches") as OutputMode;
  const context = nonNegativeInteger(args.context ?? args["-C"], 0, "context", 1000);
  const before = nonNegativeInteger(args["-B"], context, "-B", 1000);
  const after = nonNegativeInteger(args["-A"], context, "-A", 1000);
  const offset = nonNegativeInteger(args.offset, 0, "offset");
  const headLimit = nonNegativeInteger(args.head_limit, 0, "head_limit");
  const primaryDialect = dialect === "grep-basic" ? "grep-basic" : "ripgrep";
  compilePattern(pattern, primaryDialect, insensitive, multiline);
  const legacyFilePattern = (args as Record<string, unknown>).file_pattern;
  const globMatcher = args.glob === undefined && legacyFilePattern === undefined ? null : compileGlob(args.glob ?? legacyFilePattern);
  let extensions: ReadonlySet<string> | null = null;
  if (args.type !== undefined) {
    const values = TYPE_EXTENSIONS[String(args.type).toLowerCase()];
    if (!values) throw new ToolArgumentsError(`未知文件类型: ${String(args.type)}`);
    extensions = new Set(values);
  }
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  const candidates = await candidateFiles({
    invocation,
    searchPath: typeof args.path === "string" ? args.path : "",
    defaultRootId,
    globMatcher,
    extensions,
    deadline,
  });

  const run = async (effectiveDialect: string): Promise<Readonly<{ matches: FileMatch[]; skippedBinary: number; timedOut: boolean }>> => {
    const regex = compilePattern(pattern, effectiveDialect, insensitive, multiline);
    const matches: FileMatch[] = [];
    let skippedBinary = 0;
    let timedOut = false;
    for (const file of candidates.files) {
      throwIfCancelled(invocation.signal);
      if (Date.now() > deadline) { timedOut = true; break; }
      const authorized = await invocation.path.searchFile(file, { defaultRootId, maxBytes: MAX_TEXT_BYTES });
      let text: string;
      try { text = decodeUtf8Text(authorized.bytes); }
      catch (error) {
        if (candidates.explicitFile) throw error;
        skippedBinary += 1;
        continue;
      }
      const result = scanText(file, text, regex, multiline);
      if (result) matches.push(result);
    }
    return Object.freeze({ matches, skippedBinary, timedOut });
  };

  let result = await run(primaryDialect);
  if (dialect === "auto" && result.matches.length === 0 && !result.timedOut) {
    const basicSource = grepBasicToJavaScript(pattern);
    if (basicSource !== pattern) result = await run("grep-basic");
  }
  let entries = mode === "files_with_matches"
    ? result.matches.map(match => match.file)
    : mode === "count"
      ? result.matches.map(match => `${match.file}:${match.count}`)
      : renderContent(result.matches, before, after, args["-n"] !== false);
  entries = entries.slice(offset, headLimit === 0 ? offset + MAX_OUTPUT_ENTRIES : offset + headLimit);
  const footer = `${candidates.timedOut || result.timedOut ? "\n... search timed out" : ""}${result.skippedBinary ? `\n... skipped ${result.skippedBinary} binary files` : ""}`;
  if (entries.length === 0) return `No matches found for pattern: ${pattern}${footer}`;
  return `${entries.join("\n")}${footer}`;
};
