// ===========================================
// A15 开发模式持久终端：以用户身份运行的管道式 cmd/PowerShell。
// 由同一 TerminalManager 投影输出、分页、退出码与归属；这里只提供
// 启动/输入/读取/终止，lease 类型决定走开发后端还是原生隔离后端。
// ===========================================

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import iconv from "iconv-lite";
import type { IsolatedTerminalLease, ScopedExecutionGateway } from "./execution-runtime.js";
import { developerEnvironment } from "./developer-execution.js";
import { terminateProcessTree } from "./process-tree.js";
import type { ResourceOwner } from "./resource-owner.js";
import { throwIfCancelled } from "./run-cancellation.js";

const RETAINED_BYTES = 1024 * 1024;
// cmd 提示符前缀哨兵：出现即表示 cmd 回到读取命令状态。输出中会被移除。
const PROMPT_SENTINEL = Buffer.from("\u001b]9;rd\u001b", "latin1");
const CMD_PROMPT = "$E]9;rd$E$P$G";

let oemCodepage: string | null = null;
/**
 * 管道中的 cmd/PowerShell 按系统 OEM 代码页解析输入；chcp 65001 时 cmd 读取多字节输入会出错。
 * 因此命令行以 OEM 编码写入，运行中程序的 stdin 仍按 UTF-8 写入。
 */
export function systemOemCodepage(): string {
  if (oemCodepage) return oemCodepage;
  let page = "utf8";
  try {
    const output = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5000 }).stdout?.toString("latin1").trim() ?? "";
    const number = /(\d+)\s*$/u.exec(output)?.[1];
    if (number && number !== "65001" && iconv.encodingExists(`cp${number}`)) page = `cp${number}`;
  } catch { /* fall back to UTF-8 */ }
  oemCodepage = page;
  return page;
}

/** 逐行把 OEM 输出（cmd 内建命令）与 UTF-8 输出（多数开发工具）统一为 UTF-8。 */
class MixedOutputTranscoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly codepage: string) {}
  push(chunk: Buffer): Buffer {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const lastNewline = data.lastIndexOf(0x0a);
    const complete = lastNewline >= 0 ? data.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    data = lastNewline >= 0 ? data.subarray(lastNewline + 1) : data;
    const parts: Buffer[] = [];
    let lineStart = 0;
    for (let index = 0; index < complete.length; index++) {
      if (complete[index] !== 0x0a) continue;
      parts.push(this.decodeLine(complete.subarray(lineStart, index + 1)));
      lineStart = index + 1;
    }
    if (data.length) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: true });
        const used = Buffer.byteLength(text, "utf8");
        parts.push(Buffer.from(text, "utf8"));
        this.pending = Buffer.from(data.subarray(used));
      } catch { parts.push(Buffer.from(iconv.decode(data, this.codepage), "utf8")); }
    }
    return Buffer.concat(parts);
  }
  private decodeLine(line: Buffer): Buffer {
    try { new TextDecoder("utf-8", { fatal: true }).decode(line); return line; }
    catch { return Buffer.from(iconv.decode(line, this.codepage), "utf8"); }
  }
}

class RetainedStream {
  private chunks: Buffer[] = [];
  private size = 0;
  start = 0;
  end = 0;
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.end += chunk.length;
    while (this.size > RETAINED_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
      this.start += dropped.length;
    }
  }
  bytes(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }
}

interface DeveloperTerminalRecord {
  readonly owner: ResourceOwner;
  readonly terminalId: string;
  readonly shell: "cmd" | "powershell";
  readonly codepage: string;
  readonly child: ChildProcess;
  promptsSeen: number;
  promptsAtCommand: number;
  awaitingPrompt: boolean;
  readonly stdout: RetainedStream;
  readonly stderr: RetainedStream;
  exitCode: number | null;
  reason: string | null;
  running: boolean;
  stopping: Promise<void> | null;
}

const records = new WeakMap<IsolatedTerminalLease, DeveloperTerminalRecord>();

export function isDeveloperTerminalLease(lease: IsolatedTerminalLease): boolean {
  return records.has(lease);
}

function requireRecord(lease: IsolatedTerminalLease, owner: ResourceOwner): DeveloperTerminalRecord {
  const record = records.get(lease);
  if (!record || record.owner !== owner) throw new Error("开发模式终端归属不匹配");
  return record;
}

export function startDeveloperShell(input: Readonly<{ terminalId: string; shell: "cmd" | "powershell"; cwd: string; owner: ResourceOwner; signal: AbortSignal }>): IsolatedTerminalLease {
  throwIfCancelled(input.signal);
  const codepage = systemOemCodepage();
  const [command, args] = input.shell === "powershell"
    ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"]]
    : [process.env.ComSpec || "cmd.exe", ["/d", "/q", "/k"]];
  const env = developerEnvironment();
  if (input.shell === "cmd") env.PROMPT = CMD_PROMPT;
  const child = spawn(command, args, { cwd: input.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const record: DeveloperTerminalRecord = {
    owner: input.owner, terminalId: input.terminalId, shell: input.shell, codepage, child,
    promptsSeen: 0, promptsAtCommand: 0, awaitingPrompt: false,
    stdout: new RetainedStream(), stderr: new RetainedStream(),
    exitCode: null, reason: null, running: true, stopping: null,
  };
  const stdoutText = new MixedOutputTranscoder(codepage), stderrText = new MixedOutputTranscoder(codepage);
  child.stdout!.on("data", (chunk: Buffer) => {
    let data = chunk;
    for (let at = data.indexOf(PROMPT_SENTINEL); at >= 0; at = data.indexOf(PROMPT_SENTINEL)) {
      data = Buffer.concat([data.subarray(0, at), data.subarray(at + PROMPT_SENTINEL.length)]);
      record.promptsSeen += 1;
    }
    if (record.awaitingPrompt && record.promptsSeen > record.promptsAtCommand) record.awaitingPrompt = false;
    record.stdout.push(stdoutText.push(data));
  });
  child.stderr!.on("data", (chunk: Buffer) => record.stderr.push(stderrText.push(chunk)));
  child.stdin!.on("error", () => undefined);
  child.once("error", error => {
    record.stderr.push(Buffer.from(`\n[无法启动 ${command}: ${error.message}]\n`));
    record.running = false; record.reason = "launch-failed";
  });
  child.once("close", code => {
    record.running = false;
    record.exitCode = code;
    record.reason ??= code === 0 ? "completed" : "child-failed";
  });
  if (input.shell === "powershell") child.stdin!.write("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n");
  const lease = Object.freeze({ leaseId: randomUUID() });
  records.set(lease, record);
  return lease;
}

/**
 * cmd 空闲时写入的是命令行（OEM 编码，等待下一个提示符）；命令运行中写入的是该程序的 stdin（UTF-8）。
 * PowerShell 管道宿主始终按 OEM 解析输入，且不把输入转给子程序。
 */
export async function writeDeveloperShell(lease: IsolatedTerminalLease, owner: ResourceOwner, data: string, appendNewline: boolean): Promise<void> {
  const record = requireRecord(lease, owner);
  if (record.shell === "cmd" && record.promptsSeen === 0) {
    const deadline = Date.now() + 5000;
    while (record.running && record.promptsSeen === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!record.running || !record.child.stdin?.writable) throw new Error("开发模式终端已结束");
  const text = appendNewline ? `${data}\r\n` : data;
  const commandLine = record.shell === "powershell" || !record.awaitingPrompt;
  if (record.shell === "cmd" && commandLine) {
    record.awaitingPrompt = true;
    record.promptsAtCommand = record.promptsSeen;
  }
  record.child.stdin.write(commandLine ? iconv.encode(text, record.codepage) : Buffer.from(text, "utf8"));
}

export function readDeveloperShell(lease: IsolatedTerminalLease, owner: ResourceOwner) {
  const record = requireRecord(lease, owner);
  const stdoutBytes = record.stdout.bytes(), stderrBytes = record.stderr.bytes();
  return Object.freeze({
    stdout: stdoutBytes.toString("utf8"), stderr: stderrBytes.toString("utf8"),
    stdoutBytes: new Uint8Array(stdoutBytes), stderrBytes: new Uint8Array(stderrBytes),
    stdoutStart: record.stdout.start, stdoutEnd: record.stdout.end,
    stderrStart: record.stderr.start, stderrEnd: record.stderr.end,
    outputTruncated: record.stdout.start > 0 || record.stderr.start > 0,
    running: record.running, exitCode: record.exitCode, reason: record.reason,
  });
}

export async function terminateDeveloperShell(lease: IsolatedTerminalLease, owner: ResourceOwner, reason: string): Promise<void> {
  const record = requireRecord(lease, owner);
  if (!record.running) return;
  record.reason = reason;
  record.stopping ??= terminateProcessTree(record.child).catch(() => { try { record.child.kill("SIGKILL"); } catch { /* close event decides */ } });
  await record.stopping;
}

/**
 * 开发模式下终端工具使用的执行网关：新终端以用户身份启动；输入只写入
 * 本 owner 的开发终端，其余（含已有隔离终端）交给原网关。
 */
export function developerTerminalGateway(base: ScopedExecutionGateway, owner: ResourceOwner, cwd: () => string, signal: AbortSignal): ScopedExecutionGateway {
  return Object.freeze<ScopedExecutionGateway>({
    ...base,
    startShell: async ({ terminalId, shell }) => startDeveloperShell({ terminalId, shell, cwd: cwd(), owner, signal }),
    writeShell: async ({ lease, terminalId, data, appendNewline }) => {
      if (!isDeveloperTerminalLease(lease)) return base.writeShell({ lease, terminalId, data, appendNewline });
      throwIfCancelled(signal);
      await writeDeveloperShell(lease, owner, data, appendNewline);
    },
  });
}
