import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const FETCH_DEFAULT_MAX_LENGTH = 20_000;
export const FETCH_MAX_LENGTH = 200_000;
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_MAX_TIMEOUT_MS = 120_000;
export const FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SEARCH_DEFAULT_RESULTS = 5;
export const SEARCH_MAX_RESULTS = 20;

const TEXT_CONTENT_TYPES = [
  "application/json", "application/ld+json", "application/xml", "application/xhtml+xml",
  "text/", "+json", "+xml",
] as const;

export interface SearchResult {
  readonly title: string;
  readonly snippet: string;
  readonly url: string;
}

export interface SearchProvider {
  readonly id: string;
  readonly search: (
    query: string,
    maxResults: number,
    fetcher: (url: string, init?: RequestInit) => Promise<Response>,
    signal: AbortSignal,
  ) => Promise<readonly SearchResult[]>;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

export function parseFetchMaxLength(value: unknown): number {
  return boundedInteger(value, FETCH_DEFAULT_MAX_LENGTH, 1, FETCH_MAX_LENGTH, "max_length");
}

export function parseFetchTimeout(value: unknown): number {
  return boundedInteger(value, FETCH_DEFAULT_TIMEOUT_MS, 100, FETCH_MAX_TIMEOUT_MS, "timeout");
}

export function parseSearchMaxResults(value: unknown): number {
  return boundedInteger(value, SEARCH_DEFAULT_RESULTS, 1, SEARCH_MAX_RESULTS, "max_results");
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes = FETCH_MAX_RESPONSE_BYTES,
): Promise<Buffer> {
  const declared = contentLength(response);
  if (declared !== null && declared > maximumBytes) {
    await response.body?.cancel("declared response limit exceeded").catch(() => undefined);
    throw new Error(`Response exceeds ${maximumBytes} byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const cancellationReason = () => signal.reason instanceof Error ? signal.reason : new Error("Request was cancelled");
  const onAbort = () => { void reader.cancel(cancellationReason()).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw cancellationReason();
      const { done, value } = await reader.read();
      if (signal.aborted) throw cancellationReason();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response limit exceeded").catch(() => undefined);
        throw new Error(`Response exceeds ${maximumBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) await reader.cancel(cancellationReason()).catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function decodeBody(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
}

function isTextContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return !mediaType || TEXT_CONTENT_TYPES.some(value => value.endsWith("/") ? mediaType.startsWith(value) : mediaType === value || mediaType.endsWith(value));
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function markdownDestination(value: string): string {
  return value.replace(/\\/gu, "%5C").replace(/\(/gu, "%28").replace(/\)/gu, "%29")
    .replace(/[\u0000-\u0020\u007f]/gu, character => encodeURIComponent(character));
}

function cleanInline(value: string): string {
  return value.replace(/[\t\r\n ]+/gu, " ");
}

function nodeMarkdown(node: Node, baseUrl: string, preformatted = false): string {
  if (node.nodeType === 3) return preformatted ? node.nodeValue ?? "" : escapeMarkdown(cleanInline(node.nodeValue ?? ""));
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (["script", "style", "nav", "footer", "form", "iframe", "svg", "canvas", "noscript"].includes(tag)) return "";
  const children = () => [...element.childNodes].map(child => nodeMarkdown(child, baseUrl, preformatted)).join("");
  if (tag === "pre") return `\n\n\`\`\`\n${element.textContent?.replace(/^\n|\n$/gu, "") ?? ""}\n\`\`\`\n\n`;
  if (tag === "code") return preformatted ? element.textContent ?? "" : `\`${(element.textContent ?? "").replace(/`/gu, "\\`")}\``;
  if (/^h[1-6]$/u.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
  if (tag === "p" || tag === "section" || tag === "article" || tag === "div") return `\n\n${children().trim()}\n\n`;
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
  if (tag === "em" || tag === "i") return `*${children().trim()}*`;
  if (tag === "blockquote") return `\n\n${children().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
  if (tag === "li") return `\n- ${children().trim()}`;
  if (tag === "ul" || tag === "ol") return `\n${children().trim()}\n`;
  if (tag === "a") {
    const label = children().trim();
    const href = element.getAttribute("href");
    if (!href) return label;
    try {
      const target = new URL(href, baseUrl);
      return target.protocol === "http:" || target.protocol === "https:" ? `[${label || escapeMarkdown(target.href)}](${markdownDestination(target.href)})` : label;
    } catch { return label; }
  }
  if (tag === "img") {
    const alt = escapeMarkdown(element.getAttribute("alt")?.trim() ?? "");
    const src = element.getAttribute("src");
    if (!src) return alt;
    try {
      const target = new URL(src, baseUrl);
      return target.protocol === "http:" || target.protocol === "https:" ? `![${alt}](${markdownDestination(target.href)})` : alt;
    } catch { return alt; }
  }
  if (tag === "tr") return `\n| ${[...element.children].map(child => nodeMarkdown(child, baseUrl).trim()).join(" | ")} |`;
  if (tag === "table") return `\n\n${children().trim()}\n\n`;
  return children();
}

function normalizeMarkdown(value: string): string {
  return value.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = "\n\n[Content truncated]";
  if (maximum <= suffix.length) return value.slice(0, maximum);
  return `${value.slice(0, maximum - suffix.length).trimEnd()}${suffix}`;
}

export function renderFetchedContent(input: Readonly<{
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
  raw: boolean;
  maxLength: number;
}>): string {
  if (!isTextContentType(input.contentType)) throw new Error(`Unsupported content type: ${input.contentType || "unknown"}`);
  const text = decodeBody(input.bytes, input.contentType);
  if (input.raw || !input.contentType.toLowerCase().includes("html")) return truncate(text, input.maxLength);
  const html = /<html(?:\s|>)/iu.test(text) ? text : `<!doctype html><html><body>${text}</body></html>`;
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const content = article?.content ?? document.body?.innerHTML ?? document.documentElement?.innerHTML ?? "";
  const parsed = parseHTML(`<main>${content}</main>`).document;
  const markdown = nodeMarkdown(parsed.querySelector("main") as unknown as Node, input.finalUrl);
  const title = article?.title?.trim() || document.title?.trim();
  const output = `${title ? `# ${escapeMarkdown(title)}\n\n` : ""}Source: ${input.finalUrl}\n\n${normalizeMarkdown(markdown)}`.trim();
  return truncate(output, input.maxLength);
}

function resultUrl(href: string): string | null {
  try {
    const redirect = new URL(href, "https://html.duckduckgo.com/");
    if (redirect.protocol !== "https:" && redirect.protocol !== "http:") return null;
    const candidate = redirect.searchParams.get("uddg");
    if (!candidate) return redirect.href;
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : redirect.href;
    } catch { return redirect.href; }
  } catch { return null; }
}

export function parseDuckDuckGoResults(html: string, maximum: number): readonly SearchResult[] {
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const block of document.querySelectorAll(".result")) {
    if (results.length >= maximum) break;
    const anchor = block.querySelector("a.result__a");
    const url = resultUrl(anchor?.getAttribute("href") ?? "");
    const title = anchor?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    if (!url || !title) continue;
    const snippet = block.querySelector(".result__snippet")?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
    results.push(Object.freeze({ title, snippet, url }));
  }
  return Object.freeze(results);
}

export const duckDuckGoSearchProvider: SearchProvider = Object.freeze({
  id: "duckduckgo-html",
  async search(
    query: string,
    maxResults: number,
    fetcher: (url: string, init?: RequestInit) => Promise<Response>,
    signal: AbortSignal,
  ) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetcher(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Mini-Lux/0.1)", Accept: "text/html" },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel("search provider rejected response").catch(() => undefined);
      throw new Error(`Search provider HTTP ${response.status}`);
    }
    const bytes = await readBoundedResponse(response, signal);
    return parseDuckDuckGoResults(decodeBody(bytes, response.headers.get("content-type") ?? "text/html; charset=utf-8"), maxResults);
  },
});
