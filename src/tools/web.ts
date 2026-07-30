// ===========================================
// 网络工具 —— URL 抓取 + 网页内容提取
// 让 agent 能访问互联网，读取网页内容
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";

// ===========================================
// fetch_url —— 抓取网页内容
// ===========================================
export const fetchUrlDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "抓取指定 URL 的网页内容，返回纯文本。支持 HTTP/HTTPS。适合读取文档页面、API 返回的 JSON、文章内容等。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要抓取的 URL，如 'https://example.com/doc'。",
        },
        format: {
          type: "string",
          enum: ["text", "json", "raw"],
          description: "返回格式：text=去除HTML标签的纯文本（默认），json=解析JSON，raw=原始响应体。",
        },
      },
      required: ["url"],
    },
  },
};

export const fetchUrlExec: ToolExecutor = async (args) => {
  const url = args.url as string;
  const format = (args.format as string) || "text";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "RainyDays/0.1 (AI Agent)",
        Accept: "text/html,application/json,*/*",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `请求失败: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") || "";

    // JSON 格式
    if (format === "json" || contentType.includes("application/json")) {
      const data = await response.json();
      const text = JSON.stringify(data, null, 2);
      return text.length > 8000 ? text.slice(0, 8000) + "\n...(已截断)" : text;
    }

    // 原始格式
    if (format === "raw") {
      const text = await response.text();
      return text.length > 8000 ? text.slice(0, 8000) + "\n...(已截断)" : text;
    }

    // 默认：text —— 去除 HTML 标签
    const html = await response.text();
    const text = htmlToText(html);
    return text.length > 8000 ? text.slice(0, 8000) + "\n...(已截断)" : text;
  } catch (err) {
    return `抓取失败: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/**
 * 简单的 HTML 转纯文本
 * 去除标签、脚本、样式，保留文本内容
 */
function htmlToText(html: string): string {
  return html
    // 移除 script 和 style 块
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    // 块级元素换行
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // 移除所有标签
    .replace(/<[^>]+>/g, "")
    // 解码常见 HTML 实体
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 清理多余空行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
