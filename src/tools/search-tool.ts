// ===========================================
// web_search —— provider adapter with structured, traceable sources
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { cancellationError, cancellationFailure, throwIfCancelled, timeoutSignal } from "../run-cancellation.js";
import { duckDuckGoSearchProvider, parseSearchMaxResults, type SearchProvider } from "../fetch-runtime.js";

export const webSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web through a bounded provider adapter. Returns titles, snippets, and traceable source URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query." },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of results. Defaults to 5.",
        },
      },
      required: ["query"],
    },
  },
};

export function createWebSearchExecutor(provider: SearchProvider): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("Network gateway is required");
    const query = String(args.query).trim();
    if (!query || query.length > 500) throw new TypeError("Search query is invalid");
    const maxResults = parseSearchMaxResults(args.max_results === 0 ? undefined : args.max_results);
    const cancellation = timeoutSignal(invocation.signal, 15_000, `web_search:${provider.id}`);
    try {
      throwIfCancelled(cancellation.signal);
      const results = await provider.search(query, maxResults, invocation.network.fetch, cancellation.signal);
      if (results.length === 0) return `未找到与 ${JSON.stringify(query)} 相关的搜索结果。\n\nProvider: ${provider.id}`;
      const rendered = results.map((result, index) => [
        `[${index + 1}] ${result.title.replace(/[\r\n]/gu, " ")}`,
        result.snippet ? `    ${result.snippet}` : "",
        `    🔗 ${result.url}`,
        `    Source: ${result.url}`,
      ].filter(Boolean).join("\n"));
      return `Search results for ${JSON.stringify(query)}\nProvider: ${provider.id}\n\n${rendered.join("\n\n")}`;
    } catch (error) {
      if (cancellation.signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw cancellationError(cancellation.signal, "web_search was cancelled");
      }
      if (cancellation.signal.aborted) throw cancellationFailure(cancellation.signal, error, "web_search was cancelled");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      cancellation.dispose();
    }
  };
}

export const webSearchExec: ToolExecutor = createWebSearchExecutor(duckDuckGoSearchProvider);
