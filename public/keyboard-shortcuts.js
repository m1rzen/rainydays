(function installRainyDaysKeyboard(global) {
  "use strict";

  const STORAGE_KEY = "rd-keymap-v1";
  const ACTIONS = Object.freeze([
    "cancelRun", "newSession", "openFile", "openTerminal", "openSettings", "closeTab",
    "previousTab", "nextTab", "splitHorizontal", "splitVertical", "attachFile",
  ]);
  const DEFAULT_BINDINGS = Object.freeze({
    cancelRun: "Escape",
    newSession: "Primary+N",
    openFile: "Primary+Shift+F",
    openTerminal: "Primary+Shift+T",
    openSettings: "Primary+,",
    closeTab: "Primary+W",
    previousTab: "Alt+Shift+[",
    nextTab: "Alt+Shift+]",
    splitHorizontal: "Alt+Shift+ArrowRight",
    splitVertical: "Alt+Shift+ArrowDown",
    attachFile: "Alt+V",
  });
  const MODIFIERS = Object.freeze(["Primary", "Control", "Meta", "Alt", "Shift"]);
  const MODIFIER_SET = new Set(MODIFIERS);
  const NAMED_KEYS = new Set(["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab", "Space", "[", "]", ","]);

  function normalizeKey(value) {
    if (/^[A-Za-z0-9]$/u.test(value)) return value.toUpperCase();
    const named = [...NAMED_KEYS].find(key => key.toLowerCase() === value.toLowerCase());
    if (!named) throw new TypeError("Shortcut key is invalid");
    return named;
  }

  function normalizeChord(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 80 || value.trim() !== value) throw new TypeError("Shortcut chord is invalid");
    const tokens = value.split("+");
    if (tokens.some(token => !token)) throw new TypeError("Shortcut chord is invalid");
    const modifiers = new Set();
    let key = null;
    for (const token of tokens) {
      const modifier = MODIFIERS.find(candidate => candidate.toLowerCase() === token.toLowerCase());
      if (modifier) {
        if (modifiers.has(modifier)) throw new TypeError("Shortcut modifier is duplicated");
        modifiers.add(modifier);
      } else {
        if (key !== null || MODIFIER_SET.has(token)) throw new TypeError("Shortcut chord has multiple keys");
        key = normalizeKey(token);
      }
    }
    if (!key || (modifiers.has("Primary") && (modifiers.has("Control") || modifiers.has("Meta")))) throw new TypeError("Shortcut chord is ambiguous");
    return [...MODIFIERS.filter(modifier => modifiers.has(modifier)), key].join("+");
  }

  function normalizeBindings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Shortcut bindings are invalid");
    const result = { ...DEFAULT_BINDINGS };
    for (const [action, chord] of Object.entries(value)) {
      if (!ACTIONS.includes(action)) throw new TypeError(`Unknown shortcut action: ${action}`);
      result[action] = normalizeChord(chord);
    }
    for (const platform of ["non-darwin", "darwin"]) {
      const seen = new Map();
      for (const [action, chord] of Object.entries(result)) {
        const semanticChord = chord.replace("Primary", platform === "darwin" ? "Meta" : "Control");
        const owner = seen.get(semanticChord);
        if (owner) throw new TypeError(`Shortcut conflict: ${owner} and ${action} on ${platform}`);
        seen.set(semanticChord, action);
      }
    }
    return Object.freeze(result);
  }

  function loadBindings(storage = global.localStorage) {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return normalizeBindings({});
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "bindings,schemaVersion" || value.schemaVersion !== 1) return normalizeBindings({});
      return normalizeBindings(value.bindings);
    } catch {
      return normalizeBindings({});
    }
  }

  function saveBindings(bindings, storage = global.localStorage) {
    const normalized = normalizeBindings(bindings);
    storage?.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, bindings: normalized }));
    return normalized;
  }

  function eventMatches(event, chord, platform = global.electronAPI?.platform || global.navigator?.platform || "") {
    const normalized = normalizeChord(chord);
    const tokens = normalized.split("+");
    const key = tokens.at(-1);
    const modifiers = new Set(tokens.slice(0, -1));
    const darwin = String(platform).toLowerCase().includes("darwin") || /mac/i.test(String(platform));
    const expectsControl = modifiers.has("Control") || (modifiers.has("Primary") && !darwin);
    const expectsMeta = modifiers.has("Meta") || (modifiers.has("Primary") && darwin);
    if (Boolean(event.ctrlKey) !== expectsControl || Boolean(event.metaKey) !== expectsMeta
      || Boolean(event.altKey) !== modifiers.has("Alt") || Boolean(event.shiftKey) !== modifiers.has("Shift")) return false;
    try { return normalizeKey(String(event.key)) === key; }
    catch { return false; }
  }

  function actionForEvent(event, bindings, platform) {
    for (const action of ACTIONS) if (eventMatches(event, bindings[action], platform)) return action;
    return null;
  }

  global.RainyDaysKeyboard = Object.freeze({
    storageKey: STORAGE_KEY,
    actions: ACTIONS,
    defaults: DEFAULT_BINDINGS,
    normalizeChord,
    normalizeBindings,
    loadBindings,
    saveBindings,
    eventMatches,
    actionForEvent,
  });
})(globalThis);
