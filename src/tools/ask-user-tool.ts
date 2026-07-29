// ===========================================
// ask_user 工具 —— agent 向用户提问
// 通过 SSE 推送问题到前端，暂停等待用户回答
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";

// 待回答的问题队列
const pendingQuestions = new Map<string, { resolve: (answer: string) => void; question: string; options: string[]; timer: ReturnType<typeof setTimeout> }>();
let questionCounter = 0;

/** SSE 回调——由 index.ts 注册 */
let sseCallback: ((data: unknown) => void) | null = null;

export function setAskUserSseCallback(cb: (data: unknown) => void): void {
  sseCallback = cb;
}

/** 用户提交回答（由 API 调用） */
export function submitAnswer(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pending.resolve(answer);
  pendingQuestions.delete(questionId);
  return true;
}

/**
 * 向用户提问并等待回答。
 * 供 ask_user 工具和 Supervisor escalate 共用，确保所有人工确认都走同一条 SSE 通道。
 */
export async function askUserQuestion(question: string, options: string[] = [], timeoutMs = 300000): Promise<string> {
  const questionId = `q_${++questionCounter}`;

  return await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingQuestions.has(questionId)) {
        pendingQuestions.delete(questionId);
        resolve("(用户未在5分钟内回答)");
      }
    }, timeoutMs);
    timer.unref?.();

    pendingQuestions.set(questionId, { resolve, question, options, timer });
    sseCallback?.({
      type: "ask_user",
      questionId,
      question,
      options,
      timestamp: Date.now(),
    });
  });
}

/**
 * 请求用户确认危险操作。
 * 只接受固定结构化选项的精确文本；模糊、复合或带否定的自由文本一律不授权。
 */
export async function askUserConfirm(question: string): Promise<{ approved: boolean; answer: string }> {
  const answer = await askUserQuestion(question, ["确认执行", "拒绝执行"]);
  const normalized = answer.trim().toLowerCase();

  const rejectChoices = new Set(["拒绝执行", "拒绝", "取消", "不同意", "不允许", "否", "no", "n", "deny", "reject", "cancel"]);
  if (rejectChoices.has(normalized)) return { approved: false, answer };

  const approveChoices = new Set(["确认执行", "确认", "同意", "允许", "可以", "是", "yes", "y", "approve", "ok"]);
  return { approved: approveChoices.has(normalized), answer };
}

export const askUserDef: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "向用户提问并等待回答。用于需要用户决策的场景，如选择方案、确认操作、提供缺失信息。会暂停执行直到用户回答。",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "要问用户的问题。",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选选项列表（最多 4 个）。用户也可以输入自定义答案。",
        },
      },
      required: ["question"],
    },
  },
};

export const askUserExec: ToolExecutor = async (args) => {
  const question = args.question as string;
  const options = (args.options as string[]) || [];
  const answer = await askUserQuestion(question, options);
  return `用户回答: ${answer}`;
};
