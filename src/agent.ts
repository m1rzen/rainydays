// ===========================================
// Agent 核心 —— 对话循环（流式版 + 任务系统）
// 思考 → 调工具 → 看结果 → 再思考 → ... → 逐字回答
// 工具调用时检测任务相关操作，yield task 事件给前端
// ===========================================

import { randomUUID } from "node:crypto";
import type { LLMClient } from "./llm.js";
import type { ConversationMemory } from "./memory.js";
import type { AgentStep, PersonaDefinition, Message, MessageAttachment, TaskSnapshot, ToolCall, ToolExecutionOutcome, ToolPipelineStageRecord } from "./types.js";
import type { CapabilityContext, InspectedToolCall, RuntimeAuthority, ToolPolicy } from "./capability-broker.js";
import { CapabilityDeniedError } from "./capability-broker.js";
import { PathDeniedError } from "./path-policy.js";
import { NetworkPolicyDeniedError } from "./network-policy.js";
import { capabilityBroker, getToolDefinitions, inspectToolCall, prepareInspectedToolExecution, type PreparedToolExecution } from "./tools/index.js";
import { createToolOutcome, isValidToolCallId, parseToolArguments, serializeToolOutcome, ToolArgumentsError, ToolExecutionError, ToolLoopDetector, ToolLoopError, ToolStageTrace } from "./tool-pipeline.js";
import { touch, autoGenerateTitle, generateSemanticSessionTitle } from "./session.js";
import { getTasksBySession, getNextPendingTask, allTasksCompleted } from "./task.js";
import { getRecentMemories, getPinsBySession } from "./db.js";
import { approveToolCall } from "./supervisor.js";
import { buildToolExecutionBatches } from "./tool-scheduler.js";
import { askUserConfirm } from "./tools/ask-user-tool.js";
import { readMessageAttachmentForSession } from "./attachment-store.js";
import { requestNativeProcessConsent } from "./native-process-consent.js";
import type { SecurityAuditJournal } from "./security-audit-journal.js";
import { cancellationError, isRunCancellation, isRunSettlementFailure, NEVER_ABORT_SIGNAL, throwIfCancelled } from "./run-cancellation.js";
import {
  makeAuthorizationAuditPayload,
  makeExecutionAuditPayload,
  makeRequestAuditPayload,
  makeResultAuditPayload,
  type SecurityAuditCorrelation,
  type SecurityAuditResultStatus,
} from "./security-audit.js";

const MAX_ITERATIONS = 25;

const SERIAL_SCHEDULING_POLICY: ToolPolicy = Object.freeze({
  riskClasses: Object.freeze(["read"] as const),
  approval: "none",
  effects: Object.freeze([] as const),
  pathOperations: Object.freeze([] as const),
});

interface ParsedAgentToolCall {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly rawArguments: string;
  readonly toolArgs: Readonly<Record<string, unknown>> | null;
  readonly parseError: string | null;
}

interface PlannedAgentToolCall extends ParsedAgentToolCall {
  readonly originalIndex: number;
  readonly policy: ToolPolicy;
  readonly inspected: InspectedToolCall | null;
  readonly planningError: unknown;
  readonly trace: ToolStageTrace;
}

interface AgentToolResult {
  readonly toolName: string;
  readonly outcome: ToolExecutionOutcome;
  readonly stages: readonly ToolPipelineStageRecord[];
  readonly toolMs: number;
}

interface SettledAgentToolCall {
  readonly result: AgentToolResult;
  readonly fatal: unknown | null;
}

function resultStatus(result: string): SecurityAuditResultStatus {
  if (result.startsWith("⛔")) return "denied";
  if (/超时|timeout/iu.test(result)) return "timeout";
  if (result.startsWith("工具执行出错:")) return "error";
  return "success";
}

class ToolAuditTrail {
  readonly #journal: SecurityAuditJournal;
  readonly #context: CapabilityContext;
  readonly #toolCallId: string | null;
  readonly #toolName: string;
  readonly #requestCommitment: string;
  readonly #requestId = randomUUID();
  #executionId: string | null = null;
  #authorized = false;
  #executed = false;
  #finished = false;

  constructor(journal: SecurityAuditJournal, context: CapabilityContext, toolCallId: string | null, toolName: string, rawArguments: string) {
    this.#journal = journal;
    this.#context = context;
    this.#toolCallId = toolCallId;
    this.#toolName = /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(toolName) ? toolName : "invalid-tool-name";
    this.#requestCommitment = journal.commit({ toolName, rawArguments });
  }

  #correlation(): SecurityAuditCorrelation {
    return Object.freeze({
      sessionId: this.#context.sessionId,
      runId: this.#context.runId,
      requestId: this.#requestId,
      parentRequestId: null,
      toolCallId: this.#toolCallId,
      contextId: this.#context.contextId,
      executionId: this.#executionId,
    });
  }

  #common() {
    return {
      correlation: this.#correlation(),
      principal: "agent" as const,
      operationKind: "tool" as const,
      operationName: this.#toolName,
      requestCommitment: this.#requestCommitment,
    };
  }

  get requestId(): string { return this.#requestId; }
  get authorized(): boolean { return this.#authorized; }
  get executed(): boolean { return this.#executed; }
  get finished(): boolean { return this.#finished; }

  async request(rawArguments: string): Promise<void> {
    await this.#journal.append({
      ...this.#common(),
      phase: "request",
      outcome: "received",
      code: null,
      safePayload: makeRequestAuditPayload({
        ingress: "agent-tool",
        argumentBytes: Buffer.byteLength(rawArguments, "utf8"),
        argumentsCommitment: this.#journal.commit(rawArguments),
      }),
    });
  }

  async authorize(decision: "allowed" | "denied", approvalKind: "none" | "supervisor" | "user" | "native-process", code: string | null, policyDigest: string | null = null): Promise<void> {
    if (this.#authorized) throw new Error("Security audit authorization was already recorded");
    await this.#journal.append({
      ...this.#common(),
      phase: "authorization",
      outcome: decision,
      code,
      safePayload: makeAuthorizationAuditPayload({
        decision,
        policyDigest,
        personaDigest: this.#context.persona.digest,
        approvalKind,
      }),
    });
    this.#authorized = true;
  }

  async execution(started: boolean): Promise<void> {
    if (!this.#authorized || this.#executed) throw new Error("Security audit execution phase is invalid");
    this.#executionId = started ? randomUUID() : null;
    await this.#journal.append({
      ...this.#common(),
      phase: "execution",
      outcome: started ? "started" : "not_started",
      code: null,
      safePayload: makeExecutionAuditPayload({
        state: started ? "started" : "not_started",
        executor: started ? "tool-dispatcher" : "none",
        profile: null,
        proofDigest: null,
      }),
    });
    this.#executed = true;
  }

  async result(
    result: string,
    durationMs: number,
    status = resultStatus(result),
    code: string | null = null,
    outputBytes = Buffer.byteLength(result, "utf8"),
    truncated = false,
  ): Promise<void> {
    if (!this.#executed || this.#finished) throw new Error("Security audit result phase is invalid");
    await this.#journal.append({
      ...this.#common(),
      phase: "result",
      outcome: status,
      code,
      safePayload: makeResultAuditPayload({
        status,
        durationMs,
        outputBytes,
        truncated,
        resultCommitment: this.#journal.commit(result),
      }),
    });
    this.#finished = true;
  }

  async deny(outcome: ToolExecutionOutcome, durationMs: number, approvalKind: "none" | "supervisor" | "user" | "native-process", code: string, policyDigest: string | null = null): Promise<void> {
    await this.authorize("denied", approvalKind, code, policyDigest);
    await this.execution(false);
    await this.result(outcome.content, durationMs, "denied", code, outcome.outputBytes, outcome.truncated);
  }
}

export class Agent {
  private llm: LLMClient;
  private memory: ConversationMemory;
  private persona: PersonaDefinition;
  private authority: RuntimeAuthority;
  private auditJournal: SecurityAuditJournal | null;
  private sessionId: string | null = null;
  private running = false;

  constructor(llm: LLMClient, memory: ConversationMemory, persona: PersonaDefinition, authority: RuntimeAuthority, auditJournal: SecurityAuditJournal | null = null) {
    this.llm = llm;
    this.memory = memory;
    this.persona = persona;
    this.authority = authority;
    this.auditJournal = auditJournal;
    this.memory.setSystemPrompt(persona.systemPrompt);
  }

  setSession(sessionId: string): void {
    if (this.running) throw new Error("Agent 正在运行，不能切换会话");
    this.sessionId = sessionId;
    this.memory.setSessionId(sessionId);
    this.memory.loadFromDb(sessionId);
    this.memory.setSystemPrompt(this.persona.systemPrompt);
  }

  switchPersona(persona: PersonaDefinition, authority: RuntimeAuthority): void {
    if (this.running) throw new Error("Agent 正在运行，不能切换 Persona");
    this.persona = persona;
    this.authority = authority;
    this.memory.reset();
    this.memory.setSystemPrompt(persona.systemPrompt);
    this.sessionId = null;
  }

  getPersona(): PersonaDefinition {
    return this.persona;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 每次 run 都从当前 persona、跨会话记忆和 Pin 重建唯一主 system prompt。 */
  private refreshSystemPrompt(sessionId: string): void {
    const memories = getRecentMemories(10);
    const pins = getPinsBySession(sessionId);
    const blocks = [this.persona.systemPrompt];

    if (memories.length > 0) {
      const lines = memories.map((memory) => {
        let tags: string[] = [];
        try { tags = JSON.parse(memory.tags || "[]"); } catch { /* ignore */ }
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        return `- [${memory.kind}]${tagStr} ${memory.content}`;
      });
      blocks.push(`## 跨会话记忆\n以下是之前对话中记住的重要信息。相关的记忆会自动出现在这里，不需要主动搜索。如果需要更详细的信息，使用 recall 工具搜索。\n${lines.join("\n")}`);
    }

    if (pins.length > 0) {
      blocks.push("## 固定指令\n以下是用户设定的持久指令，在整个会话中持续生效：\n" +
        pins.map((pin, index) => `${index + 1}. ${pin.content}`).join("\n"));
    }

    this.memory.setSystemPrompt(blocks.join("\n\n"));
  }

  private async executePlannedToolCall(input: Readonly<{
    planned: PlannedAgentToolCall;
    capabilityContext: CapabilityContext;
    runAuthority: RuntimeAuthority;
    runSessionId: string;
    signal: AbortSignal;
    loopDetector: ToolLoopDetector;
  }>): Promise<SettledAgentToolCall> {
    const { planned, capabilityContext, runAuthority, runSessionId, signal, loopDetector } = input;
    const { toolCall, toolName, rawArguments, toolArgs, inspected, planningError, trace } = planned;
    const toolStart = Date.now();
    const audit = this.auditJournal
      ? new ToolAuditTrail(this.auditJournal, capabilityContext, toolCall.id, toolName, rawArguments)
      : null;
    let grantContext: CapabilityContext | null = null;
    let preparedExecution: PreparedToolExecution | null = null;
    let policyDigest: string | null = null;
    const settled = (outcome: ToolExecutionOutcome, fatal: unknown = null): SettledAgentToolCall => Object.freeze({
      result: Object.freeze({ toolName, outcome, stages: trace.snapshot(), toolMs: Date.now() - toolStart }),
      fatal,
    });

    await audit?.request(rawArguments);
    try {
      if (planningError) throw planningError;
      if (!inspected || !toolArgs) {
        throw new ToolArgumentsError(planned.parseError ?? "工具参数不是合法 JSON");
      }
      policyDigest = this.auditJournal?.commit(inspected.policy) ?? null;
      const advice = await approveToolCall(toolName, inspected.args as Record<string, unknown>, signal);
      if (advice.decision === "deny") {
        const outcome = createToolOutcome("denied", `⛔ Supervisor 拒绝执行: ${advice.reason}`, "SUPERVISOR_DENIED");
        trace.record("approval", "denied", outcome.code);
        trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
        await audit?.deny(outcome, Date.now() - toolStart, "supervisor", "SEC06_SUPERVISOR_DENIED", policyDigest);
        trace.record("audit", "passed");
        return settled(outcome);
      }
      if (inspected.policy.concurrency === "parallel-read" && advice.decision !== "approve") {
        const outcome = createToolOutcome("denied", "⛔ 并行只读调用不能进入交互式审批", "PARALLEL_APPROVAL_REQUIRED");
        trace.record("approval", "denied", outcome.code);
        trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
        await audit?.deny(outcome, Date.now() - toolStart, "supervisor", "SEC06_PARALLEL_APPROVAL_REQUIRED", policyDigest);
        trace.record("audit", "passed");
        return settled(outcome);
      }

      const requiresGrant = inspected.policy.approval === "user";
      const requiresConfirmation = requiresGrant || advice.decision === "escalate";
      let approvalKind: "none" | "user" | "native-process" = "none";
      if (requiresConfirmation) {
        const challenge = requiresGrant ? capabilityBroker.createApprovalChallenge(capabilityContext, inspected) : null;
        const requiresNativeProcessConsent = inspected.policy.effects.includes("process");
        approvalKind = requiresNativeProcessConsent ? "native-process" : "user";
        let approved = false;
        let answer = "原生进程确认被拒绝或不可用";
        if (requiresNativeProcessConsent) {
          approved = await requestNativeProcessConsent({
            authority: runAuthority,
            authorityEpoch: capabilityContext.authorityEpoch,
            sessionId: runSessionId,
            runId: capabilityContext.runId,
            contextId: capabilityContext.contextId,
            registrationId: inspected.registrationId,
            toolName,
            argumentsDigest: inspected.argumentsDigest,
            args: inspected.args,
            profile: toolName === "execute_command"
              ? "E1 · one-shot-shell"
              : toolName === "shell_start" || toolName === "shell_input"
                ? "E2 · agent-shell"
                : toolName === "script"
                  ? "E3 · script"
                  : `fixed-purpose · ${toolName}`,
            rootAliases: capabilityContext.allowedRoots,
            cwd: typeof inspected.args.cwd === "string" ? inspected.args.cwd : "(tool default)",
            validateCurrent: () => this.running && this.authority === runAuthority
              && this.sessionId === runSessionId && capabilityBroker.isContextActive(capabilityContext),
            signal,
          });
        } else {
          const question = `${requiresGrant ? "此工具需要用户批准" : "Supervisor 请求用户确认"}。\n\n工具: ${toolName}\n参数: ${JSON.stringify(inspected.args, null, 2).slice(0, 1000)}\n原因: ${advice.reason}\n\n请选择是否执行。`;
          const confirmation = await askUserConfirm(question, signal);
          approved = confirmation.approved;
          answer = confirmation.answer;
        }
        if (challenge) {
          grantContext = capabilityBroker.resolveApprovalChallenge({
            challengeId: challenge.challengeId,
            choice: approved ? "approve" : "deny",
            sessionId: runSessionId,
            runId: capabilityContext.runId,
            responsePrincipal: "local-user-api",
            responseChannel: requiresNativeProcessConsent ? "native-process" : "ask-user",
          });
        }
        if (!approved || (requiresGrant && !grantContext)) {
          const outcome = createToolOutcome("denied", `⛔ 用户拒绝执行（${answer}）`, "USER_DENIED");
          trace.record("approval", "denied", outcome.code);
          trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
          await audit?.deny(outcome, Date.now() - toolStart, approvalKind, "SEC06_USER_DENIED", policyDigest);
          trace.record("audit", "passed");
          return settled(outcome);
        }
      }

      trace.record("approval", "passed");
      await audit?.authorize("allowed", approvalKind, null, policyDigest);
      preparedExecution = prepareInspectedToolExecution(
        grantContext ?? capabilityContext,
        inspected,
        audit && this.auditJournal ? Object.freeze({ journal: this.auditJournal, parentRequestId: audit.requestId }) : null,
        signal,
        loopDetector,
      );
      trace.record("policy", "passed");
      await audit?.execution(true);
      const outcome = await preparedExecution.execute();
      trace.record("execute", "passed");
      trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
      await audit?.result(outcome.content, Date.now() - toolStart, "success", null, outcome.outputBytes, outcome.truncated);
      trace.record("audit", "passed");
      return settled(outcome);
    } catch (error) {
      if (isRunCancellation(error) || (signal.aborted && error instanceof Error && error.name === "AbortError")) {
        const cancelled = isRunCancellation(error) ? error : cancellationError(signal);
        const cancellationStatus = cancelled.code === "RUN_TIMEOUT" ? "timeout" : "cancelled";
        const outcome = createToolOutcome(cancellationStatus, `工具执行${cancellationStatus === "timeout" ? "超时" : "已取消"}: ${cancelled.message}`, cancelled.code);
        if (!trace.has("approval")) trace.record("approval", "error", cancelled.code);
        else if (!trace.has("policy")) trace.record("policy", "error", cancelled.code);
        else trace.record("execute", "error", cancelled.code);
        trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
        if (audit && !audit.finished) {
          if (!audit.authorized) await audit.authorize("denied", "none", cancelled.code, policyDigest);
          if (!audit.executed) await audit.execution(false);
          await audit.result(outcome.content, Date.now() - toolStart, cancellationStatus, cancelled.code, outcome.outputBytes, outcome.truncated);
        }
        trace.record("audit", "passed");
        return settled(outcome, cancelled);
      }
      if (trace.has("output")) {
        trace.record("audit", "error", "SECURITY_AUDIT_FAILED");
        throw new Error(`Security audit delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const denied = error instanceof CapabilityDeniedError
        || error instanceof PathDeniedError
        || error instanceof NetworkPolicyDeniedError
        || error instanceof ToolArgumentsError
        || error instanceof ToolLoopError;
      const code = error instanceof CapabilityDeniedError || error instanceof PathDeniedError || error instanceof NetworkPolicyDeniedError || error instanceof ToolExecutionError || error instanceof ToolLoopError
        ? error.code
        : error instanceof ToolArgumentsError
          ? "TOOL_ARGUMENTS_INVALID"
          : isRunSettlementFailure(error)
            ? error.code
            : "TOOL_EXECUTION_FAILED";
      const content = error instanceof CapabilityDeniedError
        ? `⛔ 执行授权拒绝 [${error.code}]`
        : error instanceof PathDeniedError
          ? `⛔ 路径授权拒绝 [${error.code}]`
          : error instanceof NetworkPolicyDeniedError
            ? `⛔ 网络授权拒绝 [${error.code}]`
            : error instanceof ToolArgumentsError || error instanceof ToolLoopError
              ? `⛔ ${error.message}`
              : `工具执行出错: ${error instanceof Error ? error.message : String(error)}`;
      const outcome = createToolOutcome(denied ? "denied" : "error", content, code);
      if (error instanceof ToolArgumentsError && !trace.has("schema")) trace.record("schema", "denied", code);
      else if (error instanceof CapabilityDeniedError && !trace.has("capability")) {
        if (!trace.has("schema")) trace.record("schema", "passed");
        trace.record("capability", "denied", code);
      } else if (error instanceof ToolLoopError && !trace.has("loop")) trace.record("loop", "denied", code);
      else if ((error instanceof PathDeniedError || error instanceof NetworkPolicyDeniedError) && !trace.has("policy")) trace.record("policy", "denied", code);
      else if (!trace.has("policy")) trace.record("policy", "error", code);
      else trace.record("execute", "error", code);
      trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
      if (audit && !audit.finished) {
        if (!audit.authorized) await audit.deny(outcome, Date.now() - toolStart, "none", code, policyDigest);
        else {
          if (!audit.executed) await audit.execution(false);
          await audit.result(outcome.content, Date.now() - toolStart, outcome.status, code, outcome.outputBytes, outcome.truncated);
        }
      }
      trace.record("audit", "passed");
      return settled(outcome, isRunSettlementFailure(error) ? error : null);
    } finally {
      preparedExecution?.close();
      if (grantContext && capabilityBroker.isContextActive(grantContext)) capabilityBroker.finishContext(grantContext);
    }
  }

  /**
   * 处理用户输入 —— 流式输出
   * 产出事件序列：
   *   [task_created] → [task_update] → tool_call → tool_result → ... → answer_chunk × N → answer_done
   */
  async *run(
    userInput: string,
    runId?: string,
    signal: AbortSignal = NEVER_ABORT_SIGNAL,
    userAttachments: readonly MessageAttachment[] = [],
  ): AsyncGenerator<AgentStep> {
    if (!this.sessionId) {
      yield {
        type: "error",
        content: "未绑定会话，请先创建或选择一个会话",
        timestamp: Date.now(),
      };
      return;
    }

    throwIfCancelled(signal);
    const runSessionId = this.sessionId;
    const runAuthority = this.authority;
    let capabilityContext;
    try {
      capabilityContext = capabilityBroker.beginAgentRun(runAuthority, runSessionId, runId);
    } catch (error) {
      yield {
        type: "error",
        content: error instanceof CapabilityDeniedError ? `执行授权失败 [${error.code}]` : `无法开始 Agent run: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      };
      return;
    }

    this.running = true;
    try {
      throwIfCancelled(signal);
      const isFirstMessage = this.memory.getAll().filter((m) => m.role === "user").length === 0;
      const attachments = Object.freeze([...userAttachments]);
      this.memory.add({ role: "user", content: userInput, ...(attachments.length ? { attachments } : {}) });

      if (isFirstMessage) {
        const titleInput = userInput.trim() || attachments.map(attachment => attachment.name).join(", ");
        const fallbackTitle = autoGenerateTitle(runSessionId, titleInput);
        void generateSemanticSessionTitle(this.llm, runSessionId, titleInput, fallbackTitle).catch(() => undefined);
      }

      this.refreshSystemPrompt(runSessionId);

      const tools = getToolDefinitions(capabilityContext);

      // 任务驱动模式：新建 DAG 或重启后已有未完成 DAG 都会选择未阻塞任务。
      let taskMode = getTasksBySession(runSessionId).some(task => task.status !== "completed");
      const toolLoopDetector = new ToolLoopDetector();

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      throwIfCancelled(signal);
      const iterStart = Date.now();

      // 每轮调 LLM 前检查上下文预算，必要时压缩
      const compactStart = Date.now();
      await this.memory.compact(this.llm, signal);
      const compactMs = Date.now() - compactStart;

      // 任务驱动：如果有 pending 任务，注入当前任务状态引导 LLM 执行下一个
    if (taskMode) {
      const tasks = getTasksBySession(runSessionId);
      const pending = tasks.filter((t) => t.status === "pending");
      const inProgress = tasks.filter((t) => t.status === "in_progress");

      if (pending.length > 0 || inProgress.length > 0) {
        // 构造任务状态提示
        const taskStatus = tasks.map((t) => {
          const icon = { pending: t.blocked ? "⛔" : "⏳", in_progress: "🔄", completed: "✅" }[t.status] || "?";
          return `${icon} [${t.id}] ${t.subject}`;
        }).join("\n");

        const nextTask = getNextPendingTask(runSessionId);
        const guidance = nextTask
          ? `\n\n当前任务进度:\n${taskStatus}\n\n请执行下一个未阻塞任务: [${nextTask.id}] ${nextTask.subject}。先调用 task_update(task_id=${nextTask.id}, status=in_progress)，完成后调用 task_update(task_id=${nextTask.id}, status=completed)。`
          : inProgress.length > 0
            ? `\n\n当前任务进度:\n${taskStatus}\n\n请继续执行进行中的任务。`
            : `\n\n当前任务进度:\n${taskStatus}\n\n所有 pending 任务都被依赖阻塞。请用 task_get/task_list 检查依赖，不要启动 blocked 任务。`;

        // 以 system 消息形式注入引导（不持久化到数据库）
        this.memory.add({ role: "system", content: guidance });
      } else if (tasks.length > 0 && allTasksCompleted(runSessionId)) {
        // 所有任务完成，退出任务模式
        taskMode = false;
        const completed = tasks.filter((t) => t.status === "completed").length;
        const summary = `\n\n所有任务已完成（${completed}/${tasks.length}）。请汇总执行结果给用户。`;
        this.memory.add({ role: "system", content: summary });
      }
    }

      let finalMessage: Message | null = null;
      let hasStreamedContent = false;

      const llmStart = Date.now();
      try {
        for await (const event of this.llm.chatStream(this.memory.getAll(), tools, signal, runSessionId, readMessageAttachmentForSession)) {
          if (event.type === "delta") {
            hasStreamedContent = true;
            yield {
              type: "answer_chunk",
              content: event.content,
              timestamp: Date.now(),
            };
          } else {
            finalMessage = event.message;
          }
        }
      } catch (err) {
        if (isRunCancellation(err) || signal.aborted) throw err;
        // LLM 请求失败（重试已耗尽），yield error 而不是崩溃
        yield {
          type: "error",
          content: `LLM 请求失败: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        };
        return;
      }

      throwIfCancelled(signal);
      const llmMs = Date.now() - llmStart;
      console.log(`⏱️ [迭代 ${i}] compact=${compactMs}ms, LLM=${llmMs}ms, messages=${this.memory.getMessageCount()}, tokens=${this.memory.getTokenEstimate()}`);

      if (!finalMessage) {
        yield { type: "error", content: "LLM 返回为空", timestamp: Date.now() };
        return;
      }

      // 情况 A：LLM 决定调用工具
      if (finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
        if (hasStreamedContent) {
          yield { type: "answer_done", content: "", timestamp: Date.now() };
        }

        const toolCallIds = finalMessage.tool_calls.map(toolCall => toolCall.id);
        const toolCallIdsValid = toolCallIds.every(isValidToolCallId)
          && new Set(toolCallIds).size === toolCallIds.length;
        if (!toolCallIdsValid) {
          const outcome = createToolOutcome("denied", "⛔ LLM 返回无效或重复的 tool_call_id", "TOOL_CALL_ID_INVALID");
          if (this.auditJournal) {
            for (const toolCall of finalMessage.tool_calls) {
              const rawArguments = toolCall.function.arguments;
              const audit = new ToolAuditTrail(
                this.auditJournal,
                capabilityContext,
                isValidToolCallId(toolCall.id) ? toolCall.id : null,
                toolCall.function.name,
                rawArguments,
              );
              await audit.request(rawArguments);
              await audit.deny(outcome, 0, "none", "SEC06_TOOL_CALL_ID_INVALID");
            }
          }
          yield {
            type: "error",
            content: outcome.content,
            timestamp: Date.now(),
          };
          return;
        }

        const toolCallsParsed = finalMessage.tool_calls.map((toolCall) => {
          const toolName = toolCall.function.name;
          const rawArguments = toolCall.function.arguments;
          try {
            return { toolCall, toolName, rawArguments, toolArgs: parseToolArguments(rawArguments), parseError: null };
          } catch (error) {
            return {
              toolCall,
              toolName,
              rawArguments,
              toolArgs: null,
              parseError: error instanceof ToolArgumentsError ? error.message : "工具参数不是合法 JSON",
            };
          }
        });

        for (const { toolName, toolArgs } of toolCallsParsed) {
          yield {
            type: "tool_call",
            content: `调用工具: ${toolName}`,
            toolName,
            toolArgs: toolArgs ?? undefined,
            timestamp: Date.now(),
          };
        }

        const plannedCalls: PlannedAgentToolCall[] = toolCallsParsed.map((parsed, originalIndex) => {
          const trace = new ToolStageTrace();
          let inspected: InspectedToolCall | null = null;
          let planningError: unknown = parsed.toolArgs
            ? null
            : new ToolArgumentsError(parsed.parseError ?? "工具参数不是合法 JSON");
          if (parsed.toolArgs) {
            try {
              inspected = inspectToolCall(capabilityContext, parsed.toolName, parsed.toolArgs);
              trace.record("schema", "passed");
              trace.record("capability", "passed");
              toolLoopDetector.observe(inspected.name, inspected.argumentsDigest);
              trace.record("loop", "passed");
            } catch (error) {
              planningError = error;
            }
          }
          return Object.freeze({
            ...parsed,
            originalIndex,
            policy: inspected?.policy ?? SERIAL_SCHEDULING_POLICY,
            inspected,
            planningError,
            trace,
          });
        });
        const batches = buildToolExecutionBatches(plannedCalls);
        const results: AgentToolResult[] = new Array(plannedCalls.length);
        let batchCancellation: ReturnType<typeof cancellationError> | null = null;
        const executePlanned = (planned: PlannedAgentToolCall) => this.executePlannedToolCall({
          planned,
          capabilityContext,
          runAuthority,
          runSessionId,
          signal,
          loopDetector: toolLoopDetector,
        });

        try {
          for (const batch of batches) {
            throwIfCancelled(signal);
            const settlements = await Promise.allSettled(batch.calls.map(executePlanned));
            let hardFailure: unknown = null;
            let settlementFailure: unknown = null;
            let cancellationFailure: unknown = null;
            for (let index = 0; index < batch.calls.length; index += 1) {
              const planned = batch.calls[index];
              const settlement = settlements[index];
              if (settlement.status === "rejected") {
                hardFailure ??= settlement.reason;
                continue;
              }
              results[planned.originalIndex] = settlement.value.result;
              if (planned.toolName === "task_create" && settlement.value.result.outcome.status === "success") taskMode = true;
              if (isRunSettlementFailure(settlement.value.fatal)) settlementFailure ??= settlement.value.fatal;
              else if (isRunCancellation(settlement.value.fatal)) cancellationFailure ??= settlement.value.fatal;
            }
            const fatal = hardFailure ?? settlementFailure ?? cancellationFailure;
            if (fatal) {
              if (isRunCancellation(fatal)) {
                batchCancellation = fatal;
                break;
              }
              throw fatal;
            }
          }
        } catch (error) {
          if (!isRunCancellation(error)) throw error;
          batchCancellation = error;
        }

        if (batchCancellation) {
          for (const pending of plannedCalls) {
            if (results[pending.originalIndex]) continue;
            const trace = pending.trace;
            const outcome = createToolOutcome("cancelled", `工具未执行: ${batchCancellation.message}`, batchCancellation.code);
            if (!trace.has("approval")) trace.record("approval", "denied", batchCancellation.code);
            trace.record("output", outcome.truncated ? "truncated" : "passed", outcome.truncated ? "TOOL_OUTPUT_TRUNCATED" : null);
            if (this.auditJournal) {
              const audit = new ToolAuditTrail(
                this.auditJournal,
                capabilityContext,
                pending.toolCall.id,
                pending.toolName,
                pending.rawArguments,
              );
              await audit.request(pending.rawArguments);
              await audit.authorize("denied", "none", batchCancellation.code);
              await audit.execution(false);
              await audit.result(outcome.content, 0, "cancelled", batchCancellation.code, outcome.outputBytes, outcome.truncated);
            }
            trace.record("audit", "passed");
            results[pending.originalIndex] = Object.freeze({
              toolName: pending.toolName,
              outcome,
              stages: trace.snapshot(),
              toolMs: 0,
            });
          }
        }
        for (let index = 0; index < results.length; index += 1) {
          if (!results[index]) throw new Error(`Tool batch result is missing at index ${index}`);
        }

        this.memory.addMany([
          finalMessage,
          ...results.map((entry, index) => ({
            role: "tool" as const,
            content: serializeToolOutcome(entry.outcome),
            tool_call_id: toolCallsParsed[index].toolCall.id,
          })),
        ]);
        touch(runSessionId);
        if (batchCancellation) throw batchCancellation;
        throwIfCancelled(signal);

        // yield 已原子提交的结果。
        for (let ri = 0; ri < results.length; ri++) {
          throwIfCancelled(signal);
          const { toolName, outcome, stages, toolMs } = results[ri];
          // 任务事件
          if (toolName === "task_create" && outcome.status === "success") {
            yield {
              type: "task_created",
              content: "任务已创建",
              tasks: getTasksBySession(runSessionId),
              timestamp: Date.now(),
            };
          } else if ((toolName === "task_update" || toolName === "task_delete") && outcome.status === "success") {
            yield {
              type: "task_update",
              content: "任务状态已更新",
              tasks: getTasksBySession(runSessionId),
              timestamp: Date.now(),
            };
          }

          yield {
            type: "tool_result",
            content: outcome.content,
            toolName,
            toolStatus: outcome.status,
            toolCode: outcome.code,
            toolOutputBytes: outcome.outputBytes,
            toolOriginalOutputBytes: outcome.originalOutputBytes,
            toolOutputTruncated: outcome.truncated,
            toolStages: stages,
            timestamp: Date.now(),
          };

          console.log(`   └ ${toolName} (${toolMs}ms)`);
        }

        continue;
      }

      // 情况 B：LLM 给出最终文本回答
      throwIfCancelled(signal);
      this.memory.add(finalMessage);
      touch(runSessionId);

      // 如果在任务模式下 LLM 给出了文本回答而非继续执行任务
      // 检查是否还有未完成任务，如果有则继续循环
      if (taskMode) {
        const tasks = getTasksBySession(runSessionId);
        const hasPending = tasks.some((t) => t.status === "pending" || t.status === "in_progress");
        if (hasPending) {
          // LLM 可能是在解释中间过程，继续驱动
          yield {
            type: "answer_chunk",
            content: finalMessage.content,
            timestamp: Date.now(),
          };
          yield { type: "answer_done", content: "", timestamp: Date.now() };
          continue;
        }
      }

      yield {
        type: "answer_done",
        content: hasStreamedContent ? "" : finalMessage.content,
        timestamp: Date.now(),
      };
      return;
    }

      yield {
        type: "error",
        content: "处理过程过长，已达到最大循环次数。请尝试简化你的请求。",
        timestamp: Date.now(),
      };
    } finally {
      this.running = false;
      try {
        await capabilityBroker.retireSessionResources(runAuthority, runSessionId);
      } finally {
        if (capabilityBroker.isContextActive(capabilityContext)) capabilityBroker.finishContext(capabilityContext);
      }
    }
  }
}
