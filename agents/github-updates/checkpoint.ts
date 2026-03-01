/**
 * Checkpoint Manager — 原子提交 + 快照管理
 *
 * 每完成一个开发步骤，创建一个 checkpoint：
 * 1. git add + commit (语义化 message)
 * 2. 记录到 checkpoints.json
 * 3. 可选 push 到远程
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, "config");
const CHECKPOINTS_FILE = join(CONFIG_DIR, "checkpoints.json");

export interface Checkpoint {
  id: string;
  timestamp: string;
  commit: string;
  branch: string;
  summary: string;
  filesChanged: string[];
  health: "pass" | "fail" | "unknown";
  rollbackSafe: boolean;
}

interface CheckpointStore {
  checkpoints: Checkpoint[];
  lastId: number;
}

function loadStore(): CheckpointStore {
  if (!existsSync(CHECKPOINTS_FILE)) {
    return { checkpoints: [], lastId: 0 };
  }
  return JSON.parse(readFileSync(CHECKPOINTS_FILE, "utf-8"));
}

function saveStore(store: CheckpointStore): void {
  writeFileSync(CHECKPOINTS_FILE, JSON.stringify(store, null, 2));
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd: process.cwd() }).trim();
}

/**
 * Get current git status — changed files
 */
export function getStatus(): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged = exec("git diff --cached --name-only").split("\n").filter(Boolean);
  const unstaged = exec("git diff --name-only").split("\n").filter(Boolean);
  const untracked = exec("git ls-files --others --exclude-standard").split("\n").filter(Boolean);
  return { staged, unstaged, untracked };
}

/**
 * Create a new checkpoint — atomic commit + record
 */
export function createCheckpoint(
  summary: string,
  options: {
    files?: string[];      // specific files to add (default: all changed)
    commitType?: string;   // feat | fix | refactor | docs | chore
    push?: boolean;        // push to remote after commit
  } = {}
): Checkpoint {
  const { files, commitType = "feat", push = true } = options;

  // Stage files
  if (files && files.length > 0) {
    for (const f of files) {
      exec(`git add "${f}"`);
    }
  } else {
    exec("git add -A");
  }

  // Check if there's anything to commit
  const diff = exec("git diff --cached --name-only");
  if (!diff) {
    throw new Error("Nothing to commit — working tree is clean");
  }

  const filesChanged = diff.split("\n").filter(Boolean);
  const branch = exec("git branch --show-current");

  // Commit
  const commitMsg = `${commitType}: ${summary}`;
  exec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
  const commit = exec("git rev-parse --short HEAD");

  // Optional push
  if (push) {
    try {
      exec(`git push origin ${branch}`);
    } catch (e: any) {
      console.warn(`[Checkpoint] Push failed: ${e.message}`);
    }
  }

  // Record checkpoint
  const store = loadStore();
  store.lastId += 1;
  const checkpoint: Checkpoint = {
    id: `cp-${String(store.lastId).padStart(3, "0")}`,
    timestamp: new Date().toISOString(),
    commit,
    branch,
    summary,
    filesChanged,
    health: "unknown",
    rollbackSafe: true,
  };
  store.checkpoints.push(checkpoint);
  saveStore(store);

  console.log(`[Checkpoint] Created ${checkpoint.id} @ ${commit}: ${summary}`);
  return checkpoint;
}

/**
 * List recent checkpoints
 */
export function listCheckpoints(limit = 10): Checkpoint[] {
  const store = loadStore();
  return store.checkpoints.slice(-limit);
}

/**
 * Get checkpoint by ID
 */
export function getCheckpoint(id: string): Checkpoint | undefined {
  const store = loadStore();
  return store.checkpoints.find((cp) => cp.id === id);
}

/**
 * Mark a checkpoint's health status
 */
export function markHealth(id: string, health: "pass" | "fail"): void {
  const store = loadStore();
  const cp = store.checkpoints.find((c) => c.id === id);
  if (cp) {
    cp.health = health;
    cp.rollbackSafe = health === "pass";
    saveStore(store);
  }
}

/**
 * Get the latest checkpoint with health=pass
 */
export function getLastSafeCheckpoint(): Checkpoint | undefined {
  const store = loadStore();
  return [...store.checkpoints].reverse().find((cp) => cp.rollbackSafe);
}
