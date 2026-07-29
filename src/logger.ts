// ===========================================
// 结构化日志 —— 带时间戳和级别
// 替代散落的 console.log
// ===========================================

type LogLevel = "info" | "warn" | "error" | "debug";

const COLORS: Record<LogLevel, string> = {
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  debug: "\x1b[90m",  // gray
};
const RESET = "\x1b[0m";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(level: LogLevel, tag: string, message: string, data?: unknown): void {
  const prefix = `${COLORS[level]}[${timestamp()}] [${level.toUpperCase()}] [${tag}]${RESET}`;
  if (data !== undefined) {
    console.log(prefix, message, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.log(prefix, message);
  }
}

export const logger = {
  info: (tag: string, msg: string, data?: unknown) => log("info", tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => log("warn", tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => log("error", tag, msg, data),
  debug: (tag: string, msg: string, data?: unknown) => log("debug", tag, msg, data),
};
