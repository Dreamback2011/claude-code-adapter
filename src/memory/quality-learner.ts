/**
 * Quality Learner — Unified interface for learning + metrics + evaluation
 *
 * Wraps existing modules into a single API that the Memory Agent facade calls.
 * No duplication — delegates to the original implementations.
 *
 * Responsibilities:
 * - Record agent usage (delegates to agent-learning.ts)
 * - Record metrics (delegates to agent-metrics.ts)
 * - Generate evaluations (delegates to agent-evaluation.ts)
 * - Provide combined quality view per agent
 */

import {
  recordAgentUse,
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
  type AgentLearning,
  type SessionRecord,
} from "../agent-learning.js";

import {
  recordMetric,
  loadDailyMetrics,
  loadMetricsRange,
  getTodayMetrics,
  cleanupOldMetrics,
  type MetricEvent,
  type DailyMetrics,
} from "../agent-metrics.js";

import {
  generateDailyReport,
  getLatestReport,
  type DailyReport,
  type AgentEvaluation,
} from "../agent-evaluation.js";

import type { AgentReport } from "./types.js";

// ─── Combined Quality View ───────────────────────────────────────────────────

export interface AgentQualityView {
  agentId: string;
  /** From learning system */
  learning: AgentLearning | null;
  /** Today's metrics */
  todayMetrics: DailyMetrics | null;
  /** Latest evaluation (from today's report) */
  evaluation: AgentEvaluation | null;
  /** Quick health summary */
  healthSummary: string;
}

/**
 * Get a combined quality view for a specific agent.
 */
export function getAgentQuality(agentId: string): AgentQualityView {
  const allStats = getAllAgentStats();
  const learning = allStats.find((a) => a.agentId === agentId) ?? null;
  const todayMetrics = getTodayMetrics(agentId);
  const report = getLatestReport();
  const evaluation = report.evaluations.find((e) => e.agentId === agentId) ?? null;

  let healthSummary = `${agentId}: `;
  if (evaluation) {
    healthSummary += `${evaluation.healthEmoji} ${evaluation.compositeScore}分`;
    if (evaluation.issues.length > 0) {
      healthSummary += ` | ${evaluation.issues[0]}`;
    }
  } else {
    healthSummary += "无评估数据";
  }
  if (learning) {
    healthSummary += ` | 质量: ${(learning.qualityScore * 100).toFixed(0)}% (${learning.goodRatings}👍 ${learning.badRatings}👎)`;
  }

  return { agentId, learning, todayMetrics, evaluation, healthSummary };
}

/**
 * Get quality views for all agents.
 */
export function getAllAgentQuality(): AgentQualityView[] {
  const allStats = getAllAgentStats();
  const report = getLatestReport();

  // Collect all known agent IDs
  const agentIds = new Set<string>();
  for (const s of allStats) agentIds.add(s.agentId);
  for (const e of report.evaluations) agentIds.add(e.agentId);

  return Array.from(agentIds).map(getAgentQuality);
}

// ─── Unified Report Interface ─────────────────────────────────────────────────

/**
 * Process an agent's execution report.
 * This is the single entry point for recording that an agent did work.
 */
export function processAgentReport(report: AgentReport): void {
  // 1. Record in learning system (for feedback correlation)
  recordAgentUse({
    requestId: report.requestId,
    agentId: report.agentId,
    agentName: report.agentName,
    sessionId: report.sessionId,
    inputText: report.inputText,
    outputText: report.outputText,
    timestamp: report.timestamp,
  });

  // 2. Record metrics
  const metricEvent: MetricEvent = report.outputText.trim()
    ? {
        type: "success",
        agentId: report.agentId,
        latencyMs: report.latencyMs,
        costUsd: report.costUsd,
      }
    : {
        type: "empty_response",
        agentId: report.agentId,
        latencyMs: report.latencyMs,
      };

  recordMetric(metricEvent);
}

/**
 * Record a fallback event (when primary agent fails and general takes over).
 */
export function recordFallback(originalAgentId: string, fallbackAgentId: string): void {
  recordMetric({ type: "fallback", agentId: fallbackAgentId, originalAgentId });
}

/**
 * Record an error event.
 */
export function recordError(agentId: string, latencyMs: number): void {
  recordMetric({ type: "error", agentId, latencyMs });
}

/**
 * Record a timeout event.
 */
export function recordTimeout(agentId: string): void {
  recordMetric({ type: "timeout", agentId });
}

// ─── Re-exports (for convenience) ────────────────────────────────────────────

export {
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
  generateDailyReport,
  getLatestReport,
  cleanupOldMetrics,
  loadMetricsRange,
};

export type { AgentLearning, SessionRecord, MetricEvent, DailyMetrics, DailyReport, AgentEvaluation };
