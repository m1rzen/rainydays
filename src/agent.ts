// ===========================================
// Agent 核心 —— 对话循环（流式版 + 任务系统）
// 思考 → 调工具 → 看结果 → 再思考 → ... → 逐字回答
// 工具调用时检测任务相关操作，yield task 事件给前端
// ===========================================

import type { LLMClient } from "./llm.js";
import type { ConversationMemory } from "./memory.js";
import type { AgentStep, PersonaDefinition, Message, TaskSnapshot } from "./types.js";
import type { CapabilityContext, RuntimeAuthority } from "./capability-broker.js";
import { CapabilityDeniedError } from "./capability-broker.js";
import { PathDeniedError } from "./path-policy.js";
import { capabilityBroker, getToolDefinitions, inspectToolCall, executeInspectedTool, ToolArgumentsError } from "./tools/index.js";
import { touch, autoGenerateTitle } from "./session.js";
import { getTasksBySession, getNextPendingTask, allTasksCompleted, startTask, completeTask, failTask } from "./task.js";
import { getRecentMemories, getPinsBySession } from "./db.js";
import { approveToolCall } from "./supervisor.js";
import { askUserConfirm } from "./tools/ask-user-tool.js";
import { requestNativeProcessConsent } from "./native-process-consent.js";

const MAX_ITERATIONS = 25;

export class Agent {
  private llm: LLMClient;
  private memory: ConversationMemory;
  private persona: PersonaDefinition;
  private authority: RuntimeAuthority;
  private sessionId: string | null = null;
  private running = false;

  constructor(llm: LLMClient, memory: ConversationMemory, persona: PersonaDefinition, authority: RuntimeAuthority) {
    this.llm = llm;
    this.memory = memory;
    this.persona = persona;
    this.authority = authority;
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

  /**
   * 注入固定指令（Pin）到 system prompt
   */
  private injectPins(sessionId: string): void {
    const pins = getPinsBySession(sessionId);
    if (pins.length === 0) return;

    const pinBlock = "\n\n## 固定指令\n以下是用户设定的持久指令，在整个会话中持续生效：\n" +
      pins.map((p, i) => `${i + 1}. ${p.content}`).join("\n");

    // 追加到当前 system prompt
    // 注意：injectMemories 已经设置了 system prompt，这里需要追加
    const msgs = this.memory.getAll();
    const systemIdx = msgs.findIndex(m => m.role === "system" && !m.content.startsWith("## 对话摘要"));
    if (systemIdx >= 0 && !msgs[systemIdx].content.includes("## 固定指令")) {
      msgs[systemIdx] = { ...msgs[systemIdx], content: msgs[systemIdx].content + pinBlock };
    }
  }

  /**
   * 注入跨会话记忆到 system prompt
   * 取最近 N 条记忆，格式化为一行摘要，追加到 system prompt 尾部
   * 仿 Lux 的 <knowledge> 区域：让 agent 不需要主动 recall 就能看到记忆
   */
  private injectMemories(): void {
    const memories = getRecentMemories(10);
    if (memories.length === 0) return;

    // 每条记忆浓缩为一行摘要
    const lines = memories.map((m) => {
      let tags: string[] = [];
      try { tags = JSON.parse(m.tags || "[]"); } catch { /* ignore */ }
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return `- [${m.kind}]${tagStr} ${m.content}`;
    });

    const memoryBlock = `\n\n## 跨会话记忆\n以下是之前对话中记住的重要信息。相关的记忆会自动出现在这里，不需要主动搜索。如果需要更详细的信息，使用 recall 工具搜索。\n${lines.join("\n")}`;

    // 更新 system prompt：原始 persona prompt + 记忆区域
    this.memory.setSystemPrompt(this.persona.systemPrompt + memoryBlock);
  }

  /**
   * 处理用户输入 —— 流式输出
   * 产出事件序列：
   *   [task_created] → [task_update] → tool_call → tool_result → ... → answer_chunk × N → answer_done
   */
  async *run(userInput: string): AsyncGenerator<AgentStep> {
    if (!this.sessionId) {
      yield {
        type: "error",
        content: "未绑定会话，请先创建或选择一个会话",
        timestamp: Date.now(),
      };
      return;
    }

    const runSessionId = this.sessionId;
    const runAuthority = this.authority;
    let capabilityContext;
    try {
      capabilityContext = capabilityBroker.beginAgentRun(runAuthority, runSessionId);
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
      const isFirstMessage = this.memory.getAll().filter((m) => m.role === "user").length === 0;
      this.memory.add({ role: "user", content: userInput });

      if (isFirstMessage) autoGenerateTitle(runSessionId, userInput);

      // 注入跨会话记忆到 system prompt（仿 Lux <knowledge> 区域）
      this.injectMemories();
      this.injectPins(runSessionId);

      const tools = getToolDefinitions(capabilityContext);

      // 任务驱动模式：LLM 调用 create_tasks 后，agent 自动逐个驱动任务执行
      let taskMode = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const iterStart = Date.now();

      // 每轮调 LLM 前检查上下文预算，必要时压缩
      const compactStart = Date.now();
      await this.memory.compact(this.llm);
      const compactMs = Date.now() - compactStart;

      // 任务驱动：如果有 pending 任务，注入当前任务状态引导 LLM 执行下一个
    if (taskMode) {
      const tasks = getTasksBySession(runSessionId);
      const pending = tasks.filter((t) => t.status === "pending");
      const inProgress = tasks.filter((t) => t.status === "in_progress");

      if (pending.length > 0 || inProgress.length > 0) {
        // 构造任务状态提示
        const taskStatus = tasks.map((t) => {
          const icon = { pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌" }[t.status] || "?";
          return `${icon} [${t.id}] ${t.subject}`;
        }).join("\n");

        const nextTask = getNextPendingTask(runSessionId);
        const guidance = nextTask
          ? `\n\n当前任务进度:\n${taskStatus}\n\n请执行下一个任务: [${nextTask.id}] ${nextTask.subject}。先调用 update_task(id=${nextTask.id}, status=in_progress) 标记开始，然后使用工具完成它，最后调用 update_task(id=${nextTask.id}, status=completed) 标记完成。`
          : `\n\n当前任务进度:\n${taskStatus}\n\n请继续执行进行中的任务。`;

        // 以 system 消息形式注入引导（不持久化到数据库）
        this.memory.add({ role: "system", content: guidance });
      } else if (tasks.length > 0 && allTasksCompleted(runSessionId)) {
        // 所有任务完成，退出任务模式
        taskMode = false;
        const completed = tasks.filter((t) => t.status === "completed").length;
        const failed = tasks.filter((t) => t.status === "failed").length;
        const summary = `\n\n所有任务已完成（${completed} 完成, ${failed} 失败）。请汇总执行结果给用户。`;
        this.memory.add({ role: "system", content: summary });
      }
    }

      let finalMessage: Message | null = null;
      let hasStreamedContent = false;

      const llmStart = Date.now();
      try {
        for await (const event of this.llm.chatStream(this.memory.getAll(), tools)) {
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
        // LLM 请求失败（重试已耗尽），yield error 而不是崩溃
        yield {
          type: "error",
          content: `LLM 请求失败: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        };
        return;
      }

      const llmMs = Date.now() - llmStart;
      console.log(`⏱️ [迭代 ${i}] compact=${compactMs}ms, LLM=${llmMs}ms, messages=${this.memory.getMessageCount()}, tokens=${this.memory.getTokenEstimate()}`);

      if (!finalMessage) {
        yield { type: "error", content: "LLM 返回为空", timestamp: Date.now() };
        return;
      }

      // 情况 A：LLM 决定调用工具
      if (finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
        this.memory.add(finalMessage);
        touch(runSessionId);

        if (hasStreamedContent) {
          yield { type: "answer_done", content: "", timestamp: Date.now() };
        }

        const toolCallsParsed = finalMessage.tool_calls.map((toolCall) => {
          const toolName = toolCall.function.name;
          try {
            const parsed: unknown = JSON.parse(toolCall.function.arguments);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return { toolCall, toolName, toolArgs: null, parseError: "工具参数必须是 JSON object" };
            }
            return { toolCall, toolName, toolArgs: parsed as Record<string, unknown>, parseError: null };
          } catch {
            return { toolCall, toolName, toolArgs: null, parseError: "工具参数不是合法 JSON" };
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

        // 严格顺序执行，保证一次只出现一个用户批准 challenge。
        const results: { toolName: string; result: string; toolMs: number }[] = [];
        for (const { toolName, toolArgs, parseError } of toolCallsParsed) {
          const toolStart = Date.now();
          if (!toolArgs) {
            results.push({ toolName, result: `⛔ ${parseError}`, toolMs: Date.now() - toolStart });
            continue;
          }

          let grantContext: CapabilityContext | null = null;
          try {
            const inspected = inspectToolCall(capabilityContext, toolName, toolArgs);
            const advice = await approveToolCall(toolName, inspected.args as Record<string, unknown>);
            if (advice.decision === "deny") {
              results.push({ toolName, result: `⛔ Supervisor 拒绝执行: ${advice.reason}`, toolMs: Date.now() - toolStart });
              continue;
            }

            const requiresGrant = inspected.policy.approval === "user";
            const requiresConfirmation = requiresGrant || advice.decision === "escalate";
            if (requiresConfirmation) {
              const challenge = requiresGrant
                ? capabilityBroker.createApprovalChallenge(capabilityContext, inspected)
                : null;
              const requiresNativeProcessConsent = inspected.policy.effects.includes("process");
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
                });
              } else {
                const question = `${requiresGrant ? "此工具需要用户批准" : "Supervisor 请求用户确认"}。\n\n工具: ${toolName}\n参数: ${JSON.stringify(inspected.args, null, 2).slice(0, 1000)}\n原因: ${advice.reason}\n\n请选择是否执行。`;
                const confirmation = await askUserConfirm(question);
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
                results.push({ toolName, result: `⛔ 用户拒绝执行（${answer}）`, toolMs: Date.now() - toolStart });
                continue;
              }
            }

            const result = await executeInspectedTool(grantContext ?? capabilityContext, inspected);
            if (toolName === "create_tasks") taskMode = true;
            results.push({ toolName, result, toolMs: Date.now() - toolStart });
          } catch (error) {
            const result = error instanceof CapabilityDeniedError
              ? `⛔ 执行授权拒绝 [${error.code}]`
              : error instanceof PathDeniedError
                ? `⛔ 路径授权拒绝 [${error.code}]`
                : error instanceof ToolArgumentsError
                  ? `⛔ ${error.message}`
                  : `工具执行出错: ${error instanceof Error ? error.message : String(error)}`;
            results.push({ toolName, result, toolMs: Date.now() - toolStart });
          } finally {
            if (grantContext && capabilityBroker.isContextActive(grantContext)) capabilityBroker.finishContext(grantContext);
          }
        }

        // yield 结果并写入记忆
        for (let ri = 0; ri < results.length; ri++) {
          const { toolName, result, toolMs } = results[ri];
          const originalCall = toolCallsParsed[ri];
          // 任务事件
          if (toolName === "create_tasks") {
            yield {
              type: "task_created",
              content: "任务已创建",
              tasks: getTasksBySession(runSessionId),
              timestamp: Date.now(),
            };
          } else if (toolName === "update_task") {
            yield {
              type: "task_update",
              content: "任务状态已更新",
              tasks: getTasksBySession(runSessionId),
              timestamp: Date.now(),
            };
          }

          yield {
            type: "tool_result",
            content: result,
            toolName,
            timestamp: Date.now(),
          };

          this.memory.add({
            role: "tool",
            content: result,
            tool_call_id: originalCall.toolCall.id,
          });
          touch(runSessionId);
          console.log(`   └ ${toolName} (${toolMs}ms)`);
        }

        continue;
      }

      // 情况 B：LLM 给出最终文本回答
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
