import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(__dirname, "../.sessions.json");

export interface SessionData {
  cliSessionId: string;   // Claude CLI's internal session_id (for --resume)
  externalId: string;      // External identifier (Discord channel, user, etc.)
  createdAt: number;
  lastActivity: number;
  messageCount: number;
}

/**
 * Manages session mappings: external session ID → Claude CLI session ID.
 * Enables multi-turn conversations with --resume across different Discord channels.
 *
 * Features:
 *  - In-memory store with JSON file backup (survives restarts)
 *  - Configurable TTL (default 24 hours)
 *  - Automatic cleanup of expired sessions
 *  - Session stats for monitoring
 */
export class SessionStore {
  private sessions = new Map<string, SessionData>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;
  private saveTimer: ReturnType<typeof setInterval>;

  constructor(ttlHours = 24) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.load();
    // Cleanup expired sessions every hour
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    // Persist to disk every 5 minutes
    this.saveTimer = setInterval(() => this.save(), 5 * 60 * 1000);
  }

  /**
   * Get session by external ID. Returns null if expired or not found.
   */
  get(externalId: string): SessionData | null {
    const session = this.sessions.get(externalId);
    if (!session) return null;
    if (Date.now() - session.lastActivity > this.ttlMs) {
      this.sessions.delete(externalId);
      console.log(`[sessions] Expired: ${externalId}`);
      return null;
    }
    return session;
  }

  /**
   * Create or update a session mapping.
   */
  set(externalId: string, cliSessionId: string): SessionData {
    const existing = this.sessions.get(externalId);
    if (existing) {
      existing.cliSessionId = cliSessionId;
      existing.lastActivity = Date.now();
      existing.messageCount++;
      console.log(`[sessions] Updated: ${externalId} → ${cliSessionId} (${existing.messageCount} msgs)`);
      return existing;
    }
    const session: SessionData = {
      cliSessionId,
      externalId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 1,
    };
    this.sessions.set(externalId, session);
    console.log(`[sessions] New: ${externalId} → ${cliSessionId}`);
    return session;
  }

  /**
   * Touch a session (update lastActivity without changing CLI session).
   */
  touch(externalId: string): void {
    const session = this.sessions.get(externalId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /**
   * Remove a session (e.g., when --resume fails and we need a fresh start).
   */
  remove(externalId: string): void {
    this.sessions.delete(externalId);
    console.log(`[sessions] Removed: ${externalId}`);
  }

  /**
   * Remove expired sessions.
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > this.ttlMs) {
        this.sessions.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[sessions] Cleaned up ${removed} expired sessions`);
      this.save();
    }
  }

  /**
   * Get session stats for monitoring.
   */
  stats(): {
    total: number;
    sessions: Array<{ id: string; cliId: string; messages: number; age: string; idle: string }>;
  } {
    const now = Date.now();
    const list = Array.from(this.sessions.values())
      .filter((s) => now - s.lastActivity <= this.ttlMs)
      .map((s) => ({
        id: s.externalId,
        cliId: s.cliSessionId,
        messages: s.messageCount,
        age: formatDuration(now - s.createdAt),
        idle: formatDuration(now - s.lastActivity),
      }));
    return { total: list.length, sessions: list };
  }

  /**
   * Persist sessions to disk.
   */
  save(): void {
    try {
      const data = Object.fromEntries(this.sessions);
      writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.warn("[sessions] Save failed:", err.message);
    }
  }

  /**
   * Load sessions from disk (filters out expired ones).
   */
  load(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) return;
      const raw = readFileSync(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw) as Record<string, SessionData>;
      const now = Date.now();
      let loaded = 0;
      for (const [key, session] of Object.entries(data)) {
        if (now - session.lastActivity <= this.ttlMs) {
          this.sessions.set(key, session);
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[sessions] Loaded ${loaded} sessions from disk`);
      }
    } catch (err: any) {
      console.warn("[sessions] Load failed:", err.message);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    clearInterval(this.saveTimer);
    this.save();
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
