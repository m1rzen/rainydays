// ===========================================
// Electron 主进程
// 开发态启动 tsx；正式包直接加载 dist，不依赖系统 Node/npm
// ===========================================

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, dialog, ipcMain, safeStorage, screen } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { ElectronBootstrapPathStore, ElectronPathError } = require("./path-bootstrap.cjs");
const { migrateLegacyUserData } = require("./user-data-migration.cjs");
const { assertTrustedJsonDownload, assertTrustedRendererBinding, parseDialogRequest, parseNotification, parseTrayState, parseWindowAction } = require("./ipc-contract.cjs");
const { ServiceSupervisor } = require("./service-supervisor.cjs");
const { createWindowStateStore, parseLaunchIntent, resolveWindowState } = require("./window-lifecycle.cjs");
const { createRecoveryStateStore } = require("./recovery-state.cjs");
const originalFs = require("original-fs");

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverSupervisor = null;
let serviceHealthInterval = null;
let serviceHealthFailures = 0;
let serviceHealthProbeActive = false;
const serviceControlRequests = new Map();
let buildInfo = null;
let electronPaths = null;
let preloadLease = null;
let apiHeaderSession = null;
let childNativeProcessConsentTransport = null;
let mainFrameGeneration = 0;
let quitCleanupPromise = null;
let finalQuit = false;
let windowStateStore = null;
let applyingWindowState = false;
let pendingLaunchIntent = null;
const rendererCrashTimes = [];
const electronChildCrashTimes = [];
let recoveryStateStore = null;
let recoveryState = null;
let recoveryWindow = null;
let recoveryRelaunchRequested = false;
let safeModeTransitionPromise = null;
let port = Number(process.env.PORT || 3111);
const apiToken = randomBytes(32).toString("hex");
const terminalConsentOperations = Object.freeze(["start", "clear", "kill", "close"]);
const terminalInteractionOperations = Object.freeze(["input", "resize"]);
const terminalConsentChannels = Object.freeze([...terminalConsentOperations, ...terminalInteractionOperations].map(operation => `rainydays:terminal-${operation}`));
const desktopIpcChannels = Object.freeze([
  "rainydays:capabilities",
  "rainydays:dialog-directory",
  "rainydays:dialog-file",
  "rainydays:dialog-save",
  "rainydays:window-state",
  "rainydays:window-action",
  "rainydays:notify",
  "rainydays:tray-state",
]);
const notificationTimes = [];
let trayState = Object.freeze({ unread: 0, running: 0, errors: 0, firstUnreadSessionId: null });

let legacyUserDataMigrationError = null;
if (app.isPackaged && !process.argv.some(argument => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="))) {
  try {
    migrateLegacyUserData({
      appDataRoot: app.getPath("appData"),
      currentUserData: app.getPath("userData"),
    });
  } catch (error) {
    legacyUserDataMigrationError = error;
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => handleLaunchIntent(parseLaunchIntent(commandLine)));
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleLaunchIntent(parseLaunchIntent([url]));
});

app.on("child-process-gone", (_event, details) => {
  const type = typeof details?.type === "string" ? details.type.slice(0, 40) : "unknown";
  const reason = typeof details?.reason === "string" ? details.reason.slice(0, 40) : "unknown";
  console.error(JSON.stringify({ event: "rainydays_electron_child_gone", type, reason }));
  if (type !== "Utility" || reason === "clean-exit" || app.isQuitting) return;
  const now = Date.now();
  while (electronChildCrashTimes.length > 0 && now - electronChildCrashTimes[0] > 60_000) electronChildCrashTimes.shift();
  electronChildCrashTimes.push(now);
  if (electronChildCrashTimes.length > 2) void activateSafeMode("electron-child-crash-loop");
});

function canListen(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function choosePort(preferred) {
  for (let candidate = preferred; candidate < preferred + 20; candidate++) {
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`无法找到可用端口（${preferred}-${preferred + 19}）`);
}

function loadBuildInfo() {
  if (!electronPaths) throw new Error("Electron bootstrap paths are unavailable");
  let lease = null;
  let parsed;
  try {
    lease = electronPaths.openAppFile("build-info.json", "build-metadata");
    parsed = JSON.parse(lease.readBytes(256 * 1024).toString("utf8"));
    lease.verify();
  } catch {
    throw new Error("RainyDays 构建元数据缺失或损坏");
  } finally {
    lease?.close();
  }
  if (parsed?.schemaVersion !== 1 || parsed?.product !== "RainyDays"
    || typeof parsed.appVersion !== "string" || typeof parsed.buildId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(parsed.buildId)
    || typeof parsed.candidateId !== "string" || !/^[a-f0-9]{64}$/.test(parsed.candidateId)
    || typeof parsed.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sourceDigest)
    || (parsed.buildIdSource !== "derived" && parsed.buildIdSource !== "ci")
    || (parsed.buildIdSource === "derived" && (parsed.buildId !== `${parsed.appVersion}+local.${parsed.sourceDigest.slice(0, 12)}` || parsed.candidateId !== parsed.sourceDigest))
    || (parsed.buildIdSource === "ci" && parsed.buildId !== `${parsed.appVersion}+ci.${parsed.candidateId}`)) {
    throw new Error("RainyDays 构建元数据格式无效");
  }
  if (app.getVersion() !== parsed.appVersion) {
    throw new Error(`应用版本不一致: Electron ${app.getVersion()}，构建元数据 ${parsed.appVersion}`);
  }
  return parsed;
}

const inheritedEnvironmentKeys = Object.freeze([
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "PROCESSOR_ARCHITECTURE",
  "DEEPSEEK_BASE_URL", "LLM_BASE_URL", "LLM_MODEL", "DEFAULT_PERSONA", "RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER",
]);

function inheritedEnvironment() {
  return Object.fromEntries(inheritedEnvironmentKeys
    .filter(key => typeof process.env[key] === "string")
    .map(key => [key, process.env[key]]));
}

function clearUntrustedPathEnvironment() {
  for (const key of ["WORKSPACE_ROOT", "DEPARTMENT_DATA_ROOT", "OUTPUT_DIR"]) delete process.env[key];
}

function runtimeEnvironment() {
  if (!buildInfo || !electronPaths) throw new Error("RainyDays bootstrap state is unavailable");
  const { appRoot, userData } = electronPaths.runtimeRoots();
  return {
    ...inheritedEnvironment(),
    PORT: String(port),
    HOST: "127.0.0.1",
    RAINYDAYS_API_TOKEN: apiToken,
    RAINYDAYS_APP_VERSION: buildInfo.appVersion,
    RAINYDAYS_BUILD_ID: buildInfo.buildId,
    RAINYDAYS_ELECTRON_VERSION: process.versions.electron || "",
    RAINYDAYS_APP_ROOT: appRoot,
    RAINYDAYS_USER_DATA_DIR: userData,
    RAINYDAYS_DATA_DIR: path.join(userData, "data"),
    RAINYDAYS_CONFIG_PATH: path.join(userData, "config.json"),
    RAINYDAYS_USER_PERSONAS_DIR: path.join(userData, "personas"),
    RAINYDAYS_USER_SKILLS_DIR: path.join(userData, "skills"),
    RAINYDAYS_PLAYBOOKS_DIR: path.join(userData, "playbooks"),
    RAINYDAYS_ORACLE_PATH: path.join(userData, "LUX.oracle"),
    RAINYDAYS_MODELS_DIR: path.join(appRoot, "models"),
  };
}

let safeStorageDurabilityPromise = null;

function readSafeStorageKeyIdentity(flush = false) {
  let lease = null;
  try {
    lease = electronPaths.openUserDataFile("Local State", "safe-storage-local-state");
    const parsed = JSON.parse(lease.readBytes(256 * 1024).toString("utf8"));
    if (flush) lease.flush();
    lease.verify("safe-storage-state-read");
    const encryptedKey = parsed?.os_crypt?.encrypted_key;
    if (typeof encryptedKey !== "string" || encryptedKey.length < 4 || encryptedKey.length > 8 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encryptedKey)) return null;
    const decoded = Buffer.from(encryptedKey, "base64");
    if (decoded.length < 1 || decoded.length > 4 * 1024 || decoded.toString("base64") !== encryptedKey) return null;
    return encryptedKey;
  } catch (error) {
    if (error instanceof ElectronPathError) throw error;
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return null;
  } finally {
    lease?.close();
  }
}

async function awaitSafeStorageDurability() {
  if (!safeStorageDurabilityPromise) {
    safeStorageDurabilityPromise = (async () => {
      const deadline = Date.now() + 20_000;
      let previous = null;
      while (Date.now() < deadline) {
        const current = readSafeStorageKeyIdentity();
        if (current && current === previous) {
          const flushed = readSafeStorageKeyIdentity(true);
          if (flushed === current && readSafeStorageKeyIdentity() === current) return;
        }
        previous = current;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("OS credential protection state did not become durable");
    })().catch(error => {
      safeStorageDurabilityPromise = null;
      throw error;
    });
  }
  await safeStorageDurabilityPromise;
}

async function protectCredential(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential protection is unavailable");
  const ciphertext = safeStorage.encryptString(plaintext);
  await awaitSafeStorageDurability();
  return ciphertext;
}

async function startPackagedServerProcess() {
  const executableLease = electronPaths.openExternalBootstrapExecutable(process.execPath, "packaged-electron-node");
  const serverLease = electronPaths.openAppFile(path.join("dist", "index.js"), "packaged-server-entry");
  try {
    return await startServerProcess(executableLease, [serverLease], { ELECTRON_RUN_AS_NODE: "1" });
  } finally {
    serverLease.close();
    executableLease.close();
  }
}

function selectServerMode() {
  const requested = process.env.RAINYDAYS_E2E_USE_DIST;
  const nodeExecutable = process.env.RAINYDAYS_E2E_NODE_EXECUTABLE;
  delete process.env.RAINYDAYS_E2E_USE_DIST;
  delete process.env.RAINYDAYS_E2E_NODE_EXECUTABLE;
  if (app.isPackaged) return { type: "packaged" };
  if (requested === undefined) {
    if (nodeExecutable !== undefined) throw new Error("RAINYDAYS_E2E_NODE_EXECUTABLE requires RAINYDAYS_E2E_USE_DIST=1");
    return { type: "source" };
  }
  if (requested !== "1") throw new Error("RAINYDAYS_E2E_USE_DIST must be exactly 1 when set");
  if (!nodeExecutable) throw new Error("RAINYDAYS_E2E_NODE_EXECUTABLE is required");
  return { type: "compiled", executablePath: nodeExecutable };
}

async function probeServiceReady() {
  const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
    headers: { "X-RainyDays-Token": apiToken },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`RainyDays readiness probe failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ready !== true || body?.buildId !== buildInfo.buildId) {
    throw new Error("RainyDays readiness payload is invalid");
  }
}

function waitForServiceReady(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let probing = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (probing || !message || typeof message !== "object" || Array.isArray(message)) return;
      const keys = Object.keys(message).sort();
      if (keys.length !== 4 || keys[0] !== "host" || keys[1] !== "pid" || keys[2] !== "port" || keys[3] !== "type"
        || message.type !== "rainydays-service-ready" || message.host !== "127.0.0.1"
        || message.port !== port || message.pid !== child.pid) return;
      probing = true;
      void probeServiceReady().then(() => finish(), finish);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`RainyDays service exited before readiness (code ${code}, signal ${signal})`));
    const timer = setTimeout(() => finish(new Error("RainyDays service readiness timed out")), 30_000);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function rejectServiceControlRequests(child, reason) {
  for (const [requestId, pending] of serviceControlRequests) {
    if (pending.child !== child) continue;
    serviceControlRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
}

function handleServiceControlResult(child, message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.type !== "rainydays-control-result") return false;
  const pending = typeof message.requestId === "string" ? serviceControlRequests.get(message.requestId) : null;
  if (!pending || pending.child !== child) return true;
  const success = message.ok === true
    && JSON.stringify(Object.keys(message).sort()) === JSON.stringify(["ok", "requestId", "type", "value"]);
  const failure = message.ok === false
    && JSON.stringify(Object.keys(message).sort()) === JSON.stringify(["error", "ok", "requestId", "type"])
    && message.error && typeof message.error === "object" && !Array.isArray(message.error)
    && JSON.stringify(Object.keys(message.error).sort()) === JSON.stringify(["code", "message", "name"])
    && typeof message.error.name === "string" && typeof message.error.message === "string"
    && (message.error.code === null || typeof message.error.code === "string");
  if (!success && !failure) return true;
  serviceControlRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (success) pending.resolve(message.value);
  else {
    const error = new Error(message.error.message);
    error.name = message.error.name;
    if (message.error.code !== null) error.code = message.error.code;
    pending.reject(error);
  }
  return true;
}

function callServiceControl(operation, args) {
  const child = serverProcess;
  if (!child || !child.connected || child.exitCode !== null || child.signalCode !== null
    || serverSupervisor?.snapshot().phase !== "ready") {
    return Promise.reject(new Error("RainyDays service control channel is unavailable"));
  }
  if (typeof operation !== "string" || !Array.isArray(args)) return Promise.reject(new TypeError("Service control request is invalid"));
  const requestId = randomBytes(16).toString("hex");
  const request = Object.freeze({ type: "rainydays-control-request", requestId, operation, args });
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 256 * 1024) {
    return Promise.reject(new TypeError("Service control request is too large"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serviceControlRequests.delete(requestId);
      reject(new Error("RainyDays service control request timed out"));
    }, 15_000);
    timer.unref?.();
    serviceControlRequests.set(requestId, { child, resolve, reject, timer });
    child.send(request, error => {
      if (!error) return;
      const pending = serviceControlRequests.get(requestId);
      if (!pending) return;
      serviceControlRequests.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function startServerProcess(commandLease, argumentLeases, extraEnvironment = {}) {
  commandLease.verify();
  for (const lease of argumentLeases) lease.verify();
  const { createNativeProcessConsentParentTransport } = await import("../dist/native-process-consent-transport.js");
  let child = null;
  let consentTransport = null;
  try {
    await electronPaths.withRuntimeAppRootDirectory("server-process-cwd", async canonicalCwd => {
      commandLease.verify("before-server-process-spawn");
      for (const lease of argumentLeases) lease.verify("before-server-process-spawn");
      child = spawn(commandLease.canonicalPath, argumentLeases.map(lease => lease.canonicalPath), {
        cwd: canonicalCwd,
        env: { ...runtimeEnvironment(), ...extraEnvironment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      serverProcess = child;
      child.stdout.on("data", data => console.log("[server]", data.toString().trim()));
      child.stderr.on("data", data => console.log("[server error]", data.toString().trim()));
      child.on("message", async message => {
        if (handleServiceControlResult(child, message)) return;
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        const keys = Object.keys(message).sort();
        if (keys.length !== 4 || keys[0] !== "operation" || keys[1] !== "requestId" || keys[2] !== "type" || keys[3] !== "value"
          || message.type !== "rainydays-credential-request"
          || typeof message.requestId !== "string" || !/^[a-f0-9]{32}$/.test(message.requestId)
          || (message.operation !== "protect" && message.operation !== "unprotect")
          || typeof message.value !== "string" || message.value.length < 1 || message.value.length > 128 * 1024) return;
        let response;
        try {
          let value;
          if (message.operation === "protect") {
            value = (await protectCredential(message.value)).toString("base64");
          } else {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.value)) {
              throw new Error("Credential ciphertext encoding is invalid");
            }
            const ciphertext = Buffer.from(message.value, "base64");
            if (ciphertext.length < 1 || ciphertext.length > 64 * 1024 || ciphertext.toString("base64") !== message.value) {
              throw new Error("Credential ciphertext encoding is invalid");
            }
            if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential protection is unavailable");
            value = safeStorage.decryptString(ciphertext);
          }
          response = { type: "rainydays-credential-result", requestId: message.requestId, ok: true, value };
        } catch {
          console.error(`[credential-service] ${message.operation} failed`);
          response = { type: "rainydays-credential-result", requestId: message.requestId, ok: false };
        }
        if (child.connected) child.send(response);
      });
      const requestPipe = child.stdio[3];
      const responsePipe = child.stdio[4];
      if (!requestPipe || !responsePipe) throw new Error("Native process consent pipes are unavailable");
      consentTransport = createNativeProcessConsentParentTransport({
        request: requestPipe,
        response: responsePipe,
        decide: handleNativeProcessConsent,
      });
      childNativeProcessConsentTransport = consentTransport;
      child.once("exit", (code, signal) => {
        rejectServiceControlRequests(child, new Error(`RainyDays service exited (code ${code}, signal ${signal})`));
        consentTransport?.close();
        if (childNativeProcessConsentTransport === consentTransport) childNativeProcessConsentTransport = null;
        if (serverProcess === child) serverProcess = null;
      });
      await Promise.all([consentTransport.ready, waitForServiceReady(child)]);
    });
    commandLease.verify();
    for (const lease of argumentLeases) lease.verify();
    return child;
  } catch (error) {
    consentTransport?.close();
    if (childNativeProcessConsentTransport === consentTransport) childNativeProcessConsentTransport = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await terminateServerProcess(child, "failed-launch");
      } catch (cleanupError) {
        if (serverProcess === child) serverProcess = null;
        throw new AggregateError([error, cleanupError], "RainyDays service launch cleanup failed", { cause: error });
      }
    }
    if (serverProcess === child) serverProcess = null;
    throw error;
  }
}

async function startDevelopmentServer() {
  const executableLease = electronPaths.openExternalTestExecutable(process.execPath);
  const tsxLease = electronPaths.openAppFile(path.join("node_modules", "tsx", "dist", "cli.mjs"), "source-tsx-entry");
  const sourceLease = electronPaths.openAppFile(path.join("src", "index.ts"), "source-server-entry");
  try {
    return await startServerProcess(executableLease, [tsxLease, sourceLease], { ELECTRON_RUN_AS_NODE: "1" });
  } finally {
    sourceLease.close();
    tsxLease.close();
    executableLease.close();
  }
}

async function startCompiledTestServer(executablePath) {
  const executableLease = electronPaths.openExternalTestExecutable(executablePath);
  const serverLease = electronPaths.openAppFile(path.join("dist", "index.js"), "compiled-server-entry");
  try {
    return await startServerProcess(executableLease, [serverLease]);
  } finally {
    serverLease.close();
    executableLease.close();
  }
}

function startConfiguredServer(mode) {
  if (mode.type === "packaged") return startPackagedServerProcess();
  if (mode.type === "compiled") return startCompiledTestServer(mode.executablePath);
  return startDevelopmentServer();
}

function reportServiceState(state) {
  if (state.phase === "ready") serviceHealthFailures = 0;
  const payload = {
    event: "rainydays_service_state",
    phase: state.phase,
    generation: state.generation,
    restartCount: state.restartCount,
    restartDelayMs: state.restartDelayMs,
    pid: state.pid,
    failure: state.failure,
  };
  if (state.phase === "crash-loop") {
    console.error(JSON.stringify(payload));
    void activateSafeMode("service-crash-loop");
  } else console.log(JSON.stringify(payload));
}

function startServiceHealthMonitor() {
  if (serviceHealthInterval) return;
  serviceHealthInterval = setInterval(() => {
    if (serviceHealthProbeActive || app.isQuitting || serverSupervisor?.snapshot().phase !== "ready") return;
    serviceHealthProbeActive = true;
    void probeServiceReady().then(
      () => { serviceHealthFailures = 0; },
      error => {
        serviceHealthFailures += 1;
        console.warn(`[service-health] readiness failure ${serviceHealthFailures}: ${error instanceof Error ? error.message : String(error)}`);
        if (serviceHealthFailures >= 3) {
          serviceHealthFailures = 0;
          void serverSupervisor?.restart("health-check-failed").catch(restartError => {
            console.error("[service-health] restart failed:", restartError instanceof Error ? restartError.message : String(restartError));
          });
        }
      },
    ).finally(() => { serviceHealthProbeActive = false; });
  }, 15_000);
  serviceHealthInterval.unref?.();
}

function stopServiceHealthMonitor() {
  if (serviceHealthInterval) clearInterval(serviceHealthInterval);
  serviceHealthInterval = null;
  serviceHealthFailures = 0;
  serviceHealthProbeActive = false;
}

function releasePreloadLease() {
  const lease = preloadLease;
  preloadLease = null;
  lease?.close();
}

function nativeProcessDialogDetail(challenge) {
  return [
    `工具: ${challenge.toolName}`,
    `根别名: ${challenge.rootAliases.join(", ") || "(none)"}`,
    `工作目录: ${challenge.cwd}`,
    `Profile: ${challenge.profile}`,
    `参数 UTF-8 字节数: ${challenge.argumentsUtf8Bytes}`,
    `参数 SHA-256: ${challenge.argumentsBytesSha256}`,
    `参数摘要: ${challenge.argumentsDigest}`,
    `预览${challenge.previewTruncated ? "（已截断）" : ""}: ${challenge.preview}`,
  ].join("\n");
}

function exactNativeProcessWindow(snapshot) {
  const window = mainWindow;
  return Boolean(window && window === snapshot.window && !window.isDestroyed()
    && window.webContents === snapshot.webContents && !window.webContents.isDestroyed()
    && window.webContents.mainFrame === snapshot.mainFrame
    && mainFrameGeneration === snapshot.mainFrameGeneration
    && window.isVisible() && window.isFocused());
}

async function handleNativeProcessConsent(challenge) {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return "deny";
  const snapshot = Object.freeze({
    window,
    webContents: window.webContents,
    mainFrame: window.webContents.mainFrame,
    mainFrameGeneration,
  });
  if (!exactNativeProcessWindow(snapshot)) return "deny";
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["拒绝", "允许"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "允许受管进程执行？",
    detail: nativeProcessDialogDetail(challenge),
  });
  if (!exactNativeProcessWindow(snapshot)) return "deny";
  return choice.response === 1 ? "approve" : "deny";
}

function reportControlFailure(operation, error) {
  console.error(`[service-control] ${operation} failed:`, error instanceof Error ? error.message : String(error));
}

function invalidateAllNativeConsent() {
  void callServiceControl("invalidate-native-consent", []).catch(error => reportControlFailure("invalidate-native-consent", error));
}

const manualTerminalConsentServer = Object.freeze({
  prepareManualTerminalConsent: (...args) => callServiceControl("prepare-manual-terminal", args),
  decideManualTerminalConsent: (...args) => callServiceControl("decide-manual-terminal", args),
  writeInteractiveTerminal: (...args) => callServiceControl("write-interactive-terminal", args),
  resizeInteractiveTerminal: (...args) => callServiceControl("resize-interactive-terminal", args),
});

function requireManualTerminalConsentServer() {
  if (serverSupervisor?.snapshot().phase !== "ready") throw new Error("Manual terminal consent is unavailable");
  return manualTerminalConsentServer;
}

function manualTerminalPresence(event) {
  const window = assertTrustedRendererBinding(event, mainWindow, `http://127.0.0.1:${port}`, {
    label: "Manual terminal consent",
    requireFocus: true,
  });
  return Object.freeze({
    windowId: window.id,
    webContentsId: window.webContents.id,
    topFrame: true,
    windowVisible: true,
    windowFocused: true,
  });
}

function manualTerminalDialogDetail(challenge) {
  const { display } = challenge;
  return [
    `目标: ${display.targetLabel}`,
    `根: ${display.rootAlias}`,
    `预览: ${display.preview}`,
    `摘要: ${challenge.argumentsDigest}`,
  ].join("\n");
}

async function handleManualTerminalConsent(event, operation, request) {
  const consentServer = requireManualTerminalConsentServer();
  const presence = manualTerminalPresence(event);
  const challenge = await consentServer.prepareManualTerminalConsent(operation, request, presence);
  const window = mainWindow;
  if (!window || window.isDestroyed()) throw new Error("Manual terminal consent window is unavailable");
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["拒绝", "允许"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: challenge.display.operationLabel,
    detail: manualTerminalDialogDetail(challenge),
  });
  const decisionPresence = manualTerminalPresence(event);
  return consentServer.decideManualTerminalConsent(
    challenge.challengeId,
    choice.response === 1 ? "approve" : "deny",
    operation,
    challenge.argumentsDigest,
    decisionPresence
  );
}

function registerManualTerminalConsentHandlers() {
  for (const operation of terminalConsentOperations) {
    ipcMain.handle(`rainydays:terminal-${operation}`, (event, request) =>
      handleManualTerminalConsent(event, `terminal-${operation}`, request));
  }
  ipcMain.handle("rainydays:terminal-input", async (event, request) => {
    const consentServer = requireManualTerminalConsentServer();
    try { return await consentServer.writeInteractiveTerminal(request, manualTerminalPresence(event)); }
    catch (error) {
      if (error?.code !== "PTY_INTERACTION_GRANT_REQUIRED") throw error;
      return handleManualTerminalConsent(event, "terminal-input", request);
    }
  });
  ipcMain.handle("rainydays:terminal-resize", (event, request) => {
    const consentServer = requireManualTerminalConsentServer();
    return consentServer.resizeInteractiveTerminal(request, manualTerminalPresence(event));
  });
}

function removeManualTerminalConsentHandlers() {
  for (const channel of terminalConsentChannels) ipcMain.removeHandler(channel);
}

function trustedRendererWindow(event, requireFocus = false) {
  return assertTrustedRendererBinding(event, mainWindow, `http://127.0.0.1:${port}`, {
    label: "Desktop IPC",
    requireFocus,
  });
}

function windowState(window) {
  const bounds = window.getBounds();
  return Object.freeze({
    minimized: window.isMinimized(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    bounds: Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
  });
}

function reportWindowLifecycle(event, outcome) {
  console.log(JSON.stringify({ event: "rainydays_window_lifecycle", action: event, outcome }));
}

function displayTopology() {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return screen.getAllDisplays().map(display => Object.freeze({
    id: String(display.id),
    primary: String(display.id) === primaryId,
    workArea: Object.freeze({
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    }),
  }));
}

function captureMainWindowState(window = mainWindow) {
  if (!window || window.isDestroyed()) return null;
  const bounds = (window.isMaximized() || window.isFullScreen()) && typeof window.getNormalBounds === "function"
    ? window.getNormalBounds()
    : window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return Object.freeze({
    schemaVersion: 1,
    bounds: Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    displayId: String(display.id),
  });
}

function saveMainWindowState(immediate = false) {
  if (applyingWindowState || !windowStateStore) return;
  const state = captureMainWindowState();
  if (!state) return;
  try {
    windowStateStore.schedule(state);
    if (immediate) windowStateStore.flush();
  } catch {
    reportWindowLifecycle("state-save", "failure");
  }
}

function sameBounds(left, right) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function reconcileMainWindowBounds() {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const current = captureMainWindowState(window);
  const reachable = resolveWindowState(current, displayTopology());
  if (sameBounds(current.bounds, reachable.bounds)) {
    saveMainWindowState();
    return;
  }
  applyingWindowState = true;
  try {
    if (current.fullscreen) window.setFullScreen(false);
    if (current.maximized) window.unmaximize();
    window.setBounds(reachable.bounds, false);
    if (current.maximized) window.maximize();
    if (current.fullscreen) window.setFullScreen(true);
    reportWindowLifecycle("display-reconcile", "success");
  } finally {
    applyingWindowState = false;
  }
  saveMainWindowState();
}

function onDisplayTopologyChanged() {
  reconcileMainWindowBounds();
}

function installDisplayLifecycle() {
  screen.on("display-added", onDisplayTopologyChanged);
  screen.on("display-removed", onDisplayTopologyChanged);
  screen.on("display-metrics-changed", onDisplayTopologyChanged);
}

function removeDisplayLifecycle() {
  screen.removeListener("display-added", onDisplayTopologyChanged);
  screen.removeListener("display-removed", onDisplayTopologyChanged);
  screen.removeListener("display-metrics-changed", onDisplayTopologyChanged);
}

function focusMainWindow() {
  const window = mainWindow ?? recoveryWindow;
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

function deliverPendingLaunchIntent() {
  const intent = pendingLaunchIntent;
  const window = mainWindow;
  if (!intent?.sessionId || !window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  pendingLaunchIntent = null;
  window.webContents.send("rainydays:notification-clicked", Object.freeze({
    id: null,
    sessionId: intent.sessionId,
    targetTab: "session",
  }));
  reportWindowLifecycle("launch-intent", "delivered");
}

function handleLaunchIntent(intent) {
  if (intent?.sessionId) pendingLaunchIntent = intent;
  focusMainWindow();
  deliverPendingLaunchIntent();
  reportWindowLifecycle("single-instance", intent?.sessionId ? "targeted" : "focused");
}

function handleRendererGone(window, details) {
  if (window !== mainWindow || window.isDestroyed() || app.isQuitting) return;
  const reason = typeof details?.reason === "string" ? details.reason.slice(0, 40) : "unknown";
  const now = Date.now();
  while (rendererCrashTimes.length > 0 && now - rendererCrashTimes[0] > 60_000) rendererCrashTimes.shift();
  rendererCrashTimes.push(now);
  console.error(JSON.stringify({ event: "rainydays_renderer_gone", reason, crashCount: rendererCrashTimes.length }));
  invalidateManualTerminalConsent();
  invalidateAllNativeConsent();
  if (rendererCrashTimes.length > 2) {
    void activateSafeMode("renderer-crash-loop");
    return;
  }
  const timer = setTimeout(() => {
    if (window !== mainWindow || window.isDestroyed() || app.isQuitting) return;
    void window.loadURL(`http://127.0.0.1:${port}/`).catch(error => {
      console.error("RainyDays renderer recovery failed", error instanceof Error ? error.message : String(error));
    });
  }, 250 * rendererCrashTimes.length);
  timer.unref?.();
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "显示主窗口", accelerator: "CmdOrCtrl+Shift+R", click: focusMainWindow },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "最大化/还原" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
  ]));
}

function escapeRecoveryText(value) {
  return String(value).replace(/[&<>"']/gu, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function recoveryDiagnostics(reason) {
  let ledger = null;
  try { ledger = recoveryStateStore?.diagnostics() ?? null; } catch { ledger = null; }
  return Object.freeze({
    schemaVersion: 1,
    mode: "safe",
    reason,
    build: Object.freeze({
      appVersion: buildInfo?.appVersion ?? app.getVersion(),
      buildId: buildInfo?.buildId ?? "unavailable",
    }),
    integrity: buildInfo ? "verified" : "failed",
    crashes: Object.freeze({
      uncleanLaunches: ledger?.uncleanLaunches ?? 0,
      serviceCrashLoops: ledger?.serviceCrashLoops ?? 0,
      rendererCrashLoops: ledger?.rendererCrashLoops ?? 0,
      electronChildCrashes: ledger?.electronChildCrashes ?? 0,
    }),
  });
}

function recoveryHtml(reason) {
  const diagnosticText = escapeRecoveryText(JSON.stringify(recoveryDiagnostics(reason), null, 2));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RainyDays 安全模式</title><style>body{margin:0;background:#111827;color:#e5e7eb;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:720px;margin:0 auto;padding:48px 36px}h1{font-size:28px;margin:0 0 12px}.reason{color:#fbbf24}p{color:#cbd5e1}pre{max-height:260px;overflow:auto;padding:16px;border:1px solid #374151;border-radius:10px;background:#030712;color:#a7f3d0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}a{display:inline-block;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;text-decoration:none}a.secondary{background:#374151}</style></head><body><main class="wrap"><h1>RainyDays 已进入安全模式</h1><p class="reason">恢复原因：${escapeRecoveryText(reason)}</p><p>后台服务、原生执行和普通工作台均未启动。下面只显示固定维度、脱敏后的恢复诊断。</p><pre id="recovery-diagnostics">${diagnosticText}</pre><div class="actions"><a id="retry-normal" href="rainydays-recovery://retry">尝试正常重启</a><a id="quit-recovery" class="secondary" href="rainydays-recovery://quit">退出</a></div></main></body></html>`;
}

function relaunchArguments() {
  const args = process.argv.slice(1).filter(argument => argument !== "--safe-mode" && argument !== "--recover-normal");
  args.push("--recover-normal");
  return args;
}

function handleRecoveryAction(action) {
  if (action === "quit") {
    app.quit();
    return;
  }
  if (action !== "retry" || recoveryRelaunchRequested) return;
  try {
    recoveryState = recoveryStateStore.requestNormalRetry();
    recoveryRelaunchRequested = true;
    app.relaunch({ args: relaunchArguments() });
    app.quit();
  } catch (error) {
    console.error(JSON.stringify({ event: "rainydays_recovery_action", action: "retry", outcome: "failure" }));
    try { recoveryState = recoveryStateStore?.enterSafeMode(recoveryState?.safeModeReason ?? "integrity-failure"); } catch { /* Already fail-closed in the recovery window. */ }
  }
}

function createRecoveryWindow(reason) {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show();
    recoveryWindow.focus();
    return recoveryWindow;
  }
  const html = recoveryHtml(reason);
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  recoveryWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 640,
    minHeight: 520,
    title: `RainyDays 安全模式 (${buildInfo?.buildId ?? "unavailable"})`,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
    },
  });
  const createdWindow = recoveryWindow;
  createdWindow.setMenuBarVisibility(false);
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  createdWindow.webContents.on("will-attach-webview", event => event.preventDefault());
  createdWindow.webContents.on("will-navigate", (event, url) => {
    if (url === dataUrl) return;
    event.preventDefault();
    let action = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "rainydays-recovery:") action = parsed.hostname;
    } catch { action = null; }
    if (action) handleRecoveryAction(action);
  });
  createdWindow.once("ready-to-show", () => createdWindow.show());
  createdWindow.on("closed", () => {
    if (recoveryWindow === createdWindow) recoveryWindow = null;
    if (!app.isQuitting && !recoveryRelaunchRequested) app.quit();
  });
  void createdWindow.loadURL(dataUrl).catch(() => {
    console.error(JSON.stringify({ event: "rainydays_safe_mode", reason, outcome: "load-failed" }));
    app.quit();
  });
  console.error(JSON.stringify({ event: "rainydays_safe_mode", reason, outcome: "active" }));
  return createdWindow;
}

async function suspendNormalRuntimeForSafeMode() {
  const errors = [];
  removeDesktopIpcHandlers();
  removeManualTerminalConsentHandlers();
  invalidateManualTerminalConsent();
  invalidateAllNativeConsent();
  removeApiHeaderInjection();
  releasePreloadLease();
  removeDisplayLifecycle();
  stopServiceHealthMonitor();
  const finalWindowState = captureMainWindowState();
  try {
    if (windowStateStore && finalWindowState) {
      windowStateStore.schedule(finalWindowState);
      windowStateStore.flush();
    }
    windowStateStore?.close();
  } catch (error) { errors.push(error); }
  windowStateStore = null;
  const supervisor = serverSupervisor;
  serverSupervisor = null;
  try { await supervisor?.shutdown(); }
  catch (error) {
    errors.push(error);
    try {
      const child = serverProcess;
      if (child) await terminateServerProcess(child, "safe-mode-fallback");
    } catch (fallbackError) { errors.push(fallbackError); }
  }
  try { childNativeProcessConsentTransport?.close(); } catch (error) { errors.push(error); }
  childNativeProcessConsentTransport = null;
  tray?.destroy();
  tray = null;
  Menu.setApplicationMenu(null);
  const workbench = mainWindow;
  mainWindow = null;
  workbench?.destroy();
  if (errors.length) console.error(JSON.stringify({ event: "rainydays_safe_mode_cleanup", failureCount: errors.length }));
}

function activateSafeMode(reason) {
  if (safeModeTransitionPromise) return safeModeTransitionPromise;
  safeModeTransitionPromise = (async () => {
    try { recoveryState = recoveryStateStore?.enterSafeMode(reason) ?? recoveryState; }
    catch { reason = "integrity-failure"; }
    await suspendNormalRuntimeForSafeMode();
    createRecoveryWindow(reason);
  })();
  return safeModeTransitionPromise;
}

async function chooseNativePath(event, kind, request) {
  const window = trustedRendererWindow(event, true);
  const parsed = parseDialogRequest(request, kind);
  if (kind === "directory") {
    const result = await dialog.showOpenDialog(window, { title: parsed.title ?? undefined, properties: ["openDirectory", "createDirectory"] });
    return Object.freeze({ canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] ?? null });
  }
  if (kind === "file") {
    const result = await dialog.showOpenDialog(window, { title: parsed.title ?? undefined, properties: ["openFile"] });
    return Object.freeze({ canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] ?? null });
  }
  const result = await dialog.showSaveDialog(window, {
    title: parsed.title ?? undefined,
    defaultPath: parsed.defaultName ?? undefined,
  });
  return Object.freeze({ canceled: result.canceled, path: result.canceled ? null : result.filePath ?? null });
}

function enforceNotificationRateLimit() {
  const cutoff = Date.now() - 60_000;
  while (notificationTimes.length > 0 && notificationTimes[0] < cutoff) notificationTimes.shift();
  if (notificationTimes.length >= 5) throw new Error("Notification rate limit exceeded");
  notificationTimes.push(Date.now());
}

function registerDesktopIpcHandlers() {
  ipcMain.handle("rainydays:capabilities", event => {
    trustedRendererWindow(event);
    return Object.freeze({
      platform: process.platform,
      dialogs: true,
      notifications: Notification.isSupported(),
      windowControls: true,
      updates: false,
    });
  });
  ipcMain.handle("rainydays:dialog-directory", (event, request) => chooseNativePath(event, "directory", request));
  ipcMain.handle("rainydays:dialog-file", (event, request) => chooseNativePath(event, "file", request));
  ipcMain.handle("rainydays:dialog-save", (event, request) => chooseNativePath(event, "save", request));
  ipcMain.handle("rainydays:window-state", event => windowState(trustedRendererWindow(event)));
  ipcMain.handle("rainydays:window-action", (event, request) => {
    const window = trustedRendererWindow(event, true);
    const { action } = parseWindowAction(request);
    if (action === "minimize") window.minimize();
    else if (action === "maximize") window.maximize();
    else if (action === "restore") window.restore();
    else window.setFullScreen(!window.isFullScreen());
    return windowState(window);
  });
  ipcMain.handle("rainydays:notify", (event, request) => {
    const window = trustedRendererWindow(event);
    const parsed = parseNotification(request);
    if (!Notification.isSupported()) throw new Error("System notifications are unavailable");
    enforceNotificationRateLimit();
    const notification = new Notification({ title: parsed.title, body: parsed.body, silent: true });
    notification.once("click", () => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
      window.webContents.send("rainydays:notification-clicked", Object.freeze({
        id: parsed.id,
        sessionId: parsed.sessionId,
        targetTab: parsed.targetTab,
      }));
    });
    notification.show();
    return Object.freeze({ shown: true, id: parsed.id });
  });
  ipcMain.handle("rainydays:tray-state", (event, request) => {
    trustedRendererWindow(event);
    trayState = parseTrayState(request);
    updateTrayPresentation();
    return trayState;
  });
}

function removeDesktopIpcHandlers() {
  for (const channel of desktopIpcChannels) ipcMain.removeHandler(channel);
  notificationTimes.splice(0);
}

function invalidateManualTerminalConsent() {
  const webContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
  if (!webContentsId) return;
  void callServiceControl("invalidate-manual-terminal", [webContentsId])
    .catch(error => reportControlFailure("invalidate-manual-terminal", error));
}

function installApiHeaderInjection(window) {
  const origin = `http://127.0.0.1:${port}`;
  const targetSession = window.webContents.session;
  targetSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === "x-rainydays-token") delete requestHeaders[key];
    }
    const current = mainWindow;
    const exactWindow = current === window && !window.isDestroyed()
      && details.webContents === window.webContents
      && details.frame === window.webContents.mainFrame;
    let exactOrigin = false;
    try { exactOrigin = new URL(details.url).origin === origin; } catch { /* deny */ }
    if (exactWindow && exactOrigin) {
      requestHeaders["X-RainyDays-Token"] = apiToken;
    }
    callback({ requestHeaders });
  });
  apiHeaderSession = targetSession;
}

function removeApiHeaderInjection() {
  apiHeaderSession?.webRequest.onBeforeSendHeaders(null);
  apiHeaderSession?.setPermissionCheckHandler(null);
  apiHeaderSession?.setPermissionRequestHandler(null);
  apiHeaderSession?.removeAllListeners("will-download");
  apiHeaderSession = null;
}

function installRendererSecurity(window) {
  const origin = `http://127.0.0.1:${port}`;
  const canonicalUrl = `${origin}/`;
  const targetSession = window.webContents.session;
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  targetSession.removeAllListeners("will-download");
  targetSession.on("will-download", (event, item, webContents) => {
    try {
      if (webContents !== window.webContents || window.isDestroyed()
        || window.webContents.mainFrame.url !== canonicalUrl) throw new Error("Download sender is denied");
      assertTrustedJsonDownload({
        url: item.getURL(),
        mimeType: item.getMimeType(),
        filename: item.getFilename(),
      }, origin);
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
    if (url !== canonicalUrl) event.preventDefault();
  });
  window.webContents.on("will-redirect", event => event.preventDefault());
}

function createWindow() {
  const initialState = resolveWindowState(windowStateStore?.load() ?? null, displayTopology());
  const iconLease = electronPaths.openAppFile(path.join("public", "icon.png"), "window-icon");
  let icon;
  try {
    icon = nativeImage.createFromBuffer(iconLease.readBytes(4 * 1024 * 1024));
    iconLease.verify();
  } finally {
    iconLease.close();
  }
  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  preloadLease = electronPaths.openElectronFile("preload.cjs", "window-preload");
  try {
    preloadLease.verify("before-browser-window-preload");
    mainWindow = new BrowserWindow({
      x: initialState.bounds.x,
      y: initialState.bounds.y,
      width: initialState.bounds.width,
      height: initialState.bounds.height,
      minWidth: 800,
      minHeight: 600,
      title: `RainyDays ${buildInfo.appVersion} (${buildInfo.buildId})`,
      icon,
      show: false,
      webPreferences: {
        preload: preloadLease.canonicalPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
      },
    });
  } catch (error) {
    releasePreloadLease();
    throw error;
  }

  applyingWindowState = true;
  try {
    if (initialState.maximized) mainWindow.maximize();
    if (initialState.fullscreen) mainWindow.setFullScreen(true);
  } finally {
    applyingWindowState = false;
  }

  installApiHeaderInjection(mainWindow);
  installRendererSecurity(mainWindow);
  mainWindow.webContents.once("did-finish-load", () => {
    const lease = preloadLease;
    preloadLease = null;
    try {
      lease?.verify();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mainWindow?.destroy();
      dialog.showErrorBox("RainyDays 启动失败", message);
      app.quit();
    } finally {
      lease?.close();
    }
  });
  mainWindow.webContents.on("did-finish-load", deliverPendingLaunchIntent);
  const createdWindow = mainWindow;
  mainWindow.webContents.on("render-process-gone", (_event, details) => handleRendererGone(createdWindow, details));
  mainWindow.webContents.once("did-fail-load", releasePreloadLease);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    mainFrameGeneration += 1;
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  for (const eventName of ["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    mainWindow.on(eventName, () => saveMainWindowState());
  }
  mainWindow.on("blur", () => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.on("hide", () => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.on("close", (event) => {
    saveMainWindowState(true);
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
    if (!app.isQuitting) {
      event.preventDefault();
      createdWindow.hide();
    }
  });
  createdWindow.on("closed", () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });

  createTray(icon);
  installApplicationMenu();
}

function navigateFromTray(sessionId) {
  if (!mainWindow || mainWindow.isDestroyed() || !sessionId) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("rainydays:notification-clicked", Object.freeze({
    id: null,
    sessionId,
    targetTab: "session",
  }));
}

function updateTrayPresentation() {
  if (!tray || tray.isDestroyed()) return;
  const counts = `${trayState.unread} 未读 · ${trayState.running} 运行 · ${trayState.errors} 错误`;
  tray.setToolTip(`RainyDays ${buildInfo.appVersion} · ${counts}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: counts, enabled: false },
    { label: "打开首个未读会话", enabled: Boolean(trayState.firstUnreadSessionId), click: () => navigateFromTray(trayState.firstUnreadSessionId) },
    { label: "显示窗口", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray(icon) {
  if (tray && !tray.isDestroyed()) {
    updateTrayPresentation();
    return;
  }
  tray = new Tray(icon);
  updateTrayPresentation();
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

async function terminateServerProcess(child, reason = "shutdown") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (child.connected) {
    try { child.send({ type: "rainydays-service-shutdown", reason }); }
    catch { /* Forced process-tree cleanup below remains authoritative. */ }
  }
  const graceful = await Promise.race([
    exited.then(() => true, () => false),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3_000);
      timer.unref?.();
    }),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && child.pid) {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot) throw new Error("Windows system root is unavailable");
      const taskkillLease = electronPaths.openExternalBootstrapExecutable(path.join(systemRoot, "System32", "taskkill.exe"), "taskkill");
      try {
        taskkillLease.verify("before-taskkill-spawn");
        const taskkill = spawn(taskkillLease.canonicalPath, ["/pid", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        taskkillLease.verify("after-taskkill-spawn");
        await new Promise((resolve, reject) => {
          taskkill.once("error", reject);
          taskkill.once("exit", code => code === 0 || code === 128
            ? resolve()
            : reject(new Error(`taskkill failed with exit ${code}`)));
        });
      } finally {
        taskkillLease.close();
      }
    } else {
      child.kill("SIGTERM");
    }
    await exited;
  }
  if (serverProcess === child) serverProcess = null;
}

app.whenReady().then(async () => {
  try {
    electronPaths = new ElectronBootstrapPathStore({
      appRoot: app.getAppPath(),
      electronRoot: __dirname,
      userDataRoot: app.getPath("userData"),
      nativeFs: originalFs,
    });
    clearUntrustedPathEnvironment();
    const userDataRoot = electronPaths.runtimeRoots().userData;
    recoveryStateStore = createRecoveryStateStore({
      root: userDataRoot,
      io: originalFs,
      path,
      randomBytes,
      onEvent: event => console.log(JSON.stringify({ event: "rainydays_recovery_state", action: event.event, outcome: event.outcome })),
    });
    let integrityFailure = legacyUserDataMigrationError !== null;
    try { buildInfo = loadBuildInfo(); } catch { integrityFailure = true; }
    try {
      recoveryState = recoveryStateStore.beginLaunch({
        forceSafeMode: process.argv.includes("--safe-mode"),
        normalRetry: process.argv.includes("--recover-normal"),
      });
    } catch {
      integrityFailure = true;
      recoveryState = Object.freeze({ safeMode: true, safeModeReason: "integrity-failure" });
    }
    if (integrityFailure) {
      try { recoveryState = recoveryStateStore.enterSafeMode("integrity-failure"); } catch { /* Recovery UI remains fail-closed without ledger details. */ }
      createRecoveryWindow("integrity-failure");
      return;
    }
    if (recoveryState.safeMode) {
      createRecoveryWindow(recoveryState.safeModeReason);
      return;
    }
    windowStateStore = createWindowStateStore({
      root: userDataRoot,
      io: originalFs,
      path,
      randomBytes,
      onEvent: event => reportWindowLifecycle(`state-${event.event}`, event.outcome),
    });
    installDisplayLifecycle();
    const initialIntent = parseLaunchIntent(process.argv);
    if (initialIntent.sessionId) pendingLaunchIntent = initialIntent;
    Object.assign(process.env, runtimeEnvironment());
    port = await choosePort(port);
    const serverMode = selectServerMode();
    serverSupervisor = new ServiceSupervisor({
      launch: () => startConfiguredServer(serverMode),
      terminate: terminateServerProcess,
      onState: reportServiceState,
      maxRestarts: 5,
      crashWindowMs: 60_000,
      backoffBaseMs: 500,
      backoffCapMs: 30_000,
    });
    try { await serverSupervisor.start(); }
    catch (error) {
      if (safeModeTransitionPromise || serverSupervisor?.snapshot().phase === "crash-loop") {
        await activateSafeMode("service-crash-loop");
        return;
      }
      throw error;
    }
    startServiceHealthMonitor();
    createWindow();
    registerDesktopIpcHandlers();
    registerManualTerminalConsentHandlers();
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    dialog.showErrorBox("RainyDays 启动失败", message);
    app.quit();
  }
});

async function cleanupBeforeFinalQuit() {
  const errors = [];
  removeDesktopIpcHandlers();
  removeManualTerminalConsentHandlers();
  invalidateManualTerminalConsent();
  invalidateAllNativeConsent();
  removeApiHeaderInjection();
  releasePreloadLease();
  removeDisplayLifecycle();
  stopServiceHealthMonitor();
  try {
    const finalWindowState = captureMainWindowState();
    if (windowStateStore && finalWindowState) {
      windowStateStore.schedule(finalWindowState);
      windowStateStore.flush();
    }
    windowStateStore?.close();
    windowStateStore = null;
  } catch (error) {
    errors.push(error);
  }
  const supervisor = serverSupervisor;
  serverSupervisor = null;
  try { await supervisor?.shutdown(); } catch (error) { errors.push(error); }
  try { childNativeProcessConsentTransport?.close(); } catch (error) { errors.push(error); }
  childNativeProcessConsentTransport = null;
  if (errors.length === 0) {
    try {
      if (!recoveryRelaunchRequested) recoveryState = recoveryStateStore?.markCleanExit() ?? recoveryState;
      recoveryStateStore?.close();
      recoveryStateStore = null;
    } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "RainyDays shutdown cleanup failed");
}

app.on("before-quit", (event) => {
  app.isQuitting = true;
  if (finalQuit) return;
  event.preventDefault();
  if (quitCleanupPromise) return;
  quitCleanupPromise = cleanupBeforeFinalQuit()
    .then(() => {
      finalQuit = true;
      app.quit();
    })
    .catch((error) => {
      quitCleanupPromise = null;
      app.isQuitting = false;
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error("RainyDays shutdown did not complete; quit remains blocked", message);
      dialog.showErrorBox("RainyDays 无法安全退出", message);
    });
});

app.on("will-quit", () => {
  electronPaths?.close();
});

app.on("window-all-closed", () => {
  // Windows/Linux 保持托盘常驻。
});

app.on("activate", () => {
  if (recoveryState?.safeMode || recoveryWindow) {
    createRecoveryWindow(recoveryState?.safeModeReason ?? "integrity-failure");
    return;
  }
  if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) createWindow();
  else mainWindow?.show();
});
