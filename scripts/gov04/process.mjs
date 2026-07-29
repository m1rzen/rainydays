import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { terminateProcessTreeAsync } from "../../tests/helpers.mjs";

function outputCollector(limit) {
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  const hash = createHash("sha256");
  return {
    write(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(value);
      bytes += value.length;
      if (!exceeded && bytes <= limit) chunks.push(value);
      else exceeded = true;
    },
    result() {
      return {
        text: exceeded ? null : Buffer.concat(chunks).toString("utf8"),
        bytes,
        sha256: hash.digest("hex"),
        exceeded,
      };
    },
  };
}

export async function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw Object.assign(new Error("Pinned npm CLI is unavailable"), { code: "NPM_CLI_UNAVAILABLE" });
}

export function safeChildEnvironment(extra = {}) {
  const allowed = [
    "ALLUSERSPROFILE", "APPDATA", "ComSpec", "CommonProgramFiles", "CommonProgramFiles(x86)", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "Path", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "SystemDrive", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "CI", "GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_SHA",
  ];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

export async function runBoundedProcess(command, args, {
  cwd,
  env = safeChildEnvironment(),
  timeoutMs = 120_000,
  maxOutputBytes = 16 * 1024 * 1024,
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const stdout = outputCollector(maxOutputBytes);
  const stderr = outputCollector(maxOutputBytes);
  child.stdout.on("data", (chunk) => stdout.write(chunk));
  child.stderr.on("data", (chunk) => stderr.write(chunk));
  let timer;
  let settled = false;
  let termination = null;
  const outcome = await new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", (cause) => {
      const error = new Error(`Failed to spawn ${command}`, { cause });
      error.code = "PROCESS_SPAWN_FAILED";
      fail(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
    timer = setTimeout(async () => {
      if (settled) return;
      try { termination = await terminateProcessTreeAsync(child); }
      catch { termination = { attempted: true, exitCode: 1, childExited: false }; }
      const cleanupPassed = termination.exitCode === 0 && termination.childExited;
      const error = new Error(cleanupPassed ? "Process timed out" : "Process timeout cleanup failed");
      error.code = cleanupPassed ? "PROCESS_TIMEOUT" : "PROCESS_TIMEOUT_CLEANUP_FAILED";
      error.timedOut = true;
      error.termination = termination;
      fail(error);
    }, timeoutMs);
  });
  const stdoutResult = stdout.result();
  const stderrResult = stderr.result();
  if (stdoutResult.exceeded || stderrResult.exceeded) {
    if (child.exitCode === null) termination = await terminateProcessTreeAsync(child);
    const error = new Error("Process output exceeded governed limit");
    error.code = "PROCESS_OUTPUT_LIMIT";
    error.termination = termination;
    error.observation = { pid: child.pid ?? null, stdout: stdoutResult, stderr: stderrResult };
    throw error;
  }
  return {
    pid: child.pid ?? null,
    code: outcome.code,
    signal: outcome.signal,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutBytes: stdoutResult.bytes,
    stderrBytes: stderrResult.bytes,
    stdoutSha256: stdoutResult.sha256,
    stderrSha256: stderrResult.sha256,
  };
}
