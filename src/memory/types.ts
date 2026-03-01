/**
 * Memory Agent — Core Types
 *
 * Central type definitions for the memory system:
 * - Permission tiers (T0–T3)
 * - Caller identity (user / external / system)
 * - Memory items, queries, and progress records
 */

// ─── Permission Tiers ─────────────────────────────────────────────────────────

export enum PermissionTier {
  /** Public: any agent, any caller */
  T0_PUBLIC = 0,
  /** Internal: any agent, user-triggered only */
  T1_INTERNAL = 1,
  /** Sensitive: specified agents, needs user confirmation */
  T2_SENSITIVE = 2,
  /** Restricted: never stored — handled by 1Password */
  T3_RESTRICTED = 3,
}

// ─── Caller Identity ──────────────────────────────────────────────────────────

export enum CallerIdentity {
  /** Alex (owner) — T0-T2 access, T2 requires confirmation */
  USER = "user",
  /** External clients (via customer-facing agents) — T0 only */
  EXTERNAL = "external",
  /** Automated / cron / system tasks — T0-T1 */
  SYSTEM = "system",
}

// ─── Memory Items ─────────────────────────────────────────────────────────────

export type MemoryCategory =
  | "context"   // General facts, preferences, knowledge
  | "progress"  // Task / project status
  | "daily"     // Daily notes, observations, mixed content
  | "learning"  // Quality feedback, good samples, metrics snapshots
  | "agent"     // Agent-specific config or state

export interface MemoryItem {
  id: string;
  tier: PermissionTier;
  category: MemoryCategory;
  tags: string[];
  /** Which agent or source created this memory */
  source: string;
  /** Short title for display / search */
  title: string;
  /** The actual memory content */
  content: string;
  createdAt: string;
  updatedAt: string;
  /** Optional expiration (ISO timestamp). Null = permanent */
  expiresAt: string | null;
}

export interface CreateMemoryInput {
  tier?: PermissionTier;
  category: MemoryCategory;
  tags?: string[];
  source: string;
  title: string;
  content: string;
  expiresAt?: string | null;
}

export interface MemoryQuery {
  /** Filter by category */
  category?: MemoryCategory;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by source agent */
  source?: string;
  /** Full-text search in title + content */
  search?: string;
  /** Max results (default 20) */
  limit?: number;
}

// ─── Progress Records ─────────────────────────────────────────────────────────

export type ProgressStatus =
  | "active"      // In progress
  | "completed"   // Done
  | "stalled"     // No updates for >48h
  | "blocked"     // Waiting on external dependency
  | "cancelled"

export interface ProgressRecord {
  id: string;
  /** What agent is working on this */
  agentId: string;
  /** Short description of the task */
  title: string;
  /** Current status */
  status: ProgressStatus;
  /** Status updates (newest first) */
  updates: ProgressUpdate[];
  createdAt: string;
  updatedAt: string;
}

export interface ProgressUpdate {
  timestamp: string;
  agentId: string;
  message: string;
  /** Optional: link to related memory item */
  relatedMemoryId?: string;
}

// ─── Context Enrichment ───────────────────────────────────────────────────────

export interface EnrichmentResult {
  /** Relevant memories to prepend to agent context */
  memories: MemoryItem[];
  /** Active progress items for this agent */
  activeProgress: ProgressRecord[];
  /** Was any content filtered by permission? */
  filtered: boolean;
}

// ─── Agent Report (post-execution) ────────────────────────────────────────────

export interface AgentReport {
  requestId: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  inputText: string;
  outputText: string;
  /** Extracted key facts / decisions / outcomes (optional) */
  keyFacts?: string[];
  /** Progress update (optional) */
  progressUpdate?: {
    progressId: string;
    message: string;
  };
  timestamp: string;
  latencyMs: number;
  costUsd?: number;
}
