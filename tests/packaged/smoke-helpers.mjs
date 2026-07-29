import assert from "node:assert/strict";
import { spawnManaged, waitFor } from "../helpers.mjs";

export function classifyInstallerResult(result, timedOut = false) {
  if (timedOut) return "timed-out";
  if (result?.signal) return "signal-crash";
  if (result?.code === 0) return "passed";
  if (Number.isInteger(result?.code) && (result.code >>> 0) >= 0xC0000000) return "windows-crash";
  return "non-zero";
}

export function requireObservedProcessResult(result, allowedCodes, label) {
  assert(result && typeof result === "object", `${label} produced no result`);
  assert.equal(result.signal, null, `${label} crashed`);
  assert(allowedCodes.includes(result.code), `${label} failed with ${result.code}`);
  return result;
}

export function launchTracked(command, args, { env, timeoutMs, label, readyProbe }) {
  const child = spawnManaged(command, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const instance = { child, logs: () => ({ stdout, stderr }), ready: null };
  instance.ready = waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}: ${stdout}\n${stderr}`);
    return await readyProbe();
  }, { timeoutMs, label });
  return instance;
}
