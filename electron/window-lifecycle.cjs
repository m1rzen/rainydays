"use strict";

const WINDOW_STATE_SCHEMA_VERSION = 1;
const WINDOW_STATE_FILE = "window-state.json";
const MAX_STATE_BYTES = 64 * 1024;
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const MAX_DIMENSION = 32_768;
const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const sessionArgumentPattern = new RegExp(`^--session=(${SESSION_ID})$`, "iu");
const sessionUrlPattern = new RegExp(`^rainydays://session/(${SESSION_ID})/?$`, "iu");

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function finiteInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizeBounds(value) {
  if (!exactObject(value, ["x", "y", "width", "height"])
    || !finiteInteger(value.x, -MAX_DIMENSION, MAX_DIMENSION)
    || !finiteInteger(value.y, -MAX_DIMENSION, MAX_DIMENSION)
    || !finiteInteger(value.width, 1, MAX_DIMENSION)
    || !finiteInteger(value.height, 1, MAX_DIMENSION)) return null;
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

function normalizePersistedState(value) {
  if (!exactObject(value, ["schemaVersion", "bounds", "maximized", "fullscreen", "displayId"])
    || value.schemaVersion !== WINDOW_STATE_SCHEMA_VERSION
    || typeof value.maximized !== "boolean"
    || typeof value.fullscreen !== "boolean"
    || (value.displayId !== null && (typeof value.displayId !== "string" || value.displayId.length < 1 || value.displayId.length > 128))) return null;
  const bounds = normalizeBounds(value.bounds);
  if (!bounds) return null;
  return Object.freeze({
    schemaVersion: WINDOW_STATE_SCHEMA_VERSION,
    bounds,
    maximized: value.maximized,
    fullscreen: value.fullscreen,
    displayId: value.displayId,
  });
}

function normalizeDisplays(displays) {
  if (!Array.isArray(displays) || displays.length < 1 || displays.length > 64) throw new TypeError("Display topology is invalid");
  const normalized = [];
  const ids = new Set();
  for (const display of displays) {
    if (!display || typeof display !== "object" || Array.isArray(display)) throw new TypeError("Display record is invalid");
    const id = String(display.id);
    if (id.length < 1 || id.length > 128 || ids.has(id)) throw new TypeError("Display identity is invalid");
    const workArea = normalizeBounds(display.workArea);
    if (!workArea) throw new TypeError("Display work area is invalid");
    ids.add(id);
    normalized.push(Object.freeze({ id, workArea, primary: display.primary === true }));
  }
  return Object.freeze(normalized);
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitBounds(bounds, workArea) {
  const width = Math.min(Math.max(bounds.width, Math.min(MIN_WIDTH, workArea.width)), workArea.width);
  const height = Math.min(Math.max(bounds.height, Math.min(MIN_HEIGHT, workArea.height)), workArea.height);
  return Object.freeze({
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  });
}

function centeredBounds(workArea) {
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, workArea.height);
  return Object.freeze({
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  });
}

function chooseDisplay(state, displays) {
  if (state && state.displayId !== null) {
    const bound = displays.find(display => display.id === state.displayId);
    if (bound) return bound;
  }
  if (state) {
    let best = null;
    let bestArea = 0;
    for (const display of displays) {
      const area = intersectionArea(state.bounds, display.workArea);
      if (area <= bestArea) continue;
      best = display;
      bestArea = area;
    }
    if (best) return best;
  }
  return displays.find(display => display.primary) ?? displays[0];
}

function resolveWindowState(value, displayInput) {
  const displays = normalizeDisplays(displayInput);
  const state = normalizePersistedState(value);
  const display = chooseDisplay(state, displays);
  const bounds = state ? fitBounds(state.bounds, display.workArea) : centeredBounds(display.workArea);
  return Object.freeze({
    schemaVersion: WINDOW_STATE_SCHEMA_VERSION,
    bounds,
    maximized: state?.maximized === true,
    fullscreen: state?.fullscreen === true,
    displayId: display.id,
  });
}

function parseLaunchIntent(argv) {
  if (!Array.isArray(argv) || argv.length > 64) return Object.freeze({ type: "show", sessionId: null });
  const sessionIds = new Set();
  for (const argument of argv) {
    if (typeof argument !== "string" || argument.length > 4096 || argument.includes("\0")) continue;
    const match = sessionArgumentPattern.exec(argument) ?? sessionUrlPattern.exec(argument);
    if (match) sessionIds.add(match[1].toLowerCase());
  }
  return Object.freeze({ type: "show", sessionId: sessionIds.size === 1 ? [...sessionIds][0] : null });
}

function fileIdentity(info) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function directoryIdentity(info) {
  return `${info.dev}:${info.ino}:${info.mode}`;
}

function createWindowStateStore({ root, io, path, randomBytes, onEvent = () => undefined }) {
  if (typeof root !== "string" || !io || !path || typeof randomBytes !== "function" || typeof onEvent !== "function") {
    throw new TypeError("Window state store options are invalid");
  }
  const canonicalRoot = io.realpathSync.native(root);
  const rootInfo = io.lstatSync(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Window state root is invalid");
  const rootIdentity = directoryIdentity(rootInfo);
  const statePath = path.join(canonicalRoot, WINDOW_STATE_FILE);
  let timer = null;
  let pending = null;
  let closed = false;

  const assertRoot = () => {
    const current = io.lstatSync(canonicalRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || directoryIdentity(current) !== rootIdentity) {
      throw new Error("Window state root identity changed");
    }
  };

  const emit = (event, outcome) => {
    try { onEvent(Object.freeze({ event, outcome })); } catch { /* Diagnostics cannot change persistence. */ }
  };

  const read = () => {
    assertRoot();
    let descriptor = null;
    try {
      const before = io.lstatSync(statePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_STATE_BYTES) throw new Error("Window state file identity is invalid");
      descriptor = io.openSync(statePath, "r");
      const opened = io.fstatSync(descriptor);
      if (fileIdentity(opened) !== fileIdentity(before)) throw new Error("Window state changed before open");
      const bytes = io.readFileSync(descriptor);
      const after = io.fstatSync(descriptor);
      const named = io.lstatSync(statePath);
      if (fileIdentity(after) !== fileIdentity(opened) || fileIdentity(named) !== fileIdentity(opened) || bytes.length !== opened.size) {
        throw new Error("Window state changed while reading");
      }
      const value = normalizePersistedState(JSON.parse(bytes.toString("utf8")));
      if (!value) throw new Error("Window state payload is invalid");
      emit("load", "success");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") emit("load", "missing");
      else emit("load", "invalid");
      return null;
    } finally {
      if (descriptor !== null) io.closeSync(descriptor);
    }
  };

  const write = value => {
    if (closed) throw new Error("Window state store is closed");
    const state = normalizePersistedState(value);
    if (!state) throw new TypeError("Window state payload is invalid");
    assertRoot();
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    if (bytes.length > MAX_STATE_BYTES) throw new Error("Window state payload is too large");
    const temporary = path.join(canonicalRoot, `.window-state.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
    let descriptor = null;
    let primaryError = null;
    const cleanupErrors = [];
    try {
      descriptor = io.openSync(temporary, "wx", 0o600);
      io.writeFileSync(descriptor, bytes);
      io.fsyncSync(descriptor);
      const written = io.fstatSync(descriptor);
      const named = io.lstatSync(temporary);
      if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length || fileIdentity(named) !== fileIdentity(written)) {
        throw new Error("Window state temporary identity is invalid");
      }
      assertRoot();
      io.closeSync(descriptor);
      descriptor = null;
      io.renameSync(temporary, statePath);
      assertRoot();
      const published = io.lstatSync(statePath);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 || published.size !== bytes.length) {
        throw new Error("Window state publication is invalid");
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (descriptor !== null) {
        try { io.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      try { io.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") cleanupErrors.push(error); }
    }
    if (primaryError) {
      emit("save", "failure");
      if (cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "Window state publication and cleanup failed", { cause: primaryError });
      throw primaryError;
    }
    if (cleanupErrors.length) {
      emit("save", "failure");
      throw new AggregateError(cleanupErrors, "Window state cleanup failed");
    }
    emit("save", "success");
  };

  return Object.freeze({
    path: statePath,
    load: () => {
      if (closed) throw new Error("Window state store is closed");
      return read();
    },
    schedule: (value, delayMs = 250) => {
      if (closed) throw new Error("Window state store is closed");
      const state = normalizePersistedState(value);
      if (!state || !finiteInteger(delayMs, 1, 10_000)) throw new TypeError("Window state schedule is invalid");
      pending = state;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        try { if (next) write(next); }
        catch { if (!closed && pending === null) pending = next; }
      }, delayMs);
      timer.unref?.();
    },
    flush: () => {
      if (closed) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const next = pending;
      pending = null;
      if (next) write(next);
    },
    close: () => {
      if (closed) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const next = pending;
      pending = null;
      if (next) write(next);
      closed = true;
    },
  });
}

module.exports = Object.freeze({
  WINDOW_STATE_SCHEMA_VERSION,
  createWindowStateStore,
  normalizePersistedState,
  parseLaunchIntent,
  resolveWindowState,
});
