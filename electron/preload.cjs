// preload 脚本 —— 安全地暴露 IPC 接口给前端
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
  appVersion: process.env.MINI_LUX_APP_VERSION || null,
  buildId: process.env.MINI_LUX_BUILD_ID || null,
  terminalStart: request => ipcRenderer.invoke("mini-lux:terminal-start", request),
  terminalInput: request => ipcRenderer.invoke("mini-lux:terminal-input", request),
});
