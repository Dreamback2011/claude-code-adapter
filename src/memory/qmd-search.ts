/**
 * QMD Search — Semantic & BM25 search via the QMD CLI
 *
 * Wraps the local QMD binary (/opt/homebrew/bin/qmd) for:
 *   - Vector semantic search (vsearch)
 *   - BM25 keyword search (search)
 *   - Collection management and memory item sync
 *
 * Memory items (JSON) are synced to .md files in memory/qmd-docs/
 * so QMD can index and search them.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MemoryItem } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const execFileRaw = promisify(execFileCb);

/** execFile with a 30-second timeout to prevent hangs */
const QMD_TIMEOUT_MS = 30_000;
function execFile(bin: string, args: string[]) {
  return execFileRaw(bin, args, { timeout: QMD_TIMEOUT_MS, encoding: "utf-8" });
}

// ─── Constants ───────────────────────────────────────────────────────────────

const QMD_BIN = "/opt/homebrew/bin/qmd";
const QMD_CONFIG = join(
  process.env.HOME || "/Users/dreamback",
  ".config/qmd/index.yml",
);
const COLLECTION_NAME = "agent-memory";
const QMD_DOCS_DIR = join(__dirname, "../../memory/qmd-docs");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QmdSearchResult {
  docid: string;
  score: number;
  file: string;
  title: string;
  snippet: string;
  /** Memory ID extracted from the .md filename */
  memoryId?: string;
}

/** Raw JSON entry returned by QMD CLI */
interface QmdRawEntry {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
}

// ─── 1. Check if QMD binary is available ─────────────────────────────────────

export function isQmdAvailable(): boolean {
  return existsSync(QMD_BIN);
}

// ─── 2. Initialize QMD collection ────────────────────────────────────────────

/**
 * Set up the QMD collection for memory items.
 * - Creates memory/qmd-docs/ directory if missing
 * - Registers the "agent-memory" collection with QMD (if not already registered)
 */
export async function initQmdCollection(): Promise<boolean> {
  if (!isQmdAvailable()) {
    console.warn("[qmd-search] QMD binary not found, skipping init");
    return false;
  }

  // Ensure docs directory exists
  if (!existsSync(QMD_DOCS_DIR)) {
    mkdirSync(QMD_DOCS_DIR, { recursive: true });
    console.log(`[qmd-search] Created ${QMD_DOCS_DIR}`);
  }

  // Check if collection already registered
  if (isCollectionRegistered()) {
    console.log("[qmd-search] Collection already registered");
    return true;
  }

  // Register collection
  try {
    await execFile(QMD_BIN, [
      "collection",
      "add",
      QMD_DOCS_DIR,
      "--name",
      COLLECTION_NAME,
    ]);
    console.log(`[qmd-search] Registered collection "${COLLECTION_NAME}"`);
    return true;
  } catch (err: any) {
    console.warn(`[qmd-search] Failed to register collection:`, err.message);
    return false;
  }
}

/**
 * Check if the agent-memory collection is already in QMD config.
 */
function isCollectionRegistered(): boolean {
  try {
    if (!existsSync(QMD_CONFIG)) return false;
    const content = readFileSync(QMD_CONFIG, "utf-8");
    return content.includes(`${COLLECTION_NAME}:`);
  } catch {
    return false;
  }
}

// ─── 3. Sync a single memory item to .md ─────────────────────────────────────

/**
 * Write a memory item as a Markdown file in qmd-docs/.
 * Format: frontmatter-like header + content body.
 */
export function syncItemToQmd(item: MemoryItem): void {
  if (!existsSync(QMD_DOCS_DIR)) {
    mkdirSync(QMD_DOCS_DIR, { recursive: true });
  }

  const mdContent = [
    `# ${item.title}`,
    "",
    `Category: ${item.category}`,
    `Tags: ${item.tags.join(", ")}`,
    `Source: ${item.source}`,
    "",
    item.content,
  ].join("\n");

  const filePath = join(QMD_DOCS_DIR, `${item.id}.md`);
  writeFileSync(filePath, mdContent, "utf-8");
}

// ─── 4. Remove a memory item's .md file ──────────────────────────────────────

export function removeItemFromQmd(id: string): void {
  const filePath = join(QMD_DOCS_DIR, `${id}.md`);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err: any) {
    console.warn(`[qmd-search] Failed to remove ${id}.md:`, err.message);
  }
}

// ─── 5. Schedule QMD reindex (debounced) ─────────────────────────────────────

let reindexTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run `qmd update` + `qmd embed` after a 5-second debounce.
 * Multiple calls within 5 seconds collapse into one reindex.
 */
export function scheduleQmdReindex(): void {
  if (!isQmdAvailable()) return;

  if (reindexTimer) {
    clearTimeout(reindexTimer);
  }

  reindexTimer = setTimeout(async () => {
    reindexTimer = null;
    try {
      await execFile(QMD_BIN, ["update"]);
      await execFile(QMD_BIN, ["embed"]);
      console.log("[qmd-search] Reindex complete (update + embed)");
    } catch (err: any) {
      console.warn("[qmd-search] Reindex failed:", err.message);
    }
  }, 5000);
}

// ─── 6. Semantic vector search ───────────────────────────────────────────────

export async function qmdVsearch(
  query: string,
  limit: number = 5,
): Promise<QmdSearchResult[]> {
  return runQmdSearch("vsearch", query, limit);
}

// ─── 7. BM25 keyword search ─────────────────────────────────────────────────

export async function qmdBm25Search(
  query: string,
  limit: number = 5,
): Promise<QmdSearchResult[]> {
  return runQmdSearch("search", query, limit);
}

// ─── 8. Full sync ────────────────────────────────────────────────────────────

/**
 * Write all memory items as .md files, then trigger reindex.
 */
export async function fullSync(items: MemoryItem[]): Promise<void> {
  if (!isQmdAvailable()) {
    console.warn("[qmd-search] QMD not available, skipping full sync");
    return;
  }

  // Ensure collection is set up
  await initQmdCollection();

  // Sync all items
  for (const item of items) {
    syncItemToQmd(item);
  }

  console.log(`[qmd-search] Synced ${items.length} items to qmd-docs/`);

  // Reindex immediately (no debounce for full sync)
  try {
    await execFile(QMD_BIN, ["update"]);
    await execFile(QMD_BIN, ["embed"]);
    console.log("[qmd-search] Full sync reindex complete");
  } catch (err: any) {
    console.warn("[qmd-search] Full sync reindex failed:", err.message);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Run a QMD search command (vsearch or search) and parse JSON output.
 */
async function runQmdSearch(
  command: "vsearch" | "search",
  query: string,
  limit: number,
): Promise<QmdSearchResult[]> {
  if (!isQmdAvailable()) {
    return [];
  }

  try {
    const { stdout } = await execFile(QMD_BIN, [
      command,
      query,
      "--json",
      "-n",
      String(limit),
      "-c",
      COLLECTION_NAME,
    ]);

    const raw = JSON.parse(stdout);

    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.map((r: QmdRawEntry) => ({
      docid: r.docid ?? "",
      score: r.score ?? 0,
      file: r.file ?? "",
      title: r.title ?? "",
      snippet: r.snippet ?? "",
      memoryId: extractMemoryId(r.file ?? ""),
    }));
  } catch (err: any) {
    console.warn(`[qmd-search] ${command} failed:`, err.message);
    return [];
  }
}

/**
 * Extract memory ID from a filename like "/path/to/mem_abc123.md"
 */
function extractMemoryId(filePath: string): string | undefined {
  const match = filePath.match(/([^/]+)\.md$/);
  if (match) {
    return match[1];
  }
  return undefined;
}
