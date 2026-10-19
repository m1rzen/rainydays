import type { DocumentLocation } from "./tools/parsers.js";
import { ToolArgumentsError } from "./tool-pipeline.js";

export function parsePdfPageRange(value: unknown): readonly number[] | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new ToolArgumentsError("pages 必须是 PDF 页码或页码范围");
  const pages = new Set<number>();
  for (const token of value.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(token);
    if (!match) throw new ToolArgumentsError(`PDF pages 无效: ${value}`);
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > 100_000) throw new ToolArgumentsError(`PDF pages 无效: ${value}`);
    if (last - first + 1 + pages.size > 100) throw new ToolArgumentsError("单次最多读取 100 个 PDF 页面");
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return Object.freeze([...pages].sort((left, right) => left - right));
}

/** Stable virtual lines keep the parser's source location on every long-line segment. */
export function documentTextPage(text: string, offset = 1, limit = 12, locations: readonly DocumentLocation[] = []): string {
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new ToolArgumentsError("offset 和 limit 必须是正整数");
  let locationIndex = 0;
  const lines = text.split(/\r?\n/u).flatMap((line, sourceIndex) => {
    const sourceLine = sourceIndex + 1;
    while (locationIndex < locations.length && locations[locationIndex].endLine < sourceLine) locationIndex++;
    const location = locations[locationIndex];
    const label = location && sourceLine >= location.startLine && sourceLine <= location.endLine ? location.label : "";
    const chars = Array.from(line), parts: string[] = [];
    for (let start = 0; start < chars.length; start += 500) parts.push(chars.slice(start, start + 500).join(""));
    if (!parts.length) parts.push("");
    return parts.map((part, index) => {
      const position = parts.length > 1 ? `${label || `原文第 ${sourceLine} 行`}；分段 ${index + 1}/${parts.length}` : label;
      return `${position ? `[${position}] ` : ""}${part}`;
    });
  });
  const start = Math.min(offset - 1, lines.length), end = Math.min(lines.length, start + Math.min(limit, 12));
  const body = lines.slice(start, end).map((line, index) => `${start + index + 1} | ${line}`).join("\n");
  const range = end > start ? `本次第 ${start + 1}-${end} 行；` : "本次无可显示行；";
  return `${body}\n\n提取文本共 ${lines.length} 行；${range}${end < lines.length ? `下一页 offset=${end + 1}` : "已到末尾"}。行号指提取文本，长行按 500 字符分段。`;
}

export function documentWarnings(warnings: readonly string[] | undefined): string {
  return warnings?.length ? `\n读取说明:\n${warnings.map(warning => `- ${warning}`).join("\n")}\n` : "";
}
