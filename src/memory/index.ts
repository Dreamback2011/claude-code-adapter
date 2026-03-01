/**
 * Memory Agent — Unified Facade
 *
 * Single entry point for all memory operations.
 * Wires together:
 *   - memory-store     → Storage / retrieval / cleanup
 *   - permission-gate  → Access control
 *   - identity-resolver → Caller identification
 *   - progress-tracker → Task progress monitoring
 *   - quality-learner  → Learning / metrics / evaluation
 *
 * Usage in the request pipeline:
 *   1. enrichContext()  — Before agent execution, load relevant memories
 *   2. reportExecution() — After execution, record what happened
 *   3. Direct CRUD     — For explicit memory management
 */

import {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getAgentMemories,
  cleanupExpired,
  getMemoryStats,
  reloadIndex,
} from "./memory-store.js";

import {
  filterByPermission,
  getMaxTier,
  detectSensitiveTier,
  checkAccess,
} from "./permission-gate.js";

import { resolveIdentity, type CallerContext } from "./identity-resolver.js";

import {
  createProgress,
  getProgress,
  addProgressUpdate,
  setProgressStatus,
  getAgentActiveProgress,
  getAllActiveProgress,
  detectStalled,
  cleanupProgress,
  getProgressSummary,
} from "./progress-tracker.js";

import {
  processAgentReport,
  recordFallback,
  recordError,
  recordTimeout,
  getAgentQuality,
  getAllAgentQuality,
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
  generateDailyReport,
  getLatestReport,
  cleanupOldMetrics,
} from "./quality-learner.js";

import { extractMemories, parseAndSaveMemoryTags } from "./auto-extract.js";

import { ragQuery, type RAGQuery, type RAGResult, type ScoredRAGItem } from "./rag-retriever.js";
import { preloadModel, isModelLoaded } from "./embeddings.js";

import type {
  MemoryItem,
  CreateMemoryInput,
  MemoryQuery,
  EnrichmentResult,
  AgentReport,
  PermissionTier,
} from "./types.js";

// ─── Context Enrichment ───────────────────────────────────────────────────────

/**
 * Enrich an agent's context before execution.
 *
 * Retrieves:
 * - Agent-specific memories (tagged with agentId)
 * - Active progress for this agent
 * - Recent relevant memories from search
 *
 * All filtered by caller's permission level.
 */
export async function enrichContext(
  agentId: string,
  callerCtx: CallerContext,
  searchHint?: string
): Promise<EnrichmentResult> {
  const maxTier = getMaxTier(callerCtx);

  // 1. Agent-specific memories
  const agentMems = getAgentMemories(agentId, maxTier);

  // 2. Search by hint — use RAG if model is loaded, fallback to keyword
  let searchMems: MemoryItem[] = [];
  if (searchHint) {
    if (isModelLoaded()) {
      // 使用 RAG 混合检索
      const ragResult = await ragQuery({
        query: searchHint,
        agentId,
        limit: 5,
        maxTier,
      });
      searchMems = ragResult.items.map(r => r.item);
    } else {
      // 降级: 纯关键词搜索
      searchMems = searchMemories({ search: searchHint, limit: 5 }, maxTier);
    }
    // Deduplicate
    const agentMemIds = new Set(agentMems.map((m) => m.id));
    searchMems = searchMems.filter((m) => !agentMemIds.has(m.id));
  }

  const allMemories = [...agentMems, ...searchMems];

  // 3. Apply permission filter (double-check)
  const { allowed, filtered } = filterByPermission(callerCtx, allMemories);

  // 4. Active progress
  const activeProgress = getAgentActiveProgress(agentId);

  return {
    memories: allowed,
    activeProgress,
    filtered: filtered > 0,
  };
}

/**
 * Format enrichment result as a context string to prepend to agent system prompt.
 */
export function formatEnrichment(result: EnrichmentResult): string {
  const sections: string[] = [];

  if (result.memories.length > 0) {
    sections.push("## 相关记忆");
    for (const mem of result.memories.slice(0, 10)) {
      sections.push(`- [${mem.category}] ${mem.title}: ${mem.content.slice(0, 200)}`);
    }
  }

  if (result.activeProgress.length > 0) {
    sections.push("\n## 当前进度");
    for (const prog of result.activeProgress.slice(0, 5)) {
      const lastMsg = prog.updates[0]?.message ?? "无更新";
      sections.push(`- ${prog.title} (${prog.status}): ${lastMsg}`);
    }
  }

  if (sections.length === 0) return "";

  return `\n<memory-context>\n${sections.join("\n")}\n</memory-context>\n`;
}

// ─── Post-Execution Reporting ─────────────────────────────────────────────────

/**
 * Report an agent's execution result to the memory system.
 * Called after each agent request completes.
 *
 * Handles:
 * - Quality tracking (learning + metrics)
 * - Progress updates (if applicable)
 * - Auto-memory creation for significant interactions
 */
export function reportExecution(report: AgentReport): void {
  // 1. Quality tracking
  processAgentReport(report);

  // 2. Progress update if specified
  if (report.progressUpdate) {
    addProgressUpdate(
      report.progressUpdate.progressId,
      report.agentId,
      report.progressUpdate.message,
    );
  }

  // 3. Auto-extract memories from conversation (throttled)
  try {
    extractMemories(report);
  } catch (err: any) {
    console.warn(`[memory] Auto-extract failed:`, err.message);
  }
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Run all maintenance tasks.
 * Called daily (from evaluation cron) or on demand.
 */
export function runMaintenance(): {
  expiredMemories: number;
  stalledProgress: number;
  cleanedProgress: number;
  cleanedMetrics: number;
} {
  console.log("[memory] Running maintenance...");

  const expiredMemories = cleanupExpired();
  const stalledTasks = detectStalled();
  const cleanedProgress = cleanupProgress();
  const cleanedMetrics = cleanupOldMetrics();

  console.log(
    `[memory] Maintenance done: ${expiredMemories} expired memories, ` +
    `${stalledTasks.length} stalled tasks, ${cleanedProgress} old progress, ` +
    `${cleanedMetrics} old metrics`
  );

  return {
    expiredMemories,
    stalledProgress: stalledTasks.length,
    cleanedProgress,
    cleanedMetrics,
  };
}

/**
 * Get a full system status overview.
 */
export function getSystemStatus(): {
  memory: ReturnType<typeof getMemoryStats>;
  progress: string;
  quality: ReturnType<typeof getAllAgentQuality>;
} {
  return {
    memory: getMemoryStats(),
    progress: getProgressSummary(),
    quality: getAllAgentQuality(),
  };
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

// Memory CRUD
export {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryStats,
  reloadIndex,
};

// Permission
export { checkAccess, getMaxTier, detectSensitiveTier, resolveIdentity };
export type { CallerContext };

// Progress
export {
  createProgress,
  getProgress,
  addProgressUpdate,
  setProgressStatus,
  getAgentActiveProgress,
  getAllActiveProgress,
  getProgressSummary,
};

// Quality (learning + metrics + evaluation)
export {
  processAgentReport,
  recordFallback,
  recordError,
  recordTimeout,
  rateRequest,
  getAgentQuality,
  getAllAgentQuality,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
  generateDailyReport,
  getLatestReport,
};

// Auto-extract
export { extractMemories, parseAndSaveMemoryTags };

// RAG
export { ragQuery, preloadModel, isModelLoaded };
export type { RAGQuery, RAGResult, ScoredRAGItem };

// QMD
export { fullSync as qmdFullSync } from "./qmd-search.js";

// Types
export type {
  MemoryItem,
  CreateMemoryInput,
  MemoryQuery,
  EnrichmentResult,
  AgentReport,
};
export { PermissionTier } from "./types.js";
