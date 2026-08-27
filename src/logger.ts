import { currentObservabilityContext } from "./observability.js";

type LogLevel = "info" | "warn" | "error" | "debug";

const REDACTED = "[REDACTED]";
const MAX_LOG_STRING = 4_096;
const MAX_LOG_ARRAY = 50;
const MAX_LOG_OBJECT_KEYS = 100;
const MAX_LOG_DEPTH = 8;
const sensitiveKey = /(?:api[-_]?key|authorization|credential|password|secret|token|prompt|messages?|content)/iu;

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
    .replace(/((?:api[-_]?key|authorization|credential|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu, `$1${REDACTED}`)
    .slice(0, MAX_LOG_STRING);
}

export function redactLogData(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value).slice(0, MAX_LOG_STRING);
  if (depth >= MAX_LOG_DEPTH) return "[DEPTH_LIMIT]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (Array.isArray(value)) return value.slice(0, MAX_LOG_ARRAY).map(entry => redactLogData(entry, seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS)) {
    output[key] = sensitiveKey.test(key) ? REDACTED : redactLogData(entry, seen, depth + 1);
  }
  return output;
}

export function log(level: LogLevel, tag: string, message: string, data?: unknown): void {
  const correlation = currentObservabilityContext();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    tag: redactText(tag).slice(0, 80),
    message: redactText(message),
    correlation: correlation ? { ...correlation } : null,
    ...(data === undefined ? {} : { data: redactLogData(data) }),
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (tag: string, msg: string, data?: unknown) => log("info", tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => log("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => log("error", tag, msg, data),
  debug: (tag: string, msg: string, data?: unknown) => log("debug", tag, msg, data),
};
