/**
 * Agent Metrics Collection System
 *
 * Tracks per-agent operational metrics:
 *   - Request counts (success / error / timeout / empty / fallback)
 *   - Latency statistics (avg, max, p95)
 *   - Daily snapshots stored as JSON files
 *
 * Storage: agents/{agentId}/metrics/YYYY-MM-DD.json
 * Retention: 30 days rolling
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "../agents");
const RETENTION_DAYS = 30;
const MAX_LATENCIES = 100; // FIFO cap: keep only the most recent N latency samples

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DailyMetrics {
  agentId: string;
  date: string; // YYYY-MM-DD
  // Request counts
  totalRequests: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  emptyResponseCount: number;
  fallbackCount: number;
  // Latency (ms)
  latencies: number[]; // raw values for p95 calc
  avgLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
  // Cost tracking (from CLI result events)
  totalCostUsd: number;
  totalDurationMs: number;
}

export type MetricEvent =
  | { type: "success"; agentId: string; latencyMs: number; costUsd?: number; durationMs?: number }
  | { type: "error"; agentId: string; latencyMs: number }
  | { type: "timeout"; agentId: string }
  | { type: "empty_response"; agentId: string; latencyMs: number }
  | { type: "fallback"; agentId: string; originalAgentId: string };

// ─── Agent ID normalization ──────────────────────────────────────────────────

/**
 * Normalize agentId to prevent inconsistent metrics paths.
 * Maps undefined, null, empty string, and library sentinel values to "unrouted".
 *
 * "unrouted" indicates no agent was successfully selected for the request,
 * which is more descriptive than the previous "unknown" label.
 *
 * The agent-squad library returns "no_agent_selected" when classification fails,
 * which is truthy and bypasses `??` fallback. This function catches all variants.
 */
export function normalizeAgentId(agentId: string | undefined | null): string {
  if (!agentId || agentId.trim() === "" || agentId === "no_agent_selected") {
    return "unrouted";
  }
  return agentId;
}

// ─── In-memory daily buffer ──────────────────────────────────────────────────

const dailyBuffers = new Map<string, DailyMetrics>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function bufferKey(agentId: string, date: string): string {
  return `${agentId}::${date}`;
}

function getOrCreateBuffer(agentId: string): DailyMetrics {
  const date = today();
  const key = bufferKey(agentId, date);

  if (dailyBuffers.has(key)) {
    return dailyBuffers.get(key)!;
  }

  // Try to load from disk (server restart recovery)
  const existing = loadDailyMetrics(agentId, date);
  if (existing) {
    dailyBuffers.set(key, existing);
    return existing;
  }

  const fresh: DailyMetrics = {
    agentId,
    date,
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    timeoutCount: 0,
    emptyResponseCount: 0,
    fallbackCount: 0,
    latencies: [],
    avgLatencyMs: 0,
    maxLatencyMs: 0,
    p95LatencyMs: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
  };

  dailyBuffers.set(key, fresh);
  return fresh;
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Record a metric event for an agent.
 * Call this from squad.ts, claude-cli.ts, cli-classifier.ts.
 */
export function recordMetric(event: MetricEvent): void {
  // Normalize all agentId fields to prevent inconsistent paths
  event = { ...event, agentId: normalizeAgentId(event.agentId) };
  if (event.type === "fallback") {
    event = { ...event, originalAgentId: normalizeAgentId(event.originalAgentId) };
  }

  const metrics = getOrCreateBuffer(event.agentId);

  switch (event.type) {
    case "success":
      metrics.totalRequests++;
      metrics.successCount++;
      metrics.latencies.push(event.latencyMs);
      if (event.costUsd) metrics.totalCostUsd += event.costUsd;
      if (event.durationMs) metrics.totalDurationMs += event.durationMs;
      break;

    case "error":
      metrics.totalRequests++;
      metrics.errorCount++;
      metrics.latencies.push(event.latencyMs);
      break;

    case "timeout":
      metrics.totalRequests++;
      metrics.timeoutCount++;
      break;

    case "empty_response":
      metrics.totalRequests++;
      metrics.emptyResponseCount++;
      metrics.latencies.push(event.latencyMs);
      break;

    case "fallback":
      // Increment fallback count on the ORIGINAL agent (the one that failed)
      const originalMetrics = getOrCreateBuffer(event.originalAgentId);
      originalMetrics.fallbackCount++;
      flushMetrics(event.originalAgentId);
      break;
  }

  // Recalculate latency stats
  if (metrics.latencies.length > 0) {
    const sorted = [...metrics.latencies].sort((a, b) => a - b);
    metrics.avgLatencyMs = Math.round(
      sorted.reduce((a, b) => a + b, 0) / sorted.length
    );
    metrics.maxLatencyMs = sorted[sorted.length - 1];
    const p95Index = Math.floor(sorted.length * 0.95);
    metrics.p95LatencyMs = sorted[Math.min(p95Index, sorted.length - 1)];
  }

  // Cap latencies array to prevent unbounded growth (FIFO: keep most recent)
  if (metrics.latencies.length > MAX_LATENCIES) {
    metrics.latencies = metrics.latencies.slice(-MAX_LATENCIES);
  }

  // Flush to disk after every event (lightweight, single agent file)
  flushMetrics(event.agentId);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function metricsDir(agentId: string): string {
  return join(AGENTS_DIR, agentId, "metrics");
}

function metricsPath(agentId: string, date: string): string {
  return join(metricsDir(agentId), `${date}.json`);
}

function flushMetrics(agentId: string): void {
  const date = today();
  const key = bufferKey(agentId, date);
  const metrics = dailyBuffers.get(key);
  if (!metrics) return;

  const dir = metricsDir(agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Write without latencies array (save space), recalculate on load
  const toWrite = { ...metrics };
  // Keep latencies in file for accurate p95 on reload
  writeFileSync(metricsPath(agentId, date), JSON.stringify(toWrite, null, 2));
}

/**
 * Load daily metrics from disk.
 */
export function loadDailyMetrics(
  agentId: string,
  date: string
): DailyMetrics | null {
  const path = metricsPath(agentId, date);
  if (!existsSync(path)) return null;
  try {
    const metrics: DailyMetrics = JSON.parse(readFileSync(path, "utf-8"));
    // Trim latencies from legacy files that had no cap
    if (metrics.latencies && metrics.latencies.length > MAX_LATENCIES) {
      metrics.latencies = metrics.latencies.slice(-MAX_LATENCIES);
    }
    return metrics;
  } catch {
    return null;
  }
}

/**
 * Load metrics for an agent over a date range (last N days).
 */
export function loadMetricsRange(
  agentId: string,
  days: number = 7
): DailyMetrics[] {
  const results: DailyMetrics[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const m = loadDailyMetrics(agentId, dateStr);
    if (m) results.push(m);
  }

  return results;
}

/**
 * Get all agent IDs that have metrics data.
 */
export function getAgentIdsWithMetrics(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const ids: string[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    if (existsSync(metricsDir(entry.name))) {
      ids.push(entry.name);
    }
  }
  return ids;
}

/**
 * Get today's metrics for an agent (from memory buffer).
 */
export function getTodayMetrics(agentId: string): DailyMetrics | null {
  const key = bufferKey(agentId, today());
  return dailyBuffers.get(key) ?? loadDailyMetrics(agentId, today());
}

/**
 * Clean up old metrics files (> RETENTION_DAYS).
 */
export function cleanupOldMetrics(): number {
  if (!existsSync(AGENTS_DIR)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let removed = 0;

  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = metricsDir(entry.name);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const fileDate = file.replace(".json", "");
      if (fileDate < cutoffStr) {
        try {
          unlinkSync(join(dir, file));
          removed++;
        } catch {}
      }
    }
  }

  if (removed > 0) {
    console.log(`[metrics] Cleaned up ${removed} old metric files`);
  }
  return removed;
}
