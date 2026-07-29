// ===========================================
// 文档解析器 —— 把各种文件格式转成纯文本
// 支持: txt/md/docx/xlsx/pdf
// ===========================================

import path from "path";

/** 解析结果 */
export interface ParseResult {
  success: boolean;
  text: string;
  error?: string;
}

/** Parse bytes already read through an authorized, bounded file handle. */
export async function parseFileBuffer(fileName: string, input: Uint8Array): Promise<ParseResult> {
  const ext = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName).toLowerCase();
  const buffer = Buffer.from(input);

  try {
    if (baseName === "dockerfile" || baseName === "makefile") return await parseText(buffer);
    switch (ext) {
      case ".txt": case ".md": case ".markdown": case ".csv": case ".log":
      case ".json": case ".jsonl": case ".xml": case ".yaml": case ".yml":
      case ".toml": case ".ini": case ".conf": case ".config": case ".env":
      case ".js": case ".mjs": case ".cjs": case ".jsx": case ".ts": case ".tsx":
      case ".css": case ".scss": case ".less": case ".html": case ".htm":
      case ".vue": case ".svelte": case ".py": case ".java": case ".c": case ".h":
      case ".cpp": case ".hpp": case ".cs": case ".go": case ".rs": case ".php":
      case ".rb": case ".sh": case ".bash": case ".ps1": case ".bat": case ".cmd":
      case ".sql": case ".graphql": case ".gql": case ".gitignore": case ".npmrc":
        return await parseText(buffer);

      case ".docx":
        return await parseDocx(buffer);

      case ".doc":
        // .doc 是旧格式二进制，mammoth 不支持
        // MVP 阶段先跳过，提示用户转换
        return {
          success: false,
          text: "",
          error: ".doc 旧格式不支持，请转换为 .docx",
        };

      case ".xlsx":
      case ".xls":
        return await parseXlsx(buffer);

      case ".pdf":
        return await parsePdf(buffer);

      default:
        return {
          success: false,
          text: "",
          error: `不支持的文件格式: ${ext}`,
        };
    }
  } catch (err) {
    return {
      success: false,
      text: "",
      error: `解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 纯文本文件 */
async function parseText(buffer: Buffer): Promise<ParseResult> {
  // 先尝试 UTF-8
  try {
    const text = buffer.toString("utf-8");
    // 简单检测：如果没有乱码字符（替换符），就用 UTF-8
    if (!text.includes("\uFFFD")) {
      return { success: true, text };
    }
  } catch {
    // fall through to GBK
  }

  // 尝试 GBK
  try {
    const iconv = await import("iconv-lite");
    const text = iconv.decode(buffer, "gbk");
    return { success: true, text };
  } catch {
    // 如果 iconv 不可用，返回 UTF-8 的尽力解析
    return { success: true, text: buffer.toString("utf-8") };
  }
}

/** Word 文档 (.docx) */
async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return {
    success: true,
    text: result.value || "（文档内容为空）",
  };
}

/** Excel 表格 (.xlsx) */
async function parseXlsx(buffer: Buffer): Promise<ParseResult> {
  const XLSXModule = await import("xlsx");
  const XLSX = (XLSXModule as any).default || XLSXModule;
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const sheets: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      sheets.push(`【工作表: ${sheetName}】\n${csv}`);
    }
  }

  return {
    success: true,
    text: sheets.join("\n\n") || "（表格内容为空）",
  };
}

/** PDF 文档 */
async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const pdfParse = (await import("pdf-parse")).default;
  const data = await pdfParse(buffer);

  return {
    success: true,
    text: data.text || "（PDF 内容为空或为扫描件）",
  };
}
