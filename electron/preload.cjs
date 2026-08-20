// preload 脚本 —— 只暴露冻结的命名 IPC 能力，不提供任意 channel invoke。
const { contextBridge, ipcRenderer } = require("electron");

const notificationListeners = new Set();
ipcRenderer.on("rainydays:notification-clicked", (_event, id) => {
  if (typeof id !== "string") return;
  for (const listener of notificationListeners) listener(id);
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
  onNotificationClicked: listener => {
    if (typeof listener !== "function") throw new TypeError("Notification listener must be a function");
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  },
  terminalStart: request => ipcRenderer.invoke("rainydays:terminal-start", request),
  terminalInput: request => ipcRenderer.invoke("rainydays:terminal-input", request),
  terminalClear: request => ipcRenderer.invoke("rainydays:terminal-clear", request),
  terminalKill: request => ipcRenderer.invoke("rainydays:terminal-kill", request),
  terminalClose: request => ipcRenderer.invoke("rainydays:terminal-close", request),
});

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
