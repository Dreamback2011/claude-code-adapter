/**
 * Progress Tracker — Monitors agent task completion and status
 *
 * Receives reports from agents after execution.
 * Tracks ongoing tasks/projects across sessions.
 * Detects stalled tasks (no update for 48h).
 *
 * Storage: memory/progress/{id}.json
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
import type { ProgressRecord, ProgressUpdate, ProgressStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_DIR = join(__dirname, "../../memory/progress");

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(PROGRESS_DIR)) mkdirSync(PROGRESS_DIR, { recursive: true });
}

function progressPath(id: string): string {
  return join(PROGRESS_DIR, `${id}.json`);
}

let progressCounter = 0;

function generateProgressId(): string {
  const ts = Date.now().toString(36);
  const seq = (progressCounter++).toString(36);
  return `prog_${ts}_${seq}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new progress record (a task/project to track).
 */
export function createProgress(agentId: string, title: string, initialMessage?: string): ProgressRecord {
  ensureDir();

  const now = new Date().toISOString();
  const record: ProgressRecord = {
    id: generateProgressId(),
    agentId,
    title,
    status: "active",
    updates: [],
    createdAt: now,
    updatedAt: now,
  };

  if (initialMessage) {
    record.updates.push({
      timestamp: now,
      agentId,
      message: initialMessage,
    });
  }

  writeFileSync(progressPath(record.id), JSON.stringify(record, null, 2));
  console.log(`[progress] Created: ${record.id} — "${title}" (agent: ${agentId})`);
  return record;
}

/**
 * Get a progress record by ID.
 */
export function getProgress(id: string): ProgressRecord | null {
  const path = progressPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Add an update to a progress record.
 */
export function addProgressUpdate(id: string, agentId: string, message: string, relatedMemoryId?: string): ProgressRecord | null {
  const record = getProgress(id);
  if (!record) return null;

  const update: ProgressUpdate = {
    timestamp: new Date().toISOString(),
    agentId,
    message,
  };
  if (relatedMemoryId) update.relatedMemoryId = relatedMemoryId;

  record.updates.unshift(update); // newest first
  record.updatedAt = update.timestamp;

  // If status was stalled, reactivate it
  if (record.status === "stalled") {
    record.status = "active";
    console.log(`[progress] Reactivated stalled task: ${id}`);
  }

  writeFileSync(progressPath(id), JSON.stringify(record, null, 2));
  return record;
}

/**
 * Update the status of a progress record.
 */
export function setProgressStatus(id: string, status: ProgressStatus, agentId: string, message?: string): ProgressRecord | null {
  const record = getProgress(id);
  if (!record) return null;

  record.status = status;
  record.updatedAt = new Date().toISOString();

  if (message) {
    record.updates.unshift({
      timestamp: record.updatedAt,
      agentId,
      message: `[${status}] ${message}`,
    });
  }

  writeFileSync(progressPath(id), JSON.stringify(record, null, 2));
  console.log(`[progress] ${id} → ${status}${message ? `: ${message}` : ""}`);
  return record;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * List all progress records, optionally filtered.
 */
export function listProgress(filter?: {
  agentId?: string;
  status?: ProgressStatus;
}): ProgressRecord[] {
  ensureDir();

  const results: ProgressRecord[] = [];

  for (const file of readdirSync(PROGRESS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const record: ProgressRecord = JSON.parse(readFileSync(join(PROGRESS_DIR, file), "utf-8"));

      if (filter?.agentId && record.agentId !== filter.agentId) continue;
      if (filter?.status && record.status !== filter.status) continue;

      results.push(record);
    } catch {}
  }

  // Sort by updatedAt (newest first)
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Get active progress for a specific agent.
 */
export function getAgentActiveProgress(agentId: string): ProgressRecord[] {
  return listProgress({ agentId, status: "active" });
}

/**
 * Get all active progress across all agents.
 */
export function getAllActiveProgress(): ProgressRecord[] {
  return listProgress({ status: "active" });
}

// ─── Stale Detection ──────────────────────────────────────────────────────────

/**
 * Detect and mark stalled progress records.
 * A task is stalled if it's "active" and hasn't been updated for 48h.
 */
export function detectStalled(): ProgressRecord[] {
  const now = Date.now();
  const active = listProgress({ status: "active" });
  const stalled: ProgressRecord[] = [];

  for (const record of active) {
    const lastUpdate = new Date(record.updatedAt).getTime();
    if (now - lastUpdate > STALE_THRESHOLD_MS) {
      setProgressStatus(record.id, "stalled", "memory-agent", "无更新超过48小时，标记为停滞");
      record.status = "stalled";
      stalled.push(record);
    }
  }

  if (stalled.length > 0) {
    console.log(`[progress] Detected ${stalled.length} stalled tasks`);
  }

  return stalled;
}

/**
 * Cleanup: remove completed/cancelled progress records older than 30 days.
 */
export function cleanupProgress(): number {
  ensureDir();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString();
  let removed = 0;

  for (const file of readdirSync(PROGRESS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const record: ProgressRecord = JSON.parse(readFileSync(join(PROGRESS_DIR, file), "utf-8"));
      if (
        (record.status === "completed" || record.status === "cancelled") &&
        record.updatedAt < cutoffStr
      ) {
        unlinkSync(join(PROGRESS_DIR, file));
        removed++;
      }
    } catch {}
  }

  if (removed > 0) {
    console.log(`[progress] Cleaned up ${removed} old progress records`);
  }
  return removed;
}

/**
 * Get a text summary of all active/stalled progress.
 */
export function getProgressSummary(): string {
  const active = listProgress({ status: "active" });
  const stalled = listProgress({ status: "stalled" });
  const blocked = listProgress({ status: "blocked" });

  if (active.length === 0 && stalled.length === 0 && blocked.length === 0) {
    return "无活跃任务";
  }

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(`📋 活跃任务 (${active.length}):`);
    for (const r of active.slice(0, 10)) {
      const lastUpdate = r.updates[0]?.message ?? "无更新";
      lines.push(`  • [${r.agentId}] ${r.title} — ${lastUpdate}`);
    }
  }

  if (stalled.length > 0) {
    lines.push(`⚠️ 停滞任务 (${stalled.length}):`);
    for (const r of stalled.slice(0, 5)) {
      lines.push(`  • [${r.agentId}] ${r.title} — 最后更新: ${r.updatedAt.slice(0, 10)}`);
    }
  }

  if (blocked.length > 0) {
    lines.push(`🚫 阻塞任务 (${blocked.length}):`);
    for (const r of blocked.slice(0, 5)) {
      lines.push(`  • [${r.agentId}] ${r.title}`);
    }
  }

  return lines.join("\n");
}
