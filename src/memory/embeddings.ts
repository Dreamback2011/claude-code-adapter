/**
 * Embeddings — 本地语义嵌入模块
 *
 * 使用 @huggingface/transformers 加载 all-MiniLM-L6-v2 模型（384维）
 * 提供：文本嵌入生成、余弦相似度计算、语义搜索
 *
 * 特性：
 * - 懒加载模型（首次调用时加载，后续复用）
 * - LRU 缓存（最近 100 条嵌入结果）
 * - 动态导入依赖，未安装时优雅降级
 */

// ─── 类型定义 ───────────────────────────────────────────────────────────────────

export interface ScoredItem<T> {
  item: T;
  score: number; // 0-1, 余弦相似度
}

// ─── 模型状态 ───────────────────────────────────────────────────────────────────

let extractor: any = null;
let modelLoaded = false;
let modelLoadFailed = true; // ONNX disabled — Apple Silicon SIGABRT

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/**
 * 检查模型是否已加载
 */
export function isModelLoaded(): boolean {
  return modelLoaded;
}

/**
 * 预加载模型 — 已禁用（ONNX 在 Apple Silicon 上导致 SIGABRT）
 */
export async function preloadModel(): Promise<void> {
  console.log("[embeddings] Embedding model disabled (ONNX SIGABRT on Apple Silicon)");
  return;
}

/**
 * 懒加载 embedding pipeline — 已禁用（ONNX 在 Apple Silicon 上导致 SIGABRT）
 * 始终返回 null，其他函数会优雅降级（返回空数组）
 */
async function getExtractor(): Promise<any> {
  return null;
}

// ─── LRU 缓存 ───────────────────────────────────────────────────────────────────

const CACHE_MAX = 100;
const embeddingCache = new Map<string, number[]>();

/**
 * LRU 缓存：获取时移到末尾（Map 保持插入顺序）
 */
function cacheGet(key: string): number[] | undefined {
  const val = embeddingCache.get(key);
  if (val !== undefined) {
    // 移到末尾（最近使用）
    embeddingCache.delete(key);
    embeddingCache.set(key, val);
  }
  return val;
}

/**
 * LRU 缓存：超过上限时删除最早的条目
 */
function cacheSet(key: string, val: number[]): void {
  if (embeddingCache.has(key)) {
    embeddingCache.delete(key);
  } else if (embeddingCache.size >= CACHE_MAX) {
    // 删除最旧的（Map 的第一个 key）
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) {
      embeddingCache.delete(firstKey);
    }
  }
  embeddingCache.set(key, val);
}

// ─── 核心函数 ───────────────────────────────────────────────────────────────────

/**
 * 生成文本的嵌入向量（384维）
 * 如果模型未加载或加载失败，返回空数组
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // 先查缓存
  const cached = cacheGet(text);
  if (cached) return cached;

  const ext = await getExtractor();
  if (!ext) return [];

  try {
    const output = await ext(text, {
      pooling: "mean",
      normalize: true,
    });

    // output.data 是 Float32Array 或类似的 TypedArray
    const embedding = Array.from(output.data as Float32Array) as number[];

    // 写入缓存
    cacheSet(text, embedding);

    return embedding;
  } catch (err) {
    console.warn("[embeddings] 生成嵌入失败:", err);
    return [];
  }
}

/**
 * 计算两个向量的余弦相似度
 * 返回 0-1 之间的值（向量已归一化时等于点积）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * 语义搜索：用 query 对 items 进行相似度排序
 *
 * @param query    搜索文本
 * @param items    待搜索的项目列表
 * @param getText  从 item 中提取可搜索文本的函数
 * @param limit    返回结果数量上限（默认 10）
 * @returns        按相似度降序排列的结果
 */
export async function semanticSearch<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit: number = 10,
): Promise<ScoredItem<T>[]> {
  if (items.length === 0) return [];

  // 生成 query 的嵌入
  const queryEmbedding = await generateEmbedding(query);
  if (queryEmbedding.length === 0) {
    // 模型不可用，返回空结果
    return [];
  }

  // 为每个 item 计算相似度
  const scored: ScoredItem<T>[] = [];

  for (const item of items) {
    const text = getText(item);
    if (!text) continue;

    const itemEmbedding = await generateEmbedding(text);
    if (itemEmbedding.length === 0) continue;

    const score = cosineSimilarity(queryEmbedding, itemEmbedding);
    scored.push({ item, score });
  }

  // 按相似度降序排列，取前 limit 个
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
