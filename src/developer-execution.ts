// ===========================================
// A15 开发模式：用户在本机设置显式开启后，Agent 命令以当前用户身份、
// 用户 PATH/工具链与网络运行。cwd 仍由 Path gateway 限定在授权根内；
// 同事模式（默认）继续走 SEC-03 原生隔离，不经过本模块。
// ===========================================

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getConfigSnapshot } from "./config.js";
import { terminateProcessTree } from "./process-tree.js";
import { registerOwnedResource, type ResourceOwner } from "./resource-owner.js";
import { throwIfCancelled } from "./run-cancellation.js";

/** 开发模式下改为应用内确认、以用户身份执行的工具。 */
export const DEVELOPER_COMMAND_TOOLS: ReadonlySet<string> = new Set(["execute_command", "shell_start", "shell_input"]);

export const DEVELOPER_DEFAULT_TIMEOUT_SECONDS = 120;
export const DEVELOPER_MAX_TIMEOUT_SECONDS = 600;
const STDOUT_TAIL_CHARS = 32_000;
const STDERR_TAIL_CHARS = 16_000;
const COMMAND_MAX_CHARS = 32_000;

export function isDeveloperModeEnabled(): boolean {
  try { return getConfigSnapshot().domains.shell.developerMode === true; }
  catch { return false; }
}

export function isDeveloperCommandTool(toolName: string): boolean {
  return DEVELOPER_COMMAND_TOOLS.has(toolName) && isDeveloperModeEnabled();
}

/** 用户自己的环境，去掉 RainyDays/Electron 宿主内部变量。 */
export function developerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("RAINYDAYS_") || upper.startsWith("ELECTRON_") || upper === "NODE_TEST_CONTEXT") continue;
    env[key] = value;
  }
  env.PYTHONIOENCODING ??= "utf-8";
  return env;
}

export function parseDeveloperTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEVELOPER_DEFAULT_TIMEOUT_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new TypeError("timeout 必须是正数秒");
  return Math.min(Math.ceil(value), DEVELOPER_MAX_TIMEOUT_SECONDS);
}

export interface DeveloperCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly reason: "completed" | "timeout";
  readonly durationMs: number;
  readonly omittedStdoutChars: number;
  readonly omittedStderrChars: number;
}

class TailBuffer {
  private text = "";
  omitted = 0;
  private readonly decoder = new StringDecoder("utf8");
  constructor(private readonly limit: number) {}
  push(chunk: Buffer | string): void { this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk)); }
  end(): string { this.append(this.decoder.end()); return this.text; }
  private append(value: string): void {
    if (!value) return;
    this.text += value;
    if (this.text.length > this.limit * 2) this.trim();
  }
  trim(): void {
    if (this.text.length <= this.limit) return;
    this.omitted += this.text.length - this.limit;
    this.text = this.text.slice(this.text.length - this.limit);
  }
  value(): string { this.trim(); return this.text; }
}

/**
 * 在用户会话中运行一条 cmd 命令。返回真实退出码；超时、取消与 run 资源回收
 * 都终止整个进程树。stdin 关闭，需要交互输入的命令会立即得到 EOF 而不是挂起。
 */
export async function runDeveloperCommand(input: Readonly<{
  command: string;
  cwd: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  owner?: ResourceOwner;
  env?: NodeJS.ProcessEnv;
}>): Promise<DeveloperCommandResult> {
  const { command, cwd, timeoutSeconds, signal } = input;
  if (typeof command !== "string" || !command.trim() || command.length > COMMAND_MAX_CHARS || /[\r\n\u0000]/u.test(command)) {
    throw new TypeError("命令必须是单行且不超过 32000 字符");
  }
  throwIfCancelled(signal);
  const started = Date.now();
  // cmd 继承隐藏 console；先切到 UTF-8 让内建命令与多数 CLI 输出可读，再原样执行用户命令。
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"chcp 65001>nul & ${command}"`], {
    cwd,
    env: input.env ?? developerEnvironment(),
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new TailBuffer(STDOUT_TAIL_CHARS);
  const stderr = new TailBuffer(STDERR_TAIL_CHARS);
  child.stdout!.on("data", chunk => stdout.push(chunk));
  child.stderr!.on("data", chunk => stderr.push(chunk));

  let timedOut = false;
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    stopping ??= terminateProcessTree(child).catch(() => { try { child.kill("SIGKILL"); } catch { /* exit wait decides */ } });
    return stopping;
  };
  const unregister = input.owner ? registerOwnedResource(input.owner, stop) : () => undefined;
  const timer = setTimeout(() => { timedOut = true; void stop(); }, timeoutSeconds * 1000);
  timer.unref?.();
  const onAbort = () => { void stop(); };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    if (stopping) await stopping;
    throwIfCancelled(signal);
    stdout.end();
    stderr.end();
    return Object.freeze({
      stdout: stdout.value(),
      stderr: stderr.value(),
      exitCode: timedOut ? null : exitCode,
      reason: timedOut ? "timeout" as const : "completed" as const,
      durationMs: Date.now() - started,
      omittedStdoutChars: stdout.omitted,
      omittedStderrChars: stderr.omitted,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unregister();
  }
}

export function formatDeveloperResult(result: DeveloperCommandResult, timeoutSeconds: number): { text: string; failed: boolean } {
  const parts: string[] = [];
  if (result.omittedStdoutChars) parts.push(`[stdout 前 ${result.omittedStdoutChars} 字符已省略，仅保留末尾]`);
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) {
    parts.push(result.omittedStderrChars ? `[stderr，前 ${result.omittedStderrChars} 字符已省略]` : "[stderr]");
    parts.push(result.stderr);
  }
  const failed = result.reason !== "completed" || result.exitCode !== 0;
  const status = result.reason === "timeout"
    ? `[开发模式 · 超过 ${timeoutSeconds} 秒，已终止进程树]`
    : `[开发模式 · 退出码 ${result.exitCode ?? "未知"} · ${(result.durationMs / 1000).toFixed(1)} 秒]`;
  parts.push(status);
  return { text: parts.join("\n"), failed };
}
