// preload 脚本 —— 只暴露冻结的命名 IPC 能力，不提供任意 channel invoke。
const { contextBridge, ipcRenderer } = require("electron");

const notificationListeners = new Set();
const pendingNotificationTargets = [];
ipcRenderer.on("rainydays:notification-clicked", (_event, target) => {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || !(target.id === null || typeof target.id === "string")
    || typeof target.sessionId !== "string"
    || !["session", "terminal", "file"].includes(target.targetTab)) return;
  const frozen = Object.freeze({ id: target.id, sessionId: target.sessionId, targetTab: target.targetTab });
  if (notificationListeners.size === 0) pendingNotificationTargets.splice(0, pendingNotificationTargets.length, frozen);
  else for (const listener of notificationListeners) listener(frozen);
});

const electronAPI = Object.freeze({
  platform: process.platform,
  isElectron: true,
  appVersion: process.env.RAINYDAYS_APP_VERSION || null,
  buildId: process.env.RAINYDAYS_BUILD_ID || null,
  capabilities: () => ipcRenderer.invoke("rainydays:capabilities"),
  selectDirectory: request => ipcRenderer.invoke("rainydays:dialog-directory", request),
  selectFile: request => ipcRenderer.invoke("rainydays:dialog-file", request),
  selectSavePath: request => ipcRenderer.invoke("rainydays:dialog-save", request),
  windowState: () => ipcRenderer.invoke("rainydays:window-state"),
  windowAction: request => ipcRenderer.invoke("rainydays:window-action", request),
  notify: request => ipcRenderer.invoke("rainydays:notify", request),
  updateTrayState: request => ipcRenderer.invoke("rainydays:tray-state", request),
  onNotificationClicked: listener => {
    if (typeof listener !== "function") throw new TypeError("Notification listener must be a function");
    notificationListeners.add(listener);
    for (const target of pendingNotificationTargets.splice(0)) listener(target);
    return () => notificationListeners.delete(listener);
  },
  terminalStart: request => ipcRenderer.invoke("rainydays:terminal-start", request),
  terminalInput: request => ipcRenderer.invoke("rainydays:terminal-input", request),
  terminalResize: request => ipcRenderer.invoke("rainydays:terminal-resize", request),
  terminalClear: request => ipcRenderer.invoke("rainydays:terminal-clear", request),
  terminalKill: request => ipcRenderer.invoke("rainydays:terminal-kill", request),
  terminalClose: request => ipcRenderer.invoke("rainydays:terminal-close", request),
});

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
