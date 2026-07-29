// ===========================================
// 文档生成工具 —— 生成 Word/Excel 文档
// 通用版：输出路径由 persona env.OUTPUT_DIR 决定
// ===========================================

import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

function outputGateway(invocation?: ToolInvocationServices) {
  if (!invocation) throw new Error("Path gateway is required");
  const rootId = invocation.path.rootIdForEnv("OUTPUT_DIR");
  if (!rootId) throw new Error("Path root is unavailable: OUTPUT_DIR");
  return { gateway: invocation.path, rootId };
}

// ===========================================
// create_docx
// ===========================================
export const createDocxDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_docx",
    description:
      "生成 Word (.docx) 文档。支持标题和正文段落。适合写报告、方案简介、会议纪要等。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出文件名，如 '报告.docx'。" },
        title: { type: "string", description: "文档标题。" },
        paragraphs: {
          type: "array",
          items: { type: "string" },
          description: "正文段落数组。",
        },
      },
      required: ["path", "paragraphs"],
    },
  },
};

export const createDocxExec: ToolExecutor = async (args, _env, invocation) => {
  const relativePath = args.path as string;
  const { gateway, rootId } = outputGateway(invocation);
  const reservation = await gateway.reserveFile(relativePath, {
    defaultRootId: rootId,
    maxBytes: MAX_OFFICE_BYTES,
    requiredExtension: ".docx",
  });
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const title = (args.title as string) || "";
  const paragraphs = (args.paragraphs as string[]) || [];

  const children: InstanceType<typeof Paragraph>[] = [];

  if (title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: title, bold: true })],
      })
    );
  }

  for (const text of paragraphs) {
    children.push(
      new Paragraph({
        children: [new TextRun(text)],
        spacing: { after: 200 },
      })
    );
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  await reservation.commit(buffer);
  return `✅ Word 文档已生成: ${relativePath}`;
};

// ===========================================
// create_xlsx
// ===========================================
export const createXlsxDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_xlsx",
    description:
      "生成 Excel (.xlsx) 表格。支持多工作表。适合整理项目列表、数据统计、信息汇总。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出文件名。" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "工作表名称" },
              data: {
                type: "array",
                items: { type: "array", items: {} },
                description: "二维数组，第一行通常是表头。",
              },
            },
            required: ["name", "data"],
          },
          description: "工作表列表",
        },
      },
      required: ["path", "sheets"],
    },
  },
};

export const createXlsxExec: ToolExecutor = async (args, _env, invocation) => {
  const relativePath = args.path as string;
  const { gateway, rootId } = outputGateway(invocation);
  const reservation = await gateway.reserveFile(relativePath, {
    defaultRootId: rootId,
    maxBytes: MAX_OFFICE_BYTES,
    requiredExtension: ".xlsx",
  });
  const XLSXModule = await import("xlsx");
  const XLSX = (XLSXModule as any).default || XLSXModule;
  const sheets = (args.sheets as Array<{ name: string; data: unknown[][] }>) || [];

  const workbook = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.data);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  await reservation.commit(buffer);
  return `✅ Excel 表格已生成: ${relativePath}`;
};
