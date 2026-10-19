// A real isolated Electron renderer against the test's real local daemon.
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
const base = process.env.RAINYDAYS_CLI_VIEW_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(base || "")) throw new Error("Test loopback origin required");
app.setPath("userData", path.join(process.env.RAINYDAYS_CLI_VIEW_FIXTURE, "renderer-data"));
app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${base}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, "X-RainyDays-Token": process.env.RAINYDAYS_CLI_VIEW_TOKEN } });
  });
  const window = new BrowserWindow({ width: 1280, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL(base);
});
app.on("window-all-closed", () => app.quit());
