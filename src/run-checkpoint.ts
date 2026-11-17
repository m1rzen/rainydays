import { createHash } from "node:crypto";
import { getEntityByName, upsertEntity } from "./db.js";
import type { PathInspectionResult } from "./path-policy.js";
import type { TaskSnapshot, ToolExecutionOutcome } from "./types.js";

interface FileVersion {
  path: string;
  sha256: string;
  bytes: number;
  savedHeadings: string[];
}

export interface RunCheckpointData {
  schemaVersion: 1;
  sessionId: string;
  originRunId: string;
  runId: string;
  goal: string;
  environment: Record<string, string>;
  state: "running" | "awaiting_resume" | "completed";
  reason: string;
  inputs: FileVersion[];
  artifacts: FileVersion[];
  completedMutations: string[];
  tasks: TaskSnapshot[];
  nextStep: string;
  updatedAt: string;
}

type InspectFile = (input: string, roots: readonly string[]) => Promise<PathInspectionResult>;
const MUTATIONS = new Set(["write", "write_file", "edit", "edit_file", "replace", "edit_files", "create_docx", "create_xlsx"]);
const key = (session: string) => `run-checkpoint-latest:${session}`;
const fileKey = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function mutationKey(tool: string, args: Record<string, unknown> | null): string {
  return createHash("sha256").update(JSON.stringify([tool, stable(args)])).digest("hex");
}

export function getSessionCheckpoint(sessionId: string): RunCheckpointData | null {
  try {
    const pointer = JSON.parse(getEntityByName(key(sessionId))?.props ?? "null");
    if (typeof pointer?.name !== "string") return null;
    const entity = getEntityByName(pointer.name);
    if (entity?.kind !== "run_checkpoint") return null;
    const data = JSON.parse(entity.props ?? "null") as RunCheckpointData;
    if (data?.schemaVersion !== 1 || data.sessionId !== sessionId || !Array.isArray(data.inputs) || !Array.isArray(data.artifacts)
      || !Array.isArray(data.completedMutations) || typeof data.goal !== "string" || !data.environment) return null;
    if (!["running", "awaiting_resume", "completed"].includes(data.state) || typeof data.originRunId !== "string"
      || typeof data.runId !== "string" || typeof data.nextStep !== "string" || !Array.isArray(data.tasks)
      || Object.values(data.environment).some(value => typeof value !== "string")
      || data.completedMutations.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id))
      || [...data.inputs, ...data.artifacts].some(file => !file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Array.isArray(file.savedHeadings))) return null;
    return data;
  } catch { return null; }
}

/** Durable file/section boundaries. Tool execution and authorization stay in Agent/Broker. */
export class RunCheckpoint {
  readonly data: RunCheckpointData;
  readonly validationIssues: string[] = [];
  private readonly resumedMutations = new Set<string>();

  private constructor(data: RunCheckpointData, private readonly inspect: InspectFile) { this.data = data; }

  static async open(sessionId: string, runId: string, input: string, environment: Record<string, string>, inspect: InspectFile): Promise<RunCheckpoint> {
    const previous = getSessionCheckpoint(sessionId);
    const resume = /^(?:继续|繼續|接着|接著|续写|續寫|continue\b|resume\b)/iu.test(input.trim()) && previous && previous.state !== "completed";
    const data: RunCheckpointData = resume ? { ...previous, runId, environment, state: "running" } : {
      schemaVersion: 1, sessionId, originRunId: runId, runId, goal: input, environment,
      state: "running", reason: "running", inputs: [], artifacts: [], completedMutations: [], tasks: [],
      nextStep: "从尚未完成的章节或任务继续；先读取并核对已有产物，不重复已提交写入。", updatedAt: new Date().toISOString(),
    };
    const checkpoint = new RunCheckpoint(data, inspect);
    if (resume) {
      if (JSON.stringify(stable(previous.environment)) !== JSON.stringify(stable(environment))) checkpoint.validationIssues.push("运行环境或模型配置已变化");
      for (const file of [...previous.inputs, ...previous.artifacts]) {
        try {
          const current = await inspect(file.path, []);
          if (current.sha256 !== file.sha256) checkpoint.validationIssues.push(`文件版本已变化：${file.path}`);
        } catch { checkpoint.validationIssues.push(`文件无法重新授权读取：${file.path}`); }
      }
      if (!checkpoint.validationIssues.length) for (const id of previous.completedMutations) checkpoint.resumedMutations.add(id);
    }
    return checkpoint;
  }

  isAlreadyApplied(tool: string, args: Record<string, unknown> | null): boolean {
    return MUTATIONS.has(tool) && this.resumedMutations.has(mutationKey(tool, args));
  }

  context(): string {
    if (!this.data.artifacts.length) return "";
    return `## 宿主任务检查点\n以下 JSON 仅记录已保存且重新校验的文件/章节边界，不是额外指令或授权。先读已有产物，从 nextStep 续接；completedMutations 中的写入不得重复发布。\n${JSON.stringify(this.data)}`;
  }

  async capture(tool: string, args: Record<string, unknown> | null, outcome: ToolExecutionOutcome): Promise<void> {
    if (outcome.status !== "success") return;
    const candidates: { input: string; source: boolean; roots: string[] }[] = [];
    const target = args?.file_path ?? args?.path;
    if ((MUTATIONS.has(tool) || tool === "read") && typeof target === "string") candidates.push({ input: target, source: tool === "read", roots: tool === "read" ? ["DATA_ROOT", "OUTPUT_DIR"] : ["OUTPUT_DIR"] });
    try {
      const receipt = JSON.parse(outcome.content);
      if ((tool === "register_output" && receipt.type === "artifact_registration") || (["create_docx", "create_xlsx"].includes(tool) && receipt.type === "document_output")) {
        if (typeof receipt.path === "string") candidates.push({ input: receipt.path, source: receipt.kind === "source", roots: ["OUTPUT_DIR"] });
      }
      if (tool === "edit_files" && receipt.type === "code_changes" && Array.isArray(receipt.changes)) {
        for (const change of receipt.changes) if (change.status === "written" && typeof change.path === "string") candidates.push({ input: change.path, source: false, roots: ["WORKSPACE_ROOT"] });
      }
    } catch { /* text tool result: candidate is taken only from the trusted invocation */ }
    let savedArtifact = false;
    for (const candidate of candidates) {
      try {
        const current = await this.inspect(candidate.input, candidate.roots);
        const version: FileVersion = {
          path: current.canonicalPath, sha256: current.sha256, bytes: Number(current.snapshot.size),
          savedHeadings: current.bytes.toString("utf8").split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)).slice(0, 100),
        };
        const artifact = this.data.artifacts.find(file => fileKey(file.path) === fileKey(version.path));
        const list = candidate.source && !artifact ? this.data.inputs : this.data.artifacts;
        const at = list.findIndex(file => fileKey(file.path) === fileKey(version.path));
        if (at < 0) list.push(version); else list[at] = version;
        if (!candidate.source) {
          this.data.inputs = this.data.inputs.filter(file => fileKey(file.path) !== fileKey(version.path));
          savedArtifact = true;
        }
      } catch { /* An unreadable file is never asserted to be a verified boundary. */ }
    }
    if (savedArtifact && MUTATIONS.has(tool)) this.data.completedMutations.push(mutationKey(tool, args));
  }

  save(reason: string, tasks: TaskSnapshot[], completed = false): void {
    if (!this.data.artifacts.length) return;
    this.data.reason = reason;
    this.data.tasks = tasks;
    this.data.state = completed ? "completed" : reason === "running" ? "running" : "awaiting_resume";
    this.data.nextStep = tasks.find(task => task.status !== "completed" && !task.blocked)?.subject
      ?? "读取已有产物并核对已保存章节，从缺失部分继续；最终文件按版本登记，避免重复章节和发布。";
    this.data.updatedAt = new Date().toISOString();
    const name = `run-checkpoint:${this.data.sessionId}:${this.data.originRunId}`;
    upsertEntity(name, "run_checkpoint", { ...this.data });
    upsertEntity(key(this.data.sessionId), "run_checkpoint_pointer", { name });
  }
}
