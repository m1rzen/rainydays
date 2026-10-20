// ===========================================
// 文档生成工具 —— 生成 Word/Excel 文档
// 通用版：输出路径由 persona env.OUTPUT_DIR 决定
// ===========================================

import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { throwIfCancelled } from "../run-cancellation.js";
import { collectResearchSources, researchUrl } from "../research-sources.js";
import { loadSessionMessages } from "../session.js";
import { parseFileBuffer } from "./parsers.js";

const MAX_OFFICE_BYTES = 64 * 1024 * 1024;
const WORD_PAGE_WIDTH = 11906, WORD_PAGE_HEIGHT = 16838, WORD_MARGIN = 1134;
const WORD_TEXT_WIDTH = WORD_PAGE_WIDTH - WORD_MARGIN * 2;

type WordBlock = { kind: "paragraph" | "heading" | "bullet"; text: string; level?: number } | { kind: "table"; headers: string[]; rows: string[][] };
function wordBlocks(value: unknown): WordBlock[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Word blocks 必须为数组。");
  return value.map(block => {
    if (!block || typeof block !== "object") throw new Error("Word 内容块无效。");
    if (block.kind === "table") {
      const strings = (cells: unknown): cells is string[] => Array.isArray(cells) && cells.every(cell => typeof cell === "string");
      if (!strings(block.headers) || block.headers.length < 1 || block.headers.length > 8 || !Array.isArray(block.rows)
        || !block.rows.every((row: unknown) => strings(row) && row.length === block.headers.length)) throw new Error("Word 表格需要1至8列表头，所有行列数须一致，单元格使用文本。");
      return { kind: "table", headers: block.headers, rows: block.rows };
    }
    if (!["paragraph", "heading", "bullet"].includes(block.kind) || typeof block.text !== "string") throw new Error("Word 内容块需要有效kind与text。");
    if (block.kind === "heading" && block.level !== undefined && ![2, 3].includes(block.level)) throw new Error("Word 正文标题level只支持2或3。");
    return { kind: block.kind, text: block.text, level: block.level };
  });
}

const COLUMN_FORMATS = { general: "General", text: "@", integer: "#,##0", decimal: "#,##0.00", currency: '"¥"#,##0.00', percent: "0.00%", date: "yyyy-mm-dd" } as const;
type ColumnFormat = keyof typeof COLUMN_FORMATS;
type WorkbookSheet = { name: string; data: unknown[][]; columnFormats?: ColumnFormat[] };
function excelDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("日期须为YYYY-MM-DD，不能包含时间或模糊日期。");
  const [year, month, day] = value.split("-").map(Number), date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`无效日期：${value}`);
  // Excel's 1900 date system reserves serial 60 for its fictitious leap day.
  return (date.getTime() - Date.UTC(1899, 11, 31)) / 86400000 + (date.getTime() >= Date.UTC(1900, 2, 1) ? 1 : 0);
}

function workbookSheets(value: unknown): WorkbookSheet[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Workbook is empty：Excel 至少需要一个工作表。");
  return value.map(sheet => {
    if (!sheet || typeof sheet.name !== "string" || !Array.isArray(sheet.data) || !sheet.data.length || !sheet.data.every(Array.isArray)) throw new Error("工作表需要名称与二维单元格data。");
    const width = sheet.data.reduce((maximum: number, row: unknown[]) => Math.max(maximum, row.length), 0);
    if (!width) throw new Error("工作表至少需要一个非空单元格。");
    if (sheet.columnFormats !== undefined && (!Array.isArray(sheet.columnFormats) || sheet.columnFormats.length > width || !sheet.columnFormats.every((format: unknown) => typeof format === "string" && Object.hasOwn(COLUMN_FORMATS, format)))) throw new Error("columnFormats须与现有列对应，使用支持的单元格格式。");
    const data = sheet.data.map((row: unknown[], rowIndex: number) => row.map((cell, column) => {
      if (cell == null) return null;
      if (!["string", "number", "boolean"].includes(typeof cell) || typeof cell === "number" && !Number.isFinite(cell)) throw new Error(`工作表${sheet.name}第${rowIndex + 1}行含不支持的单元格；只接受文本、有限数值、布尔或空值，不执行公式对象。`);
      const format: ColumnFormat = rowIndex === 0 ? "general" : sheet.columnFormats?.[column] ?? "general";
      if (cell === "") return cell;
      if (format === "date") return excelDate(String(cell));
      if (format === "text" && typeof cell !== "string") throw new Error(`工作表${sheet.name}第${rowIndex + 1}行文本列须传字符串，以保留编号。`);
      if (["integer", "decimal", "currency", "percent"].includes(format) && (typeof cell !== "number" || format === "integer" && !Number.isSafeInteger(cell))) throw new Error(`工作表${sheet.name}第${rowIndex + 1}行需要实际数值，不从文本猜数字。`);
      return cell;
    }));
    return { name: sheet.name, data, columnFormats: sheet.columnFormats };
  });
}

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
      "生成可编辑Word(.docx)。paragraphs写普通正文，blocks按顺序写标题/列表/原生表格；使用blocks时paragraphs可为空数组。统一A4、中文字体和段落间距，提交前复读文字；不代表已做视觉核验。默认另存，避免覆盖源文件。",
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
        blocks: {
          type: "array", description: "在普通paragraphs之后追加的有序正文块。heading/bullet/paragraph用text，heading的level为2或3；table用headers和rows，1至8列且列数一致。",
          items: { type: "object", properties: {
            kind: { type: "string", enum: ["paragraph", "heading", "bullet", "table"] },
            text: { type: "string" }, level: { type: "integer", enum: [2, 3] },
            headers: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          }, required: ["kind"] },
        },
        sources: { type: "array", maxItems: 30, items: { type: "string" }, description: "研究报告的参考网址，必须是本会话 fetch_markdown 实际读取的最终 URL。自动追加参考资料与可点击链接。" },
      },
      required: ["path", "paragraphs"],
    },
  },
};

export const createDocxExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  const blocks = wordBlocks(args.blocks);
  const sourceUrls = args.sources as string[] | undefined;
  const evidence = sourceUrls?.length ? collectResearchSources(loadSessionMessages(invocation.capabilityContext.sessionId)).sources : [];
  const references = (sourceUrls ?? []).map(value => {
    const url = researchUrl(value);
    const source = evidence.find(item => item.url === url && item.status !== "failed");
    if (!source) throw new Error("报告引用的来源尚未读取，请先用 fetch_markdown 读取后再生成报告。");
    return source;
  });
  const relativePath = args.path as string;
  const { gateway, rootId } = outputGateway(invocation);
  const reservation = await gateway.reserveFile(relativePath, {
    defaultRootId: rootId,
    maxBytes: MAX_OFFICE_BYTES,
    requiredExtension: ".docx",
  });
  throwIfCancelled(invocation.signal);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, TableLayoutType, BorderStyle } = await import("docx");
  const title = (args.title as string) || "";
  const paragraphs = (args.paragraphs as string[]) || [];

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

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

  for (const block of blocks) {
    if (block.kind !== "table") {
      children.push(new Paragraph({ text: block.text, ...(block.kind === "heading" ? { heading: block.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2 } : {}), ...(block.kind === "bullet" ? { bullet: { level: 0 } } : {}) }));
      continue;
    }
    const columnWidths = block.headers.map(() => Math.floor(WORD_TEXT_WIDTH / block.headers.length));
    const border = { style: BorderStyle.SINGLE, size: 4, color: "C8CDD2" };
    children.push(new Table({ width: { size: WORD_TEXT_WIDTH, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths,
      margins: { top: 100, bottom: 100, left: 100, right: 100 }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: [block.headers, ...block.rows].map((row, index) => new TableRow({ tableHeader: index === 0, cantSplit: true, children: row.map((text, column) => new TableCell({ width: { size: columnWidths[column], type: WidthType.DXA }, ...(index === 0 ? { shading: { fill: "F1F3F5" } } : {}), children: [new Paragraph({ spacing: { after: 0, before: 0 }, children: [new TextRun({ text, bold: index === 0 })] })] })) })) }));
    children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
  }

  if (references.length) {
    children.push(new Paragraph({ text: "参考资料", heading: HeadingLevel.HEADING_2 }));
    for (const [index, source] of references.entries()) children.push(new Paragraph({ children: [
      new TextRun(`[${index + 1}] ${source.title}${source.status === "partial" ? "（部分读取）" : ""} `),
      new ExternalHyperlink({ link: source.url, children: [new TextRun({ text: source.url, style: "Hyperlink" })] }),
    ] }));
  }

  const doc = new Document({ title, styles: { default: {
    document: { run: { font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" }, size: 22, color: "20252A" }, paragraph: { spacing: { after: 140, line: 276 } } },
    heading1: { run: { size: 40, bold: true, color: "20252A" }, paragraph: { spacing: { before: 0, after: 280 }, keepNext: true } },
    heading2: { run: { size: 28, bold: true, color: "20252A" }, paragraph: { spacing: { before: 220, after: 120 }, keepNext: true } },
    heading3: { run: { size: 24, bold: true, color: "20252A" }, paragraph: { spacing: { before: 160, after: 100 }, keepNext: true } },
  } }, sections: [{ properties: { page: { size: { width: WORD_PAGE_WIDTH, height: WORD_PAGE_HEIGHT }, margin: { top: WORD_MARGIN, bottom: WORD_MARGIN, left: WORD_MARGIN, right: WORD_MARGIN } } }, children }] });
  const buffer = await Packer.toBuffer(doc);
  const checked = await parseFileBuffer(relativePath, buffer);
  const expected = [title, ...paragraphs, ...blocks.flatMap(block => block.kind === "table" ? [...block.headers, ...block.rows.flat()] : [block.text])];
  if (!checked.success || expected.some(text => text && !checked.text.includes(text))) throw new Error("Word 生成后文字复读不一致，未保存成果。请缩小内容或检查输入字符。");
  throwIfCancelled(invocation.signal);
  await reservation.commit(buffer);
  return JSON.stringify({ type: "document_output", format: "docx", path: reservation.path, verification: "text-read-back", message: `Word 文档已生成: ${relativePath}` });
};

// ===========================================
// create_xlsx
// ===========================================
export const createXlsxDef: ToolDefinition = {
  type: "function",
  function: {
    name: "create_xlsx",
    description:
      "生成可编辑Excel(.xlsx)，支持多表、可读列宽与columnFormats。data第一行为表头，只传实际数值/文本/布尔/空值；日期列传YYYY-MM-DD。文本编号保留前导零；百分比传0到1比例。不执行或重算公式，公式字符串按普通文本保存。提交前复读类型和值，默认另存。",
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
              columnFormats: { type: "array", items: { type: "string", enum: Object.keys(COLUMN_FORMATS) }, description: "与数据列依次对应，应用于表头之后：general/text/integer/decimal/currency/percent/date。数值列须传JSON数值，date传严格YYYY-MM-DD。" },
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
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  const relativePath = args.path as string;
  const { gateway, rootId } = outputGateway(invocation);
  const sheets = workbookSheets(args.sheets);
  const reservation = await gateway.reserveFile(relativePath, {
    defaultRootId: rootId,
    maxBytes: MAX_OFFICE_BYTES,
    requiredExtension: ".xlsx",
  });
  throwIfCancelled(invocation.signal);
  const XLSXModule = await import("xlsx");
  const XLSX = (XLSXModule as any).default || XLSXModule;

  const workbook = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.data);
    const width = sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    for (let row = 1; row < sheet.data.length; row++) for (let column = 0; column < width; column++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && sheet.columnFormats?.[column]) cell.z = COLUMN_FORMATS[sheet.columnFormats[column]];
    }
    worksheet["!cols"] = Array.from({ length: width }, (_, column) => {
      const displayWidth = (value: unknown): number => Array.from(String(value ?? "")).reduce((total, char) => total + (char.codePointAt(0)! > 255 ? 2 : 1), 0);
      const values = sheet.data.map((_row, row) => XLSX.utils.format_cell(worksheet[XLSX.utils.encode_cell({ r: row, c: column })] ?? { t: "z" }));
      return { wch: Math.min(60, values.reduce((maximum, value) => Math.max(maximum, displayWidth(value)), 12) + 2) };
    });
    worksheet["!rows"] = [{ hpt: 24 }];
    if (sheet.data.length > 1) worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheet.data.length - 1, c: width - 1 } }) };
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true });
  const checked = XLSX.read(Buffer.from(buffer), { type: "buffer", cellNF: true });
  for (const sheet of sheets) for (const [row, cells] of sheet.data.entries()) for (const [column, expected] of cells.entries()) {
    if (expected == null || expected === "") continue;
    const cell = checked.Sheets[sheet.name]?.[XLSX.utils.encode_cell({ r: row, c: column })];
    if (!cell || cell.v !== expected || cell.t !== ({ string: "s", number: "n", boolean: "b" } as Record<string, string>)[typeof expected]) throw new Error("Excel 生成后单元格类型或值复读不一致，未保存成果。");
  }
  throwIfCancelled(invocation.signal);
  await reservation.commit(buffer);
  return JSON.stringify({ type: "document_output", format: "xlsx", path: reservation.path, verification: "values-read-back", message: `Excel 表格已生成: ${relativePath}` });
};
