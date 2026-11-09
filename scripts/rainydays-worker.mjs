#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const mode = argv[0] || "stdio";
const option = name => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const rootCwd = path.resolve(option("cwd") || process.cwd());
const expectedAccessCode = option("access-code") || process.env.RAINYDAYS_WORKER_ACCESS_CODE || "";
const workerName = option("name") || os.hostname();
const MAX_OUTPUT = 2 * 1024 * 1024;
const sessions = new Map();
let authenticated = expectedAccessCode.length === 0;

if (mode !== "stdio") {
  console.error("rainydays-worker currently exposes the stdio transport; launch it through SSH for remote routing");
  process.exit(2);
}

function exactText(value, label, maximum = 1_000_000, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return value;
}

function normalizeCwd(value) { return path.resolve(value ? exactText(value, "cwd", 32_768) : rootCwd); }
function outputValue(value) { return JSON.stringify(value); }
function trimOutput(value) { return value.length > MAX_OUTPUT ? value.slice(value.length - MAX_OUTPUT) : value; }

function shellExecutable(requested) {
  const shell = requested || (process.platform === "win32" ? "powershell" : "bash");
  const values = {
    bash: process.platform === "win32" ? (process.env.RAINYDAYS_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe") : "bash",
    sh: process.platform === "win32" ? (process.env.RAINYDAYS_SH_PATH || "C:\\Program Files\\Git\\bin\\sh.exe") : "sh",
    powershell: "powershell.exe",
    pwsh: "pwsh",
    cmd: "cmd.exe",
  };
  if (!Object.hasOwn(values, shell)) throw new TypeError(`Unsupported shell: ${shell}`);
  return { shell, executable: values[shell] };
}

// Windows shells default to the system code page; the Worker decodes output as UTF-8.
const POWERSHELL_UTF8 = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;";

function commandArguments(shell, command) {
  if (shell === "bash" || shell === "sh") return ["-lc", command];
  if (shell === "powershell" || shell === "pwsh") return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${POWERSHELL_UTF8}${command}`];
  return ["/d", "/s", "/c", `chcp 65001>nul & ${command}`];
}

function persistentArguments(shell) {
  if (shell === "bash" || shell === "sh") return ["--noprofile", "--norc"];
  if (shell === "powershell" || shell === "pwsh") return ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"];
  return ["/d", "/q", "/k"];
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", resolve); killer.once("error", resolve);
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

async function runOneShot(args) {
  const command = exactText(args.command, "command", 1_000_000);
  const cwd = normalizeCwd(args.cwd);
  const timeout = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(args.timeout ?? 30_000)));
  const { shell, executable } = shellExecutable(args.shell);
  const env = { ...process.env, ...(args.env && typeof args.env === "object" ? Object.fromEntries(Object.entries(args.env).map(([key, value]) => [key, String(value)])) : {}) };
  const child = spawn(executable, commandArguments(shell, command), { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout = trimOutput(stdout + chunk.toString("utf8")); });
  child.stderr.on("data", chunk => { stderr = trimOutput(stderr + chunk.toString("utf8")); });
  const timer = timeout ? setTimeout(() => { timedOut = true; void killTree(child); }, timeout) : null;
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
  if (timer) clearTimeout(timer);
  return { shell, cwd, exitCode, timedOut, stdout, stderr };
}

function startPersistent(args) {
  const name = exactText(args.session, "session", 120);
  const existing = sessions.get(name);
  if (existing && existing.status === "running") return existing;
  const cwd = normalizeCwd(args.cwd);
  const { shell, executable } = shellExecutable(args.shell);
  const env = { ...process.env, ...(args.env && typeof args.env === "object" ? Object.fromEntries(Object.entries(args.env).map(([key, value]) => [key, String(value)])) : {}) };
  const child = spawn(executable, persistentArguments(shell), { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const session = { name, shell, cwd, process: child, output: "", status: "running", startedAt: new Date().toISOString(), lastCommand: null };
  const append = chunk => { session.output = trimOutput(session.output + chunk.toString("utf8")); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.once("exit", () => { session.status = "exited"; });
  child.once("error", error => { session.output = trimOutput(`${session.output}\n${error.stack || error.message}`); session.status = "error"; });
  sessions.set(name, session);
  return session;
}

async function bashOperation(args) {
  if (!args.session) return runOneShot(args);
  const session = startPersistent(args);
  if (session.status !== "running") throw new Error(`Persistent session is not running: ${session.name}`);
  const command = exactText(args.command, "command", 1_000_000);
  session.lastCommand = command;
  session.process.stdin.write(`${command}${os.EOL}`);
  return { session: session.name, shell: session.shell, cwd: session.cwd, status: session.status, pid: session.process.pid, outputLength: session.output.length };
}

function sessionInfo(session) { return { session: session.name, shell: session.shell, cwd: session.cwd, status: session.status, pid: session.process.pid, startedAt: session.startedAt, outputLength: session.output.length, lastCommand: session.lastCommand }; }

function globRegex(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

async function walk(root, limit = 20_000) {
  const rows = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (rows.length >= limit) return;
      const full = path.join(directory, entry.name);
      rows.push({ full, relative: path.relative(root, full).replaceAll("\\", "/"), directory: entry.isDirectory() });
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(full);
    }
  }
  await visit(root);
  return rows;
}

async function readOperation(args) {
  const filePath = path.resolve(exactText(args.file_path, "file_path", 32_768));
  const bytes = await readFile(filePath);
  if (args.byte_offset !== undefined) {
    const offset = Math.max(0, Number(args.byte_offset));
    const maximum = Math.max(1, Math.min(10_240, Number(args.max_bytes ?? 8_192)));
    const selected = bytes.subarray(offset, offset + maximum);
    return { filePath, encoding: "base64", data: selected.toString("base64"), byteOffset: offset, nextByteOffset: offset + selected.length, totalBytes: bytes.length };
  }
  if (bytes.includes(0)) return { filePath, encoding: "base64", data: bytes.toString("base64"), totalBytes: bytes.length };
  const lines = bytes.toString("utf8").split(/\r?\n/u);
  const offset = Math.max(1, Number(args.offset ?? 1));
  const limit = args.limit === undefined ? lines.length : Math.max(0, Number(args.limit));
  return { filePath, offset, totalLines: lines.length, text: lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}\t${line}`).join("\n") };
}

async function workerOperation(op, args) {
  if (op === "status") return { name: workerName, platform: `${process.platform}/${process.arch}`, cwd: rootCwd, pid: process.pid, sessions: sessions.size };
  if (op === "bash") return bashOperation(args);
  if (op === "bash_output") {
    const session = sessions.get(exactText(args.session, "session", 120));
    if (!session) throw new Error(`Persistent session not found: ${args.session}`);
    const tail = args.tail === undefined ? null : Math.max(1, Number(args.tail));
    const lines = session.output.split(/\r?\n/u);
    const output = tail ? lines.slice(-tail).join("\n") : session.output;
    return { ...sessionInfo(session), output };
  }
  if (op === "bash_list") return [...sessions.values()].map(sessionInfo);
  if (op === "bash_kill") {
    const name = exactText(args.session, "session", 120); const session = sessions.get(name);
    if (!session) throw new Error(`Persistent session not found: ${name}`);
    await killTree(session.process); session.status = "killed"; sessions.delete(name); return { session: name, status: "killed" };
  }
  if (op === "read") return readOperation(args);
  if (op === "write" || op === "upload") {
    const filePath = path.resolve(exactText(args.file_path, "file_path", 32_768));
    await mkdir(path.dirname(filePath), { recursive: true });
    const bytes = op === "upload" ? Buffer.from(exactText(args.dataBase64, "dataBase64", 512 * 1024 * 1024), "base64") : Buffer.from(exactText(args.content, "content", 128 * 1024 * 1024, true), "utf8");
    await writeFile(filePath, bytes); return { filePath, bytes: bytes.length };
  }
  if (op === "download") {
    const filePath = path.resolve(exactText(args.file_path, "file_path", 32_768)); const bytes = await readFile(filePath);
    return { filePath, bytes: bytes.length, dataBase64: bytes.toString("base64") };
  }
  if (op === "edit") {
    const filePath = path.resolve(exactText(args.file_path, "file_path", 32_768));
    const oldString = exactText(args.old_string, "old_string", 64 * 1024 * 1024); const newString = exactText(args.new_string, "new_string", 64 * 1024 * 1024, true);
    const source = await readFile(filePath, "utf8"); const count = source.split(oldString).length - 1;
    if (count === 0) throw new Error("old_string was not found");
    if (!args.replace_all && count !== 1) throw new Error(`old_string matched ${count} times`);
    const output = args.replace_all ? source.split(oldString).join(newString) : source.replace(oldString, newString);
    await writeFile(filePath, output, "utf8"); return { filePath, replacements: args.replace_all ? count : 1 };
  }
  if (op === "glob") {
    const root = normalizeCwd(args.path); const expression = globRegex(exactText(args.pattern, "pattern", 4_096));
    const values = await walk(root, 50_000); return values.filter(value => expression.test(value.relative)).map(value => value.relative).slice(0, 5_000);
  }
  if (op === "grep") {
    const root = path.resolve(exactText(args.path || rootCwd, "path", 32_768)); const expression = new RegExp(exactText(args.pattern, "pattern", 16_384), args.case_insensitive ? "iu" : "u");
    const filter = args.glob ? globRegex(exactText(args.glob, "glob", 4_096)) : null;
    const info = await stat(root); const files = info.isFile() ? [{ full: root, relative: path.basename(root), directory: false }] : (await walk(root, 50_000)).filter(value => !value.directory);
    const results = [];
    for (const file of files) {
      if (filter && !filter.test(file.relative)) continue;
      let text; try { text = await readFile(file.full, "utf8"); } catch { continue; }
      if (text.includes("\0")) continue;
      const lines = text.split(/\r?\n/u);
      lines.forEach((line, index) => { expression.lastIndex = 0; if (expression.test(line)) results.push({ path: file.relative, line: index + 1, text: line }); });
      if (results.length >= Number(args.head_limit ?? 1_000)) break;
    }
    return results;
  }
  if (op === "script") {
    const lang = args.lang || "node"; const cwd = normalizeCwd(args.cwd); const extension = lang === "python" ? "py" : lang === "node-cjs" ? "cjs" : "mjs";
    const temporary = path.join(cwd, `.rainydays-worker-${randomBytes(8).toString("hex")}.${extension}`);
    await writeFile(temporary, exactText(args.code, "code", 2 * 1024 * 1024), "utf8");
    try {
      const command = lang === "python" ? `python ${JSON.stringify(temporary)}` : `node ${JSON.stringify(temporary)}`;
      return await runOneShot({ command, cwd, timeout: args.timeout ?? 120_000, shell: process.platform === "win32" ? "powershell" : "bash" });
    } finally { await rm(temporary, { force: true }); }
  }
  if (op === "read_repo") {
    const root = normalizeCwd(args.path); return (await walk(root, 10_000)).map(value => value.relative).slice(0, 10_000);
  }
  if (op === "computer_use") {
    return computerUseOperation(args);
  }
  throw new Error(`Unsupported Worker operation: ${op}`);
}

async function computerUseOperation(args) {
  const action = exactText(args.action || "screen_info", "action", 64);
  if (process.platform !== "win32") {
    return { ok: false, platform: process.platform, action, error: "Native GUI computer_use currently targets Windows desktop environments; use browser_* or bash on non-Windows workers." };
  }
  const x = Number.isFinite(Number(args.x)) ? Math.round(Number(args.x)) : null;
  const y = Number.isFinite(Number(args.y)) ? Math.round(Number(args.y)) : null;
  const toX = Number.isFinite(Number(args.to_x)) ? Math.round(Number(args.to_x)) : null;
  const toY = Number.isFinite(Number(args.to_y)) ? Math.round(Number(args.to_y)) : null;
  const width = Number.isFinite(Number(args.width)) ? Math.max(1, Math.round(Number(args.width))) : null;
  const height = Number.isFinite(Number(args.height)) ? Math.max(1, Math.round(Number(args.height))) : null;
  const amount = Number.isFinite(Number(args.amount)) ? Math.round(Number(args.amount)) : 120;
  const text = typeof args.text === "string" ? args.text.slice(0, 8192) : "";
  const key = typeof args.key === "string" ? args.key.slice(0, 256) : "";
  const target = typeof args.target === "string" ? args.target.slice(0, 2048) : "";
  const outPath = typeof args.output_path === "string" && args.output_path.trim()
    ? path.resolve(args.output_path.trim())
    : path.join(os.tmpdir(), `rainydays-cu-${Date.now()}-${randomBytes(4).toString("hex")}.png`);

  const payloadJson = JSON.stringify({ action, x, y, toX, toY, width, height, amount, text, key, target, outPath });
  const payloadBase64 = Buffer.from(payloadJson, "utf8").toString("base64");

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$win32 = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RainyWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
Add-Type -TypeDefinition $win32 -Language CSharp
$cfg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadBase64}')) | ConvertFrom-Json
$act = $cfg.action
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$vbounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$pos = [System.Windows.Forms.Cursor]::Position
$fg = [RainyWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][RainyWin32]::GetWindowText($fg, $sb, 512)
$fgTitle = $sb.ToString()

if ($act -eq 'screen_info') {
  @{ ok = $true; action = $act; screen = @{ width = $bounds.Width; height = $bounds.Height; virtualWidth = $vbounds.Width; virtualHeight = $vbounds.Height }; cursor = @{ x = $pos.X; y = $pos.Y }; activeWindowTitle = $fgTitle } | ConvertTo-Json -Compress
} elseif ($act -eq 'screenshot') {
  $rx = if ($null -ne $cfg.x) { [int]$cfg.x } else { $bounds.X }
  $ry = if ($null -ne $cfg.y) { [int]$cfg.y } else { $bounds.Y }
  $rw = if ($null -ne $cfg.width) { [int]$cfg.width } else { $bounds.Width }
  $rh = if ($null -ne $cfg.height) { [int]$cfg.height } else { $bounds.Height }
  $bmp = New-Object System.Drawing.Bitmap $rw, $rh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rx, $ry, 0, 0, $bmp.Size)
  $g.Dispose()
  $dir = [System.IO.Path]::GetDirectoryName($cfg.outPath)
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($cfg.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $fi = Get-Item $cfg.outPath
  @{ ok = $true; action = $act; filePath = $cfg.outPath; width = $rw; height = $rh; bytes = $fi.Length; cursor = @{ x = $pos.X; y = $pos.Y }; activeWindowTitle = $fgTitle } | ConvertTo-Json -Compress
} elseif ($act -eq 'window_list') {
  $wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 60 @{N='pid';E={$_.Id}}, @{N='processName';E={$_.ProcessName}}, @{N='title';E={$_.MainWindowTitle}}, @{N='hwnd';E={[int64]$_.MainWindowHandle}}
  @{ ok = $true; action = $act; activeWindowTitle = $fgTitle; windows = @($wins) } | ConvertTo-Json -Compress
} elseif ($act -eq 'window_focus') {
  $t = $cfg.target
  $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$t*" -or $_.ProcessName -like "*$t*" -or [string]$_.Id -eq $t) } | Select-Object -First 1
  if (-not $proc) { throw "Window not found matching: $t" }
  [void][RainyWin32]::ShowWindow($proc.MainWindowHandle, 9)
  [void][RainyWin32]::SetForegroundWindow($proc.MainWindowHandle)
  @{ ok = $true; action = $act; pid = $proc.Id; processName = $proc.ProcessName; title = $proc.MainWindowTitle } | ConvertTo-Json -Compress
} elseif ($act -eq 'mouse_move') {
  [void][RainyWin32]::SetCursorPos([int]$cfg.x, [int]$cfg.y)
  @{ ok = $true; action = $act; cursor = @{ x = [int]$cfg.x; y = [int]$cfg.y } } | ConvertTo-Json -Compress
} elseif ($act -eq 'click' -or $act -eq 'double_click' -or $act -eq 'right_click') {
  if ($null -ne $cfg.x -and $null -ne $cfg.y) { [void][RainyWin32]::SetCursorPos([int]$cfg.x, [int]$cfg.y); Start-Sleep -Milliseconds 30 }
  if ($act -eq 'right_click') {
    [RainyWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    [RainyWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [RainyWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [RainyWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($act -eq 'double_click') {
      Start-Sleep -Milliseconds 60
      [RainyWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [RainyWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
  }
  $nowPos = [System.Windows.Forms.Cursor]::Position
  @{ ok = $true; action = $act; cursor = @{ x = $nowPos.X; y = $nowPos.Y } } | ConvertTo-Json -Compress
} elseif ($act -eq 'drag') {
  [void][RainyWin32]::SetCursorPos([int]$cfg.x, [int]$cfg.y)
  Start-Sleep -Milliseconds 40
  [RainyWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [void][RainyWin32]::SetCursorPos([int]$cfg.toX, [int]$cfg.toY)
  Start-Sleep -Milliseconds 60
  [RainyWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  @{ ok = $true; action = $act; from = @{ x = [int]$cfg.x; y = [int]$cfg.y }; to = @{ x = [int]$cfg.toX; y = [int]$cfg.toY } } | ConvertTo-Json -Compress
} elseif ($act -eq 'scroll') {
  if ($null -ne $cfg.x -and $null -ne $cfg.y) { [void][RainyWin32]::SetCursorPos([int]$cfg.x, [int]$cfg.y) }
  [RainyWin32]::mouse_event(0x0800, 0, 0, [int]$cfg.amount, [UIntPtr]::Zero)
  @{ ok = $true; action = $act; amount = [int]$cfg.amount } | ConvertTo-Json -Compress
} elseif ($act -eq 'type' -or $act -eq 'keypress' -or $act -eq 'hotkey') {
  $keys = if ($act -eq 'type') { $cfg.text } else { $cfg.key }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  @{ ok = $true; action = $act; sent = $keys } | ConvertTo-Json -Compress
} elseif ($act -eq 'clipboard_get') {
  $clip = [System.Windows.Forms.Clipboard]::GetText()
  @{ ok = $true; action = $act; text = $clip } | ConvertTo-Json -Compress
} elseif ($act -eq 'clipboard_set') {
  [System.Windows.Forms.Clipboard]::SetText([string]$cfg.text)
  @{ ok = $true; action = $act; length = ([string]$cfg.text).Length } | ConvertTo-Json -Compress
} elseif ($act -eq 'open_app' -or $act -eq 'open_url') {
  $p = Start-Process -FilePath $cfg.target -PassThru
  @{ ok = $true; action = $act; target = $cfg.target; pid = if ($p) { $p.Id } else { $null } } | ConvertTo-Json -Compress
} else {
  throw "Unsupported computer_use action: $act"
}
`;
  const res = await runOneShot({ command: psScript, cwd: rootCwd, timeout: 25_000, shell: "powershell" });
  if (res.exitCode !== 0) {
    throw new Error(`computer_use (${action}) failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || "{}";
  const parsed = JSON.parse(line);
  if (parsed && parsed.screen && !Array.isArray(parsed.screens)) {
    parsed.screens = [parsed.screen];
  }
  if (parsed && parsed.windows && !Array.isArray(parsed.windows)) {
    parsed.windows = [parsed.windows];
  }
  return parsed;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async line => {
  let request;
  try { request = JSON.parse(line); } catch { process.stdout.write(`${outputValue({ id: null, error: "invalid JSON" })}\n`); return; }
  const id = request?.id ?? null;
  try {
    if (request.op === "hello") {
      const received = typeof request.args?.accessCode === "string" ? request.args.accessCode : "";
      if (expectedAccessCode && received !== expectedAccessCode) throw new Error("Worker access code rejected");
      authenticated = true;
      process.stdout.write(`${outputValue({ id, result: { workerName, platform: `${process.platform}/${process.arch}`, cwd: rootCwd, pid: process.pid } })}\n`);
      return;
    }
    if (!authenticated) throw new Error("Worker handshake is required");
    const result = await workerOperation(request.op, request.args || {});
    process.stdout.write(`${outputValue({ id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${outputValue({ id, error: error instanceof Error ? error.stack || error.message : String(error) })}\n`);
  }
});

async function shutdown() {
  for (const session of sessions.values()) await killTree(session.process);
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
