// ===========================================
// Supervisor —— 自动权限审批
// LLM 驱动的子 agent，自动判断工具调用是否安全
// approve / deny / escalate
// ===========================================

import type { LLMClient } from "./llm.js";

export type SupervisorDecision = "approve" | "deny" | "escalate";

let supervisorEnabled = false;
let supervisorRules = "";
let llmRef: LLMClient | null = null;

/** 需要审批的工具（有副作用的） */
const dangerousTools = new Set([
  "write_file", "edit_file", "create_docx", "create_xlsx",
  "execute_command", "shell_start", "shell_input", "shell_kill", "download",
]);

/** 初始化 Supervisor */
export function initSupervisor(llm: LLMClient): void {
  llmRef = llm;
}

/** 开启 Supervisor */
export function enableSupervisor(rules?: string): void {
  supervisorEnabled = true;
  if (rules) supervisorRules = rules;
  console.log(`✅ Supervisor 已开启${rules ? ` (规则: ${rules.slice(0, 50)}...)` : ""}`);
}

/** 关闭 Supervisor */
export function disableSupervisor(): void {
  supervisorEnabled = false;
  console.log("✅ Supervisor 已关闭");
}

/** Supervisor 是否开启 */
export function isSupervisorEnabled(): boolean {
  return supervisorEnabled;
}

/** 获取 Supervisor 规则 */
export function getSupervisorRules(): string {
  return supervisorRules;
}

/** 设置 Supervisor 规则 */
export function setSupervisorRules(rules: string): void {
  supervisorRules = rules;
}

/**
 * 审批工具调用
 * @returns approve=放行, deny=拒绝, escalate=交由用户决定
 */
export async function approveToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<{ decision: SupervisorDecision; reason: string }> {
  // 不在危险列表中的工具直接放行
  if (!dangerousTools.has(toolName)) {
    return { decision: "approve", reason: "只读工具，自动放行" };
  }

  // Supervisor 未开启时直接放行
  if (!supervisorEnabled || !llmRef) {
    return { decision: "approve", reason: "Supervisor 未开启" };
  }

  // 用 LLM 判断
  const argsStr = JSON.stringify(toolArgs).slice(0, 500);
  const prompt = `你是 Supervisor，负责审批工具调用。${supervisorRules ? `\n审批规则: ${supervisorRules}` : ""}

工具: ${toolName}
参数: ${argsStr}

请判断此操作是否安全：
- approve: 安全操作，自动放行
- deny: 危险操作，拒绝执行
- escalate: 不确定，需要用户确认

只返回一个 JSON: {"decision": "approve/deny/escalate", "reason": "简短理由"}`;

  try {
    const response = await llmRef.chat([
      { role: "system", content: "你是安全审批器。只返回 JSON。" },
      { role: "user", content: prompt },
    ]);

    const jsonStr = response.content.trim().replace(/^```json\s*/, "").replace(/```\s*$/, "");
    const result = JSON.parse(jsonStr);
    return { decision: result.decision as SupervisorDecision, reason: result.reason || "" };
  } catch {
    // 解析失败，escalate 到用户
    return { decision: "escalate", reason: "Supervisor 判断失败" };
  }
}
