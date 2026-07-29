// ===========================================
// 对话记忆 —— 内存 + SQLite 双写
// 内存：供 LLM 对话使用，按 token 预算动态管理
// SQLite：持久化存储（完整内容），重启不丢失
//
// 上下文管理策略（仿 Lux canvas）：
//   1. 工具结果存入历史时截断到 1500 字符（第一道防线）
//   2. agent 每轮调 LLM 前调用 compact()，检查 token 预算
//   3. 超预算时：用 LLM 把旧对话生成摘要，替换旧消息
//   4. 保留：system prompt + 摘要 + 最近 N 轮完整对话
//   5. 摘要是累积的——二次压缩时合并旧摘要 + 新消息
//   6. LLM 摘要失败时回退到删除（带孤立 tool 保护）
// ===========================================

import type { Message } from "./types.js";
import type { LLMClient } from "./llm.js";
import { insertMessage, getMessagesBySession } from "./db.js";

// --- 常量 ---

/** 工具结果在历史中保留的最大字符数（超出截断，第一道防线） */
const MAX_TOOL_RESULT_CHARS = 1500;

/** 上下文 token 预算（留出空间给 system prompt + 新回复） */
const MAX_CONTEXT_TOKENS = 28000;

/** 压缩时保留的最近消息条数（约 4 轮对话） */
const KEEP_RECENT = 8;

/** 摘要 system 消息的标记前缀 */
const SUMMARY_MARKER = "## 对话摘要\n";

// --- token 估算 ---

/** 粗略估算：中文 ~1.5 字符/token，英文 ~4 字符/token，混合取 2.5 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function messageTokens(msg: Message): number {
  let total = estimateTokens(msg.content || "");
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name + tc.function.arguments);
    }
  }
  return total + 4;
}

function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

// --- 工具结果压缩（第一道防线） ---

function compressToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  const lines = content.split("\n");
  const headBudget = Math.floor(MAX_TOOL_RESULT_CHARS * 0.6); // 60% 给头部
  const tailBudget = Math.floor(MAX_TOOL_RESULT_CHARS * 0.3);  // 30% 给尾部

  // 头部
  let head = "";
  let headEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if ((head + lines[i] + "\n").length > headBudget) break;
    head += lines[i] + "\n";
    headEnd = i + 1;
  }

  // 尾部
  let tail = "";
  let tailStart = lines.length;
  for (let i = lines.length - 1; i > headEnd; i--) {
    const candidate = lines[i] + "\n" + tail;
    if (candidate.length > tailBudget) break;
    tail = candidate;
    tailStart = i;
  }

  // 中间关键行（含路径、错误、状态等关键词的行）
  const keyPattern = /(错误|失败|警告|error|fail|warn|路径|文件|✅|❌|⚠️|总结|结果|total|count)/i;
  let middle = "";
  for (let i = headEnd; i < tailStart && middle.length < MAX_TOOL_RESULT_CHARS * 0.1; i++) {
    if (keyPattern.test(lines[i])) {
      middle += lines[i] + "\n";
    }
  }

  const result = head +
    (middle ? `\n... (省略中间内容，以下为关键行)\n${middle}` : "") +
    (tail ? `\n... (省略中间内容)\n${tail}` : "");

  return result + `\n\n...(结果已压缩，原始 ${content.length} 字符)`;
}

// --- 消息格式化（供摘要用） ---

function formatMessagesForSummary(messages: Message[]): string {
  return messages.map((m) => {
    if (m.role === "user") return `用户: ${m.content}`;
    if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const toolNames = m.tool_calls.map((tc) => tc.function.name).join(", ");
        return `助手: [调用工具: ${toolNames}] ${m.content}`;
      }
      return `助手: ${m.content}`;
    }
    if (m.role === "tool") return `工具结果: ${m.content}`;
    return m.content;
  }).join("\n\n");
}

// --- 摘要 LLM prompt ---

const SUMMARIZER_SYSTEM = `你是对话摘要器。请把对话历史压缩成简洁的摘要。

保留以下信息：
1. 用户的核心需求和意图
2. 已完成的操作及其关键结果（文件路径、搜索结果、关键数据值）
3. 未完成的任务和待办事项
4. 重要的上下文信息（用户偏好、决策、约定）

可以丢弃：
1. 冗余的工具输出细节
2. 重复出现的信息
3. 不影响后续对话的中间过程

用简洁的要点列出，不要写多余的修饰语。`;

// ===========================================
// ConversationMemory
// ===========================================

export class ConversationMemory {
  private messages: Message[] = [];
  private maxMessages: number;
  private sessionId: string | null = null;

  constructor(maxMessages: number = 100) {
    this.maxMessages = maxMessages;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** 从数据库恢复会话历史到内存 */
  loadFromDb(sessionId: string): void {
    this.sessionId = sessionId;
    const rows = getMessagesBySession(sessionId);

    let messages = rows.map((row) => {
      const msg: Message = {
        role: row.role as Message["role"],
        content: row.content,
      };
      if (row.tool_calls) {
        try {
          msg.tool_calls = JSON.parse(row.tool_calls);
        } catch {
          // 忽略
        }
      }
      if (row.tool_call_id) {
        msg.tool_call_id = row.tool_call_id;
      }
      return msg;
    });

    // 工具结果压缩（数据库存的是完整内容，内存里压缩）
    messages = messages.map((m) => {
      if (m.role === "tool") {
        return { ...m, content: compressToolResult(m.content) };
      }
      return m;
    });

    this.messages = messages;

    // 基本的消息数量限制（真正的 token 管理在 compact() 中）
    this.enforceMessageLimit();
  }

  setSystemPrompt(prompt: string): void {
    this.messages = this.messages.filter((m) => !(m.role === "system" && !m.content.startsWith(SUMMARY_MARKER)));
    this.messages.unshift({ role: "system", content: prompt });
  }

  /** 添加一条消息（同时写入内存和数据库） */
  add(message: Message): void {
    // 工具结果在存入内存前压缩（但数据库存完整内容）
    const memoryMsg: Message = { ...message };
    if (message.role === "tool") {
      memoryMsg.content = compressToolResult(message.content);
    }

    this.messages.push(memoryMsg);

    // 基本的消息数量限制
    this.enforceMessageLimit();

    // 持久化到数据库（存完整内容，不压缩）
    if (this.sessionId && message.role !== "system") {
      insertMessage({
        session_id: this.sessionId,
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        tool_call_id: message.tool_call_id || null,
        created_at: new Date().toISOString(),
      });
    }
  }

  /**
   * 基本的消息数量限制（防止无限增长）
   * 真正的 token 预算管理在 compact() 中
   */
  private enforceMessageLimit(): void {
    if (this.messages.length <= this.maxMessages) return;

    // 保留 system 消息 + 最近的消息
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    let otherMsgs = this.messages.filter((m) => m.role !== "system");
    const keep = this.maxMessages - systemMsgs.length;
    otherMsgs = otherMsgs.slice(-keep);

    // 清除孤立的 tool 消息
    while (otherMsgs.length > 0 && otherMsgs[0].role === "tool") {
      otherMsgs = otherMsgs.slice(1);
    }

    this.messages = [...systemMsgs, ...otherMsgs];
  }

  /**
   * 上下文压缩 —— 核心方法
   * 在 agent 每轮调 LLM 前调用
   * 如果 token 超预算，用 LLM 把旧对话生成摘要
   *
   * @param llm LLM 客户端
   * @returns 是否执行了压缩
   */
  async compact(llm: LLMClient): Promise<boolean> {
    const tokens = totalTokens(this.messages);
    if (tokens <= MAX_CONTEXT_TOKENS) return false;

    // 分离 system 消息和对话消息
    const mainSystem = this.messages.filter(
      (m) => m.role === "system" && !m.content.startsWith(SUMMARY_MARKER)
    );
    const existingSummary = this.messages.find(
      (m) => m.role === "system" && m.content.startsWith(SUMMARY_MARKER)
    );
    let otherMsgs = this.messages.filter((m) => m.role !== "system");

    // 不够消息可压缩
    if (otherMsgs.length <= KEEP_RECENT) return false;

    // 分割：旧消息（要压缩的）+ 最近消息（保留的）
    let toSummarize = otherMsgs.slice(0, otherMsgs.length - KEEP_RECENT);
    let recent = otherMsgs.slice(-KEEP_RECENT);

    // 确保不在 assistant(tool_calls) 和 tool 之间切断
    while (
      toSummarize.length > 0 &&
      toSummarize[toSummarize.length - 1].role === "assistant" &&
      toSummarize[toSummarize.length - 1].tool_calls &&
      recent.length > 0 &&
      recent[0].role === "tool"
    ) {
      toSummarize.push(recent.shift()!);
    }

    // 清除 recent 开头的孤立 tool 消息
    while (recent.length > 0 && recent[0].role === "tool") {
      recent.shift();
    }

    if (toSummarize.length === 0) return false;

    // 构造摘要 prompt
    const dialogText = formatMessagesForSummary(toSummarize);
    const summaryPrompt = existingSummary
      ? `${existingSummary.content}\n\n## 新增对话内容\n${dialogText}\n\n请合并以上内容，生成一个更新的摘要。`
      : `${SUMMARIZER_SYSTEM}\n\n## 对话内容\n${dialogText}`;

    try {
      // 调用 LLM 生成摘要（非流式，无工具）
      const summaryResponse = await llm.chat([
        { role: "system", content: SUMMARIZER_SYSTEM },
        { role: "user", content: summaryPrompt },
      ]);

      if (!summaryResponse.content) {
        throw new Error("摘要 LLM 返回空内容");
      }

      // 构建新消息列表：主 system + 摘要 + 最近对话
      const newSummary: Message = {
        role: "system",
        content: SUMMARY_MARKER + summaryResponse.content,
      };

      this.messages = [...mainSystem, newSummary, ...recent];

      console.log(
        `📦 上下文已压缩: ${toSummarize.length} 条消息 → 摘要 ` +
        `(${estimateTokens(summaryResponse.content)} tokens), ` +
        `总计 ${totalTokens(this.messages)} tokens (预算 ${MAX_CONTEXT_TOKENS})`
      );

      return true;
    } catch (err) {
      // LLM 摘要失败，回退到删除策略
      console.error("⚠️ 上下文摘要失败，回退到删除:", err instanceof Error ? err.message : String(err));
      this.fallbackDelete(mainSystem, otherMsgs, recent);
      return true;
    }
  }

  /**
   * 回退策略：LLM 摘要失败时，删除最旧的消息
   */
  private fallbackDelete(mainSystem: Message[], allMsgs: Message[], recent: Message[]): void {
    let otherMsgs = allMsgs;
    let tokens = totalTokens([...mainSystem, ...otherMsgs]);

    while (tokens > MAX_CONTEXT_TOKENS && otherMsgs.length > KEEP_RECENT) {
      const removed = otherMsgs.shift()!;
      tokens -= messageTokens(removed);

      // 清除孤立的 tool 消息
      while (otherMsgs.length > 0 && otherMsgs[0].role === "tool") {
        const orphan = otherMsgs.shift()!;
        tokens -= messageTokens(orphan);
      }
    }

    this.messages = [...mainSystem, ...otherMsgs];
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  getTokenEstimate(): number {
    return totalTokens(this.messages);
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  /** 是否有摘要 */
  hasSummary(): boolean {
    return this.messages.some((m) => m.role === "system" && m.content.startsWith(SUMMARY_MARKER));
  }

  clear(): void {
    const systemMsgs = this.messages.filter((m) => m.role === "system" && !m.content.startsWith(SUMMARY_MARKER));
    this.messages = systemMsgs;
  }

  reset(): void {
    this.messages = [];
    this.sessionId = null;
  }
}
