import path from "node:path";
import { throwIfCancelled } from "../run-cancellation.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { workerRegistry } from "../worker.js";

const noExtra = { additionalProperties: false } as const;

function sessionId(invocation?: ToolInvocationServices): string {
  const value = invocation?.capabilityContext.sessionId;
  if (!value) throw new Error("Worker tools require a Session identity");
  return value;
}
function json(value: unknown): string { return JSON.stringify(value, null, 2); }

export const workerListDef: ToolDefinition = { type: "function", function: { name: "worker_list", description: "List local and attached Workers with status and current Session selection.", parameters: { type: "object", properties: {}, ...noExtra } } };
export const workerListExec: ToolExecutor = async (_args, _env, invocation) => json(await workerRegistry.list(sessionId(invocation)));

export const workerStatusDef: ToolDefinition = { type: "function", function: { name: "worker_status", description: "Get selected or named Worker status. Disconnected remote Workers never fall back locally.", parameters: { type: "object", properties: { workerId: { type: "string" } }, ...noExtra } } };
export const workerStatusExec: ToolExecutor = async (args, _env, invocation) => json(await workerRegistry.status(sessionId(invocation), args.workerId as string | undefined));

export const workerSelectDef: ToolDefinition = { type: "function", function: { name: "worker_select", description: "Select an online Worker for this Session's routed tools.", parameters: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"], ...noExtra } } };
export const workerSelectExec: ToolExecutor = async (args, _env, invocation) => json(await workerRegistry.select(sessionId(invocation), args.workerId as string));

export const workerConnectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "worker_connect",
    description: "Attach an independent RainyDays Worker over authenticated stdio or SSH transport.",
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string" }, name: { type: "string" }, transport: { type: "string", enum: ["stdio", "ssh"] }, cwd: { type: "string" },
        accessCode: { type: "string" }, host: { type: "string" }, remoteCommand: { type: "string" }, executable: { type: "string" }, args: { type: "array", items: { type: "string" } },
      },
      required: ["workerId"],
      ...noExtra,
    },
  },
};
export const workerConnectExec: ToolExecutor = async (args) => json(await workerRegistry.connect({
  workerId: args.workerId as string,
  name: args.name as string | undefined,
  transport: args.transport as "stdio" | "ssh" | undefined,
  cwd: args.cwd as string | undefined,
  accessCode: args.accessCode as string | undefined,
  host: args.host as string | undefined,
  remoteCommand: args.remoteCommand as string | undefined,
  executable: args.executable as string | undefined,
  args: args.args as string[] | undefined,
}));

export const workerDisconnectDef: ToolDefinition = { type: "function", function: { name: "worker_disconnect", description: "Detach and terminate a named non-local Worker transport.", parameters: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"], ...noExtra } } };
export const workerDisconnectExec: ToolExecutor = async args => { await workerRegistry.disconnect(args.workerId as string); return `Worker ${args.workerId as string} disconnected`; };

export const bashDef: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a one-shot command or send it to a named persistent shell on the selected Worker.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number", minimum: 0 }, description: { type: "string" },
        session: { type: "string" }, shell: { type: "string", enum: ["bash", "sh", "powershell", "pwsh", "cmd"] },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
      ...noExtra,
    },
  },
};
export const bashExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("bash requires invocation services");
  throwIfCancelled(invocation.signal);
  return json(await workerRegistry.execute(sessionId(invocation), "bash", args, invocation.signal, typeof args.timeout === "number" ? Math.max(args.timeout + 5_000, 10_000) : undefined));
};

export const bashOutputDef: ToolDefinition = { type: "function", function: { name: "bash_output", description: "Read current output or a line tail from a persistent shell on the selected Worker.", parameters: { type: "object", properties: { session: { type: "string" }, tail: { type: "number", minimum: 1 }, wait: { type: "number", minimum: 0 } }, required: ["session"], ...noExtra } } };
export const bashOutputExec: ToolExecutor = async (args, _env, invocation) => {
  if (typeof args.wait === "number" && args.wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(args.wait as number, 30_000)));
  return json(await workerRegistry.execute(sessionId(invocation), "bash_output", args, invocation?.signal));
};

export const bashListDef: ToolDefinition = { type: "function", function: { name: "bash_list", description: "List persistent shell sessions on the selected Worker.", parameters: { type: "object", properties: {}, ...noExtra } } };
export const bashListExec: ToolExecutor = async (_args, _env, invocation) => json(await workerRegistry.execute(sessionId(invocation), "bash_list", {}, invocation?.signal));

export const bashKillDef: ToolDefinition = { type: "function", function: { name: "bash_kill", description: "Kill a persistent shell and its process tree on the selected Worker.", parameters: { type: "object", properties: { session: { type: "string" } }, required: ["session"], ...noExtra } } };
export const bashKillExec: ToolExecutor = async (args, _env, invocation) => json(await workerRegistry.execute(sessionId(invocation), "bash_kill", args, invocation?.signal));

export const workerUploadDef: ToolDefinition = { type: "function", function: { name: "worker_upload", description: "Upload a local DATA_ROOT file to the selected Worker.", parameters: { type: "object", properties: { localPath: { type: "string" }, remotePath: { type: "string" } }, required: ["localPath", "remotePath"], ...noExtra } } };
export const workerUploadExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("worker_upload requires invocation services");
  const rootId = invocation.path.rootIdForEnv("DATA_ROOT");
  if (!rootId) throw new Error("worker_upload requires DATA_ROOT");
  const file = await invocation.path.readFile(args.localPath as string, { defaultRootId: rootId, maxBytes: 128 * 1024 * 1024 });
  return json(await workerRegistry.execute(sessionId(invocation), "upload", { file_path: args.remotePath, dataBase64: file.bytes.toString("base64") }, invocation.signal));
};

export const workerDownloadDef: ToolDefinition = { type: "function", function: { name: "worker_download", description: "Download a selected Worker file into local OUTPUT_DIR.", parameters: { type: "object", properties: { remotePath: { type: "string" }, localPath: { type: "string" } }, required: ["remotePath", "localPath"], ...noExtra } } };
export const workerDownloadExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("worker_download requires invocation services");
  const rootId = invocation.path.rootIdForEnv("OUTPUT_DIR");
  if (!rootId) throw new Error("worker_download requires OUTPUT_DIR");
  const result = await workerRegistry.execute<{ dataBase64: string; bytes: number }>(sessionId(invocation), "download", { file_path: args.remotePath }, invocation.signal);
  const bytes = Buffer.from(result.dataBase64, "base64");
  if (bytes.length !== result.bytes || bytes.length > 128 * 1024 * 1024) throw new Error("Worker download framing is invalid");
  await invocation.path.writeFile(args.localPath as string, bytes, { defaultRootId: rootId, maxBytes: 128 * 1024 * 1024 });
  return json({ localPath: path.normalize(args.localPath as string), bytes: bytes.length });
};
