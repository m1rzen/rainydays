"use strict";

const SCHEMA_VERSION = 1;
const STATE_FILE = "recovery-state.json";
const MAX_STATE_BYTES = 64 * 1024;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAIN_CRASH_THRESHOLD = 3;
const MAX_EVENTS = 8;
const MAX_COUNTER = 1_000_000;
const REASONS = Object.freeze([
  "forced",
  "integrity-failure",
  "main-crash-loop",
  "service-crash-loop",
  "renderer-crash-loop",
  "electron-child-crash-loop",
]);

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function emptyState() {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeLaunch: false,
    launchStartedAt: null,
    uncleanLaunches: Object.freeze([]),
    safeMode: false,
    safeModeReason: null,
    serviceCrashLoops: 0,
    rendererCrashLoops: 0,
    electronChildCrashes: 0,
    normalRetry: false,
  });
}

function normalizeState(value) {
  if (!exactObject(value, [
    "schemaVersion",
    "activeLaunch",
    "launchStartedAt",
    "uncleanLaunches",
    "safeMode",
    "safeModeReason",
    "serviceCrashLoops",
    "rendererCrashLoops",
    "electronChildCrashes",
    "normalRetry",
  ]) || value.schemaVersion !== SCHEMA_VERSION
    || typeof value.activeLaunch !== "boolean"
    || !(value.launchStartedAt === null || timestamp(value.launchStartedAt))
    || !Array.isArray(value.uncleanLaunches)
    || value.uncleanLaunches.length > MAX_EVENTS
    || !value.uncleanLaunches.every(timestamp)
    || value.uncleanLaunches.some((entry, index) => index > 0 && value.uncleanLaunches[index - 1] > entry)
    || typeof value.safeMode !== "boolean"
    || !(value.safeModeReason === null || REASONS.includes(value.safeModeReason))
    || value.safeMode !== (value.safeModeReason !== null)
    || !counter(value.serviceCrashLoops)
    || !counter(value.rendererCrashLoops)
    || !counter(value.electronChildCrashes)
    || typeof value.normalRetry !== "boolean") return null;
  if (value.activeLaunch !== (value.launchStartedAt !== null)) return null;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeLaunch: value.activeLaunch,
    launchStartedAt: value.launchStartedAt,
    uncleanLaunches: Object.freeze([...value.uncleanLaunches]),
    safeMode: value.safeMode,
    safeModeReason: value.safeModeReason,
    serviceCrashLoops: value.serviceCrashLoops,
    rendererCrashLoops: value.rendererCrashLoops,
    electronChildCrashes: value.electronChildCrashes,
    normalRetry: value.normalRetry,
  });
}

function fileIdentity(info) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function directoryIdentity(info) {
  return `${info.dev}:${info.ino}:${info.mode}`;
}

function createRecoveryStateStore({ root, io, path, randomBytes, now = Date.now, onEvent = () => undefined }) {
  if (typeof root !== "string" || !io || !path || typeof randomBytes !== "function" || typeof now !== "function" || typeof onEvent !== "function") {
    throw new TypeError("Recovery state store options are invalid");
  }
  const canonicalRoot = io.realpathSync.native(root);
  const rootInfo = io.lstatSync(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Recovery state root is invalid");
  const rootIdentity = directoryIdentity(rootInfo);
  const statePath = path.join(canonicalRoot, STATE_FILE);
  let closed = false;

  const emit = (event, outcome) => {
    try { onEvent(Object.freeze({ event, outcome })); } catch { /* Diagnostics cannot alter recovery. */ }
  };
  const assertOpen = () => { if (closed) throw new Error("Recovery state store is closed"); };
  const assertRoot = () => {
    const current = io.lstatSync(canonicalRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || directoryIdentity(current) !== rootIdentity) {
      throw new Error("Recovery state root identity changed");
    }
  };

  const read = () => {
    assertOpen();
    assertRoot();
    let descriptor = null;
    try {
      const before = io.lstatSync(statePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_STATE_BYTES) {
        throw new Error("Recovery state identity is invalid");
      }
      descriptor = io.openSync(statePath, "r");
      const opened = io.fstatSync(descriptor);
      if (fileIdentity(opened) !== fileIdentity(before)) throw new Error("Recovery state changed before open");
      const bytes = io.readFileSync(descriptor);
      const after = io.fstatSync(descriptor);
      const named = io.lstatSync(statePath);
      if (bytes.length !== opened.size || fileIdentity(after) !== fileIdentity(opened) || fileIdentity(named) !== fileIdentity(opened)) {
        throw new Error("Recovery state changed while reading");
      }
      const state = normalizeState(JSON.parse(bytes.toString("utf8")));
      if (!state) throw new Error("Recovery state payload is invalid");
      emit("load", "success");
      return Object.freeze({ state, integrity: "verified" });
    } catch (error) {
      if (error?.code === "ENOENT") {
        emit("load", "missing");
        return Object.freeze({ state: emptyState(), integrity: "missing" });
      }
      emit("load", "invalid");
      return Object.freeze({ state: emptyState(), integrity: "invalid" });
    } finally {
      if (descriptor !== null) io.closeSync(descriptor);
    }
  };

  const write = value => {
    assertOpen();
    const state = normalizeState(value);
    if (!state) throw new TypeError("Recovery state payload is invalid");
    assertRoot();
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    const temporary = path.join(canonicalRoot, `.recovery-state.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
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
        throw new Error("Recovery state temporary identity is invalid");
      }
      assertRoot();
      io.closeSync(descriptor);
      descriptor = null;
      io.renameSync(temporary, statePath);
      assertRoot();
      const published = io.lstatSync(statePath);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 || published.size !== bytes.length) {
        throw new Error("Recovery state publication is invalid");
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
      if (cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "Recovery state publication and cleanup failed", { cause: primaryError });
      throw primaryError;
    }
    if (cleanupErrors.length) {
      emit("save", "failure");
      throw new AggregateError(cleanupErrors, "Recovery state cleanup failed");
    }
    emit("save", "success");
    return state;
  };

  const at = value => {
    const resolved = value ?? now();
    if (!timestamp(resolved)) throw new TypeError("Recovery timestamp is invalid");
    return resolved;
  };

  const recentCrashes = (state, time) => state.uncleanLaunches
    .filter(entry => entry <= time && time - entry <= CRASH_WINDOW_MS)
    .slice(-MAX_EVENTS);

  const beginLaunch = ({ time, forceSafeMode = false, normalRetry = false } = {}) => {
    const currentTime = at(time);
    const loaded = read();
    const previous = loaded.state;
    const crashes = recentCrashes(previous, currentTime);
    if (previous.activeLaunch) crashes.push(currentTime);
    const boundedCrashes = crashes.slice(-MAX_EVENTS);
    const retryAllowed = normalRetry === true && previous.normalRetry;
    const integrityFailure = loaded.integrity === "invalid";
    const safeMode = forceSafeMode || integrityFailure || (!retryAllowed && (previous.safeMode || boundedCrashes.length >= MAIN_CRASH_THRESHOLD));
    const safeModeReason = forceSafeMode
      ? "forced"
      : integrityFailure
        ? "integrity-failure"
        : safeMode
          ? previous.safeModeReason ?? "main-crash-loop"
          : null;
    return write({
      ...previous,
      activeLaunch: true,
      launchStartedAt: currentTime,
      uncleanLaunches: boundedCrashes,
      safeMode,
      safeModeReason,
      normalRetry: false,
    });
  };

  const enterSafeMode = (reason, time) => {
    if (!REASONS.includes(reason)) throw new TypeError("Safe mode reason is invalid");
    const currentTime = at(time);
    const previous = read().state;
    return write({
      ...previous,
      activeLaunch: true,
      launchStartedAt: previous.launchStartedAt ?? currentTime,
      safeMode: true,
      safeModeReason: reason,
      serviceCrashLoops: previous.serviceCrashLoops + (reason === "service-crash-loop" ? 1 : 0),
      rendererCrashLoops: previous.rendererCrashLoops + (reason === "renderer-crash-loop" ? 1 : 0),
      electronChildCrashes: previous.electronChildCrashes + (reason === "electron-child-crash-loop" ? 1 : 0),
      normalRetry: false,
    });
  };

  const requestNormalRetry = time => {
    at(time);
    const previous = read().state;
    return write({
      ...previous,
      activeLaunch: false,
      launchStartedAt: null,
      safeMode: false,
      safeModeReason: null,
      normalRetry: true,
    });
  };

  const markCleanExit = time => {
    at(time);
    const previous = read().state;
    const preserveRecovery = previous.safeMode || previous.normalRetry;
    return write({
      ...previous,
      activeLaunch: false,
      launchStartedAt: null,
      uncleanLaunches: preserveRecovery ? previous.uncleanLaunches : [],
      safeMode: preserveRecovery ? previous.safeMode : false,
      safeModeReason: preserveRecovery ? previous.safeModeReason : null,
      serviceCrashLoops: preserveRecovery ? previous.serviceCrashLoops : 0,
      rendererCrashLoops: preserveRecovery ? previous.rendererCrashLoops : 0,
      electronChildCrashes: preserveRecovery ? previous.electronChildCrashes : 0,
      normalRetry: previous.normalRetry,
    });
  };

  const diagnostics = () => {
    const state = read().state;
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      safeMode: state.safeMode,
      reason: state.safeModeReason,
      uncleanLaunches: state.uncleanLaunches.length,
      serviceCrashLoops: state.serviceCrashLoops,
      rendererCrashLoops: state.rendererCrashLoops,
      electronChildCrashes: state.electronChildCrashes,
      normalRetryAvailable: state.safeMode,
    });
  };

  return Object.freeze({
    path: statePath,
    beginLaunch,
    diagnostics,
    enterSafeMode,
    markCleanExit,
    requestNormalRetry,
    close: () => { closed = true; },
  });
}

module.exports = Object.freeze({
  CRASH_WINDOW_MS,
  MAIN_CRASH_THRESHOLD,
  REASONS,
  createRecoveryStateStore,
  normalizeState,
});
