// ===========================================
// Embedding 服务 —— 文本向量化 + 相似度计算
// 使用 @xenova/transformers 本地运行 multilingual-e5-small
// 多语言模型，支持中文语义匹配，384维向量，模型 ~470MB
// ===========================================

import type { MemoryRow } from "./db.js";
import { getBootstrapPathStore, type BootstrapModelTreeLease } from "./bootstrap-path-store.js";

// 懒加载：第一次调用 embed() 时才加载模型
type EmbeddingPipeline = (text: string | string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array }>;
let pipeline: EmbeddingPipeline | null = null;
let modelLoading: Promise<EmbeddingPipeline | null> | null = null;
let modelTreeLease: BootstrapModelTreeLease | null = null;

async function closeModelTreeLease(): Promise<void> {
  const lease = modelTreeLease;
  modelTreeLease = null;
  if (lease) await lease.close();
}

/**
 * 加载 embedding 模型（懒加载，只加载一次）
 */
async function getModel(): Promise<typeof pipeline> {
  if (pipeline) return pipeline;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    const { pipeline: createPipeline, env } = await import("@xenova/transformers");
    const lease = await getBootstrapPathStore().openModelsTreeLease();
    try {
      // 模型只从精确绑定的app/models树读取；禁用第三方可变文件缓存和远程回退。
      if (env) {
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        env.localModelPath = lease.canonicalPath;
        env.useBrowserCache = false;
        env.useFSCache = false;
      }
      const extractor = await createPipeline("feature-extraction", "Xenova/multilingual-e5-small", { quantized: true });
      await lease.assertCurrent();
      modelTreeLease = lease;

      // 每次第三方推理前后重算树和内容，覆盖pipeline创建后的懒文件读取。
      pipeline = (async (text: string | string[], options?: Record<string, unknown>) => {
        if (modelTreeLease !== lease) throw new Error("Embedding model path lease is unavailable");
        await lease.assertCurrent();
        const output = await (extractor as unknown as (t: string | string[], o?: Record<string, unknown>) => Promise<{ data: Float32Array }>)(text, options);
        await lease.assertCurrent();
        return output;
      }) as EmbeddingPipeline;
      console.log("✅ Embedding 模型已加载: multilingual-e5-small (多语言，支持中文)");
      return pipeline;
    } catch (error) {
      await lease.close();
      throw error;
    }
  })();

  return modelLoading;
}

/** 标记 embedding 是否可用（模型加载失败则为 false） */
let embeddingAvailable = true;

/**
 * 判断 embedding 功能是否可用
 */
export function isEmbeddingAvailable(): boolean {
  return embeddingAvailable;
}

export async function closeEmbedding(): Promise<void> {
  pipeline = null;
  modelLoading = null;
  await closeModelTreeLease();
}

/**
 * 将文本转为 384 维向量
 * @param text 要向量化的文本
 * @param isQuery 是否是查询文本（e5 模型需要 query:/passage: 前缀区分）
 * @returns Float32Array(384)，失败时返回 null
 */
export async function embed(text: string, isQuery: boolean = false): Promise<Float32Array | null> {
  if (!embeddingAvailable) return null;

  try {
    const pipe = await getModel();
    if (!pipe) return null;
    // multilingual-e5 要求 query:/passage: 前缀
    const prefixed = isQuery ? `query: ${text}` : `passage: ${text}`;
    const output = await pipe(prefixed, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  } catch (err) {
    console.error("⚠️ Embedding 生成失败，回退到关键词搜索:", err instanceof Error ? err.message : String(err));
    embeddingAvailable = false;
    await closeModelTreeLease();
    return null;
  }
}

/**
 * 批量向量化
 */
export async function embedBatch(texts: string[], isQuery: boolean = false): Promise<(Float32Array | null)[]> {
  if (!embeddingAvailable) return texts.map(() => null);

  try {
    const pipe = await getModel();
    if (!pipe) return texts.map(() => null);
    const prefix = isQuery ? "query: " : "passage: ";
    const prefixed = texts.map(t => prefix + t);
    const output = await pipe(prefixed, { pooling: "mean", normalize: true });
    const dim = 384;
    const data = output.data as Float32Array;
    return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  } catch (err) {
    console.error("⚠️ 批量 Embedding 失败:", err instanceof Error ? err.message : String(err));
    embeddingAvailable = false;
    await closeModelTreeLease();
    return texts.map(() => null);
  }
}

/**
 * 计算两个向量的余弦相似度（已归一化向量只需点积）
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Float32Array → Buffer（存入 SQLite BLOB） */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Buffer → Float32Array */
export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** 带相似度分数的记忆 */
export interface ScoredMemory {
  row: MemoryRow;
  score: number;
}

/**
 * 对记忆列表按查询向量做相似度排序
 */
export function rankBySimilarity(
  queryVec: Float32Array,
  memories: MemoryRow[],
  getVector: (row: MemoryRow) => Float32Array | null
): ScoredMemory[] {
  const scored: ScoredMemory[] = [];

  for (const row of memories) {
    const vec = getVector(row);
    if (!vec) continue;
    const score = cosineSimilarity(queryVec, vec);
    scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
