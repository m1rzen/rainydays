import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import * as XLSXModule from "xlsx";
import { wordBrief, salesWorkbook } from "../fixtures/office-quality-data.mjs";
const XLSX = XLSXModule.default ?? XLSXModule;
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-office-quality-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data") });
const [{ createDocxExec, createXlsxExec }, { parseFileBuffer }, { closeDb }] = await Promise.all([import("../../src/tools/writer.ts"), import("../../src/tools/parsers.ts"), import("../../src/db.ts")]);
test.after(async () => {
  await closeDb();
  if (process.env.RAINYDAYS_KEEP_D08_FIXTURE === "1") { console.log(`D08_FIXTURE:${JSON.stringify({ fixture })}`); return; }
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-office-quality-"));
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const invocation = {
  signal: new AbortController().signal,
  path: { rootIdForEnv: () => "output", reserveFile: async name => ({ path: path.join(fixture, name), commit: bytes => fs.writeFile(path.join(fixture, name), bytes, { flag: "wx" }) }) },
};

test("D08 Word public writer produces readable headings, native lists and a real repeated-header table", async () => {
  const receipt = JSON.parse(await createDocxExec(wordBrief, {}, invocation));
  const bytes = await fs.readFile(receipt.path), parsed = await parseFileBuffer(receipt.path, bytes);
  assert.equal(parsed.success, true); assert.match(parsed.text, /2026-11-25/u); assert.match(parsed.text, /客户编号/u); assert.match(parsed.text, /0007/u); assert.match(parsed.text, /1,500.00/u);
  const archive = await JSZip.loadAsync(bytes), xml = await archive.file("word/document.xml").async("string"), styles = await archive.file("word/styles.xml").async("string");
  assert.match(xml, /<w:tbl>/u); assert.match(xml, /<w:tblHeader/u); assert.match(xml, /<w:numPr>/u);
  assert.match(xml, /w:w="11906"/u); assert.match(xml, /w:h="16838"/u); assert.match(styles, /w:eastAsia="Microsoft YaHei"/u);
  assert.equal(receipt.verification, "text-read-back");
});

test("D08 Excel public writer retains numeric and date types, text identifiers, formats and readable widths", async () => {
  const receipt = JSON.parse(await createXlsxExec(salesWorkbook, {}, invocation));
  const book = XLSX.read(await fs.readFile(receipt.path), { type: "buffer", cellStyles: true, cellNF: true });
  assert.deepEqual(book.SheetNames, ["季度汇总", "销售明细"]);
  const summary = book.Sheets["季度汇总"], detail = book.Sheets["销售明细"];
  assert.equal(summary.B4.v, 1500); assert.equal(summary.B4.t, "n"); assert.equal(detail.C2.v + detail.C3.v + detail.C4.v, 1500);
  assert.equal(summary.C2.v, "0007"); assert.equal(summary.C2.t, "s"); assert.equal(summary.C2.z, "@");
  assert.equal(summary.D2.t, "n"); assert.equal(summary.D2.v, 46296); assert.equal(summary.D2.z, "yyyy-mm-dd");
  assert.equal(summary.B2.z, "#,##0.00"); assert.equal(summary.E2.z, "0.00%");
  assert(summary["!cols"][1].wch >= 14); assert(summary["!cols"][3].wch >= 12);
  assert.equal(summary["!autofilter"].ref, "A1:E4");
  assert.equal(receipt.verification, "values-read-back");
});

test("D08 invalid calendar dates, string numerics and cell objects fail before any successful output is created", async () => {
  for (const [name, value, format] of [["invalid-date", "2026-02-30", "date"], ["string-number", "1500", "decimal"], ["cell-object", { f: "SUM(A1:A2)" }, "general"]]) {
    const file = `${name}.xlsx`;
    await assert.rejects(createXlsxExec({ path: file, sheets: [{ name: "数据", data: [["标题"], [value]], columnFormats: [format] }] }, {}, invocation), /日期|数值|单元格/u);
    await assert.rejects(fs.access(path.join(fixture, file)), error => error.code === "ENOENT");
  }
  await assert.rejects(createDocxExec({ path: "invalid-table.docx", paragraphs: [], blocks: [{ kind: "table", headers: ["甲", "乙"], rows: [["只有一列"]] }] }, {}, invocation), /表格/u);
  await assert.rejects(fs.access(path.join(fixture, "invalid-table.docx")), error => error.code === "ENOENT");
});
