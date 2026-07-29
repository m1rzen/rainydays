// ===========================================
// download 工具 —— 下载文件到本地
// 支持进度反馈，超时保护
// ===========================================

import path from "path";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

function outputGateway(invocation?: ToolInvocationServices) {
  if (!invocation) throw new Error("Path gateway is required");
  const rootId = invocation.path.rootIdForEnv("OUTPUT_DIR");
  if (!rootId) throw new Error("Path root is unavailable: OUTPUT_DIR");
  return { gateway: invocation.path, rootId };
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error("下载内容超过 128 MB 上限");
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error("下载内容超过 128 MB 上限");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export const downloadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "download",
    description:
      "下载文件到本地输出目录。支持 HTTP/HTTPS 直链。返回保存的文件路径。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要下载的文件 URL。",
        },
        filename: {
          type: "string",
          description: "保存的文件名（可选，不传则从 URL 提取）",
        },
      },
      required: ["url"],
    },
  },
};

export const downloadExec: ToolExecutor = async (args, _env, invocation) => {
  const url = args.url as string;
  const { gateway, rootId } = outputGateway(invocation);
  let filename = (args.filename as string) || "";
  if (!filename) {
    try {
      const urlObj = new URL(url);
      filename = path.basename(urlObj.pathname) || "download";
    } catch {
      filename = "download";
    }
  }

  try {
    const reservation = await gateway.reserveFile(filename, { defaultRootId: rootId, maxBytes: MAX_DOWNLOAD_BYTES });
    const response = await fetch(url, {
      headers: { "User-Agent": "Mini-Lux/1.0" },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return `下载失败: HTTP ${response.status} ${response.statusText}`;
    }

    const buffer = await readBoundedResponse(response);
    await reservation.commit(buffer);
    const sizeKB = Math.round(buffer.length / 1024);
    return `✅ 文件已下载: ${filename} (${sizeKB} KB)`;
  } catch (err) {
    return `下载失败: ${err instanceof Error ? err.message : String(err)}`;
  }
};
