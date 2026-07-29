// ===========================================
// 系统工具 —— get_current_time
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";

export const getCurrentTimeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "获取当前日期和时间。返回 ISO 格式和中文可读格式。用于时间判断、时间戳、计算截止日期等。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const getCurrentTimeExec: ToolExecutor = async () => {
  const now = new Date();
  const iso = now.toISOString();
  const chinese = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const weekday = now.toLocaleDateString("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" });

  return `当前时间:\n  ISO: ${iso}\n  中文: ${chinese} ${weekday}`;
};
