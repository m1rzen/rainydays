import { spawn, type ChildProcess } from "node:child_process";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { PathDeniedError } from "./path-policy.js";

function lifecycleFailure(message: string): PathDeniedError {
  return new PathDeniedError("PATH_LIFECYCLE_FAILED", message);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    const timer = setTimeout(
      () => finish(lifecycleFailure("Process tree did not exit before the lifecycle deadline")),
      timeoutMs
    );
    timer.unref?.();
    child.once("close", onClose);
  });
}

function bestEffortKill(child: ChildProcess): void {
  try { child.kill("SIGKILL"); }
  catch { /* The lifecycle failure remains authoritative. */ }
}

async function runWindowsTreeKiller(pid: number, timeoutMs: number): Promise<void> {
  const executable = await getBootstrapPathStore().openProcessTreeKiller();
  try {
    await executable.assertCurrent("beforeProcessSpawn");
    const killer = spawn(executable.canonicalPath, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.off("error", onError);
      killer.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(lifecycleFailure("Windows process-tree termination could not start"));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) finish();
      else finish(lifecycleFailure("Windows process-tree termination failed"));
    };
    const timer = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch { /* no-op */ }
      finish(lifecycleFailure("Windows process-tree termination timed out"));
    }, timeoutMs);
    timer.unref?.();
      killer.once("error", onError);
      killer.once("close", onClose);
    });
  } finally {
    await executable.close();
  }
}

/**
 * Terminate a child process tree and resolve only after the direct child exits.
 * On Windows, a failed/non-zero taskkill is always a hard lifecycle failure;
 * killing only the parent cannot prove that descendants were removed.
 */
export async function terminateProcessTree(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Process-tree termination timeout is invalid");
  }
  if (hasExited(child)) {
    throw lifecycleFailure("Exited process root cannot prove that descendants were removed");
  }
  const pid = child.pid;
  if (!pid) throw lifecycleFailure("Process tree has no verifiable PID");

  if (process.platform === "win32") {
    try {
      await runWindowsTreeKiller(pid, timeoutMs);
    } catch (error) {
      bestEffortKill(child);
      throw error;
    }
    await waitForExit(child, timeoutMs);
    return;
  }

  try { child.kill("SIGTERM"); }
  catch { /* final verification below remains authoritative */ }
  try {
    await waitForExit(child, Math.min(timeoutMs, 500));
    return;
  } catch {
    bestEffortKill(child);
  }
  await waitForExit(child, timeoutMs);
}
