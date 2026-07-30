// preload 脚本 —— 安全地暴露 IPC 接口给前端
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  appVersion: process.env.RAINYDAYS_APP_VERSION || null,
  buildId: process.env.RAINYDAYS_BUILD_ID || null,
  terminalStart: request => ipcRenderer.invoke("rainydays:terminal-start", request),
  terminalInput: request => ipcRenderer.invoke("rainydays:terminal-input", request),
});
