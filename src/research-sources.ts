import type { Message } from "./types.js";
import { marked } from "marked";

export interface ResearchSource {
  readonly url: string;
  readonly requestedUrl: string;
  readonly title: string;
  readonly status: "read" | "partial" | "failed";
  readonly readAt: string;
  readonly error: string;
}

export function researchUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Read evidence is derived from host receipts, never Source lines inside fetched pages or search snippets. */
export function collectResearchSources(messages: readonly Message[]): Readonly<{ sources: ResearchSource[]; unreadLinks: string[] }> {
  const pending = new Map<string, string>();
  const sources = new Map<string, ResearchSource>();
  let answer = "";
  for (const message of messages) {
    if (message.role === "user") { pending.clear(); answer = ""; }
    if (message.role === "assistant") {
      pending.clear();
      if (!message.tool_calls?.length) answer = message.content;
      for (const call of message.tool_calls ?? []) {
        if (call.function.name !== "fetch_markdown") continue;
        try {
          const url = researchUrl(JSON.parse(call.function.arguments).url);
          if (url) pending.set(call.id, url);
        } catch { /* malformed calls do not establish read evidence */ }
      }
    }
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const requestedUrl = pending.get(message.tool_call_id);
    pending.delete(message.tool_call_id);
    if (!requestedUrl) continue;
    const failed: ResearchSource = { url: requestedUrl, requestedUrl, title: new URL(requestedUrl).hostname,
      status: "failed", readAt: "", error: "未获得可验证的网页内容，请重试或换一个来源。" };
    try {
      const outcome = JSON.parse(message.content);
      if (outcome.status !== "success" || outcome.truncated) {
        sources.set(requestedUrl, failed); continue;
      }
      const receipt = JSON.parse(outcome.content);
      const url = researchUrl(receipt.url);
      if (receipt.type !== "research_source" || researchUrl(receipt.requestedUrl) !== requestedUrl || !url
        || typeof receipt.content !== "string" || !receipt.content.trim() || typeof receipt.partial !== "boolean"
        || typeof receipt.title !== "string" || typeof receipt.readAt !== "string" || !Number.isFinite(Date.parse(receipt.readAt))) {
        sources.set(requestedUrl, failed); continue;
      }
      sources.delete(requestedUrl);
      sources.set(url, { url, requestedUrl, title: receipt.title.slice(0, 512), status: receipt.partial ? "partial" : "read", readAt: receipt.readAt, error: "" });
    } catch { sources.set(requestedUrl, failed); }
  }
  const readUrls = new Set([...sources.values()].filter(source => source.status !== "failed").flatMap(source => [source.url, source.requestedUrl]));
  const unreadLinks = new Set<string>();
  marked.walkTokens(marked.lexer(answer, { gfm: true }), token => {
    if (token.type !== "link") return;
    const url = researchUrl(token.href);
    if (url && !readUrls.has(url)) unreadLinks.add(url);
  });
  return { sources: [...sources.values()], unreadLinks: [...unreadLinks] };
}
