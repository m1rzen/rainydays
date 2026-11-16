import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDocumentOutputs } from "../../src/document-outputs.js";
import { registerOutputDef, registerOutputExec } from "../../src/tools/output-registry.js";
import { PathDeniedError } from "../../src/path-policy.js";
import { ToolArgumentsError } from "../../src/tool-pipeline.js";
import { NEVER_ABORT_SIGNAL } from "../../src/run-cancellation.js";
import * as resourceOwners from "../../src/resource-owner.js";

// 2026-11-14 审阅补充切片3（成品登记）：register_output 显式登记校验授权路径、
// 存在性、实际格式与版本摘要，kind 区分交付件/中间件/原始资料；collectDocumentOutputs
// 统一派生 document_output 与 artifact_registration 两类回执，失败与伪造回执不入列表。

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-outputreg-"));
const outputDir = path.join(fixture, "output");
await mkdir(outputDir, { recursive: true });
const owner = resourceOwners.issueResourceOwner({
  authorityId: "outputreg-product", authorityEpoch: 1, sessionId: "outputreg-product",
  principal: "test", rootIds: ["output"],
});
test.after(async () => {
  await resourceOwners.retireResourceOwner(owner);
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function invocation(gateway) {
  return Object.freeze({
    capabilityContext: Object.freeze({ sessionId: "outputreg-product" }),
    path: gateway,
    network: Object.freeze({ fetch: (...args) => globalThis.fetch(...args) }),
    signal: NEVER_ABORT_SIGNAL,
    resourceOwner: owner,
  });
}

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("register_output 校验存在文件并回传格式与版本摘要；缺失路径拒绝登记", async () => {
  const pngPath = path.join(outputDir, "报告.png");
  await writeFile(pngPath, PNG_1X1);
  const receipt = JSON.parse(await registerOutputExec({ path: pngPath, kind: "deliverable", note: "最终成品" }, {}, invocation({
    rootIdForEnv: () => null,
    readFile: async () => ({ bytes: PNG_1X1, rootId: "output" }),
  })));
  assert.equal(receipt.type, "artifact_registration");
  assert.equal(receipt.kind, "deliverable");
  assert.equal(receipt.detectedFormat, "png");
  assert.equal(receipt.format, "png");
  assert.equal(receipt.bytes, PNG_1X1.length);
  assert.equal(receipt.sha256, createHash("sha256").update(PNG_1X1).digest("hex"));
  assert.equal(receipt.verification, "sha256");
  assert.equal(receipt.note, "最终成品");
  await assert.rejects(
    async () => registerOutputExec({ path: path.join(outputDir, "不存在.mp4"), kind: "deliverable" }, {}, invocation({
      rootIdForEnv: () => null,
      readFile: async () => { throw new PathDeniedError("PATH_NOT_FOUND", "enoent"); },
    })),
    error => error instanceof ToolArgumentsError && /不存在/u.test(error.message),
  );
  await assert.rejects(
    () => registerOutputExec({ path: pngPath, kind: "guess" }, {}, invocation({ rootIdForEnv: () => null })),
    ToolArgumentsError,
  );
});

test("register_output 相对路径走 OUTPUT_DIR；超限大文件降级头部校验；格式不符提示", async () => {
  const calls = [];
  const gateway = {
    rootIdForEnv: key => key === "OUTPUT_DIR" ? "output" : null,
    readFile: async (input, options) => {
      calls.push({ input, maxBytes: options.maxBytes });
      if (options.maxBytes > 64 * 1024) throw new PathDeniedError("PATH_OPERATION_DENIED", "oversize");
      return { bytes: Buffer.concat([PNG_1X1, Buffer.alloc(4096)]), rootId: "output" };
    },
  };
  const oversized = JSON.parse(await registerOutputExec({ path: "movie.mp4", kind: "deliverable" }, {}, invocation(gateway)));
  assert.equal(oversized.verification, "head64k");
  assert.equal(oversized.bytes, null);
  assert.equal(oversized.detectedFormat, "png");
  assert.match(oversized.formatWarning, /扩展名提示 mp4.*内容是 png/u);
  assert.deepEqual(calls, [
    { input: "movie.mp4", maxBytes: 32 * 1024 * 1024 },
    { input: "movie.mp4", maxBytes: 64 * 1024 },
  ]);
  // 相对路径解析使用 OUTPUT_DIR 的 rootId。
  const text = JSON.parse(await registerOutputExec({ path: "result.md", kind: "intermediate" }, {}, invocation({
    rootIdForEnv: key => key === "OUTPUT_DIR" ? "output" : null,
    readFile: async input => ({ bytes: Buffer.from("# 结果\n普通文本"), rootId: "output" }),
  })));
  assert.equal(text.detectedFormat, "text");
  assert.equal(text.kind, "intermediate");
  assert.equal(text.formatWarning, undefined);
});

function toolRound(calls) {
  const messages = [];
  for (const [tool, id, receipt] of calls) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: tool, arguments: "{}" } }], created_at: "2026-11-16T00:00:00Z" });
    messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ status: "success", content: JSON.stringify(receipt) }), created_at: "2026-11-16T00:00:01Z" });
  }
  return messages;
}

test("collectDocumentOutputs 统一派生文档回执与成品登记，失败与伪造回执不入列表", () => {
  const messages = toolRound([
    ["create_docx", "d1", { type: "document_output", format: "docx", path: path.join(outputDir, "周报.docx") }],
    ["register_output", "r1", { type: "artifact_registration", path: path.join(outputDir, "merge.mp4"), kind: "deliverable", format: "mp4", bytes: 1024, sha256: "a".repeat(64), verification: "sha256" }],
    ["register_output", "r2", { type: "artifact_registration", path: path.join(outputDir, "chunks"), kind: "intermediate", format: "unknown", verification: "head64k" }],
    // 失败回执与助手散文不入列表。
    ["register_output", "r3", { status: "error", content: "登记失败" }],
    ["execute_command", "x1", { status: "success", content: "下载完成 1.26GB" }],
  ]);
  messages.push({ role: "assistant", content: "我生成了 fake_result.mp4（散文里的路径不是产物）" });
  const outputs = collectDocumentOutputs(messages);
  // 派生列表最新优先（reverse 语义）。
  assert.deepEqual(outputs.map(output => [output.kind, output.name]), [
    ["intermediate", "chunks"],
    ["deliverable", "merge.mp4"],
    ["document", "周报.docx"],
  ]);
  assert.equal(outputs.find(output => output.name === "merge.mp4").sha256, "a".repeat(64));
  assert.equal(outputs.find(output => output.name === "merge.mp4").bytes, 1024);
  assert.equal(outputs.find(output => output.name === "chunks").bytes, undefined);
  assert.equal(outputs.some(output => output.name.includes("fake_result")), false);
  // 同一路径重复登记只保留最新版本。
  const again = toolRound([
    ["register_output", "r4", { type: "artifact_registration", path: path.join(outputDir, "merge.mp4"), kind: "deliverable", format: "mp4", bytes: 2048, sha256: "b".repeat(64), verification: "sha256" }],
  ]);
  const updated = collectDocumentOutputs([...messages, ...again]);
  const versions = updated.filter(output => output.name === "merge.mp4");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].sha256, "b".repeat(64));
  assert.equal(registerOutputDef.function.name, "register_output");
});
