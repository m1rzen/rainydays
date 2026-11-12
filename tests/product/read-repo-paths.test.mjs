import assert from "node:assert/strict";
import test from "node:test";
const { safePath } = await import("../../src/tools/read-repo.ts");

test("read_repo paths stay copyable: ordinary punctuation, Windows separators and CJK names are not encoded", () => {
  const root = "C:/Users/raidriar/AppData/Local/Temp/claude/44de2a9f-cf00-43ad-95f9-efcec2979e74/eval-1112/projects/P05";
  assert.equal(safePath(root), root, "a GUID with hyphens survives unchanged, so a model cannot misread %2De as -de");
  const windows = String.raw`C:\work\my_app\src\main.test.ts`;
  assert.equal(safePath(windows), windows);
  assert.equal(safePath("资料/第三季度报告(定稿)+附录.docx"), "资料/第三季度报告(定稿)+附录.docx");
});

test("read_repo paths still cannot forge Markdown, fences or extra lines", () => {
  assert.equal(safePath("# `FORGED`.md"), "%23%20%60FORGED%60.md");
  assert.equal(safePath("a\nb*c<d>|e%f\"g'h"), "a%0Ab%2Ac%3Cd%3E%7Ce%25f%22g%27h");
  const encoded = safePath("x\u202Ey\u0000z");
  assert.equal(encoded, "x%E2%80%AEy%00z", "bidi overrides and NUL are encoded");
});
