import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDocumentOutputs } from "../../src/document-outputs.js";
import { registerOutputDef, registerOutputExec } from "../../src/tools/output-registry.js";
import { PathPolicy, PathDeniedError } from "../../src/path-policy.js";
import { ToolArgumentsError } from "../../src/tool-pipeline.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-outputreg-"));
const outputDir = path.join(fixture, "成果 工作区");
await mkdir(outputDir);
const policy = new PathPolicy();
const authority = await policy.createAuthority([{ rootId: "output", role: "output", configuredPath: outputDir, permissions: ["read-file"] }]);
const invocation = { path: {
  rootIdForEnv: key => key === "OUTPUT_DIR" ? "output" : null,
  inspectFile: (input, options = {}) => policy.inspectFile(authority, { input, operation: "read-file", defaultRootId: options.defaultRootId }),
} };
test.after(async () => {
  policy.revoke(authority);
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-outputreg-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const register = async (input, kind = "deliverable") => JSON.parse(await registerOutputExec({ path: input, kind }, {}, invocation));
function toolRound(tool, receipt, id = "receipt-1") {
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: tool, arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: JSON.stringify({ status: "success", content: JSON.stringify(receipt) }) },
  ];
}

test("relative output resolves through the real gateway and survives receipt replay", async () => {
  const target = path.join(outputDir, "报告.md");
  const text = "# 成果\n实际内容";
  await writeFile(target, text);
  const receipt = await register("报告.md");
  assert.equal(receipt.path, target);
  assert.equal(receipt.bytes, Buffer.byteLength(text));
  assert.equal(receipt.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(receipt.verification, "sha256");
  assert.deepEqual(collectDocumentOutputs(toolRound("register_output", receipt)).map(o => [o.path, o.kind]), [[target, "deliverable"]]);
  await assert.rejects(() => register("missing.md"), error => error instanceof ToolArgumentsError && /不存在/u.test(error.message));
  await assert.rejects(() => register("报告.md", "guess"), ToolArgumentsError);
  await assert.rejects(() => register(path.join(fixture, "outside.md")), PathDeniedError);
});

test("large files get a bounded preview, real size and full SHA-256; actual format wins", async () => {
  const target = path.join(outputDir, "movie.mp4");
  const handle = await open(target, "w");
  await handle.write(Buffer.from("000000186674797069736f6d00000200", "hex"));
  await handle.truncate(33 * 1024 * 1024);
  await handle.close();
  const receipt = await register(target);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  assert.equal(receipt.bytes, 33 * 1024 * 1024);
  assert.equal(receipt.sha256, digest.digest("hex"));
  assert.equal(receipt.format, "mp4");
  assert.equal(receipt.verification, "sha256");
  const inspected = await invocation.path.inspectFile(target);
  assert.equal(inspected.bytes.length, 64 * 1024);
  await writeFile(path.join(outputDir, "wrong.pdf"), "plain text");
  const mismatch = await register("wrong.pdf");
  assert.equal(mismatch.format, "text");
  assert.match(mismatch.formatWarning, /内容是 text/u);
});

test("only a matched trusted registration supplies a complete receipt, latest version wins", () => {
  const receipt = { type: "artifact_registration", path: path.join(outputDir, "result.mp4"), kind: "deliverable", format: "mp4", bytes: 42, sha256: "a".repeat(64), verification: "sha256" };
  assert.equal(collectDocumentOutputs(toolRound("third_party_tool", receipt)).length, 0);
  assert.equal(collectDocumentOutputs(toolRound("register_output", { ...receipt, sha256: "bad" })).length, 0);
  assert.equal(collectDocumentOutputs(toolRound("register_output", { ...receipt, verification: "head64k" })).length, 0);
  const first = toolRound("register_output", receipt);
  const latest = toolRound("register_output", { ...receipt, sha256: "b".repeat(64), kind: "intermediate" }, "receipt-2");
  const outputs = collectDocumentOutputs([...first, ...latest]);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].sha256, "b".repeat(64));
  assert.equal(outputs[0].kind, "intermediate");
  assert.equal(collectDocumentOutputs(toolRound("create_docx", { type: "document_output", path: path.join(outputDir, "report.docx"), format: "docx" })).length, 1);
  assert.equal(registerOutputDef.function.name, "register_output");
});

test("inspection rejects a file changed during its read instead of certifying a mixed version", async () => {
  const target=path.join(outputDir,"changing.md");
  await writeFile(target,"original");
  let changed=false;
  const racing=new PathPolicy({barrier:async point=>{if(point==='afterHandleOpen'&&!changed){changed=true;await writeFile(target,'new version with a different size');}}});
  const grant=await racing.createAuthority([{rootId:'output',role:'output',configuredPath:outputDir,permissions:['read-file']}]);
  try{await assert.rejects(()=>racing.inspectFile(grant,{input:target,operation:'read-file'}),error=>error instanceof PathDeniedError&&error.code==='PATH_IDENTITY_CHANGED');}
  finally{racing.revoke(grant);}
});

test("cancelled file inspection publishes no digest", async () => {
  const target=path.join(outputDir,"cancel-inspection.md");await writeFile(target,"content");
  const controller=new AbortController();
  const aborting=new PathPolicy({barrier:point=>{if(point==='afterHandleOpen')controller.abort();}});
  const grant=await aborting.createAuthority([{rootId:'output',role:'output',configuredPath:outputDir,permissions:['read-file']}]);
  try{await assert.rejects(()=>aborting.inspectFile(grant,{input:target,operation:'read-file'},65536,controller.signal));assert.equal(controller.signal.aborted,true);}
  finally{aborting.revoke(grant);}
});
