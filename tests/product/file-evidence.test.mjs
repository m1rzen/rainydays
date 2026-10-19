import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as XLSXModule from "xlsx";
import { parseFileBuffer } from "../../src/tools/parsers.ts";
const XLSX = XLSXModule.default ?? XLSXModule;
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-file-evidence-")), workspace = path.join(fixture, "资料"), appRoot = path.resolve(import.meta.dirname, "../..");
await fs.mkdir(workspace);
Object.assign(process.env, { RAINYDAYS_APP_ROOT: appRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json") });
const [{ capabilityBroker, executeTool }, { pathPolicy }, { createEffectivePersona }, sessions, { ConversationMemory }, store, { closeDb, listMessageAttachments }] = await Promise.all([
  import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/persona.ts"), import("../../src/session.ts"), import("../../src/memory.ts"), import("../../src/attachment-store.ts"), import("../../src/db.ts"),
]);
const persona = createEffectivePersona({ name: "evidence", displayName: "Evidence", description: "fixture", permissionLevel: "read_only", tools: ["read"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace], networkPolicy: { mode: "deny" }, systemPrompt: "fixture" });
const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["read-file", "read-directory"] }]) });
test.after(async () => { await capabilityBroker.retireAuthority(authority); await closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-file-evidence-")); await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function scenario(work) {
  const session = sessions.createSession(persona, "资料依据"), root = capabilityBroker.beginAgentRun(authority, session.id);
  try { return await work({ session, read: args => executeTool(root, "read", args) }); }
  finally { capabilityBroker.finishContext(root); }
}
function attach(session, name, mime, bytes) {
  const draft = store.reserveAttachment(session.id, { name, mime, size: bytes.length }), attachment = store.completeAttachment(session.id, draft.id, bytes);
  const memory = new ConversationMemory(); memory.setSessionId(session.id); memory.add({ role: "user", content: "核对原文与位置", attachments: [attachment] }); return attachment;
}
function thirtyPagePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"], kids = [];
  for (let page = 1; page <= 30; page++) {
    const id = objects.length + 1; kids.push(`${id} 0 R`);
    const text = `PAGE_${page}${page === 17 ? " DEADLINE_2026_11_25 OWNER_ALICE" : " ordinary reference"}`;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count 30 /Kids [${kids.join(" ")}] >>`;
  let pdf = "%PDF-1.4\n", offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function spreadsheetBytes() {
  const sheet = XLSX.utils.aoa_to_sheet([["地区", "销售额", "备注", "日期"], ["东部", 1200, "0007"], ["西部", 300]]);
  sheet.D2 = { t: "n", v: 46296, z: "yyyy-mm-dd" }; // Excel date 2026-10-01, independent of host timezone
  sheet.B4 = { t: "n", f: "SUM(B2:B3)", v: 1500 };
  sheet.C4 = { t: "n", f: "B4*0.1" }; sheet["!ref"] = "A1:D4";
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "区域 销售");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["地区", "目标"], ["东部", 900]]), "目标");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

test("D06 spreadsheet evidence preserves source coordinates and distinguishes formulas, saved caches, dates and text", async () => {
  const bytes = spreadsheetBytes();
  const result = await parseFileBuffer("销售.xlsx", bytes, { includeEvidence: true });
  assert.equal(result.success, true);
  assert(result.locations.some(location => location.label.includes("区域 销售") && location.label.includes("A2:D2")));
  assert(result.locations.some(location => location.label.includes("目标") && location.label.includes("A2:B2")));
  const row = result.locations.find(location => location.label.includes("区域 销售") && location.label.includes("A2:D2"));
  assert.match(result.text.split(/\r?\n/u).slice(row.startLine - 1, row.endLine).join("\n"), /B2.*数值.*1200/u);
  assert.match(result.text, /B2.*数值.*1200/u); assert.match(result.text, /C2.*文本.*0007/u);
  assert.match(result.text, /D2.*日期.*2026-10-01/u);
  assert.match(result.text, /B4.*公式.*SUM\(B2:B3\).*已保存缓存.*1500/u);
  assert.match(result.text, /C4.*公式.*B4\*0\.1.*无缓存/u);
  assert.match(result.warnings.join("\n"), /未重算/u);
  const preview = await parseFileBuffer("销售.xlsx", bytes);
  assert.match(preview.text, /【工作表: 区域 销售】/u); // existing preview projection remains usable
});

test("D06 public file and attachment reads select the real seventeenth PDF page and disclose incomplete ranges", async () => scenario(async ({ session, read }) => {
  const bytes = thirtyPagePdf(), file = path.join(workspace, "三十页资料.pdf"); await fs.writeFile(file, bytes);
  const first = await read({ file_path: file });
  assert.match(first, /PDF: 30 页/u); assert.match(first, /下一页 offset=/u); assert.doesNotMatch(first, /DEADLINE_2026/u);
  const selected = await read({ file_path: file, pages: "17" });
  assert.match(selected, /\[PDF 第 17 页\]/u); assert.match(selected, /DEADLINE_2026_11_25 OWNER_ALICE/u); assert.doesNotMatch(selected, /PAGE_16\b|PAGE_18\b/u);
  const attachment = attach(session, "三十页附件.pdf", "application/pdf", bytes);
  const attached = await read({ file_path: `attachment:${attachment.id}`, pages: "17" });
  assert.match(attached, /来源: 三十页附件.pdf/u); assert.match(attached, /\[PDF 第 17 页\].*DEADLINE_2026/u);
  await assert.rejects(read({ file_path: `attachment:${attachment.id}`, pages: "31" }), /超出 PDF 范围/u);
}));

test("D06 two conflicting Word files keep their own extract paragraph references", async () => scenario(async ({ read }) => {
  const { createDocxExec } = await import("../../src/tools/writer.ts");
  for (const [name, date, count] of [["方案甲", "2026-11-01", 20], ["方案乙", "2026-11-03", 25]]) {
    let bytes;
    await createDocxExec({ path: `${name}.docx`, title: name, paragraphs: [`活动日期 ${date}；参与人数 ${count} 人。`] }, {}, { signal: new AbortController().signal, path: { rootIdForEnv: () => "output", reserveFile: async () => ({ commit: async value => { bytes = value; } }) } });
    const file = path.join(workspace, `${name}.docx`); await fs.writeFile(file, bytes);
    const content = await read({ file_path: file });
    assert(content.includes(file)); assert.match(content, new RegExp(`\\[提取段落 2\\].*${date}.*${count}`, "u"));
    assert.match(content, /不是 Word 物理页码/u);
  }
}));

test("D06 long single-line text pages retain the exact middle quote and do not change code physical lines", async () => scenario(async ({ read }) => {
  const text = "🙂前文".repeat(2500) + "中段编号_MIDDLE_04567：原句需要保留。" + "后文".repeat(8000), file = path.join(workspace, "长单行.md"); await fs.writeFile(file, text);
  let offset = 1, whole = "", sawLocation = false;
  for (let pages = 0; pages < 20; pages++) {
    const content = await read({ file_path: file, offset, limit: 12 });
    assert(Buffer.byteLength(content) < 128 * 1024); assert.match(content, /原文第 1 行；分段/u);
    whole += content; if (content.includes("MIDDLE_04567")) sawLocation = true;
    const next = /下一页 offset=(\d+)/u.exec(content); if (!next) break; assert(Number(next[1]) > offset); offset = Number(next[1]);
  }
  assert(sawLocation); assert.equal((whole.match(/🙂/gu) ?? []).length, 2500); assert.equal((whole.match(/MIDDLE_04567/gu) ?? []).length, 1);
  const code = path.join(workspace, "physical.ts"); await fs.writeFile(code, "//" + "x".repeat(1000) + "\nconst second=2;\n");
  assert.match(await read({ file_path: code, offset: 2, limit: 1 }), /2 \| const second=2;/u);
}));

test("D06 valid data remains readable when companion documents are scanned or corrupt", async () => scenario(async ({ session, read }) => {
  const original = await fs.readFile(new URL("../fixtures/tool02-two-pages.pdf", import.meta.url));
  const scanned = Buffer.from(original.toString("latin1").replace(/\/Contents \d+ 0 R/gu, value => " ".repeat(value.length)), "latin1");
  const files = [["有效.pdf", original], ["扫描.pdf", scanned], ["损坏.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("broken-zip-directory")])]];
  const handles = files.map(([name, bytes]) => attach(session, name, name.endsWith("pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes));
  const results = await Promise.allSettled(handles.map(attachment => read({ file_path: `attachment:${attachment.id}` })));
  assert.equal(results[0].status, "fulfilled"); assert.match(results[0].value, /FIRST_PAGE/u);
  assert.equal(results[1].status, "rejected"); assert.match(results[1].reason.message, /扫描件/u);
  assert.equal(results[2].status, "rejected"); assert.match(results[2].reason.message, /解析失败/u);
}));

test("D06 compaction, an old conversation fork and a new process retain spreadsheet and middle-text evidence with scoped identities", async () => {
  const bytes = spreadsheetBytes();
  const textBytes = Buffer.from("前言".repeat(4000) + "中段编号_RESTART_04567：预算只适用于十一月。" + "余文".repeat(4000) + "\n|编号|金额|\n|---|---|\n" + Array.from({ length: 200 }, (_, index) => `|TABLE_${index}|${index * 10}|`).join("\n"));
  const source = await scenario(async ({ session, read }) => {
    const attachment = attach(session, "分支销售.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes);
    const textAttachment = attach(session, "长表格.md", "text/markdown", textBytes);
    const content = await read({ file_path: `attachment:${attachment.id}` }); assert.match(content, /C4.*无缓存/u); assert.match(content, /区域 销售.*A2:D2/u);
    const middle = await read({ file_path: `attachment:${textAttachment.id}`, offset: 17, limit: 2 }); assert.match(middle, /中段编号_RESTART_04567：预算只适用于十一月。/u);
    const memory = new ConversationMemory(8); memory.loadFromDb(session.id);
    memory.addMany(Array.from({ length: 18 }, () => ({ role: "assistant", content: "旧讨论".repeat(2000) })));
    memory.add({ role: "user", content: "请重新核对中段原句及表格最后一行" });
    assert.equal(await memory.compact({ chat: async () => ({ role: "assistant", content: "讨论已整理，事实应重新读取原始附件。" }) }), true);
    const keptIds = memory.getAll().flatMap(message => message.attachments?.map(item => item.id) ?? []);
    assert(keptIds.includes(attachment.id)); assert(keptIds.includes(textAttachment.id));
    assert.doesNotMatch(JSON.stringify(memory.getAll()), /预算只适用于十一月/u);
    assert.match(await read({ file_path: `attachment:${textAttachment.id}`, offset: 17, limit: 2 }), /中段编号_RESTART_04567：预算只适用于十一月。/u);
    return { session, attachment, textAttachment };
  });
  const updatedPersona = createEffectivePersona({ ...persona, systemPrompt: "updated reader definition" });
  const fork = sessions.forkSession(source.session.id, null, updatedPersona), attachments = listMessageAttachments(fork.id);
  const attachment = attachments.find(item => item.name === "分支销售.xlsx"), textAttachment = attachments.find(item => item.name === "长表格.md");
  assert(attachment); assert.notEqual(attachment.id, source.attachment.id);
  assert(textAttachment); assert.notEqual(textAttachment.id, source.textAttachment.id);
  assert.deepEqual(store.readMessageAttachmentForSession(fork.id, attachment.id).bytes, bytes);
  assert.throws(() => store.readMessageAttachmentForSession(fork.id, source.attachment.id), error => error.code === "ATTACHMENT_NOT_FOUND");
  assert.throws(() => store.readMessageAttachmentForSession(fork.id, source.textAttachment.id), error => error.code === "ATTACHMENT_NOT_FOUND");
  await closeDb();
  const requests = [{ id: attachment.id }, { id: textAttachment.id, offset: 17 }, { id: textAttachment.id, offset: 230 }];
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/read-document-evidence.mjs", fork.id, JSON.stringify(requests)], { cwd: appRoot, env: { ...process.env }, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  const line = output.split(/\r?\n/u).find(value => value.startsWith("D06_RESULT:")); assert(line, output);
  const result = JSON.parse(line.slice("D06_RESULT:".length)), [restarted, restartedText, restartedTable] = result.documents;
  assert.deepEqual(new Set(result.attachmentIds), new Set([attachment.id, textAttachment.id]));
  assert.equal(restarted.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(restarted.content, /来源: 分支销售.xlsx/u); assert.match(restarted.content, /区域 销售.*A2:D2/u); assert.match(restarted.content, /C4.*无缓存/u); assert.match(restarted.content, /未重算/u);
  assert.equal(restartedText.sha256, createHash("sha256").update(textBytes).digest("hex"));
  assert.match(restartedText.content, /中段编号_RESTART_04567：预算只适用于十一月。/u);
  assert.match(restartedTable.content, /TABLE_199\|1990/u); assert.match(restartedTable.content, /已到末尾/u);
});
