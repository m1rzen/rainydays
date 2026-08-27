// ===========================================
// fetch_markdown —— bounded fetch + Readability Markdown extraction
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { cancellationError, cancellationFailure, throwIfCancelled, timeoutSignal } from "../run-cancellation.js";
import {
  parseFetchMaxLength,
  parseFetchTimeout,
  readBoundedResponse,
  renderFetchedContent,
} from "../fetch-runtime.js";

export const fetchMarkdownDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_markdown",
    description:
      "I fetch a URL and return its content as Markdown. For HTML pages, I extract the main content using Mozilla Readability and convert it to clean Markdown. For non-HTML content (JSON, plain text, XML), I return it directly.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http or https)." },
        max_length: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum characters to return. Defaults to 20000.",
        },
        timeout: {
          type: "integer",
          minimum: 100,
          maximum: 120000,
          description: "Request timeout in milliseconds. Defaults to 30000 (30 seconds).",
        },
        raw: {
          type: "boolean",
          description: "If true, return raw content without HTML-to-Markdown conversion. Default: false.",
        },
      },
      required: ["url"],
    },
  },
};

export const fetchMarkdownExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Network gateway is required");
  const url = args.url as string;
  const maxLength = parseFetchMaxLength(args.max_length);
  const timeout = parseFetchTimeout(args.timeout);
  const raw = args.raw === true;
  const cancellation = timeoutSignal(invocation.signal, timeout, "fetch_markdown");
  try {
    throwIfCancelled(cancellation.signal);
    let response: Response;
    try {
      response = await invocation.network.fetch(url, {
        headers: {
          "User-Agent": "Mini-Lux/0.1 (Readability Fetch)",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
        },
        signal: cancellation.signal,
      });
    } catch (error) {
      if (cancellation.signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw cancellationError(cancellation.signal, "fetch_markdown was cancelled");
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const bytes = await readBoundedResponse(response, cancellation.signal);
    return renderFetchedContent({
      bytes,
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: response.url || url,
      raw,
      maxLength,
    });
  } catch (error) {
    if (cancellation.signal.aborted) throw cancellationFailure(cancellation.signal, error, "fetch_markdown was cancelled");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    cancellation.dispose();
  }
};

// Compatibility alias retained for existing personas and stored tool calls.
export const fetchUrlDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description: "Legacy alias for fetch_markdown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        format: { type: "string", enum: ["text", "json", "raw"], description: "Legacy response format." },
      },
      required: ["url"],
    },
  },
};

function legacyHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<nav[\s\S]*?<\/nav>/giu, "")
    .replace(/<footer[\s\S]*?<\/footer>/giu, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/giu, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/\n{3,}/gu, "\n\n").trim();
}

export const fetchUrlExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Network gateway is required");
  const cancellation = timeoutSignal(invocation.signal, 15_000, "fetch_url");
  try {
    let response: Response;
    try {
      response = await invocation.network.fetch(args.url as string, {
        headers: { "User-Agent": "Mini-Lux/0.1", Accept: "text/html,application/json,*/*" },
        signal: cancellation.signal,
      });
    } catch (error) {
      if (cancellation.signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw cancellationError(cancellation.signal, "fetch_url was cancelled");
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const bytes = response.body
      ? await readBoundedResponse(response, cancellation.signal)
      : Buffer.from(await response.text(), "utf8");
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Response exceeds 2097152 byte limit");
    const text = new TextDecoder("utf-8").decode(bytes);
    const contentType = response.headers.get("content-type") ?? "";
    if (args.format === "json" || contentType.includes("application/json")) return JSON.stringify(JSON.parse(text), null, 2);
    if (args.format === "raw") return text;
    return contentType.includes("html") ? legacyHtmlToText(text) : text;
  } catch (error) {
    if (cancellation.signal.aborted) throw cancellationFailure(cancellation.signal, error, "fetch_url was cancelled");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    cancellation.dispose();
  }
};
