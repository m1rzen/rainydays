import path from "node:path";
import { PathDeniedError } from "../path-policy.js";
import { ToolArgumentsError } from "../tool-pipeline.js";
import type { ToolDefinition, ToolExecutor } from "../types.js";

// 2026-11-14 审阅补充切片3（成品登记）：脚本生成、通用 write 与下载保存的成果
// 此前不在任何登记链上，只有 create_docx/create_xlsx 回执能进入产物列表。本工具
// 提供显式登记：核对授权路径与存在性、按内容识别实际格式、计算版本摘要，并要求
// 模型区分交付件/中间件/原始资料。登记回执持久化在会话消息中，由 document-outputs
// 统一派生；不做任何"按最新 mtime 猜测产物"的隐式行为。

const KINDS = new Set(["deliverable", "intermediate", "source"]);

function detectFormat(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "PK\u0003\u0004") return "zip-container";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (bytes.length >= 4 && bytes.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (!bytes.includes(0)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096)); return "text"; } catch { /* fallthrough */ }
  }
  return null;
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp",
  ".pdf": "pdf", ".docx": "zip-container", ".xlsx": "zip-container", ".zip": "zip-container",
  ".mp4": "mp4", ".m4v": "mp4", ".mov": "mp4", ".mp3": "mp3", ".m4a": "mp3",
  ".txt": "text", ".md": "text", ".markdown": "text", ".csv": "text", ".log": "text", ".json": "text",
});

function extensionFormat(filePath: string): string | null {
  return FORMAT_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export const registerOutputDef: ToolDefinition = {
  type: "function",
  function: {
    name: "register_output",
    description: "把本次任务生成的成果文件登记到会话产物列表（供用户查看与交付核对）。校验文件存在、按内容识别格式并计算版本摘要。kind：deliverable=要交给用户的交付件，intermediate=中间产物，source=原始资料。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "成果文件路径：绝对路径，或相对于 OUTPUT_DIR 的路径。" },
        kind: { type: "string", enum: ["deliverable", "intermediate", "source"], description: "产物类别：交付件/中间件/原始资料。" },
        note: { type: "string", description: "可选说明，例如内容的完成依据。" },
      },
      required: ["path", "kind"],
    },
  },
};

export const registerOutputExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = invocationValue;
  if (!invocation) throw new ToolArgumentsError("Tool invocation services are required");
  const filePath = args.path;
  const kind = args.kind;
  if (typeof filePath !== "string" || filePath.trim().length === 0) throw new ToolArgumentsError("path 必须是非空字符串");
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new ToolArgumentsError("kind 必须是 deliverable、intermediate 或 source");
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
  const defaultRootId = path.isAbsolute(filePath) ? undefined : invocation.path.rootIdForEnv("OUTPUT_DIR") ?? undefined;

  // One authorized handle: canonical path, bounded format preview and streaming
  // full-file SHA-256. Large downloads need no unbounded in-memory buffer.
  let inspected;
  try {
    inspected = await invocation.path.inspectFile(filePath, { defaultRootId, signal: invocation.signal });
  } catch (error) {
    if (error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") throw new ToolArgumentsError(`登记失败：文件不存在: ${filePath}`);
    throw error;
  }

  const { bytes, canonicalPath, sha256 } = inspected;
  const verification = "sha256";
  const detected = detectFormat(bytes);
  const byExtension = extensionFormat(filePath);
  const formatWarning = detected && byExtension && detected !== byExtension
    ? `扩展名提示 ${byExtension}，但文件内容是 ${detected}，请核对导出方式是否正确`
    : undefined;
  return JSON.stringify({
    type: "artifact_registration",
    path: canonicalPath,
    name: path.basename(canonicalPath),
    kind,
    ...(note ? { note } : {}),
    format: detected ?? "unknown",
    detectedFormat: detected ?? "unknown",
    bytes: Number(inspected.snapshot.size),
    sha256,
    verification,
    ...(formatWarning ? { formatWarning } : {}),
    message: `已登记${kind === "deliverable" ? "交付件" : kind === "intermediate" ? "中间产物" : "原始资料"}: ${canonicalPath}（版本 ${sha256.slice(0, 12)}）`,
  });
};
