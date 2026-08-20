// ===========================================
// image_helper —— VLM 图像分析
// 使用 LLM 的视觉能力分析图片内容
// ===========================================

import path from "path";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { cancellationError, cancellationFailure, throwIfCancelled } from "../run-cancellation.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function dataGateway(invocation?: ToolInvocationServices) {
  if (!invocation) throw new Error("Path gateway is required");
  const rootId = invocation.path.rootIdForEnv("DATA_ROOT");
  if (!rootId) throw new Error("Path root is unavailable: DATA_ROOT");
  return { gateway: invocation.path, rootId };
}

export const imageHelperDef: ToolDefinition = {
  type: "function",
  function: {
    name: "image_helper",
    description:
      "分析图片文件内容。使用视觉模型理解截图、图表、照片、UI 界面等。支持多次调用同一图片不同问题。",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "图片文件路径" },
        query: { type: "string", description: "要问的问题或分析方向。如 '描述这张图片'、'提取图表中的数据'、'列出所有 UI 按钮'" },
      },
      required: ["file_path", "query"],
    },
  },
};

export const imageHelperExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  const filePath = args.file_path as string;
  const query = args.query as string;
  const { gateway, rootId } = dataGateway(invocation);

  try {
    throwIfCancelled(invocation.signal);
    const authorized = await gateway.readFile(filePath, { defaultRootId: rootId, maxBytes: MAX_IMAGE_BYTES });
    throwIfCancelled(invocation.signal);
    const buffer = authorized.bytes;
    const base64 = buffer.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";

    // 使用 OpenAI 兼容的 vision API
    const { getCurrentProfile } = await import("../config.js");
    const profile = getCurrentProfile();
    const { default: OpenAI, APIUserAbortError } = await import("openai");
    const client = new OpenAI({
      apiKey: profile.apiKey,
      baseURL: profile.baseURL,
      fetch: (url, init) => {
        if (typeof url !== "string") throw new TypeError("Vision provider request URL must be a string");
        return invocation.network.fetch(url, init);
      },
    });

    let response;
    try {
      response = await client.chat.completions.create({
        model: profile.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: query },
              { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 1000,
      }, { signal: invocation.signal });
    } catch (error) {
      if (invocation.signal.aborted && error instanceof APIUserAbortError) {
        throw cancellationError(invocation.signal, "image_helper was cancelled");
      }
      throw error;
    }

    return response.choices[0]?.message?.content || "(视觉模型无回复)";
  } catch (err) {
    if (invocation.signal.aborted) throw cancellationFailure(invocation.signal, err, "image_helper was cancelled");
    throw err instanceof Error ? err : new Error(String(err));
  }
};
