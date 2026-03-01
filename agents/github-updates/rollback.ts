/**
 * Rollback Manager — 版本回滚
 *
 * 支持三种模式：
 * 1. 回滚到上一个 checkpoint
 * 2. 回滚到指定 checkpoint ID
 * 3. 选择性回滚（只回滚特定文件）
 */

import { execSync } from "child_process";
import { getCheckpoint, getLastSafeCheckpoint, listCheckpoints, type Checkpoint } from "./checkpoint.js";
import { runHealthCheck, type HealthResult } from "./health-check.js";

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd: process.cwd() }).trim();
}

export interface RollbackResult {
  success: boolean;
  fromCommit: string;
  toCommit: string;
  checkpoint: Checkpoint;
  healthAfter: HealthResult;
  message: string;
}

/**
 * Roll back to a specific checkpoint
 */
export function rollbackTo(targetId?: string): RollbackResult {
  const currentCommit = exec("git rev-parse --short HEAD");

  // Find target checkpoint
  let target: Checkpoint | undefined;
  if (targetId) {
    target = getCheckpoint(targetId);
    if (!target) {
      throw new Error(`Checkpoint ${targetId} not found`);
    }
  } else {
    // Default: roll back to last safe checkpoint (skip the current one)
    target = getLastSafeCheckpoint();
    if (!target) {
      throw new Error("No safe checkpoint found to roll back to");
    }
  }

  // Safety: stash any uncommitted work
  const hasUncommitted = exec("git status --porcelain");
  if (hasUncommitted) {
    exec('git stash push -m "auto-stash before rollback to ' + target.id + '"');
    console.log("[Rollback] Stashed uncommitted changes");
  }

  // Perform rollback via revert (safe, non-destructive)
  try {
    // Find commits between target and HEAD, revert them in reverse order
    const commits = exec(`git log --oneline ${target.commit}..HEAD --format=%H`).split("\n").filter(Boolean);

    if (commits.length === 0) {
      throw new Error(`Already at or before checkpoint ${target.id}`);
    }

    // Revert each commit from newest to oldest
    for (const commitHash of commits) {
      exec(`git revert --no-commit ${commitHash}`);
    }
    exec(`git commit -m "rollback: revert to checkpoint ${target.id} (${target.summary})"`);

    console.log(`[Rollback] Reverted ${commits.length} commits to reach ${target.id}`);
  } catch (e: any) {
    // If revert fails, abort and restore
    try { exec("git revert --abort"); } catch {}
    if (hasUncommitted) {
      try { exec("git stash pop"); } catch {}
    }
    throw new Error(`Rollback failed: ${e.message}`);
  }

  // Run health check after rollback
  const healthAfter = runHealthCheck();
  const newCommit = exec("git rev-parse --short HEAD");

  // Auto-push rollback to GitHub
  const branch = exec("git branch --show-current");
  try {
    exec(`git push origin ${branch}`);
    console.log(`[Rollback] Pushed rollback to origin/${branch}`);
  } catch (pushErr: any) {
    console.warn(`[Rollback] Push failed (rollback is local only): ${pushErr.message}`);
  }

  return {
    success: healthAfter.overall === "pass",
    fromCommit: currentCommit,
    toCommit: newCommit,
    checkpoint: target,
    healthAfter,
    message: healthAfter.overall === "pass"
      ? `Successfully rolled back to ${target.id}`
      : `Rolled back to ${target.id} but health check failed — may need manual intervention`,
  };
}

/**
 * Selective rollback — restore specific files from a checkpoint
 */
export function rollbackFiles(files: string[], targetId?: string): {
  success: boolean;
  files: string[];
  checkpoint: Checkpoint;
  message: string;
} {
  let target: Checkpoint | undefined;
  if (targetId) {
    target = getCheckpoint(targetId);
    if (!target) throw new Error(`Checkpoint ${targetId} not found`);
  } else {
    target = getLastSafeCheckpoint();
    if (!target) throw new Error("No safe checkpoint found");
  }

  // Checkout specific files from the target commit
  for (const file of files) {
    try {
      exec(`git checkout ${target.commit} -- "${file}"`);
    } catch (e: any) {
      console.warn(`[Rollback] Could not restore ${file}: ${e.message}`);
    }
  }

  // Commit the selective rollback
  const restoredFiles = files.filter((f) => {
    const status = exec("git status --porcelain").includes(f);
    return status;
  });

  if (restoredFiles.length > 0) {
    exec("git add -A");
    exec(`git commit -m "rollback: restore ${restoredFiles.length} file(s) from ${target.id}"`);

    // Auto-push selective rollback
    const branch = exec("git branch --show-current");
    try {
      exec(`git push origin ${branch}`);
      console.log(`[Rollback] Pushed selective rollback to origin/${branch}`);
    } catch (pushErr: any) {
      console.warn(`[Rollback] Push failed: ${pushErr.message}`);
    }
  }

  return {
    success: true,
    files: restoredFiles,
    checkpoint: target,
    message: `Restored ${restoredFiles.length} file(s) from checkpoint ${target.id}`,
  };
}

/**
 * Show rollback preview — what would change
 */
export function rollbackPreview(targetId?: string): {
  checkpoint: Checkpoint;
  commitsToRevert: number;
  filesAffected: string[];
} {
  let target: Checkpoint | undefined;
  if (targetId) {
    target = getCheckpoint(targetId);
  } else {
    target = getLastSafeCheckpoint();
  }
  if (!target) throw new Error("No target checkpoint found");

  const commits = exec(`git log --oneline ${target.commit}..HEAD`).split("\n").filter(Boolean);
  const files = exec(`git diff --name-only ${target.commit}..HEAD`).split("\n").filter(Boolean);

  return {
    checkpoint: target,
    commitsToRevert: commits.length,
    filesAffected: files,
  };
}
