// ===========================================
// ask_user 工具 —— run-local 用户交互通道
// ===========================================

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolExecutor } from "../types.js";
import { throwIfCancelled } from "../run-cancellation.js";

export interface RunInteractionIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

export interface RunInteractionHandlers {
  readonly emit: (data: unknown) => void;
  readonly notify?: (title: string, body: string) => void;
  readonly signal?: AbortSignal;
}

interface RunInteractionScope {
  readonly identity: Readonly<RunInteractionIdentity>;
  readonly emit: (data: unknown) => void;
  readonly notify: ((title: string, body: string) => void) | null;
  readonly pendingQuestionIds: Set<string>;
  closed: boolean;
  cancellationAnswer: string;
}

interface PendingQuestion {
  readonly identity: Readonly<RunInteractionIdentity> | null;
  readonly resolve: (answer: string) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const interactionStorage = new AsyncLocalStorage<RunInteractionScope>();
const activeScopes = new Map<string, RunInteractionScope>();
const pendingQuestions = new Map<string, PendingQuestion>();

/** Legacy fallback used only until the HTTP chat route is migrated to runWithInteractionChannel. */
let legacySseCallback: ((data: unknown) => void) | null = null;

function validateIdentityPart(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function freezeIdentity(identity: RunInteractionIdentity): Readonly<RunInteractionIdentity> {
  return Object.freeze({
    sessionId: validateIdentityPart(identity?.sessionId, "sessionId"),
    runId: validateIdentityPart(identity?.runId, "runId"),
  });
}

function identityKey(identity: RunInteractionIdentity): string {
  return `${identity.sessionId}\0${identity.runId}`;
}

function sameIdentity(left: RunInteractionIdentity, right: RunInteractionIdentity): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId;
}

function nextQuestionId(): string {
  let questionId: string;
  do questionId = `q_${randomBytes(16).toString("hex")}`;
  while (pendingQuestions.has(questionId));
  return questionId;
}

function settleQuestion(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId);
  if (!pending) return false;
  pendingQuestions.delete(questionId);
  clearTimeout(pending.timer);
  if (pending.identity) activeScopes.get(identityKey(pending.identity))?.pendingQuestionIds.delete(questionId);
  pending.resolve(answer);
  return true;
}

function cancelScope(scope: RunInteractionScope, answer: string): void {
  scope.closed = true;
  scope.cancellationAnswer = answer;
  for (const questionId of [...scope.pendingQuestionIds]) settleQuestion(questionId, answer);
}

/**
 * Runs one Agent run inside an isolated interaction channel. Async descendants inherit
 * the scope, while concurrent runs retain independent handlers and pending questions.
 */
export async function runWithInteractionChannel<T>(
  identity: RunInteractionIdentity,
  handlers: RunInteractionHandlers,
  action: () => T | Promise<T>
): Promise<T> {
  const frozenIdentity = freezeIdentity(identity);
  if (!handlers || typeof handlers.emit !== "function") throw new TypeError("Run interaction emit handler is invalid");
  if (handlers.notify !== undefined && typeof handlers.notify !== "function") throw new TypeError("Run notification handler is invalid");
  if (typeof action !== "function") throw new TypeError("Run interaction action is invalid");
  if (interactionStorage.getStore()) throw new Error("A run interaction channel is already active in this async context");

  const key = identityKey(frozenIdentity);
  if (activeScopes.has(key)) throw new Error("Run interaction identity is already active");
  if (handlers.signal?.aborted) throw new Error("Run interaction channel is aborted");

  const scope: RunInteractionScope = {
    identity: frozenIdentity,
    emit: handlers.emit,
    notify: handlers.notify ?? null,
    pendingQuestionIds: new Set(),
    closed: false,
    cancellationAnswer: "(当前运行已结束)",
  };
  activeScopes.set(key, scope);
  const onAbort = () => cancelScope(scope, "(当前运行已取消)");
  handlers.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await interactionStorage.run(scope, action);
  } finally {
    handlers.signal?.removeEventListener("abort", onAbort);
    cancelScope(scope, "(当前运行已结束)");
    activeScopes.delete(key);
  }
}

/** Cancels pending questions for exactly one run, for example when its SSE stream closes. */
export function cancelRunInteraction(identity: RunInteractionIdentity): boolean {
  const frozenIdentity = freezeIdentity(identity);
  const scope = activeScopes.get(identityKey(frozenIdentity));
  if (!scope) return false;
  cancelScope(scope, "(当前运行连接已断开)");
  return true;
}

export function getRunInteractionIdentity(): Readonly<RunInteractionIdentity> | null {
  return interactionStorage.getStore()?.identity ?? null;
}

/**
 * Sends a notification only to the current run. null means there is no run-local scope,
 * preserving the legacy fallback boundary; false means the scoped delivery failed.
 */
export function emitRunNotification(title: string, body: string): boolean | null {
  const scope = interactionStorage.getStore();
  if (!scope) return null;
  if (scope.closed) return false;
  try {
    if (scope.notify) scope.notify(title, body);
    else scope.emit({
      type: "notification",
      sessionId: scope.identity.sessionId,
      runId: scope.identity.runId,
      title,
      body,
      timestamp: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

export function setAskUserSseCallback(cb: (data: unknown) => void): void {
  legacySseCallback = cb;
}

/** Secure run-local answer API. */
export function submitAnswer(sessionId: string, runId: string, questionId: string, answer: string): boolean;
/** Legacy fallback. It cannot answer run-local questions. */
export function submitAnswer(questionId: string, answer: string): boolean;
export function submitAnswer(first: string, second: string, third?: string, fourth?: string): boolean {
  if (third === undefined && fourth === undefined) {
    const pending = pendingQuestions.get(first);
    if (!pending || pending.identity !== null || typeof second !== "string") return false;
    return settleQuestion(first, second);
  }
  if (typeof third !== "string" || typeof fourth !== "string") return false;
  const pending = pendingQuestions.get(third);
  if (!pending?.identity || !sameIdentity(pending.identity, { sessionId: first, runId: second })) return false;
  return settleQuestion(third, fourth);
}

/** Ask the current run's user and wait for an identity-bound answer. */
export async function askUserQuestion(question: string, options: string[] = [], timeoutMs = 300000, signal?: AbortSignal): Promise<string> {
  if (signal) throwIfCancelled(signal);
  const questionId = nextQuestionId();
  const scope = interactionStorage.getStore();
  if (scope?.closed) return scope.cancellationAnswer;

  const onAbort = (): void => { settleQuestion(questionId, "(当前运行已取消)"); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const answer = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => settleQuestion(questionId, "(用户未在5分钟内回答)"), timeoutMs);
    timer.unref?.();
    const identity = scope?.identity ?? null;
    pendingQuestions.set(questionId, { identity, resolve, timer });
    scope?.pendingQuestionIds.add(questionId);
    if (signal?.aborted || scope?.closed) {
      settleQuestion(questionId, "(当前运行已取消)");
      return;
    }

    const event = {
      type: "ask_user",
      questionId,
      ...(identity ? { sessionId: identity.sessionId, runId: identity.runId } : {}),
      question,
      options,
      timestamp: Date.now(),
    };
    try {
      if (scope) scope.emit(event);
      else if (legacySseCallback) legacySseCallback(event);
      else settleQuestion(questionId, "(用户交互通道不可用)");
      } catch {
        settleQuestion(questionId, "(用户交互通道不可用)");
      }
    });
    if (signal) throwIfCancelled(signal);
    return answer;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function askUserConfirm(question: string, signal?: AbortSignal): Promise<{ approved: boolean; answer: string }> {
  const answer = await askUserQuestion(question, ["确认执行", "拒绝执行"], 300000, signal);
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
    description: "向用户提问并等待回答。用于需要用户决策的场景，如选择方案、确认操作、提供缺失信息。会暂停执行直到用户回答。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问用户的问题。" },
        options: { type: "array", items: { type: "string" }, description: "可选选项列表（最多 4 个）。用户也可以输入自定义答案。" },
      },
      required: ["question"],
    },
  },
};

export const askUserExec: ToolExecutor = async (args, _env, invocation) => {
  const answer = await askUserQuestion(args.question as string, (args.options as string[]) || [], 300000, invocation?.signal);
  return `用户回答: ${answer}`;
};
