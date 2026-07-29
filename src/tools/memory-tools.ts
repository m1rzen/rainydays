// ===========================================
// 记忆工具 —— 跨会话知识存储与检索
// remember: 记录知识（自动生成 embedding 向量）
// recall: 向量语义检索（相似度排序）+ LIKE 回退
// list_memories: 列出所有记忆
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import {
  insertMemory,
  searchMemories,
  listMemories,
  deleteMemory,
  getAllMemoriesWithEmbedding,
  getMemoriesWithoutEmbedding,
  updateMemoryEmbedding,
  type MemoryRow,
} from "../db.js";
import {
  embed,
  isEmbeddingAvailable,
  rankBySimilarity,
  vectorToBuffer,
  bufferToVector,
  type ScoredMemory,
} from "../embedding.js";

// ===========================================
// remember —— 记录一条知识
// ===========================================
export const rememberDef: ToolDefinition = {
  type: "function",
  function: {
    name: "remember",
    description:
      "记住一条值得跨会话保留的信息。用于记录用户偏好、重要决策、工作约定、踩坑教训等。记录后即使重启也能通过语义搜索回忆起来。",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "要记住的内容，自由文本。例如：用户偏好用英文写 commit message；项目X用的是 SQLite 不是 Postgres。",
        },
        kind: {
          type: "string",
          enum: ["observation", "lesson", "decision", "episode"],
          description: "记忆类型：observation=观察, lesson=教训, decision=决策, episode=事件。默认 observation。",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签列表，便于后续检索。如 ['偏好', 'git'] 或 ['项目X', '数据库']",
        },
      },
      required: ["content"],
    },
  },
};

export const rememberExec: ToolExecutor = async (args) => {
  const content = args.content as string;
  const kind = (args.kind as string) || "observation";
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];

  // 生成 embedding（如果可用）—— passage 模式
  let embedding: Buffer | null = null;
  if (isEmbeddingAvailable()) {
    const vec = await embed(content, false);
    if (vec) {
      embedding = vectorToBuffer(vec);
    }
  }

  insertMemory(content, kind, tags, embedding);

  const embStatus = embedding ? "已向量化" : "纯文本";
  return `✅ 已记住: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""} (类型: ${kind}, 标签: ${tags.join(", ") || "无"}, ${embStatus})`;
};

// ===========================================
// recall —— 语义搜索记忆
// ===========================================
export const recallDef: ToolDefinition = {
  type: "function",
  function: {
    name: "recall",
    description:
      "搜索过往记忆。使用语义向量检索——即使措辞不同也能找到相关记忆（如搜'代码提交习惯'能找到'偏好英文commit'）。如果向量不可用则回退到关键词匹配。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索内容。可以是一个词，也可以是一句话。会按语义相似度匹配。",
        },
        limit: {
          type: "number",
          description: "最多返回几条（默认 5）",
        },
      },
      required: ["query"],
    },
  },
};

export const recallExec: ToolExecutor = async (args) => {
  const query = args.query as string;
  const limit = (args.limit as number) || 5;

  // 尝试向量检索
  if (isEmbeddingAvailable()) {
    const queryVec = await embed(query, true); // query 模式
    if (queryVec) {
      const allMemories = getAllMemoriesWithEmbedding();

      if (allMemories.length > 0) {
        const scored = rankBySimilarity(queryVec, allMemories, (row) => {
          return row.embedding ? bufferToVector(row.embedding) : null;
        });

        // 过滤掉相似度太低的结果（阈值 0.3）
        const relevant = scored.filter((s) => s.score >= 0.3).slice(0, limit);

        if (relevant.length > 0) {
          return formatScoredMemories(relevant, query, true);
        }

        // 向量搜索无结果，回退到 LIKE
        const fallback = searchMemories(query, limit);
        if (fallback.length > 0) {
          return formatMemories(fallback, query, false, "向量搜索无匹配，关键词回退结果");
        }
      }
    }
  }

  // 纯 LIKE 回退
  const memories = searchMemories(query, limit);
  if (memories.length === 0) {
    return `没有找到与 "${query}" 相关的记忆。`;
  }
  return formatMemories(memories, query, false, "关键词搜索");
};

// ===========================================
// list_memories —— 列出所有记忆
// ===========================================
export const listMemoriesDef: ToolDefinition = {
  type: "function",
  function: {
    name: "list_memories",
    description: "列出最近的所有记忆，按时间倒序。当用户想查看全部记忆时使用。",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "最多返回几条（默认 20）",
        },
      },
    },
  },
};

export const listMemoriesExec: ToolExecutor = async (args) => {
  const limit = (args.limit as number) || 20;
  const memories = listMemories(limit);

  if (memories.length === 0) {
    return "还没有任何记忆。";
  }

  const embCount = memories.filter((m) => m.embedding).length;
  const lines = memories.map((m) => formatMemoryLine(m));

  return `共 ${memories.length} 条记忆（${embCount} 条已向量化，最近 ${limit} 条）:\n\n${lines.join("\n\n")}`;
};

// ===========================================
// 格式化辅助
// ===========================================
function formatMemoryLine(m: MemoryRow): string {
  let tags: string[] = [];
  try { tags = JSON.parse(m.tags || "[]"); } catch { /* ignore */ }
  const date = new Date(m.created_at).toLocaleString("zh-CN");
  const embTag = m.embedding ? " 🔹" : "";
  return `[${m.id}] (${m.kind})${embTag} ${m.content}\n    标签: ${tags.join(", ") || "无"} | 记于: ${date}`;
}

function formatMemories(
  memories: MemoryRow[],
  query: string,
  isVector: boolean,
  label?: string
): string {
  const lines = memories.map((m) => formatMemoryLine(m));
  const searchType = isVector ? "向量语义搜索" : "关键词搜索";
  const prefix = label ? `（${label}）` : "";
  return `找到 ${memories.length} 条与 "${query}" 相关的记忆${prefix} [${searchType}]:\n\n${lines.join("\n\n")}`;
}

function formatScoredMemories(
  scored: ScoredMemory[],
  query: string,
  isVector: boolean
): string {
  const lines = scored.map((s) => {
    const pct = Math.round(s.score * 100);
    return `${formatMemoryLine(s.row)}\n    相似度: ${pct}%`;
  });
  return `找到 ${scored.length} 条与 "${query}" 相关的记忆 [向量语义搜索]:\n\n${lines.join("\n\n")}`;
}

// ===========================================
// 迁移：给旧记忆补 embedding
// ===========================================
export async function migrateMissingEmbeddings(): Promise<void> {
  const missing = getMemoriesWithoutEmbedding();
  if (missing.length === 0) return;

  console.log(`📦 发现 ${missing.length} 条记忆缺少向量，开始补充...`);

  for (const mem of missing) {
    if (!isEmbeddingAvailable()) break;
    const vec = await embed(mem.content, false); // passage 模式
    if (vec) {
      updateMemoryEmbedding(mem.id, vectorToBuffer(vec));
    }
  }

  console.log(`✅ 向量补充完成`);
}
