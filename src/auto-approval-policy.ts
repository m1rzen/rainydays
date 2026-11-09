// ===========================================
// Auto 授权的人工确认边界。
// Auto 只省去例行确认；模型若把摘要里的虚构任务当真，删除、推送和对外发送不应随之自动放行。
// 命令文本检查是尽力识别，不是隔离边界。
// ===========================================

const COMMAND_TEXT_ARGUMENT: Readonly<Record<string, string>> = { execute_command: "command", bash: "command", shell_input: "input", script: "code" };

const HIGH_IMPACT_COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[\s;&|(])(?:rm|del|erase|rd|rmdir|remove-item|rimraf)\s/iu, "删除文件"],
  [/\b(?:rmtree|unlink(?:Sync)?|rmSync|os\.remove)\b/iu, "删除文件"],
  [/\bformat\s+[a-z]:|\bdiskpart\b|\bmkfs\b|\bshutdown\b|\breg\s+delete\b/iu, "修改磁盘或系统"],
  [/\bgit\s+(?:push|clean\b|rebase\b|reset\s+--hard|checkout\s+--|branch\s+-d)/iu, "改写或推送 Git 历史"],
  [/\b(?:npm|pnpm|yarn)\s+publish\b/iu, "发布软件包"],
  [/\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|--upload-file|\s-d\s|\s-F\s)/iu, "向外部发送数据"],
  [/\b(?:invoke-restmethod|invoke-webrequest)\b[^\n]*-method\s+(?:post|put|patch|delete)/iu, "向外部发送数据"],
  [/\b(?:scp|sftp|rsync)\s/iu, "向外部发送文件"],
  [/\b(?:drop\s+(?:table|database)|truncate\s+table)\b/iu, "删除数据库内容"],
];

const ALWAYS_CONFIRM_TOOLS = new Set(["computer_use", "browser_eval", "browser_fetch", "browser_fill", "browser_type"]);

/** 返回必须由用户确认的原因；可以按 Auto 放行时返回 null。 */
export function requiresHumanDespiteAuto(toolName: string, args: Readonly<Record<string, unknown>>, context: Readonly<{ remoteMcp?: boolean }> = {}): string | null {
  if (context.remoteMcp) return "向远端服务发送数据";
  if (ALWAYS_CONFIRM_TOOLS.has(toolName)) return "操作桌面或在网页中输入内容";
  if (/_delete$/u.test(toolName)) return "删除已保存的内容";
  const argument = COMMAND_TEXT_ARGUMENT[toolName];
  if (!argument) return null;
  const text = args[argument];
  if (typeof text !== "string") return null;
  return HIGH_IMPACT_COMMANDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
