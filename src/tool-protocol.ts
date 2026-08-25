import type { ToolPolicy } from "./capability-broker.js";
import { ToolArgumentsError, parseToolArguments } from "./tool-pipeline.js";
import type { ToolBodyHeader, ToolBodyMode, ToolDefinition, ToolProtocolDescriptor } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const BODY_INVOCATION_LIMIT_BYTES = 512 * 1024;
const MAX_BODY_CALLS = 16;

function header(name: string, parameter: string, required = false): ToolBodyHeader {
  return Object.freeze({ name, parameter, required });
}

function rawBody(blockName: string, bodyParameter: string, headers: readonly ToolBodyHeader[]): ToolBodyMode {
  return Object.freeze({ kind: "raw" as const, blockName, bodyParameter, headers: Object.freeze([...headers]) });
}

function sectionedBody(
  blockName: string,
  sections: readonly Readonly<{ blockName: string; parameter: string }>[],
  headers: readonly ToolBodyHeader[],
): ToolBodyMode {
  return Object.freeze({
    kind: "sections" as const,
    blockName,
    sections: Object.freeze(sections.map(section => Object.freeze({ ...section }))),
    headers: Object.freeze([...headers]),
  });
}

const BODY_MODES: Readonly<Record<string, ToolBodyMode>> = Object.freeze({
  write: rawBody("WRITE", "content", [header("file_path", "file_path", true)]),
  edit: sectionedBody("EDIT", [
    { blockName: "OLD_STRING", parameter: "old_string" },
    { blockName: "NEW_STRING", parameter: "new_string" },
  ], [header("file_path", "file_path", true), header("replace_all", "replace_all")]),
  replace: sectionedBody("REPLACE", [
    { blockName: "OLD_STRING", parameter: "old_string" },
    { blockName: "NEW_STRING", parameter: "new_string" },
  ], [header("file_path", "file_path", true), header("replace_all", "replace_all")]),
  write_file: rawBody("WRITE", "content", [header("path", "path", true)]),
  edit_file: sectionedBody("EDIT", [
    { blockName: "OLD_STRING", parameter: "old_string" },
    { blockName: "NEW_STRING", parameter: "new_string" },
  ], [header("path", "path", true), header("replace_all", "replace_all")]),
  execute_command: rawBody("BASH", "command", [header("cwd", "cwd")]),
  script: rawBody("SCRIPT", "code", []),
});

const HOST_BOUND_TOOLS = new Set([
  "read", "write", "edit", "replace", "glob", "grep",
  "list_directory", "read_file", "search_files", "write_file", "edit_file",
  "execute_command", "script", "read_repo",
]);

const TOOL_TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  glob: 10_000,
  grep: 10_000,
  execute_command: 60_000,
  script: 60_000,
});

export function getToolTimeoutMs(name: string): number {
  return TOOL_TIMEOUTS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

export function createToolProtocolDescriptor(definition: ToolDefinition, policy: ToolPolicy): ToolProtocolDescriptor {
  const name = definition.function.name;
  const body = BODY_MODES[name] ?? null;
  return Object.freeze({
    schemaVersion: 1 as const,
    name,
    schema: definition,
    invocation: Object.freeze({ json: true as const, body }),
    permissions: policy,
    sideEffects: policy.effects,
    hostBound: HOST_BOUND_TOOLS.has(name),
    concurrency: policy.concurrency === "parallel-read" ? "parallel-read" as const : "serial" as const,
    timeoutMs: getToolTimeoutMs(name),
  });
}

function invalid(message: string): never {
  throw new ToolArgumentsError(message);
}

function parseHeaderValue(token: string, schema: unknown, name: string): unknown {
  let value: string;
  if (token.startsWith("\"")) {
    try { value = JSON.parse(token) as string; }
    catch { return invalid(`Body header :${name} 的双引号字符串无效`); }
    if (typeof value !== "string") return invalid(`Body header :${name} 必须是字符串`);
  } else if (token.startsWith("'")) {
    if (!token.endsWith("'") || token.length < 2) return invalid(`Body header :${name} 的单引号字符串无效`);
    value = token.slice(1, -1);
  } else {
    value = token;
  }

  const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : undefined;
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return invalid(`Body header :${name} 必须是 true 或 false`);
  }
  if (type === "number" || type === "integer") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return invalid(`Body header :${name} 必须是数字`);
    const number = Number(value);
    if (!Number.isFinite(number) || (type === "integer" && !Number.isSafeInteger(number))) return invalid(`Body header :${name} 数字无效`);
    return number;
  }
  if (type !== "string") return invalid(`Body header :${name} 不支持该参数类型`);
  return value;
}

function nextHeaderToken(text: string, start: number): Readonly<{ token: string; end: number }> {
  const first = text[start];
  if (first === "\"") {
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (!escaped && character === "\"") return Object.freeze({ token: text.slice(start, index + 1), end: index + 1 });
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    return invalid("Body header 的双引号字符串未闭合");
  }
  if (first === "'") {
    const end = text.indexOf("'", start + 1);
    if (end < 0) return invalid("Body header 的单引号字符串未闭合");
    return Object.freeze({ token: text.slice(start, end + 1), end: end + 1 });
  }
  let end = start;
  while (end < text.length && !/\s/u.test(text[end])) end += 1;
  if (end === start) return invalid("Body header 缺少值");
  return Object.freeze({ token: text.slice(start, end), end });
}

function parseHeaders(text: string, mode: ToolBodyMode, definition: ToolDefinition): Record<string, unknown> {
  const allowed = new Map(mode.headers.map(item => [item.name, item]));
  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    if (index === text.length) break;
    const keyMatch = /^:([A-Za-z][A-Za-z0-9_-]*)/u.exec(text.slice(index));
    if (!keyMatch) return invalid("Body header 必须使用 :name value 语法");
    const name = keyMatch[1];
    const binding = allowed.get(name);
    if (!binding || name === "__proto__" || name === "prototype" || name === "constructor") return invalid(`未知 Body header: :${name}`);
    if (Object.hasOwn(args, binding.parameter)) return invalid(`重复 Body header: :${name}`);
    index += keyMatch[0].length;
    if (index >= text.length || !/\s/u.test(text[index])) return invalid(`Body header :${name} 缺少值`);
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    const parsed = nextHeaderToken(text, index);
    index = parsed.end;
    const schema = definition.function.parameters.properties[binding.parameter];
    Object.defineProperty(args, binding.parameter, {
      value: parseHeaderValue(parsed.token, schema, name), enumerable: true, writable: true, configurable: true,
    });
  }
  for (const required of mode.headers.filter(item => item.required)) {
    if (!Object.hasOwn(args, required.parameter)) return invalid(`缺少 Body header: :${required.name}`);
  }
  return args;
}

interface ParsedBlock {
  readonly headerText: string;
  readonly body: string;
  readonly end: number;
}

function parseBlockAt(raw: string, start: number, blockName: string): ParsedBlock {
  const prefix = `#+BEGIN_${blockName}`;
  if (!raw.startsWith(prefix, start)) return invalid(`Body block 必须以 ${prefix} 开始`);
  const lineEnd = raw.indexOf("\n", start);
  if (lineEnd < 0) return invalid(`${prefix} 后必须换行`);
  const beginLine = raw.slice(start, lineEnd).replace(/\r$/u, "");
  if (beginLine !== prefix && !beginLine.startsWith(`${prefix} `) && !beginLine.startsWith(`${prefix}\t`)) {
    return invalid(`${prefix} 起始行无效`);
  }
  const headerText = beginLine.slice(prefix.length);
  const bodyStart = lineEnd + 1;
  const endPattern = new RegExp(`^#\\+END_${blockName}[ \\t]*\\r?$`, "gmu");
  endPattern.lastIndex = bodyStart;
  const endMatch = endPattern.exec(raw);
  if (!endMatch) return invalid(`缺少 #+END_${blockName}`);
  const nestedBeginPattern = new RegExp(`^#\\+BEGIN_${blockName}(?:[ \\t].*)?\\r?$`, "gmu");
  nestedBeginPattern.lastIndex = bodyStart;
  const nestedBegin = nestedBeginPattern.exec(raw);
  if (nestedBegin && nestedBegin.index < endMatch.index) return invalid(`重复或未闭合 #+BEGIN_${blockName}`);
  let bodyEnd = endMatch.index;
  if (raw.slice(bodyEnd - 2, bodyEnd) === "\r\n") bodyEnd -= 2;
  else if (raw[bodyEnd - 1] === "\n") bodyEnd -= 1;
  return Object.freeze({
    headerText,
    body: raw.slice(bodyStart, Math.max(bodyStart, bodyEnd)),
    end: endMatch.index + endMatch[0].length,
  });
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/u.test(value[index])) index += 1;
  return index;
}

function unescapeBodyOrgMarkers(value: string): string {
  return value.replace(/^(,+)(?=#\+(?:BEGIN|END)_[A-Z][A-Z0-9_-]*(?:[ \t].*)?\r?$)/gmu, commas => commas.slice(1));
}

export function parseBodyToolArguments(raw: string, descriptor: ToolProtocolDescriptor): Record<string, unknown> {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > BODY_INVOCATION_LIMIT_BYTES) return invalid("Body tool 调用为空或超过大小限制");
  const mode = descriptor.invocation.body;
  if (!mode) return invalid(`工具 ${descriptor.name} 不支持 org-mode body 调用`);
  const outer = parseBlockAt(raw, 0, mode.blockName);
  if (raw.slice(outer.end).trim().length > 0) return invalid(`#+END_${mode.blockName} 后存在额外内容`);
  const args = parseHeaders(outer.headerText, mode, descriptor.schema);
  if (mode.kind === "raw") {
    Object.defineProperty(args, mode.bodyParameter, { value: unescapeBodyOrgMarkers(outer.body), enumerable: true, writable: true, configurable: true });
    return args;
  }

  let cursor = 0;
  for (const section of mode.sections) {
    cursor = skipWhitespace(outer.body, cursor);
    const parsed = parseBlockAt(outer.body, cursor, section.blockName);
    Object.defineProperty(args, section.parameter, { value: unescapeBodyOrgMarkers(parsed.body), enumerable: true, writable: true, configurable: true });
    cursor = parsed.end;
  }
  if (outer.body.slice(cursor).trim().length > 0) return invalid(`EDIT body 包含未知 section 或额外内容`);
  return args;
}

export function parseToolInvocationArguments(
  raw: unknown,
  descriptor: ToolProtocolDescriptor | null,
  options: Readonly<{ allowBody?: boolean }> = {},
): Readonly<{ args: Record<string, unknown>; mode: "json" | "body" }> {
  if (typeof raw === "string" && raw.startsWith("#+BEGIN_")) {
    if (options.allowBody !== true) return invalid("Org-mode Body tool 调用未启用");
    if (!descriptor) return invalid("Body tool 缺少受权协议描述");
    return Object.freeze({ args: parseBodyToolArguments(raw, descriptor), mode: "body" as const });
  }
  return Object.freeze({ args: parseToolArguments(raw), mode: "json" as const });
}

export interface ExtractedBodyCall {
  readonly toolName: string;
  readonly rawArguments: string;
}

export function extractBodyToolCalls(
  content: string,
  descriptors: readonly ToolProtocolDescriptor[],
): Readonly<{ content: string; calls: readonly ExtractedBodyCall[] }> {
  const byBlock = new Map<string, ToolProtocolDescriptor>();
  for (const descriptor of descriptors) {
    const body = descriptor.invocation.body;
    if (!body) continue;
    if (byBlock.has(body.blockName)) throw new TypeError(`Duplicate body block name: ${body.blockName}`);
    byBlock.set(body.blockName, descriptor);
  }
  if (byBlock.size === 0 || typeof content !== "string" || !content.includes("#+BEGIN_")) {
    return Object.freeze({ content, calls: Object.freeze([]) });
  }
  const tags = [...byBlock.keys()].join("|");
  const beginPattern = new RegExp(`^#\\+BEGIN_(${tags})(?:[ \\t].*)?$`, "gmu");
  const calls: ExtractedBodyCall[] = [];
  const fragments: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = beginPattern.exec(content)) !== null) {
    if (calls.length >= MAX_BODY_CALLS) return invalid("单轮 Body tool 调用数量超过限制");
    const descriptor = byBlock.get(match[1])!;
    try {
      const end = parseBlockAt(content, match.index, descriptor.invocation.body!.blockName).end;
      fragments.push(content.slice(cursor, match.index));
      calls.push(Object.freeze({ toolName: descriptor.name, rawArguments: content.slice(match.index, end) }));
      cursor = end;
      beginPattern.lastIndex = end;
    } catch (error) {
      if (!(error instanceof ToolArgumentsError)) throw error;
      const lineEnd = content.indexOf("\n", match.index);
      const candidateEnd = lineEnd < 0 ? match.index + match[0].length : lineEnd + 1;
      calls.push(Object.freeze({ toolName: descriptor.name, rawArguments: content.slice(match.index, candidateEnd) }));
      beginPattern.lastIndex = Math.max(beginPattern.lastIndex, candidateEnd);
    }
  }
  fragments.push(content.slice(cursor));
  return Object.freeze({ content: fragments.join("").trim(), calls: Object.freeze(calls) });
}

export function renderBodyToolInstructions(descriptors: readonly ToolProtocolDescriptor[]): string {
  const modes = descriptors.map(descriptor => ({ descriptor, mode: descriptor.invocation.body })).filter(entry => entry.mode !== null);
  if (modes.length === 0) return "";
  const blocks = modes.map(({ descriptor, mode }) => {
    const headers = mode!.headers.map(item => ` :${item.name} ${item.required ? `\"<${item.parameter}>\"` : `<${item.parameter}>`}`).join("");
    if (mode!.kind === "raw") return `${descriptor.name}:\n#+BEGIN_${mode!.blockName}${headers}\n<raw ${mode!.bodyParameter}>\n#+END_${mode!.blockName}`;
    const sections = mode!.sections.map(section => `#+BEGIN_${section.blockName}\n<raw ${section.parameter}>\n#+END_${section.blockName}`).join("\n");
    return `${descriptor.name}:\n#+BEGIN_${mode!.blockName}${headers}\n${sections}\n#+END_${mode!.blockName}`;
  });
  return `## Org-mode Body Tools\nBody blocks are tool calls, not prose. Preserve raw body text without JSON escaping. Use only the exact forms below; JSON function calls remain supported. If raw text contains a line that could be an org-mode #+BEGIN_* or #+END_* marker, prefix that line with one comma; if it already has commas immediately before the marker, add one more. The host removes exactly one protective comma.\n\n${blocks.join("\n\n")}`;
}
