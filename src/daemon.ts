// ===========================================
// Daemon 守护进程 —— 后台运行 + 健康检查
// 用法：node dist/daemon.js
// 功能：启动并监控 Express 服务器，崩溃时自动重启
// ===========================================

import { spawn, type ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { terminateProcessTree } from "./process-tree.js";
const MAX_RESTARTS = 5;
const RESTART_DELAY = 3000; // 3 秒

let restartCount = 0;
let lastRestartTime = 0;
let serverProcess: any = null;
let isShuttingDown = false;

function handleStartFailure(error: unknown): void {
  console.error("[Daemon] 启动失败:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function waitForRuntimeLoaded(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "rainydays-runtime-loaded") finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error("Daemon server exited before runtime code loaded"));
    const timer = setTimeout(() => finish(new Error("Daemon server runtime load timed out")), 30_000);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function startServer() {
  console.log(`[Daemon] 启动服务器 (第 ${restartCount + 1} 次)...`);

  const store = getBootstrapPathStore();
  const [nodeExecutable, tsxLoader, serverScript] = await Promise.all([
    store.openNodeExecutable(),
    store.openDaemonTsxLoader(),
    store.openDaemonServerScript(),
  ]);
  try {
    serverProcess = await store.withAppCwd(async canonicalCwd => {
      await Promise.all([
        nodeExecutable.assertCurrent("beforeProcessSpawn"),
        tsxLoader.assertCurrent("beforeProcessSpawn"),
        serverScript.assertCurrent("beforeProcessSpawn"),
      ]);
      const childEnvironment = { ...process.env };
      delete childEnvironment.NODE_OPTIONS;
      delete childEnvironment.NODE_PATH;
      const wrapper = `const runtime = await import(${JSON.stringify(pathToFileURL(serverScript.canonicalPath).href)}); await runtime.ready; process.send?.({ type: "rainydays-runtime-loaded" });`;
      const child = spawn(nodeExecutable.canonicalPath, [
        "--import", pathToFileURL(tsxLoader.canonicalPath).href,
        "--input-type=module", "--eval", wrapper,
      ], {
        cwd: canonicalCwd,
        env: childEnvironment,
        shell: false,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      await waitForRuntimeLoaded(child);
      return child;
    });
  } finally {
    await Promise.all([serverScript.close(), tsxLoader.close(), nodeExecutable.close()]);
  }

  serverProcess.on("exit", (code: number) => {
    if (isShuttingDown) return;

    console.log(`[Daemon] 服务器退出，代码: ${code}`);

    // 如果是正常退出（code=0），不重启
    if (code === 0) return;

    // 检查重启频率——防止快速崩溃循环
    const now = Date.now();
    if (now - lastRestartTime < 5000) {
      restartCount++;
    } else {
      restartCount = 0;
    }
    lastRestartTime = now;

    if (restartCount >= MAX_RESTARTS) {
      console.error(`[Daemon] 已达到最大重启次数 (${MAX_RESTARTS})，停止重启`);
      process.exit(1);
    }

    console.log(`[Daemon] ${RESTART_DELAY / 1000} 秒后重启...`);
    setTimeout(() => void startServer().catch(handleStartFailure), RESTART_DELAY);
  });

  serverProcess.on("error", (err: Error) => {
    console.error(`[Daemon] 启动失败:`, err.message);
  });
}

// 健康检查——每 60 秒检查一次
const healthCheckInterval = setInterval(async () => {
  if (!serverProcess || isShuttingDown) return;

  try {
    const response = await fetch("http://localhost:3111/api/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[Daemon] 健康检查失败: HTTP ${response.status}`);
    }
  } catch {
    console.warn("[Daemon] 健康检查失败: 服务器无响应");
    // 如果服务器无响应且进程还在，尝试重启
    if (serverProcess && !serverProcess.killed) {
      console.log("[Daemon] 尝试重启服务器...");
      serverProcess.kill("SIGTERM");
    }
  }
}, 60000);

// 优雅关闭
let shutdownPromise: Promise<void> | null = null;
function shutdownDaemon(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[Daemon] 收到 ${signal}，正在关闭...`);
    isShuttingDown = true;
    clearInterval(healthCheckInterval);
    if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      await terminateProcessTree(serverProcess);
    }
    await getBootstrapPathStore().close();
  })();
  return shutdownPromise;
}

function finishShutdown(signal: "SIGINT" | "SIGTERM"): void {
  void shutdownDaemon(signal).then(
    () => process.exit(0),
    error => {
      console.error("[Daemon] 关闭失败:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => finishShutdown(signal));
process.on("message", message => {
  if (message && typeof message === "object"
    && Object.keys(message).length === 1
    && (message as { type?: unknown }).type === "rainydays-daemon-shutdown") finishShutdown("SIGTERM");
});

// 启动
console.log("[Daemon] 守护进程已启动");
void startServer().catch(handleStartFailure);
