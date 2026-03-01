/**
 * Embeddings — QMD CLI 语义搜索初始化模块
 *
 * 通过 QMD (qmd vsearch) 提供语义搜索能力，替代已移除的 ONNX 本地嵌入。
 */

import { isQmdAvailable, initQmdCollection } from "./qmd-search.js";

// ─── 模型状态 ───────────────────────────────────────────────────────────────────

let qmdInitialized = false;

/**
 * 检查语义搜索是否可用。
 * QMD 可用时返回 true。
 */
export function isModelLoaded(): boolean {
  return qmdInitialized || isQmdAvailable();
}

/**
 * 预加载模型 — 初始化 QMD collection
 */
export async function preloadModel(): Promise<void> {
  if (isQmdAvailable()) {
    const ok = await initQmdCollection();
    qmdInitialized = ok;
    console.log(`[embeddings] QMD semantic search: ${ok ? "ready" : "failed to init"}`);
  } else {
    console.log("[embeddings] QMD not available, semantic search disabled");
  }
}
