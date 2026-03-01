/**
 * Agent Evaluation Engine
 *
 * Four-dimension scoring system:
 *   1. Activity   (20%) — Is the agent being used?
 *   2. Success    (30%) — Are requests handled correctly?
 *   3. Failure    (30%) — How many errors/timeouts/empty responses?
 *   4. Resilience (20%) — Long-term stability and trend
 *
 * Health levels:
 *   🟢 ≥80 HEALTHY              — No action needed
 *   🟡 60–79 NEEDS_OPTIMIZATION  — Improve in next iteration
 *   🟠 40–59 NEEDS_OVERHAUL      — Fix this week
 *   🔴 <40 CRITICAL              — Fix immediately
 *
 * Reports stored in: agents/evaluator/reports/YYYY-MM-DD.json
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  loadMetricsRange,
  getAgentIdsWithMetrics,
  loadDailyMetrics,
  cleanupOldMetrics,
  type DailyMetrics,
} from "./agent-metrics.js";
import { getAllAgentStats } from "./agent-learning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "../agents");
const REPORTS_DIR = join(AGENTS_DIR, "evaluator", "reports");

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthLevel = "HEALTHY" | "NEEDS_OPTIMIZATION" | "NEEDS_OVERHAUL" | "CRITICAL";

export interface AgentEvaluation {
  agentId: string;
  date: string;
  // Dimension scores (0–100)
  activityScore: number;
  successScore: number;
  failureScore: number;
  resilienceScore: number;
  // Weighted composite
  compositeScore: number;
  healthLevel: HealthLevel;
  healthEmoji: string;
  // Today's raw data
  todayRequests: number;
  todaySuccess: number;
  todayErrors: number;
  todayTimeouts: number;
  todayEmpty: number;
  todayFallbacks: number;
  avgLatencyMs: number;
  // Diagnostics
  issues: string[];
  trend: number; // positive = improving, negative = declining
}

export interface DailyReport {
  date: string;
  generatedAt: string;
  evaluations: AgentEvaluation[];
  summary: string;
}

// ─── Weights ─────────────────────────────────────────────────────────────────

const WEIGHTS = {
  activity: 0.2,
  success: 0.3,
  failure: 0.3,
  resilience: 0.2,
};

// ─── Scoring Functions ───────────────────────────────────────────────────────

/**
 * Activity Score (20%):
 * How active is this agent relative to its own baseline?
 */
function calcActivityScore(todayMetrics: DailyMetrics | null, history: DailyMetrics[]): number {
  if (!todayMetrics || todayMetrics.totalRequests === 0) {
    // No activity today — but don't penalize if the agent is new or rarely used
    if (history.length === 0) return 50; // new agent, neutral score
    return 0; // established agent with zero activity today
  }

  // Baseline: average daily requests over last 7 days
  const historicalDays = history.filter((h) => h.totalRequests > 0);
  if (historicalDays.length === 0) {
    // First day of data — full score for any activity
    return 100;
  }

  const avgDaily =
    historicalDays.reduce((sum, h) => sum + h.totalRequests, 0) / historicalDays.length;

  if (avgDaily === 0) return todayMetrics.totalRequests > 0 ? 100 : 0;

  const ratio = todayMetrics.totalRequests / avgDaily;
  return Math.min(100, Math.round(ratio * 100));
}

/**
 * Success Rate Score (30%):
 * Percentage of requests that completed successfully.
 */
function calcSuccessScore(todayMetrics: DailyMetrics | null): number {
  if (!todayMetrics || todayMetrics.totalRequests === 0) return -1; // unscored

  const rate = todayMetrics.successCount / todayMetrics.totalRequests;
  // Scale: 95%+ = 100, linear below
  if (rate >= 0.95) return 100;
  return Math.round(rate * 105); // slight boost so 90% ≈ 95 points
}

/**
 * Failure Score (30%):
 * Inverse of weighted failure rate.
 * Weights: error=1.0, timeout=0.8, empty=0.5
 */
function calcFailureScore(todayMetrics: DailyMetrics | null): number {
  if (!todayMetrics || todayMetrics.totalRequests === 0) return -1; // unscored

  const weightedFailures =
    todayMetrics.errorCount * 1.0 +
    todayMetrics.timeoutCount * 0.8 +
    todayMetrics.emptyResponseCount * 0.5;

  const failureRatio = weightedFailures / todayMetrics.totalRequests;
  return Math.max(0, Math.round((1 - failureRatio) * 100));
}

/**
 * Resilience Score (20%):
 * Long-term stability based on:
 *   - Consecutive days without failures (max 70 pts from this)
 *   - 7-day average success rate (max 20 pts)
 *   - No fallbacks bonus (10 pts)
 */
function calcResilienceScore(history: DailyMetrics[]): number {
  if (history.length === 0) return 50; // new agent, neutral

  // Consecutive no-failure days (from most recent)
  let consecutiveClean = 0;
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  for (const day of sorted) {
    if (day.errorCount === 0 && day.timeoutCount === 0 && day.emptyResponseCount === 0) {
      consecutiveClean++;
    } else {
      break;
    }
  }
  const cleanScore = Math.min(70, consecutiveClean * 10);

  // 7-day average success rate
  const totalReqs = history.reduce((s, h) => s + h.totalRequests, 0);
  const totalSuccess = history.reduce((s, h) => s + h.successCount, 0);
  const avgSuccessRate = totalReqs > 0 ? totalSuccess / totalReqs : 0;
  const avgScore = Math.round(avgSuccessRate * 20);

  // No-fallback bonus
  const totalFallbacks = history.reduce((s, h) => s + h.fallbackCount, 0);
  const fallbackBonus = totalFallbacks === 0 ? 10 : 0;

  return Math.min(100, cleanScore + avgScore + fallbackBonus);
}

/**
 * Calculate trend: compare today's composite vs yesterday's.
 * Returns point difference (e.g., +5 or -3).
 */
function calcTrend(agentId: string, todayComposite: number): number {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // Try to load yesterday's report
  const reportPath = join(REPORTS_DIR, `${yesterdayStr}.json`);
  if (!existsSync(reportPath)) return 0;

  try {
    const report: DailyReport = JSON.parse(readFileSync(reportPath, "utf-8"));
    const yesterdayEval = report.evaluations.find((e) => e.agentId === agentId);
    if (yesterdayEval) {
      return Math.round(todayComposite - yesterdayEval.compositeScore);
    }
  } catch {}

  return 0;
}

// ─── Diagnosis ───────────────────────────────────────────────────────────────

function diagnose(metrics: DailyMetrics | null, history: DailyMetrics[]): string[] {
  const issues: string[] = [];
  if (!metrics || metrics.totalRequests === 0) {
    if (history.length > 0) issues.push("今日零活跃，可能已停用");
    return issues;
  }

  const total = metrics.totalRequests;

  // Error rate
  if (metrics.errorCount > 0) {
    const rate = ((metrics.errorCount / total) * 100).toFixed(0);
    issues.push(`错误率 ${rate}% (${metrics.errorCount}/${total})`);
  }

  // Timeout rate
  if (metrics.timeoutCount > 0) {
    const rate = ((metrics.timeoutCount / total) * 100).toFixed(0);
    issues.push(`超时率 ${rate}%，建议检查 prompt 长度或工具调用`);
  }

  // Empty response rate
  if (metrics.emptyResponseCount > 0) {
    const rate = ((metrics.emptyResponseCount / total) * 100).toFixed(0);
    issues.push(`空响应率 ${rate}%，建议重写 system prompt`);
  }

  // Fallback rate
  if (metrics.fallbackCount > 0) {
    issues.push(`触发 ${metrics.fallbackCount} 次 fallback`);
  }

  // High latency
  if (metrics.avgLatencyMs > 30000) {
    issues.push(`平均延迟 ${(metrics.avgLatencyMs / 1000).toFixed(1)}s 偏高`);
  }

  // Declining trend in history
  if (history.length >= 3) {
    const recent3 = history.slice(0, 3);
    const successRates = recent3.map((h) =>
      h.totalRequests > 0 ? h.successCount / h.totalRequests : 1
    );
    if (successRates[0] < successRates[1] && successRates[1] < successRates[2]) {
      issues.push("连续3天成功率下降趋势");
    }
  }

  return issues;
}

// ─── Main Evaluation ─────────────────────────────────────────────────────────

function healthLevel(score: number): { level: HealthLevel; emoji: string } {
  if (score >= 80) return { level: "HEALTHY", emoji: "🟢" };
  if (score >= 60) return { level: "NEEDS_OPTIMIZATION", emoji: "🟡" };
  if (score >= 40) return { level: "NEEDS_OVERHAUL", emoji: "🟠" };
  return { level: "CRITICAL", emoji: "🔴" };
}

/**
 * Evaluate a single agent.
 */
function evaluateAgent(agentId: string): AgentEvaluation {
  const date = new Date().toISOString().slice(0, 10);
  const history = loadMetricsRange(agentId, 7);
  const todayMetrics = history.find((h) => h.date === date) ?? null;

  const activityScore = calcActivityScore(todayMetrics, history.filter((h) => h.date !== date));
  let successScore = calcSuccessScore(todayMetrics);
  let failureScore = calcFailureScore(todayMetrics);

  // If unscored (no requests today), use last known scores from history
  if (successScore === -1 && history.length > 1) {
    const lastWithData = history.find((h) => h.date !== date && h.totalRequests > 0);
    if (lastWithData) {
      successScore = calcSuccessScore(lastWithData);
      failureScore = calcFailureScore(lastWithData);
    } else {
      successScore = 50;
      failureScore = 50;
    }
  } else if (successScore === -1) {
    successScore = 50;
    failureScore = 50;
  }

  const resilienceScore = calcResilienceScore(history);

  const compositeScore = Math.round(
    activityScore * WEIGHTS.activity +
    successScore * WEIGHTS.success +
    failureScore * WEIGHTS.failure +
    resilienceScore * WEIGHTS.resilience
  );

  const health = healthLevel(compositeScore);
  const trend = calcTrend(agentId, compositeScore);
  const issues = diagnose(todayMetrics, history);

  return {
    agentId,
    date,
    activityScore,
    successScore,
    failureScore,
    resilienceScore,
    compositeScore,
    healthLevel: health.level,
    healthEmoji: health.emoji,
    todayRequests: todayMetrics?.totalRequests ?? 0,
    todaySuccess: todayMetrics?.successCount ?? 0,
    todayErrors: todayMetrics?.errorCount ?? 0,
    todayTimeouts: todayMetrics?.timeoutCount ?? 0,
    todayEmpty: todayMetrics?.emptyResponseCount ?? 0,
    todayFallbacks: todayMetrics?.fallbackCount ?? 0,
    avgLatencyMs: todayMetrics?.avgLatencyMs ?? 0,
    issues,
    trend,
  };
}

// ─── Report Generation ───────────────────────────────────────────────────────

/**
 * Generate a full daily evaluation report for all agents.
 */
export function generateDailyReport(): DailyReport {
  const date = new Date().toISOString().slice(0, 10);

  // Get all agent IDs: from metrics + from learning.json + from SKILL.md
  const metricsAgents = getAgentIdsWithMetrics();
  const learningAgents = getAllAgentStats().map((a) => a.agentId);

  // Also scan for SKILL.md agents that might not have metrics yet
  const skillAgents: string[] = [];
  if (existsSync(AGENTS_DIR)) {
    for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "archive" || entry.name === "evaluator") continue;
      const skillPath = join(AGENTS_DIR, entry.name, "SKILL.md");
      if (existsSync(skillPath)) {
        skillAgents.push(entry.name);
      }
    }
  }

  const allAgentIds = [...new Set([...metricsAgents, ...learningAgents, ...skillAgents])];
  const evaluations = allAgentIds.map(evaluateAgent).sort((a, b) => b.compositeScore - a.compositeScore);

  const summary = formatTextReport(evaluations, date);

  const report: DailyReport = {
    date,
    generatedAt: new Date().toISOString(),
    evaluations,
    summary,
  };

  // Save report
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(
    join(REPORTS_DIR, `${date}.json`),
    JSON.stringify(report, null, 2)
  );

  console.log(`[evaluator] Daily report generated: ${evaluations.length} agents evaluated`);
  return report;
}

/**
 * Format the report as a human-readable text summary.
 */
function formatTextReport(evaluations: AgentEvaluation[], date: string): string {
  const lines: string[] = [];
  lines.push(`📊 Agent 健康日报 — ${date}\n`);

  for (const ev of evaluations) {
    const trendStr = ev.trend > 0 ? `↑${ev.trend}` : ev.trend < 0 ? `↓${Math.abs(ev.trend)}` : "→";
    const statusLabel =
      ev.healthLevel === "NEEDS_OPTIMIZATION" ? " ⚠️ 需优化" :
      ev.healthLevel === "NEEDS_OVERHAUL" ? " 🔧 需整改" :
      ev.healthLevel === "CRITICAL" ? " 🚨 需检修" : "";

    lines.push(`${ev.healthEmoji} ${ev.agentId} (${ev.compositeScore}分)${statusLabel}`);
    lines.push(`   活跃度: ${ev.activityScore} | 成功率: ${ev.successScore} | 故障率: ${ev.failureScore} | 坚固: ${ev.resilienceScore}`);

    if (ev.todayRequests > 0) {
      lines.push(`   今日: ${ev.todayRequests}次请求, 成功${ev.todaySuccess}, 平均延迟 ${(ev.avgLatencyMs / 1000).toFixed(1)}s`);
    } else {
      lines.push(`   今日: 无请求`);
    }

    if (ev.issues.length > 0) {
      lines.push(`   问题: ${ev.issues.join("; ")}`);
    }

    lines.push("");
  }

  // Trend summary
  const trends = evaluations
    .filter((e) => e.trend !== 0)
    .map((e) => {
      const arrow = e.trend > 0 ? `↑${e.trend}` : `↓${Math.abs(e.trend)}`;
      return `${e.agentId}${arrow}`;
    });

  if (trends.length > 0) {
    lines.push(`📈 趋势: ${trends.join(", ")}`);
  }

  // Action items
  const critical = evaluations.filter((e) => e.healthLevel === "CRITICAL");
  const overhaul = evaluations.filter((e) => e.healthLevel === "NEEDS_OVERHAUL");
  const optimize = evaluations.filter((e) => e.healthLevel === "NEEDS_OPTIMIZATION");

  if (critical.length > 0 || overhaul.length > 0) {
    lines.push("");
    lines.push("🎯 行动项:");
    for (const e of critical) {
      lines.push(`   🔴 ${e.agentId}: 立即检修 — ${e.issues.join("; ") || "综合分过低"}`);
    }
    for (const e of overhaul) {
      lines.push(`   🟠 ${e.agentId}: 本周整改 — ${e.issues.join("; ") || "需要优化"}`);
    }
    for (const e of optimize) {
      lines.push(`   🟡 ${e.agentId}: 下次迭代优化`);
    }
  }

  return lines.join("\n");
}

/**
 * Get the latest report (from disk or generate fresh).
 */
export function getLatestReport(): DailyReport {
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(REPORTS_DIR, `${date}.json`);

  if (existsSync(reportPath)) {
    try {
      return JSON.parse(readFileSync(reportPath, "utf-8"));
    } catch {}
  }

  // Generate fresh
  return generateDailyReport();
}

/**
 * Run the scheduled daily evaluation.
 * Called by cron at 23:00 UTC+4 (19:00 UTC).
 */
export function runScheduledEvaluation(): void {
  console.log("[evaluator] Running scheduled daily evaluation...");
  const report = generateDailyReport();
  cleanupOldMetrics();
  console.log("[evaluator] Report summary:\n" + report.summary);
}

/**
 * Setup daily cron — runs at 23:00 local time every day.
 * Uses setInterval (no external dependency needed).
 */
export function setupEvaluationCron(): void {
  // Calculate ms until next 23:00
  const now = new Date();
  const next2300 = new Date(now);
  next2300.setHours(23, 0, 0, 0);
  if (now >= next2300) {
    next2300.setDate(next2300.getDate() + 1);
  }

  const msUntilFirst = next2300.getTime() - now.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  console.log(
    `[evaluator] Cron scheduled: first run in ${(msUntilFirst / 3600000).toFixed(1)}h, then every 24h`
  );

  // First run
  setTimeout(() => {
    runScheduledEvaluation();
    // Then every 24h
    setInterval(runScheduledEvaluation, oneDayMs);
  }, msUntilFirst);
}
