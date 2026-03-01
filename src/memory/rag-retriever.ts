/**
 * RAG Retriever — 混合检索模块
 *
 * 结合三种信号进行记忆检索:
 *   1. 关键词匹配 (keyword search)  — 基于 memory-store 的全文搜索
 *   2. 语义相似度 (semantic search) — 基于 embeddings 的向量搜索
 *   3. 时间衰减   (recency)         — 越新的记忆权重越高
 *
 * 评分公式:
 *   hybrid:       0.40 * semantic + 0.35 * keyword + 0.25 * recency
 *   keyword_only: 0.70 * keyword  + 0.30 * recency (embedding 不可用时)
 */

import { searchMemories, getMemory } from "./memory-store.js";
import { isModelLoaded } from "./embeddings.js";
import { qmdVsearch } from "./qmd-search.js";
import type { MemoryItem, MemoryCategory } from "./types.js";
import { PermissionTier } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RAGQuery {
  /** 搜索查询文本 */
  query: string;
  /** 可选: 偏向特定 agent 的记忆 */
  agentId?: string;
  /** 按 category 过滤 */
  category?: MemoryCategory;
  /** 返回结果数量上限，默认 10 */
  limit?: number;
  /** 最高权限层级，默认 T2 */
  maxTier?: PermissionTier;
}

export interface RAGResult {
  items: ScoredRAGItem[];
  method: "hybrid" | "keyword_only" | "semantic_only";
  totalCandidates: number;
}

export interface ScoredRAGItem {
  item: MemoryItem;
  /** 综合得分 0-1 */
  score: number;
  /** 关键词匹配得分 */
  keywordScore: number;
  /** 语义相似度得分 */
  semanticScore: number;
  /** 时间衰减得分 */
  recencyScore: number;
}

// ─── 关键词评分 ──────────────────────────────────────────────────────────────

/**
 * 计算关键词匹配得分。
 * 策略: 将 query 拆分为词项，统计在 title + content 中的出现次数，
 * 精确匹配 > 部分匹配 > 无匹配。
 *
 * 返回 0-1 之间的归一化分数。
 */
function computeKeywordScore(query: string, item: MemoryItem): number {
  const queryLower = query.toLowerCase();
  const titleLower = item.title.toLowerCase();
  const contentLower = item.content.toLowerCase();

  // 整体 query 精确匹配（给较高加分）
  let score = 0;
  if (titleLower.includes(queryLower)) score += 0.4;
  if (contentLower.includes(queryLower)) score += 0.2;

  // 按词项拆分，逐个匹配
  const terms = queryLower
    .split(/\s+/)
    .filter((t) => t.length > 1); // 忽略单字符

  if (terms.length === 0) return Math.min(score, 1);

  let termHits = 0;
  let totalOccurrences = 0;

  for (const term of terms) {
    const titleHits = countOccurrences(titleLower, term);
    const contentHits = countOccurrences(contentLower, term);

    if (titleHits > 0 || contentHits > 0) {
      termHits++;
      // title 中出现权重更高
      totalOccurrences += titleHits * 3 + contentHits;
    }
  }

  // 词项覆盖率 (多少比例的查询词被匹配到)
  const coverage = termHits / terms.length;
  score += coverage * 0.3;

  // TF 归一化: occurrences / content length，防止长文本天然占优
  const contentLength = Math.max(contentLower.length, 1);
  const tfScore = Math.min(totalOccurrences / (contentLength / 100), 1);
  score += tfScore * 0.1;

  return Math.min(score, 1);
}

/** 统计 text 中 term 出现的次数 */
function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    pos = text.indexOf(term, pos);
    if (pos === -1) break;
    count++;
    pos += term.length;
  }
  return count;
}

// ─── 时间衰减评分 ────────────────────────────────────────────────────────────

/**
 * 计算时间衰减得分。
 * - 今天更新的 → 1.0
 * - 指数衰减: score = exp(-daysSinceUpdate / 30)
 *   半衰期约 21 天 (ln(2) * 30 ≈ 20.8)
 */
function computeRecencyScore(item: MemoryItem): number {
  const now = Date.now();
  const updatedAt = new Date(item.updatedAt).getTime();
  const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);

  // 今天的记忆直接返回 1.0
  if (daysSinceUpdate < 1) return 1.0;

  return Math.exp(-daysSinceUpdate / 30);
}

// ─── 混合检索 ────────────────────────────────────────────────────────────────

/**
 * 执行混合 RAG 检索。
 *
 * 流程:
 * 1. 通过 memory-store 做关键词搜索，获取候选集
 * 2. 如果 embedding 模型可用，额外做语义搜索
 * 3. 合并去重，计算综合评分，排序返回
 */
export async function ragQuery(query: RAGQuery): Promise<RAGResult> {
  const {
    query: queryText,
    agentId,
    category,
    limit = 10,
    maxTier = PermissionTier.T2_SENSITIVE,
  } = query;

  const useSemantics = isModelLoaded();

  // ── 1. 关键词搜索 ──────────────────────────────────────────────────────

  // 拉取较多候选，后续重新排序
  const keywordCandidateLimit = Math.max(limit * 3, 30);

  const keywordResults = searchMemories(
    {
      search: queryText,
      category,
      source: agentId,
      limit: keywordCandidateLimit,
    },
    maxTier,
  );

  // 如果指定了 agentId，也搜索 tags 中包含 agentId 的记忆
  let agentTagResults: MemoryItem[] = [];
  if (agentId) {
    agentTagResults = searchMemories(
      {
        tags: [agentId],
        category,
        limit: keywordCandidateLimit,
      },
      maxTier,
    );
  }

  // ── 2. 语义搜索（QMD vsearch）────────────────────────────────────────

  let semanticResults: Map<string, number> = new Map(); // id → semantic score

  if (useSemantics) {
    const qmdResults = await qmdVsearch(queryText, keywordCandidateLimit);

    for (const r of qmdResults) {
      if (r.memoryId) {
        semanticResults.set(r.memoryId, r.score);
        // If QMD found items not in keyword results, load and add them
        if (!keywordResults.some(k => k.id === r.memoryId) &&
            !agentTagResults.some(k => k.id === r.memoryId)) {
          const item = getMemory(r.memoryId);
          if (item && item.tier <= maxTier) {
            keywordResults.push(item);
          } else if (!item) {
            console.warn(`[rag] QMD returned stale memoryId "${r.memoryId}" — not found in store`);
          }
        }
      }
    }
  }

  // ── 3. 合并去重 + 综合评分 ────────────────────────────────────────────

  const allItems = deduplicateItems([
    ...keywordResults,
    ...agentTagResults,
  ]);

  const totalCandidates = allItems.length;
  const method: RAGResult["method"] = useSemantics ? "hybrid" : "keyword_only";

  const scored: ScoredRAGItem[] = allItems.map((item) => {
    const keywordScore = computeKeywordScore(queryText, item);
    const semanticScore = semanticResults.get(item.id) ?? 0;
    const recencyScore = computeRecencyScore(item);

    // 综合评分
    let score: number;
    if (useSemantics) {
      // hybrid: 0.40 semantic + 0.35 keyword + 0.25 recency
      score = 0.4 * semanticScore + 0.35 * keywordScore + 0.25 * recencyScore;
    } else {
      // keyword_only: 0.70 keyword + 0.30 recency
      score = 0.7 * keywordScore + 0.3 * recencyScore;
    }

    return { item, score, keywordScore, semanticScore, recencyScore };
  });

  // 按综合得分降序排列
  scored.sort((a, b) => b.score - a.score);

  return {
    items: scored.slice(0, limit),
    method,
    totalCandidates,
  };
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 按 ID 去重，保留第一次出现的 item */
function deduplicateItems(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  const result: MemoryItem[] = [];

  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }

  return result;
}
