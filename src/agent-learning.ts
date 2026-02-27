/**
 * Agent Learning System
 *
 * Tracks quality feedback for each SubAgent.
 * - Good rating → save session sample, boost score
 * - Bad rating  → penalize score, auto-archive if quality drops below threshold
 * - Good samples are saved to agents/{agentId}/samples/ so we can learn what works
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agents/ is at repo root: ../../agents/ relative to src/
const AGENTS_DIR = join(__dirname, "../../agents");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentLearning {
  agentId: string;
  totalUses: number;
  goodRatings: number;
  badRatings: number;
  /** 0.0–1.0 weighted quality score */
  qualityScore: number;
  lastUsed: string | null;
  lastRated: string | null;
  /** Filenames of saved good sample files (capped at 50) */
  goodSamples: string[];
  archived: boolean;
}

export interface SessionRecord {
  requestId: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  inputText: string;
  outputText: string;
  timestamp: string;
}

// ─── In-memory session cache ──────────────────────────────────────────────────
// Keeps last 200 requests for feedback correlation.
// Key = requestId (UUID per request)

const sessionCache = new Map<string, SessionRecord>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLearningPath(agentId: string): string {
  return join(AGENTS_DIR, agentId, "learning.json");
}

function loadLearning(agentId: string): AgentLearning {
  const path = getLearningPath(agentId);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {}
  }
  return {
    agentId,
    totalUses: 0,
    goodRatings: 0,
    badRatings: 0,
    qualityScore: 1.0,
    lastUsed: null,
    lastRated: null,
    goodSamples: [],
    archived: false,
  };
}

function saveLearning(data: AgentLearning): void {
  const dir = join(AGENTS_DIR, data.agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getLearningPath(data.agentId), JSON.stringify(data, null, 2));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record that an agent handled a request.
 * Call immediately after getting an AgentSquad response.
 * Returns the requestId so you can embed it in the response footer.
 */
export function recordAgentUse(record: SessionRecord): void {
  // Evict oldest if cache is full
  if (sessionCache.size >= 200) {
    const oldest = sessionCache.keys().next().value;
    if (oldest) sessionCache.delete(oldest);
  }
  sessionCache.set(record.requestId, record);

  const learning = loadLearning(record.agentId);
  learning.totalUses++;
  learning.lastUsed = record.timestamp;
  saveLearning(learning);

  console.log(
    `[learning] use recorded: agent=${record.agentId} requestId=${record.requestId}`
  );
}

/**
 * Process user quality feedback for a specific requestId.
 *
 * rating="good": save the session as a sample, improve score
 * rating="bad":  penalize score, auto-archive if threshold crossed
 */
export function rateRequest(
  requestId: string,
  rating: "good" | "bad",
  comment?: string
): {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  qualityScore?: number;
  archived?: boolean;
  message: string;
} {
  const record = sessionCache.get(requestId);
  if (!record) {
    return {
      ok: false,
      message: `Request ID "${requestId}" not found in cache. It may have expired or the server restarted.`,
    };
  }

  const { agentId, agentName } = record;
  const learning = loadLearning(agentId);
  learning.lastRated = new Date().toISOString();

  if (rating === "good") {
    learning.goodRatings++;
    saveGoodSample(record, comment);
  } else {
    learning.badRatings++;
  }

  // Recalculate quality score (simple ratio)
  const total = learning.goodRatings + learning.badRatings;
  learning.qualityScore = total > 0 ? learning.goodRatings / total : 1.0;

  saveLearning(learning);

  // Auto-archive: ≥3 bad ratings AND quality score < 0.3
  let archived = false;
  if (!learning.archived && learning.badRatings >= 3 && learning.qualityScore < 0.3) {
    archiveAgent(agentId, learning.qualityScore, total);
    learning.archived = true;
    saveLearning(learning);
    archived = true;
  }

  const scoreStr = (learning.qualityScore * 100).toFixed(0) + "%";
  return {
    ok: true,
    agentId,
    agentName,
    qualityScore: learning.qualityScore,
    archived,
    message: archived
      ? `Agent "${agentName}" auto-archived (quality: ${scoreStr} after ${total} ratings)`
      : `Rated "${rating}" for agent "${agentName}" — quality: ${scoreStr} (${learning.goodRatings}👍 ${learning.badRatings}👎)`,
  };
}

/**
 * Save a "good" session as a learning sample.
 * Stored in agents/{agentId}/samples/YYYY-MM-DD_{short-requestId}.json
 */
function saveGoodSample(record: SessionRecord, comment?: string): void {
  const sampleDir = join(AGENTS_DIR, record.agentId, "samples");
  if (!existsSync(sampleDir)) mkdirSync(sampleDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const shortId = record.requestId.slice(0, 8);
  const filename = `${date}_${shortId}.json`;
  const samplePath = join(sampleDir, filename);

  const sample = {
    agentId: record.agentId,
    agentName: record.agentName,
    requestId: record.requestId,
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    ratedAt: new Date().toISOString(),
    comment: comment ?? null,
    input: record.inputText,
    output: record.outputText,
  };

  writeFileSync(samplePath, JSON.stringify(sample, null, 2));

  // Update goodSamples list in learning.json
  const learning = loadLearning(record.agentId);
  learning.goodSamples.push(filename);
  if (learning.goodSamples.length > 50) {
    learning.goodSamples = learning.goodSamples.slice(-50);
  }
  saveLearning(learning);

  console.log(`[learning] Good sample saved: agents/${record.agentId}/samples/${filename}`);
}

/**
 * Mark an agent as archived by updating its SKILL.md status field.
 * The agent will not be loaded on next startup.
 */
function archiveAgent(agentId: string, score: number, totalRatings: number): void {
  const skillPath = join(AGENTS_DIR, agentId, "SKILL.md");
  if (!existsSync(skillPath)) {
    console.warn(`[learning] Cannot archive ${agentId}: SKILL.md not found`);
    return;
  }

  const content = readFileSync(skillPath, "utf-8");
  const reason = `auto-archived: quality ${(score * 100).toFixed(0)}% after ${totalRatings} ratings`;
  // Replace the status line in frontmatter
  const updated = content.replace(
    /^status:\s*"?active"?/m,
    `status: "archived"  # ${reason}`
  );
  writeFileSync(skillPath, updated);
  console.warn(`[learning] Agent "${agentId}" archived: ${reason}`);
}

/**
 * Return learning stats for all agents that have a learning.json.
 * Sorted by quality score (best first).
 */
export function getAllAgentStats(): AgentLearning[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const stats: AgentLearning[] = [];

  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const lp = getLearningPath(entry.name);
    if (existsSync(lp)) {
      try {
        stats.push(JSON.parse(readFileSync(lp, "utf-8")));
      } catch {}
    }
  }

  return stats.sort((a, b) => b.qualityScore - a.qualityScore);
}

/**
 * List good sample filenames for a given agent.
 */
export function listGoodSamples(agentId: string): string[] {
  const sampleDir = join(AGENTS_DIR, agentId, "samples");
  if (!existsSync(sampleDir)) return [];
  return readdirSync(sampleDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse(); // newest first
}

/**
 * Read a specific good sample file.
 */
export function readGoodSample(agentId: string, filename: string): object | null {
  const samplePath = join(AGENTS_DIR, agentId, "samples", filename);
  if (!existsSync(samplePath)) return null;
  try {
    return JSON.parse(readFileSync(samplePath, "utf-8"));
  } catch {
    return null;
  }
}
