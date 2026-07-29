// ===========================================
// web_search 工具 —— 网页搜索
// 使用 DuckDuckGo HTML 版（无需 API Key）
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";

export const webSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "搜索网页获取最新信息。返回搜索结果标题、摘要和链接。用于查询超出知识范围的事实、新闻、技术文档等。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词。",
        },
        max_results: {
          type: "number",
          description: "最大返回结果数（默认 5）",
        },
      },
      required: ["query"],
    },
  },
};

export const webSearchExec: ToolExecutor = async (args) => {
  const query = encodeURIComponent(args.query as string);
  const maxResults = (args.max_results as number) || 5;

  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `搜索失败: HTTP ${response.status}`;
    }

    const html = await response.text();

    // 解析 DuckDuckGo HTML 结果
    const results: { title: string; snippet: string; url: string }[] = [];

    // 提取结果块
    const resultRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
    const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
    const urlRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"/;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const block = match[1];
      const titleMatch = titleRegex.exec(block);
      const snippetMatch = snippetRegex.exec(block);
      const urlMatch = urlRegex.exec(block);

      if (titleMatch) {
        const title = stripHtml(titleMatch[1]).trim();
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";
        let url = urlMatch ? urlMatch[1] : "";

        // DuckDuckGo 的 URL 是跳转链接，提取实际 URL
        const ddgUrl = url.match(/uddg=([^&]+)/);
        if (ddgUrl) {
          try { url = decodeURIComponent(ddgUrl[1]); } catch { /* keep original */ }
        }

        results.push({ title, snippet, url });
      }
    }

    if (results.length === 0) {
      return `未找到与 "${args.query}" 相关的搜索结果。`;
    }

    const lines = results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.snippet}\n    🔗 ${r.url}`
    );

    return `搜索 "${args.query}" 找到 ${results.length} 个结果:\n\n${lines.join("\n\n")}`;
  } catch (err) {
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}
