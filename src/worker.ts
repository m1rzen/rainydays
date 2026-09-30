import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import type { ToolInvocationServices } from "./types.js";

export type WorkerTransport = "local" | "stdio" | "ssh" | "relay";
export type WorkerStatus = "online" | "offline" | "connecting";

export interface WorkerInfo {
  readonly workerId: string;
  readonly name: string;
  readonly status: WorkerStatus;
  readonly transport: WorkerTransport;
  readonly platform: string;
  readonly cwd: string;
  readonly pid: number | null;
  readonly selected: boolean;
  readonly error: string | null;
}

interface RpcPending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerSpawnOptions {
  readonly workerId: string;
  readonly name: string;
  readonly transport: WorkerTransport;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly accessCode: string;
}

const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u;
const WORKER_CLI = process.env.RAINYDAYS_WORKER_CLI || fileURLToPath(new URL("../scripts/rainydays-worker.mjs", import.meta.url));

function exactId(value: unknown): string {
  if (typeof value !== "string" || !WORKER_ID.test(value)) throw new TypeError("Worker id is invalid");
  return value;
}

function exactText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return value;
}

export class StdioWorkerAdapter {
  readonly workerId: string;
  readonly name: string;
  readonly transport: WorkerTransport;
  readonly process: ChildProcess;
  status: WorkerStatus = "connecting";
  platform = "unknown";
  cwd = "";
  error: string | null = null;
  #nextId = 1;
  #pending = new Map<number, RpcPending>();
  #stderr = "";

  private constructor(options: WorkerSpawnOptions) {
    this.workerId = options.workerId;
    this.name = options.name;
    this.transport = options.transport;
    this.process = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const lines = readline.createInterface({ input: this.process.stdout!, crlfDelay: Infinity });
    lines.on("line", line => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "number") return;
      const pending = this.#pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(record.id);
      if (record.error) pending.reject(new Error(String(record.error)));
      else pending.resolve(record.result);
    });
    this.process.stderr!.on("data", chunk => { this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-64_000); });
    this.process.once("exit", (code, signal) => {
      this.status = "offline";
      this.error = `Worker exited (${code ?? signal ?? "unknown"})${this.#stderr ? `: ${this.#stderr.slice(-1_000)}` : ""}`;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(this.error)); }
      this.#pending.clear();
    });
    this.process.once("error", error => {
      this.status = "offline";
      this.error = error.message;
    });
  }

  static async connect(options: WorkerSpawnOptions): Promise<StdioWorkerAdapter> {
    const adapter = new StdioWorkerAdapter(options);
    const hello = await adapter.request<{ workerName: string; platform: string; cwd: string; pid: number }>("hello", { accessCode: options.accessCode }, undefined, 15_000);
    adapter.status = "online";
    adapter.platform = hello.platform;
    adapter.cwd = hello.cwd;
    return adapter;
  }

  async request<T = unknown>(operation: string, args: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal, timeoutMs = 120_000): Promise<T> {
    if (this.status === "offline") throw new Error(`Worker ${this.workerId} is offline: ${this.error ?? "disconnected"}`);
    if (!this.process.stdin?.writable) throw new Error(`Worker ${this.workerId} transport is unavailable`);
    if (signal?.aborted) throw signal.reason;
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Worker ${this.workerId} operation timed out: ${operation}`));
      }, Math.max(100, timeoutMs));
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    });
    const abort = (): void => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(signal?.reason ?? new Error("Worker operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.process.stdin.write(`${JSON.stringify({ id, op: operation, args })}\n`);
    try { return await result; } finally { signal?.removeEventListener("abort", abort); }
  }

  info(selected: boolean): WorkerInfo {
    return Object.freeze({ workerId: this.workerId, name: this.name, status: this.status, transport: this.transport, platform: this.platform, cwd: this.cwd, pid: this.process.pid ?? null, selected, error: this.error });
  }

  async close(): Promise<void> {
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      await new Promise(resolve => { const timer = setTimeout(resolve, 2_000); this.process.once("exit", () => { clearTimeout(timer); resolve(undefined); }); });
      if (this.process.exitCode === null) this.process.kill("SIGKILL");
    }
    this.status = "offline";
  }
}

export interface WorkerConnectInput {
  readonly workerId: string;
  readonly name?: string;
  readonly transport?: "stdio" | "ssh";
  readonly cwd?: string;
  readonly accessCode?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly host?: string;
  readonly remoteCommand?: string;
}

export class WorkerRegistry {
  #workers = new Map<string, StdioWorkerAdapter>();
  #selectedBySession = new Map<string, string>();
  #localPromise: Promise<StdioWorkerAdapter> | null = null;

  async #local(): Promise<StdioWorkerAdapter> {
    if (!this.#localPromise) {
      const accessCode = randomBytes(24).toString("base64url");
      this.#localPromise = StdioWorkerAdapter.connect({
        workerId: "local",
        name: "Local",
        transport: "local",
        executable: process.execPath,
        args: [WORKER_CLI, "stdio", "--access-code", accessCode, "--cwd", process.cwd(), "--name", "Local"],
        cwd: process.cwd(),
        accessCode,
      }).catch(error => { this.#localPromise = null; throw error; });
    }
    return this.#localPromise;
  }

  selectedWorkerId(sessionIdInput: string): string {
    const sessionId = exactText(sessionIdInput, "Session id", 200);
    return this.#selectedBySession.get(sessionId) ?? "local";
  }

  async list(sessionIdInput: string): Promise<WorkerInfo[]> {
    const selectedId = this.selectedWorkerId(sessionIdInput);
    const local = await this.#local();
    return [local, ...this.#workers.values()].map(worker => worker.info(worker.workerId === selectedId)).sort((a, b) => a.workerId.localeCompare(b.workerId));
  }

  async status(sessionIdInput: string, workerIdInput?: string): Promise<WorkerInfo> {
    const workerId = workerIdInput ? exactId(workerIdInput) : this.selectedWorkerId(sessionIdInput);
    const worker = workerId === "local" ? await this.#local() : this.#workers.get(workerId);
    if (!worker) throw new Error(`Worker was not found: ${workerId}`);
    return worker.info(workerId === this.selectedWorkerId(sessionIdInput));
  }

  async connect(input: WorkerConnectInput): Promise<WorkerInfo> {
    const workerId = exactId(input.workerId);
    if (workerId === "local" || this.#workers.has(workerId)) throw new Error(`Worker already exists: ${workerId}`);
    const name = input.name ? exactText(input.name, "Worker name", 120) : workerId;
    const transport = input.transport ?? "stdio";
    const accessCode = input.accessCode ? exactText(input.accessCode, "Worker access code", 256) : randomBytes(24).toString("base64url");
    let executable: string;
    let args: string[];
    if (input.executable) {
      executable = exactText(input.executable, "Worker executable", 32_768);
      args = (input.args ?? []).map(value => exactText(value, "Worker argument", 32_768, true));
    } else if (transport === "ssh") {
      const host = exactText(input.host, "SSH host", 512);
      const remoteCommand = exactText(input.remoteCommand, "Remote Worker command", 8_192);
      executable = process.platform === "win32" ? "ssh.exe" : "ssh";
      args = [host, remoteCommand, "stdio", "--access-code", accessCode, "--cwd", input.cwd ?? ".", "--name", name];
    } else {
      executable = process.execPath;
      args = [WORKER_CLI, "stdio", "--access-code", accessCode, "--cwd", input.cwd ?? process.cwd(), "--name", name];
    }
    const worker = await StdioWorkerAdapter.connect({ workerId, name, transport, executable, args, cwd: transport === "stdio" ? input.cwd : undefined, accessCode });
    this.#workers.set(workerId, worker);
    return worker.info(false);
  }

  async disconnect(workerIdInput: string): Promise<void> {
    const workerId = exactId(workerIdInput);
    if (workerId === "local") throw new Error("The built-in local Worker cannot be disconnected");
    const worker = this.#workers.get(workerId);
    if (!worker) throw new Error(`Worker was not found: ${workerId}`);
    this.#workers.delete(workerId);
    await worker.close();
  }

  async select(sessionIdInput: string, workerIdInput: string): Promise<WorkerInfo> {
    const sessionId = exactText(sessionIdInput, "Session id", 200);
    const workerId = exactId(workerIdInput);
    const worker = workerId === "local" ? await this.#local() : this.#workers.get(workerId);
    if (!worker) throw new Error(`Worker was not found: ${workerId}`);
    if (worker.status !== "online") throw new Error(`Worker ${workerId} is offline and cannot be selected`);
    this.#selectedBySession.set(sessionId, workerId);
    return worker.info(true);
  }

  async execute<T = unknown>(sessionIdInput: string, operation: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const workerId = this.selectedWorkerId(sessionIdInput);
    const worker = workerId === "local" ? await this.#local() : this.#workers.get(workerId);
    if (!worker) throw new Error(`Selected Worker is unavailable: ${workerId}`);
    if (worker.status !== "online") throw new Error(`Selected Worker ${workerId} disconnected; local fallback is forbidden`);
    return worker.request<T>(operation, args, signal, timeoutMs);
  }

  isRemoteSelected(sessionIdInput: string): boolean { return this.selectedWorkerId(sessionIdInput) !== "local"; }

  async dispose(): Promise<void> {
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    const local = this.#localPromise ? await this.#localPromise.catch(() => null) : null;
    this.#localPromise = null;
    await Promise.all([...workers, ...(local ? [local] : [])].map(worker => worker.close()));
  }
}

export const workerRegistry = new WorkerRegistry();

export async function routeToSelectedWorker(invocation: ToolInvocationServices | undefined, operation: string, args: Readonly<Record<string, unknown>>): Promise<string | null> {
  if (!invocation) return null;
  const sessionId = invocation.capabilityContext.sessionId;
  if (!workerRegistry.isRemoteSelected(sessionId)) return null;
  const value = await workerRegistry.execute(sessionId, operation, args, invocation.signal);
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
