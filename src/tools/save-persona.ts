// ===========================================
// save_persona 工具 —— 运行时保存当前配置为新 persona
// ===========================================

import matter from "gray-matter";
import type { PersonaNetworkPolicy, ToolDefinition, ToolExecutor } from "../types.js";
import { getManagedPathStore, validateManagedIdentifier } from "../managed-path-store.js";
import { PathDeniedError } from "../path-policy.js";

export const savePersonaDef: ToolDefinition = {
  type: "function",
  function: {
    name: "save_persona",
    description:
      "将当前的工作模式（system prompt + 工具集 + 环境变量）保存为一个新的 Persona 文件。保存后可以在 persona 选择器中切换到它。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Persona 内部名称（英文，如 'data-analyst'）" },
        displayName: { type: "string", description: "显示名称（中文，如 '数据分析师'）" },
        description: { type: "string", description: "Persona 描述" },
      },
      required: ["name", "displayName"],
    },
  },
};

export function createSavePersonaExec(
  getCurrentPersona: () => {
    tools: readonly string[];
    env: Readonly<Record<string, string>>;
    networkPolicy: PersonaNetworkPolicy;
    systemPrompt: string;
  },
  onSaved?: (name: string) => void | Promise<void>
): ToolExecutor {
  return async (args) => {
    const name = args.name as string;
    const displayName = args.displayName as string;
    const description = (args.description as string) || "";

    try {
      validateManagedIdentifier(name);
    } catch {
      return `❌ Persona 名称必须以小写字母或数字开头，只能包含小写字母、数字和连字符，且不超过64字符`;
    }

    const current = getCurrentPersona();

    // 构造 frontmatter + body
    const frontmatter: Record<string, unknown> = {
      name,
      display_name: displayName,
      description,
      tools: current.tools,
      env: current.env,
      network_policy: current.networkPolicy.mode,
      ...(current.networkPolicy.mode === "allowlist" ? { network_origins: current.networkPolicy.origins } : {}),
    };

    const content = matter.stringify(current.systemPrompt, frontmatter);
    const store = await getManagedPathStore();
    try {
      await store.createNamed("user-personas", name, ".md", Buffer.from(content, "utf8"));
    } catch (error) {
      if (error instanceof PathDeniedError && error.code === "PATH_OPERATION_DENIED") {
        const names = await store.listNames("user-personas", ".md");
        if (names.includes(name)) return `❌ Persona "${name}" 已存在。请用不同的名称。`;
      }
      throw error;
    }
    if (onSaved) await onSaved(name);
    return `✅ Persona "${displayName}" (${name}) 已保存，已热重载。现在可在选择器中看到它，或用 /persona ${name} 切换。`;
  };
}
