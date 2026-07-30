// ===========================================
// Electron 主进程
// 开发态启动 tsx；正式包直接加载 dist，不依赖系统 Node/npm
// ===========================================

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { ElectronBootstrapPathStore } = require("./path-bootstrap.cjs");
const { migrateLegacyUserData } = require("./user-data-migration.cjs");
const originalFs = require("original-fs");

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverModule = null;
let buildInfo = null;
let electronPaths = null;
let preloadLease = null;
let apiHeaderSession = null;
let nativeProcessConsentCleanup = null;
let childNativeProcessConsentTransport = null;
let mainFrameGeneration = 0;
let quitCleanupPromise = null;
let finalQuit = false;
let port = Number(process.env.PORT || 3111);
const apiToken = process.env.RAINYDAYS_API_TOKEN || randomBytes(32).toString("hex");
const terminalConsentChannels = Object.freeze([
  "rainydays:terminal-start",
  "rainydays:terminal-input",
]);

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
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

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
  "DEEPSEEK_API_KEY", "LLM_API_KEY", "DEEPSEEK_BASE_URL", "LLM_BASE_URL", "LLM_MODEL", "DEFAULT_PERSONA",
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

async function startPackagedServer() {
  Object.assign(process.env, runtimeEnvironment());
  const lease = electronPaths.openAppFile(path.join("dist", "index.js"), "packaged-server-module");
  try {
    lease.verify("before-packaged-server-import");
    const literalServerPath = path.resolve(__dirname, "..", "dist", "index.js");
    if (path.resolve(lease.canonicalPath).toLowerCase() !== literalServerPath.toLowerCase()) {
      throw new Error("Packaged server module differs from the verified literal import target");
    }
    serverModule = await import("../dist/index.js");
    lease.verify();
    if (typeof serverModule.registerNativeProcessConsentHandler !== "function") {
      throw new Error("Native process consent broker is unavailable");
    }
    nativeProcessConsentCleanup = serverModule.registerNativeProcessConsentHandler(handleNativeProcessConsent);
    await serverModule.ready;
    lease.verify();
  } finally {
    lease.close();
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
  return { type: "compiled", executableLease: electronPaths.openExternalTestExecutable(nodeExecutable) };
}

async function startServerProcess(commandLease, argumentLeases, extraEnvironment = {}) {
  commandLease.verify();
  for (const lease of argumentLeases) lease.verify();
  const { createNativeProcessConsentParentTransport } = await import("../dist/native-process-consent-transport.js");
  await electronPaths.withAppRootDirectory("server-process-cwd", async canonicalCwd => {
    commandLease.verify("before-server-process-spawn");
    for (const lease of argumentLeases) lease.verify("before-server-process-spawn");
    serverProcess = spawn(commandLease.canonicalPath, argumentLeases.map(lease => lease.canonicalPath), {
      cwd: canonicalCwd,
      env: { ...runtimeEnvironment(), ...extraEnvironment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const requestPipe = serverProcess.stdio[3];
    const responsePipe = serverProcess.stdio[4];
    if (!requestPipe || !responsePipe) throw new Error("Native process consent pipes are unavailable");
    childNativeProcessConsentTransport = createNativeProcessConsentParentTransport({
      request: requestPipe,
      response: responsePipe,
      decide: handleNativeProcessConsent,
    });

    await Promise.all([
      childNativeProcessConsentTransport.ready,
      new Promise((resolve, reject) => {
        let resolved = false;
        let readinessBuffer = "";
        const onOutput = (prefix, data) => {
          const text = data.toString();
          console.log(prefix, text.trim());
          readinessBuffer = `${readinessBuffer}${text}`.slice(-16_384);
          if (!resolved && readinessBuffer.includes("已启动: http://127.0.0.1:")) {
            resolved = true;
            resolve();
          }
        };
        serverProcess.stdout.on("data", (data) => onOutput("[server]", data));
        serverProcess.stderr.on("data", (data) => onOutput("[server error]", data));
        serverProcess.once("error", reject);
        serverProcess.once("exit", (code) => {
          childNativeProcessConsentTransport?.close();
          childNativeProcessConsentTransport = null;
          if (!resolved) reject(new Error(`RainyDays 服务启动失败（exit ${code}）`));
        });
      }),
    ]);
  });
  commandLease.verify();
  for (const lease of argumentLeases) lease.verify();
}

async function startDevelopmentServer() {
  const executableLease = electronPaths.openExternalTestExecutable(process.execPath);
  const tsxLease = electronPaths.openAppFile(path.join("node_modules", "tsx", "dist", "cli.mjs"), "source-tsx-entry");
  const sourceLease = electronPaths.openAppFile(path.join("src", "index.ts"), "source-server-entry");
  try {
    await startServerProcess(executableLease, [tsxLease, sourceLease], { ELECTRON_RUN_AS_NODE: "1" });
  } finally {
    sourceLease.close();
    tsxLease.close();
    executableLease.close();
  }
}

async function startCompiledTestServer(executableLease) {
  const serverLease = electronPaths.openAppFile(path.join("dist", "index.js"), "compiled-server-entry");
  try {
    await startServerProcess(executableLease, [serverLease]);
  } finally {
    serverLease.close();
    executableLease.close();
  }
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

function invalidateAllNativeConsent() {
  if (typeof serverModule?.invalidateNativeProcessConsent === "function") {
    serverModule.invalidateNativeProcessConsent();
  }
}

function requireManualTerminalConsentServer() {
  if (!serverModule
    || typeof serverModule.prepareManualTerminalConsent !== "function"
    || typeof serverModule.decideManualTerminalConsent !== "function") {
    throw new Error("Manual terminal consent is unavailable");
  }
  return serverModule;
}

function manualTerminalPresence(event) {
  const window = mainWindow;
  if (!window || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame
    || !window.isVisible() || !window.isFocused()) {
    throw new Error("Manual terminal consent requires the focused visible main window");
  }
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
  ipcMain.handle("rainydays:terminal-start", (event, request) =>
    handleManualTerminalConsent(event, "terminal-start", request));
  ipcMain.handle("rainydays:terminal-input", (event, request) =>
    handleManualTerminalConsent(event, "terminal-input", request));
}

function removeManualTerminalConsentHandlers() {
  for (const channel of terminalConsentChannels) ipcMain.removeHandler(channel);
}

function invalidateManualTerminalConsent() {
  const webContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
  if (webContentsId && typeof serverModule?.invalidateManualTerminalConsent === "function") {
    serverModule.invalidateManualTerminalConsent(webContentsId);
  }
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
  apiHeaderSession = null;
}

function createWindow() {
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
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: `RainyDays ${buildInfo.appVersion} (${buildInfo.buildId})`,
      icon,
      show: false,
      webPreferences: {
        preload: preloadLease.canonicalPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
  } catch (error) {
    releasePreloadLease();
    throw error;
  }

  installApiHeaderInjection(mainWindow);
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
  mainWindow.webContents.once("did-fail-load", releasePreloadLease);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    mainFrameGeneration += 1;
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
    try {
      const target = new URL(url);
      if (target.origin !== `http://127.0.0.1:${port}`) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on("blur", () => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.on("hide", () => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
  });
  mainWindow.on("close", (event) => {
    invalidateManualTerminalConsent();
    invalidateAllNativeConsent();
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  createTray(icon);
}

function createTray(icon) {
  tray = new Tray(icon);
  tray.setToolTip(`RainyDays ${buildInfo.appVersion} (${buildInfo.buildId})`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

async function stopDevelopmentServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
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
        taskkill.once("exit", (code) => code === 0 || code === 128
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

app.whenReady().then(async () => {
  try {
    if (legacyUserDataMigrationError) throw new Error(`RainyDays 用户数据迁移失败: ${legacyUserDataMigrationError.message}`);
    electronPaths = new ElectronBootstrapPathStore({
      appRoot: app.getAppPath(),
      electronRoot: __dirname,
      userDataRoot: app.getPath("userData"),
      nativeFs: originalFs,
    });
    clearUntrustedPathEnvironment();
    buildInfo = loadBuildInfo();
    Object.assign(process.env, runtimeEnvironment());
    port = await choosePort(port);
    const serverMode = selectServerMode();
    if (serverMode.type === "packaged") await startPackagedServer();
    else if (serverMode.type === "compiled") await startCompiledTestServer(serverMode.executableLease);
    else await startDevelopmentServer();
    createWindow();
    registerManualTerminalConsentHandlers();
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    dialog.showErrorBox("RainyDays 启动失败", message);
    app.quit();
  }
});

async function cleanupBeforeFinalQuit() {
  removeManualTerminalConsentHandlers();
  invalidateManualTerminalConsent();
  invalidateAllNativeConsent();
  removeApiHeaderInjection();
  releasePreloadLease();
  childNativeProcessConsentTransport?.close();
  childNativeProcessConsentTransport = null;
  if (serverModule?.shutdown) await serverModule.shutdown(false);
  else await stopDevelopmentServer();
  nativeProcessConsentCleanup?.();
  nativeProcessConsentCleanup = null;
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
  if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) createWindow();
  else mainWindow?.show();
});
