/**
 * Memory Store — File-based storage / retrieval / cleanup
 *
 * Storage layout:
 *   memory/items/{id}.json     — Individual memory items
 *   memory/index.json          — Lightweight index for fast search
 *
 * Operations:
 *   create / read / update / delete / search / cleanup (expired items)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MemoryItem, CreateMemoryInput, MemoryQuery, MemoryCategory } from "./types.js";
import { PermissionTier } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, "../../memory");
const ITEMS_DIR = join(MEMORY_DIR, "items");
const INDEX_PATH = join(MEMORY_DIR, "index.json");

// ─── Index ────────────────────────────────────────────────────────────────────

interface IndexEntry {
  id: string;
  tier: PermissionTier;
  category: MemoryCategory;
  tags: string[];
  source: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

let memoryIndex: IndexEntry[] = [];

function loadIndex(): void {
  if (existsSync(INDEX_PATH)) {
    try {
      memoryIndex = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
      return;
    } catch {}
  }
  memoryIndex = [];
}

function saveIndex(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(memoryIndex, null, 2));
}

function itemPath(id: string): string {
  return join(ITEMS_DIR, `${id}.json`);
}

// Initialize on import
loadIndex();

// ─── ID Generation ────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const seq = (idCounter++).toString(36);
  return `mem_${ts}_${rand}${seq}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createMemory(input: CreateMemoryInput): MemoryItem {
  if (!existsSync(ITEMS_DIR)) mkdirSync(ITEMS_DIR, { recursive: true });

  const now = new Date().toISOString();
  const item: MemoryItem = {
    id: generateId(),
    tier: input.tier ?? PermissionTier.T1_INTERNAL,
    category: input.category,
    tags: input.tags ?? [],
    source: input.source,
    title: input.title,
    content: input.content,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt ?? null,
  };

  // Write item file
  writeFileSync(itemPath(item.id), JSON.stringify(item, null, 2));

  // Update index
  memoryIndex.push({
    id: item.id,
    tier: item.tier,
    category: item.category,
    tags: item.tags,
    source: item.source,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
  });
  saveIndex();

  console.log(`[memory] Created: ${item.id} — "${item.title}" (${item.category}, T${item.tier})`);
  return item;
}

export function getMemory(id: string): MemoryItem | null {
  const path = itemPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function updateMemory(id: string, updates: Partial<Pick<MemoryItem, "title" | "content" | "tags" | "tier" | "category" | "expiresAt">>): MemoryItem | null {
  const item = getMemory(id);
  if (!item) return null;

  const updated: MemoryItem = {
    ...item,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(itemPath(id), JSON.stringify(updated, null, 2));

  // Update index entry
  const idx = memoryIndex.findIndex((e) => e.id === id);
  if (idx !== -1) {
    memoryIndex[idx] = {
      id: updated.id,
      tier: updated.tier,
      category: updated.category,
      tags: updated.tags,
      source: updated.source,
      title: updated.title,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      expiresAt: updated.expiresAt,
    };
    saveIndex();
  }

  console.log(`[memory] Updated: ${id} — "${updated.title}"`);
  return updated;
}

export function deleteMemory(id: string): boolean {
  const path = itemPath(id);
  if (!existsSync(path)) return false;

  try {
    unlinkSync(path);
  } catch {
    return false;
  }

  memoryIndex = memoryIndex.filter((e) => e.id !== id);
  saveIndex();

  console.log(`[memory] Deleted: ${id}`);
  return true;
}

// ─── Search / Query ───────────────────────────────────────────────────────────

/**
 * Search memories using the index for fast filtering.
 * Only loads full items for matches that pass the filter.
 *
 * @param query  Filter criteria
 * @param maxTier  Maximum permission tier to include (for permission gating)
 */
export function searchMemories(query: MemoryQuery, maxTier: PermissionTier = PermissionTier.T2_SENSITIVE): MemoryItem[] {
  const limit = query.limit ?? 20;
  const now = new Date().toISOString();

  // Filter the index
  let candidates = memoryIndex.filter((entry) => {
    // Permission filter
    if (entry.tier > maxTier) return false;

    // Expired filter
    if (entry.expiresAt && entry.expiresAt < now) return false;

    // Category filter
    if (query.category && entry.category !== query.category) return false;

    // Source filter
    if (query.source && entry.source !== query.source) return false;

    // Tag filter (any match)
    if (query.tags && query.tags.length > 0) {
      const hasMatch = query.tags.some((t) => entry.tags.includes(t));
      if (!hasMatch) return false;
    }

    // Text search in title (index-level)
    if (query.search) {
      const searchLower = query.search.toLowerCase();
      if (!entry.title.toLowerCase().includes(searchLower)) {
        // Need to check content — defer to full item load
        return true; // keep as candidate, will filter again below
      }
    }

    return true;
  });

  // Sort by updatedAt (newest first)
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Load full items and apply content-level search
  const results: MemoryItem[] = [];
  for (const entry of candidates) {
    if (results.length >= limit) break;

    const item = getMemory(entry.id);
    if (!item) continue;

    // Content-level search filter
    if (query.search) {
      const searchLower = query.search.toLowerCase();
      const matchesTitle = item.title.toLowerCase().includes(searchLower);
      const matchesContent = item.content.toLowerCase().includes(searchLower);
      if (!matchesTitle && !matchesContent) continue;
    }

    results.push(item);
  }

  return results;
}

/**
 * Get all memories by category (respecting permission tier).
 */
export function getMemoriesByCategory(category: MemoryCategory, maxTier: PermissionTier = PermissionTier.T2_SENSITIVE): MemoryItem[] {
  return searchMemories({ category }, maxTier);
}

/**
 * Get memories tagged for a specific agent.
 */
export function getAgentMemories(agentId: string, maxTier: PermissionTier = PermissionTier.T2_SENSITIVE): MemoryItem[] {
  return searchMemories({ tags: [agentId] }, maxTier);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove expired memory items.
 * Returns the count of items removed.
 */
export function cleanupExpired(): number {
  const now = new Date().toISOString();
  const expired = memoryIndex.filter((e) => e.expiresAt && e.expiresAt < now);

  for (const entry of expired) {
    try {
      const path = itemPath(entry.id);
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }

  const removed = expired.length;
  if (removed > 0) {
    memoryIndex = memoryIndex.filter((e) => !expired.some((x) => x.id === e.id));
    saveIndex();
    console.log(`[memory] Cleaned up ${removed} expired items`);
  }

  return removed;
}

/**
 * Get stats about the memory store.
 */
export function getMemoryStats(): {
  total: number;
  byCategory: Record<string, number>;
  byTier: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const byTier: Record<string, number> = {};

  for (const entry of memoryIndex) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    byTier[`T${entry.tier}`] = (byTier[`T${entry.tier}`] ?? 0) + 1;
  }

  return {
    total: memoryIndex.length,
    byCategory,
    byTier,
  };
}

/**
 * Reload index from disk (useful after external changes).
 */
export function reloadIndex(): void {
  loadIndex();
}
