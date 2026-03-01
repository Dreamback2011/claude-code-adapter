/**
 * Identity Resolver — Determines who is making the request
 *
 * Rules:
 * - USER (Alex): Direct messages, Discord owner channels, known user IDs
 * - EXTERNAL: Customer-facing agent channels, unknown senders
 * - SYSTEM: Cron jobs, webhooks, automated tasks
 *
 * Identity determines the maximum permission tier accessible.
 */

import { CallerIdentity, PermissionTier } from "./types.js";

// ─── Known Identifiers ───────────────────────────────────────────────────────

/** Alex's Discord user ID */
const OWNER_USER_IDS = new Set([
  "181605247330811905",
]);

/** Agents that serve external clients (restrict to T0) */
const EXTERNAL_FACING_AGENTS = new Set([
  "telegram",
  "wecom",
]);

/** System / automated session patterns */
const SYSTEM_SESSION_PATTERNS = [
  /^cron-/,
  /^webhook-/,
  /^system-/,
  /^eval-/,
];

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface CallerContext {
  /** Session ID from the request */
  sessionId: string;
  /** User ID if available (from metadata or Discord) */
  userId?: string;
  /** Agent ID handling the request */
  agentId?: string;
  /** Whether this is an async/automated request */
  isAsync?: boolean;
}

export interface ResolvedIdentity {
  identity: CallerIdentity;
  /** Maximum tier this identity can access */
  maxTier: PermissionTier;
  /** Human-readable reason for the resolution */
  reason: string;
}

/**
 * Resolve the caller's identity from request context.
 */
export function resolveIdentity(ctx: CallerContext): ResolvedIdentity {
  // System: cron, webhook, automated tasks
  if (ctx.isAsync) {
    return {
      identity: CallerIdentity.SYSTEM,
      maxTier: PermissionTier.T1_INTERNAL,
      reason: "async/automated task",
    };
  }

  for (const pattern of SYSTEM_SESSION_PATTERNS) {
    if (pattern.test(ctx.sessionId)) {
      return {
        identity: CallerIdentity.SYSTEM,
        maxTier: PermissionTier.T1_INTERNAL,
        reason: `system session: ${ctx.sessionId}`,
      };
    }
  }

  // External: customer-facing agents or unknown users
  if (ctx.agentId && EXTERNAL_FACING_AGENTS.has(ctx.agentId)) {
    // Even if the owner is using a customer-facing agent, treat as external
    // (safer default — owner can override via direct channel)
    if (ctx.userId && OWNER_USER_IDS.has(ctx.userId)) {
      return {
        identity: CallerIdentity.USER,
        maxTier: PermissionTier.T2_SENSITIVE,
        reason: "owner via customer-facing agent",
      };
    }
    return {
      identity: CallerIdentity.EXTERNAL,
      maxTier: PermissionTier.T0_PUBLIC,
      reason: `external-facing agent: ${ctx.agentId}`,
    };
  }

  // User: known owner IDs
  if (ctx.userId && OWNER_USER_IDS.has(ctx.userId)) {
    return {
      identity: CallerIdentity.USER,
      maxTier: PermissionTier.T2_SENSITIVE,
      reason: "owner user ID",
    };
  }

  // Default: treat as user for personal system
  // (since this is a personal system, most requests come from the owner)
  return {
    identity: CallerIdentity.USER,
    maxTier: PermissionTier.T1_INTERNAL,
    reason: "default (personal system)",
  };
}

/**
 * Quick check: can this identity access this tier?
 */
export function canAccess(identity: ResolvedIdentity, tier: PermissionTier): boolean {
  return tier <= identity.maxTier;
}
