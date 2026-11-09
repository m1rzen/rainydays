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

export const workerSelectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "worker_select",
    description: "Select an online Worker for this Session's routed tools.",
    parameters: {
      type: "object",
      properties: {
        worker_id: { type: "string", description: "Authorized online Worker ID." },
        workerId: { type: "string", description: "Legacy alias for worker_id." },
      },
      ...noExtra,
    },
  },
};
export const workerSelectExec: ToolExecutor = async (args, _env, invocation) => {
  const target = (typeof args.worker_id === "string" && args.worker_id.trim()) || (typeof args.workerId === "string" && args.workerId.trim());
  if (!target) throw new Error("worker_select requires worker_id");
  return json(await workerRegistry.select(sessionId(invocation), target));
};

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
    description: "Run a one-shot command or send it to a named persistent shell. On Windows the default shell is PowerShell 5.1: use ; or if ($?) instead of || and &&, and $null instead of /dev/null.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number", minimum: 0 }, description: { type: "string" },
        session: { type: "string" }, shell: { type: "string", enum: ["bash", "sh", "powershell", "pwsh", "cmd"] },
        env: { type: "object", additionalProperties: { type: "string" } },
        worker_id: { type: "string" },
      },
      required: ["command"],
      ...noExtra,
    },
  },
};
export const bashExec: ToolExecutor = async (args, env, invocation) => {
  if (!invocation) throw new Error("bash requires invocation services");
  throwIfCancelled(invocation.signal);
  // Without a cwd the Worker falls back to the application folder, not the user's project.
  const request = args.cwd === undefined && !args.worker_id && env?.WORKSPACE_ROOT ? { ...args, cwd: env.WORKSPACE_ROOT } : args;
  return json(await workerRegistry.execute(sessionId(invocation), "bash", request, invocation.signal, typeof args.timeout === "number" ? Math.max(args.timeout + 5_000, 10_000) : undefined));
};

export const bashOutputDef: ToolDefinition = { type: "function", function: { name: "bash_output", description: "Read current output or a line tail from a persistent shell on the selected Worker.", parameters: { type: "object", properties: { session: { type: "string" }, tail: { type: "number", minimum: 0 }, wait: { type: "number", minimum: 0 }, worker_id: { type: "string" } }, required: ["session"], ...noExtra } } };
export const bashOutputExec: ToolExecutor = async (args, _env, invocation) => {
  if (typeof args.wait === "number" && args.wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(args.wait as number, 30_000)));
  return json(await workerRegistry.execute(sessionId(invocation), "bash_output", args, invocation?.signal));
};

export const bashListDef: ToolDefinition = { type: "function", function: { name: "bash_list", description: "List persistent shell sessions on the selected Worker.", parameters: { type: "object", properties: { worker_id: { type: "string" } }, ...noExtra } } };
export const bashListExec: ToolExecutor = async (args, _env, invocation) => json(await workerRegistry.execute(sessionId(invocation), "bash_list", args ?? {}, invocation?.signal));

export const bashKillDef: ToolDefinition = { type: "function", function: { name: "bash_kill", description: "Kill a persistent shell and its process tree on the selected Worker.", parameters: { type: "object", properties: { session: { type: "string" }, worker_id: { type: "string" } }, required: ["session"], ...noExtra } } };
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

export const computerUseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "computer_use",
    description: "Execute OS-level Desktop GUI Computer Use actions on the selected or specified Worker (screen_info, screenshot, window_list, window_focus, mouse_move, click, double_click, right_click, drag, scroll, type, keypress, hotkey, clipboard_get, clipboard_set, open_app, open_url).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screen_info",
            "screenshot",
            "window_list",
            "window_focus",
            "mouse_move",
            "click",
            "double_click",
            "right_click",
            "drag",
            "scroll",
            "type",
            "keypress",
            "hotkey",
            "clipboard_get",
            "clipboard_set",
            "open_app",
            "open_url",
          ],
          description: "Desktop GUI action to perform.",
        },
        x: { type: "number", description: "Target X screen coordinate (or region X for screenshot)." },
        y: { type: "number", description: "Target Y screen coordinate (or region Y for screenshot)." },
        to_x: { type: "number", description: "Destination X coordinate for drag." },
        to_y: { type: "number", description: "Destination Y coordinate for drag." },
        width: { type: "number", minimum: 1, description: "Region width for screenshot." },
        height: { type: "number", minimum: 1, description: "Region height for screenshot." },
        amount: { type: "number", description: "Scroll wheel delta (e.g., 120 or -120)." },
        text: { type: "string", description: "Text to type or set into clipboard." },
        key: { type: "string", description: "Key or hotkey sequence in SendKeys format (e.g. '{ENTER}', '^c', '%{TAB}')." },
        target: { type: "string", description: "Window title/process substring for window_focus, or app/URL for open_app/open_url." },
        output_path: { type: "string", description: "Optional PNG file path to save desktop screenshot." },
        worker_id: { type: "string", description: "Optional per-call Worker ID override." },
      },
      required: ["action"],
      ...noExtra,
    },
  },
};
export const computerUseExec: ToolExecutor = async (args, _env, invocation) => {
  const sid = invocation?.capabilityContext?.sessionId || "default-session";
  if (invocation?.signal) throwIfCancelled(invocation.signal);
  return json(await workerRegistry.execute(sid, "computer_use", args, invocation?.signal, 30_000));
};
