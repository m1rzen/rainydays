// ===========================================
// 文档解析器 —— 把各种文件格式转成纯文本
// 支持: txt/md/docx/xlsx/pdf
// ===========================================

import path from "path";

/** 解析结果 */
export interface DocumentLocation {
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string;
}

export interface ParseResult {
  success: boolean;
  text: string;
  error?: string;
  pageCount?: number;
  renderedPages?: number[];
  locations?: readonly DocumentLocation[];
  warnings?: readonly string[];
}

export interface ParseFileOptions {
  readonly pdfPages?: readonly number[] | null;
  readonly includeEvidence?: boolean;
}

function locatedSections(sections: readonly Readonly<{ label: string; text: string }>[]): Pick<ParseResult, "text" | "locations"> {
  let nextLine = 1;
  const locations = sections.map(section => {
    const startLine = nextLine, endLine = startLine + section.text.split(/\r?\n/u).length - 1;
    nextLine = endLine + 2; // sections are separated by two newlines
    return { startLine, endLine, label: section.label };
  });
  return { text: sections.map(section => section.text).join("\n\n"), locations };
}

/** Parse bytes already read through an authorized, bounded file handle. */
export async function parseFileBuffer(fileName: string, input: Uint8Array, options: ParseFileOptions = {}): Promise<ParseResult> {
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
        return await parseDocx(buffer, options.includeEvidence === true);

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
        return await parseXlsx(buffer, options.includeEvidence === true);

      case ".pdf":
        return await parsePdf(buffer, options.pdfPages ?? null, options.includeEvidence === true);

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
async function parseDocx(buffer: Buffer, includeEvidence: boolean): Promise<ParseResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  if (includeEvidence) {
    const paragraphs = result.value.split(/\n{2,}/u).filter(paragraph => paragraph.trim().length > 0);
    if (!paragraphs.length) return { success: false, text: "", error: "DOCX 未提取到文字，可能为空或仅含图片；请提供可读取的正文。" };
    return { success: true, ...locatedSections(paragraphs.map((text, index) => ({ label: `提取段落 ${index + 1}`, text }))), warnings: ["段落按非空提取顺序编号，表格单元格正文亦包含在内；这不是 Word 物理页码。", "仅提取正文文字，图片、图表与页面版式未读取。"] };
  }
  return {
    success: true,
    text: result.value || "（文档内容为空）",
  };
}

/** Excel 表格 (.xlsx) */
async function parseXlsx(buffer: Buffer, includeEvidence: boolean): Promise<ParseResult> {
  const XLSXModule = await import("xlsx");
  const XLSX = (XLSXModule as any).default || XLSXModule;
  const workbook: import("xlsx").WorkBook = XLSX.read(buffer, { type: "buffer", cellDates: true, cellFormula: true, sheetStubs: includeEvidence });

  if (includeEvidence) {
    const sections: { label: string; text: string }[] = [];
    let formulas = 0, missing = 0, dates = false;
    const cellValue = (cell: import("xlsx").CellObject): string => {
      switch (cell.t) {
        case "n": return typeof cell.v === "number" && Number.isFinite(cell.v) ? `数值 ${cell.v}` : "无可信数值";
        case "d": dates = true; return `日期（原表显示值）${JSON.stringify(XLSX.utils.format_cell(cell))}`;
        case "b": return `布尔 ${String(cell.v)}`;
        case "e": return `错误 ${JSON.stringify(cell.w ?? "未知 Excel 错误")}`;
        default: return `文本 ${JSON.stringify(String(cell.v ?? ""))}`;
      }
    };
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = new Map<number, { address: string; column: number; text: string }[]>();
      for (const [address, cell] of Object.entries(sheet)) {
        if (!/^[A-Z]+[1-9]\d*$/u.test(address)) continue;
        const typed = cell as import("xlsx").CellObject;
        const formula = typeof typed.f === "string" || typeof typed.F === "string";
        const cached = typed.v !== undefined && typed.v !== null && typed.t !== "z";
        if (!formula && !cached) continue;
        const position = XLSX.utils.decode_cell(address);
        let text: string;
        if (formula) {
          formulas++; if (!cached) missing++;
          const expression = typed.f !== undefined ? JSON.stringify(`=${typed.f}`) : `数组公式范围 ${typed.F}（公式见起始单元格）`;
          text = `公式 ${expression}；${cached ? `已保存缓存 ${cellValue(typed)}（未重算）` : "无缓存；未计算，不能当作 0"}`;
        } else text = cellValue(typed);
        const row = rows.get(position.r) ?? []; row.push({ address, column: position.c, text }); rows.set(position.r, row);
      }
      for (const [rowNumber, cells] of [...rows].sort(([left], [right]) => left - right)) {
        cells.sort((left, right) => left.column - right.column);
        sections.push({ label: `工作表 ${JSON.stringify(sheetName)}；第 ${rowNumber + 1} 行；${cells[0].address}:${cells.at(-1)!.address}`, text: cells.map(cell => `${cell.address}: ${cell.text}`).join(" | ") });
      }
    }
    const warnings = ["空白行与空白单元格已省略；行列地址仍对应原表。"];
    if (formulas) warnings.push(`共 ${formulas} 个公式单元格；本次未重算，已保存缓存可能过期；其中 ${missing} 个无缓存，不能据此给出可信数值。`);
    if (dates) warnings.push("日期按原工作簿格式显示，未将表内本地日期解释为 UTC。");
    const rendered = locatedSections(sections);
    return { success: true, ...rendered, text: rendered.text || "（未发现非空单元格）", warnings };
  }

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
async function parsePdf(buffer: Buffer, requestedPages: readonly number[] | null, includeEvidence: boolean): Promise<ParseResult> {
  const pdfParse = (await import("pdf-parse")).default;
  const requested = requestedPages ? new Set(requestedPages) : null;
  const renderedPages: number[] = [];
  let hasText = false;
  const sections: { label: string; text: string }[] = [];
  const pagerender = async (pageData: any): Promise<string> => {
    const pageNumber = Number(pageData.pageNumber);
    if (requested && !requested.has(pageNumber)) return "";
    const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let lastY: number | undefined;
    let text = "";
    let pageHasText = false;
    for (const item of textContent.items as Array<{ str: string; transform: number[] }>) {
      if (item.str.trim()) { hasText = true; pageHasText = true; }
      text += lastY === undefined || lastY === item.transform[5] ? item.str : `\n${item.str}`;
      lastY = item.transform[5];
    }
    renderedPages.push(pageNumber);
    if (includeEvidence) sections.push({ label: `PDF 第 ${pageNumber} 页`, text: `--- PDF Page ${pageNumber} ---\n${pageHasText ? text : "（此页未提取到文字，可能为空白或扫描件；未做 OCR）"}` });
    return `--- PDF Page ${pageNumber} ---\n${text}`;
  };
  const max = requestedPages?.length ? Math.max(...requestedPages) : 0;
  const data = await pdfParse(buffer, { pagerender, max });
  if (requestedPages?.some(pageNumber => pageNumber > data.numpages)) {
    return { success: false, text: "", error: `请求页面超出 PDF 范围（共 ${data.numpages} 页）`, pageCount: data.numpages, renderedPages };
  }
  if (requested && renderedPages.length === 0) {
    return { success: false, text: "", error: `请求页面超出 PDF 范围（共 ${data.numpages} 页）`, pageCount: data.numpages, renderedPages: [] };
  }
  if (!hasText) return { success: false, text: "", error: "PDF 未提取到文字，可能是扫描件；请先识别文字或提供文本型 PDF。", pageCount: data.numpages, renderedPages };
  return {
    success: true,
    text: data.text.trim() || "（PDF 内容为空或为扫描件）",
    ...(includeEvidence ? locatedSections(sections) : {}),
    pageCount: data.numpages,
    renderedPages,
  };
}
