import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUTPUT = process.env.LUX_PARITY_PROBE_OUTPUT;
const STABLE_TICKS = 10;
const MAX_TICKS = 150;
const INTERVAL_MS = 100;

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in tool definition");
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || typeof value === "undefined") {
    throw new Error(`Unsupported ${typeof value} in tool definition`);
  }
  if (seen.has(value)) throw new Error("Circular value in tool definition");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]));
  } finally {
    seen.delete(value);
  }
}

function serializeRegistry(lux) {
  const names = [...new Set(lux.tools.list())].sort();
  const tools = names.map((name) => {
    const entry = lux.tools.get(name);
    if (!entry?.definition) throw new Error(`Missing definition for tool: ${name}`);
    const definition = canonicalize(entry.definition);
    if (definition.name !== name) throw new Error(`Registry name mismatch: ${name}`);
    return definition;
  });
  return canonicalize({ version: String(lux.version), tools });
}

export default function parityToolCatalogProbe(lux) {
  if (!OUTPUT) {
    lux.log.warn("LUX_PARITY_PROBE_OUTPUT is not set; parity probe is inactive");
    return;
  }

  let ticks = 0;
  let stableTicks = 0;
  let previous = "";
  const timer = setInterval(() => {
    ticks += 1;
    try {
      const snapshot = serializeRegistry(lux);
      const serialized = JSON.stringify(snapshot);
      if (snapshot.tools.length > 0 && serialized === previous) stableTicks += 1;
      else stableTicks = 0;
      previous = serialized;

      if (stableTicks >= STABLE_TICKS || ticks >= MAX_TICKS) {
        if (snapshot.tools.length === 0) throw new Error("Runtime tool registry is empty");
        mkdirSync(dirname(OUTPUT), { recursive: true });
        writeFileSync(OUTPUT, JSON.stringify({ ...snapshot, stable: stableTicks >= STABLE_TICKS }, null, 2) + "\n", "utf8");
        clearInterval(timer);
        lux.log.info(`Parity tool catalog exported: ${snapshot.tools.length} tools`);
      }
    } catch (error) {
      mkdirSync(dirname(OUTPUT), { recursive: true });
      writeFileSync(OUTPUT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) + "\n", "utf8");
      clearInterval(timer);
      lux.log.error(`Parity probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, INTERVAL_MS);
  timer.unref?.();
  lux.onDispose(() => clearInterval(timer));
}
