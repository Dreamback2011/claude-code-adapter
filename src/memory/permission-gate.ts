/**
 * Permission Gate — Controls access to memory items
 *
 * Flow:
 * 1. Resolve caller identity (identity-resolver)
 * 2. Check if the requested tier is accessible
 * 3. Filter query results by maximum allowed tier
 *
 * Tier access rules:
 *   T0 (Public)    → USER, EXTERNAL, SYSTEM
 *   T1 (Internal)  → USER, SYSTEM
 *   T2 (Sensitive)  → USER only (with confirmation for write operations)
 *   T3 (Restricted) → Never stored in system (1Password)
 *
 * Sensitive data categories (auto-classified as T2):
 *   - Health data (WHOOP HRV, SpO2, body metrics)
 *   - Financial info (contract amounts, salary, token allocations)
 *   - Private communications (partner DMs, internal evaluations)
 *   - BD-sensitive (unpublished partnerships, internal assessments)
 */

import { PermissionTier, type MemoryItem } from "./types.js";
import { resolveIdentity, canAccess, type CallerContext, type ResolvedIdentity } from "./identity-resolver.js";

// ─── Sensitive Keywords (auto-T2 detection) ───────────────────────────────────

const SENSITIVE_KEYWORDS = [
  // Health
  "hrv", "spo2", "体脂", "心率", "恢复指数", "whoop", "recovery",
  // Financial
  "salary", "薪资", "合同金额", "token分配", "compensation", "budget",
  // BD Sensitive
  "内部评估", "未公开", "合作意向", "kill filter", "partner eval",
  // Private
  "私密", "confidential", "private",
];

/**
 * Check if content likely contains sensitive material.
 * Used for auto-classifying new memories that don't specify a tier.
 */
export function detectSensitiveTier(title: string, content: string): PermissionTier {
  const combined = `${title} ${content}`.toLowerCase();

  for (const keyword of SENSITIVE_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      return PermissionTier.T2_SENSITIVE;
    }
  }

  return PermissionTier.T1_INTERNAL;
}

// ─── Gate Operations ──────────────────────────────────────────────────────────

export interface GateResult {
  allowed: boolean;
  maxTier: PermissionTier;
  identity: ResolvedIdentity;
  /** Reason if denied */
  reason?: string;
}

/**
 * Check if a caller can access a specific memory item.
 */
export function checkAccess(ctx: CallerContext, item: MemoryItem): GateResult {
  const identity = resolveIdentity(ctx);

  if (canAccess(identity, item.tier)) {
    return { allowed: true, maxTier: identity.maxTier, identity };
  }

  return {
    allowed: false,
    maxTier: identity.maxTier,
    identity,
    reason: `Tier T${item.tier} exceeds max allowed T${identity.maxTier} for ${identity.identity}`,
  };
}

/**
 * Filter a list of memory items by caller's permission level.
 * Returns only items the caller is allowed to see.
 */
export function filterByPermission(ctx: CallerContext, items: MemoryItem[]): {
  allowed: MemoryItem[];
  filtered: number;
  identity: ResolvedIdentity;
} {
  const identity = resolveIdentity(ctx);

  const allowed: MemoryItem[] = [];
  let filtered = 0;

  for (const item of items) {
    if (canAccess(identity, item.tier)) {
      allowed.push(item);
    } else {
      filtered++;
    }
  }

  if (filtered > 0) {
    console.log(`[permission] Filtered ${filtered} items above T${identity.maxTier} for ${identity.identity}`);
  }

  return { allowed, filtered, identity };
}

/**
 * Get the maximum accessible tier for a caller context.
 */
export function getMaxTier(ctx: CallerContext): PermissionTier {
  return resolveIdentity(ctx).maxTier;
}
