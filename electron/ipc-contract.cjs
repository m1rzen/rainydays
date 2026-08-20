const notificationIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const fileNamePattern = /^[^<>:"/\\|?*]{1,128}$/u;
const reservedWindowsNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function containsControlCharacter(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid`);
  }
  return value;
}

function optionalText(value, label, maximum) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || containsControlCharacter(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseDialogRequest(value, kind) {
  const allowed = kind === "save" ? ["title", "defaultName"] : ["title"];
  const request = exactObject(value ?? Object.freeze({}), allowed.filter(key => Object.prototype.hasOwnProperty.call(value ?? {}, key)), `${kind} dialog request`);
  const title = optionalText(request.title, "Dialog title", 80);
  if (kind !== "save") return Object.freeze({ title });
  const defaultName = request.defaultName === undefined ? null : request.defaultName;
  if (defaultName !== null && (typeof defaultName !== "string" || !fileNamePattern.test(defaultName)
    || containsControlCharacter(defaultName) || defaultName === "." || defaultName === "..")) {
    throw new TypeError("Default file name is invalid");
  }
  return Object.freeze({ title, defaultName });
}

function assertTrustedRendererOrigin(senderUrl, expectedOrigin) {
  if (typeof senderUrl !== "string" || typeof expectedOrigin !== "string") {
    throw new TypeError("Desktop IPC sender origin is invalid");
  }
  let origin;
  try { origin = new URL(senderUrl).origin; }
  catch { throw new TypeError("Desktop IPC sender origin is invalid"); }
  if (origin !== expectedOrigin) throw new Error("Desktop IPC sender origin is denied");
  return origin;
}

function assertTrustedRendererBinding(event, window, expectedOrigin, options = Object.freeze({})) {
  const label = typeof options.label === "string" && options.label.length > 0 ? options.label : "Desktop IPC";
  if (!window || typeof window.isDestroyed !== "function" || window.isDestroyed()
    || !event || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error(`${label} requires the main application frame`);
  }
  assertTrustedRendererOrigin(event.senderFrame.url, expectedOrigin);
  if (options.requireFocus && (!window.isVisible() || !window.isFocused())) {
    throw new Error(`${label} requires the focused visible main window`);
  }
  return window;
}

function parseWindowAction(value) {
  const request = exactObject(value, ["action"], "Window action request");
  if (!["minimize", "maximize", "restore", "toggle-fullscreen"].includes(request.action)) {
    throw new TypeError("Window action is invalid");
  }
  return Object.freeze({ action: request.action });
}

function parseNotification(value) {
  const request = exactObject(value, ["id", "title", "body"], "Notification request");
  if (typeof request.id !== "string" || !notificationIdPattern.test(request.id)) throw new TypeError("Notification id is invalid");
  const title = optionalText(request.title, "Notification title", 80);
  const body = optionalText(request.body, "Notification body", 240);
  if (!title || !body) throw new TypeError("Notification content is required");
  return Object.freeze({ id: request.id, title, body });
}

function assertTrustedJsonDownload(value, expectedOrigin) {
  const request = exactObject(value, ["url", "mimeType", "filename"], "Download request");
  if (typeof request.url !== "string" || !request.url.startsWith("blob:") || request.url.length > 4096) {
    throw new Error("Download URL is denied");
  }
  let embedded;
  try { embedded = new URL(request.url.slice("blob:".length)); }
  catch { throw new TypeError("Download URL is invalid"); }
  if (embedded.origin !== expectedOrigin) throw new Error("Download URL origin is denied");
  if (request.mimeType !== "application/json") throw new Error("Download MIME type is denied");
  if (typeof request.filename !== "string" || !fileNamePattern.test(request.filename)
    || containsControlCharacter(request.filename) || request.filename === "." || request.filename === ".."
    || reservedWindowsNamePattern.test(request.filename) || !request.filename.toLowerCase().endsWith(".json")) {
    throw new TypeError("Download file name is invalid");
  }
  return Object.freeze({ filename: request.filename });
}

module.exports = Object.freeze({
  assertTrustedRendererBinding,
  assertTrustedRendererOrigin,
  assertTrustedJsonDownload,
  parseDialogRequest,
  parseWindowAction,
  parseNotification,
});
