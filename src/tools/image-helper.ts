// ===========================================
// image_helper —— VLM 图像分析
// 使用 LLM 的视觉能力分析图片内容
// ===========================================

import path from "path";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

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
  const filePath = args.file_path as string;
  const query = args.query as string;
  const { gateway, rootId } = dataGateway(invocation);

  try {
    const authorized = await gateway.readFile(filePath, { defaultRootId: rootId, maxBytes: MAX_IMAGE_BYTES });
    const buffer = authorized.bytes;
    const base64 = buffer.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";

    // 使用 OpenAI 兼容的 vision API
    const { getCurrentProfile } = await import("../config.js");
    const profile = getCurrentProfile();
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseURL });

    const response = await client.chat.completions.create({
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
    });

    return response.choices[0]?.message?.content || "(视觉模型无回复)";
  } catch (err) {
    // 当前模型可能不支持 vision——返回有用的错误
    return `图像分析失败: ${err instanceof Error ? err.message : String(err)}\n\n注意：当前模型可能不支持视觉输入。image_helper 需要支持 vision 的模型（如 GPT-4o）。`;
  }
};
