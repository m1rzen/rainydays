// ===========================================
// skill_open — read an enabled SKILL.md package on demand (A11)
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { ToolArgumentsError } from "../tool-pipeline.js";
import { openSkillPackage } from "../skill-packages.js";

export const skillOpenDef: ToolDefinition = {
  type: "function",
  function: {
    name: "skill_open",
    description: "读取「可用技能」中列出的技能。只给 name 时返回技能正文和参考文件清单；同时给 file 时只返回该参考文件。只读，不执行技能里的脚本或安装命令。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能 id，取自系统提示中的「可用技能」列表。" },
        file: { type: "string", description: "可选：技能文件夹内的参考文件相对路径，例如 references/guide.md。" },
      },
      required: ["name"],
    },
  },
};

export const skillOpenExec: ToolExecutor = async args => {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) throw new ToolArgumentsError("name 必须是可用技能列表中的 id");
  const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
  try { return await openSkillPackage(name, file); }
  catch (error) { throw new ToolArgumentsError(error instanceof Error ? error.message : String(error)); }
};
