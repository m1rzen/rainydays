// ===========================================
// 结构化日志 —— 带时间戳、级别和递归脱敏
// ===========================================

type LogLevel = "info" | "warn" | "error" | "debug";

const COLORS: Record<LogLevel, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[90m",
};
const RESET = "\x1b[0m";
const REDACTED = "[REDACTED]";
const sensitiveKey = /(?:api[-_]?key|authorization|credential|password|secret|token)/iu;

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
    .replace(/((?:api[-_]?key|authorization|credential|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu, `$1${REDACTED}`);
}

export function redactLogData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(entry => redactLogData(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? REDACTED : redactLogData(entry, seen);
  }
  return output;
}

export function log(level: LogLevel, tag: string, message: string, data?: unknown): void {
  const prefix = `${COLORS[level]}[${timestamp()}] [${level.toUpperCase()}] [${tag}]${RESET}`;
  if (data !== undefined) {
    console.log(prefix, redactText(message), JSON.stringify(redactLogData(data)));
  } else {
    console.log(prefix, redactText(message));
  }
}

export const logger = {
  info: (tag: string, msg: string, data?: unknown) => log("info", tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => log("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => log("error", tag, msg, data),
  debug: (tag: string, msg: string, data?: unknown) => log("debug", tag, msg, data),
};
