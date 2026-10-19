import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getMessagesBySession } from "../db.js";
import { throwIfCancelled } from "../run-cancellation.js";
import { createToolOutcome, ToolArgumentsError } from "../tool-pipeline.js";
import type { ToolDefinition, ToolExecutor, ToolExecutionOutcome, ToolInvocationServices } from "../types.js";

const MAX_FILE_BYTES = 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Patch { offset: number; removed: string; inserted: string }
interface Change { path: string; status: "not_started" | "written" | "conflict" | "failed"; beforeRevision: string; afterRevision?: string; patches: Patch[]; diff: string; message?: string }
interface Receipt { type: "code_changes"; changeId: string; status: "complete" | "blocked" | "partial" | "cancelled"; changes: Change[]; undoOf?: string }
interface Plan { change: Change; output: Buffer }

const editsSchema = { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: { old_string: { type: "string", minLength: 1 }, new_string: { type: "string" } }, required: ["old_string", "new_string"] } };
export const editFilesDef: ToolDefinition = { type: "function", function: {
  name: "edit_files", description: "按read返回的字节版本，一批精确修改最多8个已有UTF-8项目文件。保留用户改动；冲突先重读。返回每个文件的实际状态、片段差异与可撤回记录。新文件用write创建。",
  parameters: { type: "object", properties: { files: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { file_path: { type: "string", description: "已授权项目中的绝对路径" }, expected_revision: { type: "string", pattern: "^[a-f0-9]{64}$", description: "read返回的原始字节版本" }, edits: editsSchema }, required: ["file_path", "expected_revision", "edits"] } } }, required: ["files"] },
} };
export const undoEditsDef: ToolDefinition = { type: "function", function: {
  name: "undo_edits", description: "撤回本会话edit_files的已完成片段；必须仍与该次保存后的版本一致。有任何外部修改则停止并保留，不能用Git reset。重启后仍可引用changeId。",
  parameters: { type: "object", properties: { change_id: { type: "string", description: "真实代码变更回执的changeId" } }, required: ["change_id"] },
} };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolArgumentsError("编辑条目必须是对象");
  return value as Record<string, unknown>;
}
function text(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ToolArgumentsError("项目编辑不支持二进制文件");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ToolArgumentsError("项目编辑只支持UTF-8；请保留原编码并另行转换"); }
}
function diff(patches: Patch[]): string {
  return patches.map((patch, index) => `@@ 片段 ${index+1} @@\n${patch.removed.split("\n").map(line=>`-${line}`).join("\n")}\n${patch.inserted.split("\n").map(line=>`+${line}`).join("\n")}`).join("\n");
}
function requireInvocation(invocation?: ToolInvocationServices): ToolInvocationServices {
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  return invocation;
}
function newReceipt(undoOf?: string): Receipt { return { type: "code_changes", changeId: randomUUID(), status: "blocked", changes: [], ...(undoOf ? { undoOf } : {}) }; }
function assertReceiptFits(receipt: Receipt): void {
  const reserve = { ...receipt, changes: receipt.changes.map(change=>({ ...change, status: "written", afterRevision: "0".repeat(64), message: "\0".repeat(512) })) };
  if (createToolOutcome("success", JSON.stringify(reserve)).truncated) throw new ToolArgumentsError("本批差异过大；请拆成更小的精确修改，尚未写入文件");
}

async function commitPlans(receipt: Receipt, plans: Plan[], invocation: ToolInvocationServices): Promise<string> {
  assertReceiptFits(receipt);
  if (receipt.changes.some(change=>change.status !== "not_started")) return JSON.stringify(receipt);
  for (const plan of plans) {
    if (invocation.signal.aborted) { receipt.status = "cancelled"; break; }
    try {
      const result = await invocation.path.replaceFile(plan.change.path, current => {
        throwIfCancelled(invocation.signal);
        if (hash(current) !== plan.change.beforeRevision) return { bytes: null, value: false };
        return { bytes: plan.output, value: true };
      }, { maxBytes: MAX_FILE_BYTES });
      if (!result.value) { plan.change.status = "conflict"; plan.change.message = "文件已被修改，未覆盖；请重新读取并合并。"; break; }
      plan.change.status = "written";
      plan.change.afterRevision = hash(plan.output);
    } catch (error) {
      plan.change.status = "failed";
      plan.change.message = error instanceof Error ? error.message.slice(0, 400) : "保存失败，后续文件尚未执行。";
      if (invocation.signal.aborted) receipt.status = "cancelled";
      break;
    }
  }
  if (receipt.status !== "cancelled") receipt.status = receipt.changes.every(change=>change.status === "written") ? "complete" : receipt.changes.some(change=>change.status === "written") ? "partial" : "blocked";
  return JSON.stringify(receipt);
}

export const editFilesExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > 8) throw new ToolArgumentsError("每批编辑1至8个文件");
  const receipt = newReceipt(), plans: Plan[] = [], seen = new Set<string>();
  let patchBytes = 0;
  for (const value of args.files) {
    throwIfCancelled(invocation.signal);
    const file = object(value);
    if (typeof file.file_path !== "string" || !path.isAbsolute(file.file_path) || typeof file.expected_revision !== "string" || !/^[a-f0-9]{64}$/u.test(file.expected_revision) || !Array.isArray(file.edits) || !file.edits.length || file.edits.length > 16) throw new ToolArgumentsError("需要绝对路径、read版本及1至16项精确替换");
    const key = process.platform === "win32" ? path.normalize(file.file_path).toLowerCase() : path.normalize(file.file_path);
    if (seen.has(key)) throw new ToolArgumentsError("同一批不能重复指定同一文件；请合并其替换项"); seen.add(key);
    const change: Change = { path: file.file_path, beforeRevision: file.expected_revision, status: "not_started", patches: [], diff: "" };
    receipt.changes.push(change);
    try {
      const current = await invocation.path.readFile(change.path, { maxBytes: MAX_FILE_BYTES });
      if (hash(current.bytes) !== change.beforeRevision) { change.status = "conflict"; change.message = "读取后文件已变；本批尚未写入，请重新读取并合并。"; continue; }
      let output = text(current.bytes);
      for (const raw of file.edits) {
        const edit = object(raw);
        if (typeof edit.old_string !== "string" || !edit.old_string || typeof edit.new_string !== "string" || edit.new_string.includes("\0")) throw new ToolArgumentsError("原片段不能为空，新片段必须是文本且不含NUL");
        const offset = output.indexOf(edit.old_string);
        if (offset < 0 || output.indexOf(edit.old_string, offset + edit.old_string.length) >= 0) throw new ToolArgumentsError("原片段必须恰好出现一次；请重新读取并给出唯一上下文");
        patchBytes += Buffer.byteLength(edit.old_string) + Buffer.byteLength(edit.new_string);
        if (patchBytes > 24 * 1024) throw new ToolArgumentsError("本批修改片段超过24KiB；请分批处理");
        change.patches.push({ offset, removed: edit.old_string, inserted: edit.new_string });
        output = output.slice(0, offset) + edit.new_string + output.slice(offset + edit.old_string.length);
      }
      const bytes = Buffer.from(output, "utf8");
      if (bytes.length > MAX_FILE_BYTES) throw new ToolArgumentsError("项目编辑结果超过1MiB；请缩小修改范围");
      change.diff = diff(change.patches);
      plans.push({ change, output: bytes });
    } catch (error) { if (invocation.signal.aborted) throw error; change.status = "failed"; change.message = error instanceof Error ? error.message.slice(0, 400) : "预检失败"; }
  }
  return commitPlans(receipt, plans, invocation);
};

function findReceipt(sessionId: string, changeId: string): Receipt {
  const calls = new Map<string, string>();
  for (const row of getMessagesBySession(sessionId)) {
    if (row.role === "assistant") {
      calls.clear();
      try { for (const call of JSON.parse(row.tool_calls || "[]")) calls.set(call.id, call.function.name); } catch { /* Malformed legacy messages are not edit receipts. */ }
    }
    if (row.role !== "tool" || !row.tool_call_id || !["edit_files", "undo_edits"].includes(calls.get(row.tool_call_id) || "")) continue;
    calls.delete(row.tool_call_id);
    try {
      const outcome = JSON.parse(row.content), receipt: Receipt = JSON.parse(outcome.content);
      if (!outcome.truncated && receipt.type === "code_changes" && receipt.changeId === changeId && Array.isArray(receipt.changes) && receipt.changes.length <= 8) return receipt;
    } catch { /* Other tool text cannot provide an undo source. */ }
  }
  throw new ToolArgumentsError("当前会话没有这项真实代码修改记录；不能撤回其他会话的修改");
}

export const undoEditsExec: ToolExecutor = async (args, _env, invocationValue) => {
  const invocation = requireInvocation(invocationValue);
  if (typeof args.change_id !== "string" || !/^[a-f0-9-]{36}$/u.test(args.change_id)) throw new ToolArgumentsError("需要真实修改回执的changeId");
  const source = findReceipt(invocation.capabilityContext.sessionId, args.change_id), receipt = newReceipt(source.changeId), plans: Plan[] = [];
  for (const saved of source.changes.filter(change=>change.status === "written")) {
    throwIfCancelled(invocation.signal);
    if (!path.isAbsolute(saved.path) || !saved.afterRevision || !/^[a-f0-9]{64}$/u.test(saved.afterRevision) || !Array.isArray(saved.patches) || saved.patches.length > 16) throw new ToolArgumentsError("历史修改回执不完整，不能安全撤回");
    const change: Change = { path: saved.path, beforeRevision: saved.afterRevision, status: "not_started", patches: [], diff: "" }; receipt.changes.push(change);
    try {
      const current = await invocation.path.readFile(saved.path, { maxBytes: MAX_FILE_BYTES });
      if (hash(current.bytes) !== saved.afterRevision) { change.status = "conflict"; change.message = "修改后文件已被外部保存，尚未撤回；请保留并人工合并。"; continue; }
      let output = text(current.bytes);
      for (const patch of [...saved.patches].reverse()) {
        if (!Number.isSafeInteger(patch.offset) || patch.offset < 0 || typeof patch.removed !== "string" || typeof patch.inserted !== "string" || output.slice(patch.offset, patch.offset + patch.inserted.length) !== patch.inserted) throw new ToolArgumentsError("修改片段与回执不一致，不能撤回");
        change.patches.push({ offset: patch.offset, removed: patch.inserted, inserted: patch.removed });
        output = output.slice(0, patch.offset) + patch.removed + output.slice(patch.offset + patch.inserted.length);
      }
      const bytes = Buffer.from(output, "utf8");
      if (hash(bytes) !== saved.beforeRevision) throw new ToolArgumentsError("撤回结果与原版本不一致，未写入");
      change.diff = diff(change.patches); plans.push({ change, output: bytes });
    } catch (error) { if (invocation.signal.aborted) throw error; change.status = "failed"; change.message = error instanceof Error ? error.message.slice(0, 400) : "撤回预检失败"; }
  }
  if (!receipt.changes.length) throw new ToolArgumentsError("这组记录没有可撤回的已完成修改");
  return commitPlans(receipt, plans, invocation);
};

export function describeCodeEditOperation(name: string, args: Readonly<Record<string, unknown>>, sessionId: string): string | null {
  if (name === "edit_files" && Array.isArray(args.files)) return `准备按已读取版本修改以下项目文件：\n${args.files.map(value=>String(object(value).file_path)).join("\n")}\n\n保留用户已有内容；发生版本冲突时停止。本次确认仅限这一批修改。`;
  if (name === "undo_edits" && typeof args.change_id === "string") return `准备撤回以下文件中本次已完成的修改：\n${findReceipt(sessionId, args.change_id).changes.filter(change=>change.status === "written").map(change=>change.path).join("\n")}\n\n后续被外部修改的文件将保留并报告冲突。`;
  return null;
}

/** Only this host adapter's structured receipt controls its outcome; arbitrary tool JSON cannot. */
export function codeEditingOutcome(content: string): ToolExecutionOutcome {
  const receipt: Receipt = JSON.parse(content);
  return createToolOutcome(receipt.status === "complete" ? "success" : receipt.status === "cancelled" ? "cancelled" : "error", content, receipt.status === "complete" ? null : receipt.status === "cancelled" ? "RUN_CANCELLED" : "CODE_EDIT_INCOMPLETE");
}
