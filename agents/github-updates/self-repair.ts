/**
 * Self-Repair — OpenClaw 自修复系统
 *
 * 四级修复策略：
 * Level 1: 诊断 — 读 error log + git diff 定位问题
 * Level 2: 自动修复 — 已知错误模式匹配 → patch
 * Level 3: 回滚 — 自动修复失败 → 回滚到安全 checkpoint
 * Level 4: 求助 — 全部失败 → 生成诊断报告通知用户
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { runQuickHealthCheck, type HealthResult } from "./health-check.js";
import { getLastSafeCheckpoint, markHealth, listCheckpoints } from "./checkpoint.js";
import { rollbackTo } from "./rollback.js";

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: process.cwd(), timeout: 15000 }).trim();
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

/**
 * Push current state to GitHub after any repair action.
 */
function pushToRemote(): void {
  try {
    const branch = exec("git branch --show-current");
    if (!branch.startsWith("ERROR:")) {
      exec(`git push origin ${branch}`);
      console.log(`[SelfRepair] Pushed repair result to origin/${branch}`);
    }
  } catch (e: any) {
    console.warn(`[SelfRepair] Push failed: ${e.message}`);
  }
}

/**
 * Kill stuck claude CLI processes that have been running too long.
 * Returns number of processes killed.
 */
export function killStuckProcesses(maxAgeMinutes = 30): number {
  // Find claude CLI processes older than maxAgeMinutes
  const result = exec(`ps aux | grep '[c]laude.*-p' | awk '{print $2, $10}'`);
  if (result.startsWith("ERROR:") || !result) return 0;

  let killed = 0;
  const lines = result.split("\n").filter(Boolean);
  for (const line of lines) {
    const [pid] = line.split(/\s+/);
    if (!pid) continue;

    // Check process elapsed time
    const elapsed = exec(`ps -o etime= -p ${pid}`);
    if (elapsed.startsWith("ERROR:")) continue;

    // Parse elapsed time (formats: MM:SS, HH:MM:SS, D-HH:MM:SS)
    const parts = elapsed.trim().replace(/-/g, ":").split(":");
    let totalMinutes = 0;
    if (parts.length >= 2) {
      const nums = parts.map(Number);
      if (parts.length === 2) totalMinutes = nums[0];
      else if (parts.length === 3) totalMinutes = nums[0] * 60 + nums[1];
      else totalMinutes = nums[0] * 24 * 60 + nums[1] * 60 + nums[2];
    }

    if (totalMinutes >= maxAgeMinutes) {
      console.log(`[SelfRepair] Killing stuck claude process PID=${pid} (running ${totalMinutes}min)`);
      exec(`kill -9 ${pid}`);
      killed++;
    }
  }

  return killed;
}

/**
 * Known error patterns → fix actions
 */
const KNOWN_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  fix: () => boolean;
}> = [
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND/,
    name: "missing-dependencies",
    fix: () => {
      const result = exec("npm install 2>&1");
      return !result.startsWith("ERROR:");
    },
  },
  {
    pattern: /EADDRINUSE.*3456/,
    name: "port-conflict",
    fix: () => {
      // Kill process on port 3456 and restart
      exec("lsof -ti:3456 | xargs kill -9 2>/dev/null");
      return true;
    },
  },
  {
    pattern: /CLAUDECODE|CLAUDE_CODE_|nested session/i,
    name: "nested-env-vars",
    fix: () => {
      // This is handled at process level, just confirm the env cleanup exists
      const indexContent = existsSync(join(process.cwd(), "src/index.ts"))
        ? readFileSync(join(process.cwd(), "src/index.ts"), "utf-8")
        : "";
      return indexContent.includes("CLAUDECODE") || indexContent.includes("CLAUDE_CODE_");
    },
  },
  {
    pattern: /ENOENT.*\.env/,
    name: "missing-env-file",
    fix: () => {
      if (!existsSync(join(process.cwd(), ".env"))) {
        // Create minimal .env from example if available
        const example = join(process.cwd(), ".env.example");
        if (existsSync(example)) {
          const content = readFileSync(example, "utf-8");
          writeFileSync(join(process.cwd(), ".env"), content);
          return true;
        }
      }
      return false;
    },
  },
  {
    pattern: /timeout|TimeoutError|AbortError|stuck.*process/i,
    name: "stuck-processes",
    fix: () => {
      const killed = killStuckProcesses(30);
      console.log(`[SelfRepair] Killed ${killed} stuck processes`);
      return killed > 0;
    },
  },
];

export interface DiagnosticReport {
  timestamp: string;
  health: HealthResult;
  recentChanges: string;
  recentCommits: string;
  errorPatterns: string[];
  suggestedActions: string[];
}

export interface RepairResult {
  level: 1 | 2 | 3 | 4;
  success: boolean;
  action: string;
  details: string;
  diagnostic?: DiagnosticReport;
}

/**
 * Level 1: Diagnose — analyze the current state
 */
export function diagnose(): DiagnosticReport {
  const health = runQuickHealthCheck();
  const recentChanges = exec("git diff --stat HEAD~3..HEAD 2>/dev/null || echo 'no recent changes'");
  const recentCommits = exec("git log --oneline -5 2>/dev/null || echo 'no commits'");

  // Check for known error patterns in recent output
  const failMessages = health.checks
    .filter((c) => c.status === "fail")
    .map((c) => c.message);

  const matchedPatterns: string[] = [];
  const suggestedActions: string[] = [];

  for (const kp of KNOWN_PATTERNS) {
    if (failMessages.some((msg) => kp.pattern.test(msg))) {
      matchedPatterns.push(kp.name);
      suggestedActions.push(`Auto-fix available: ${kp.name}`);
    }
  }

  if (matchedPatterns.length === 0 && health.overall === "fail") {
    suggestedActions.push("No known pattern matched — consider manual investigation or rollback");
  }

  return {
    timestamp: new Date().toISOString(),
    health,
    recentChanges,
    recentCommits,
    errorPatterns: matchedPatterns,
    suggestedActions,
  };
}

/**
 * Level 2: Auto-fix — try known pattern fixes
 */
function tryAutoFix(diagnostic: DiagnosticReport): RepairResult {
  const failMessages = diagnostic.health.checks
    .filter((c) => c.status === "fail")
    .map((c) => c.message)
    .join("\n");

  for (const kp of KNOWN_PATTERNS) {
    if (kp.pattern.test(failMessages)) {
      console.log(`[SelfRepair] Trying auto-fix: ${kp.name}`);
      const fixed = kp.fix();
      if (fixed) {
        // Verify fix worked
        const healthAfter = runQuickHealthCheck();
        if (healthAfter.overall !== "fail") {
          return {
            level: 2,
            success: true,
            action: `auto-fix: ${kp.name}`,
            details: `Applied fix for ${kp.name}, health is now ${healthAfter.overall}`,
          };
        }
      }
    }
  }

  return {
    level: 2,
    success: false,
    action: "auto-fix attempted",
    details: "All known pattern fixes failed or did not resolve the issue",
    diagnostic,
  };
}

/**
 * Level 3: Rollback — revert to last safe checkpoint
 */
function tryRollback(diagnostic: DiagnosticReport): RepairResult {
  const safeCheckpoint = getLastSafeCheckpoint();
  if (!safeCheckpoint) {
    return {
      level: 3,
      success: false,
      action: "rollback skipped",
      details: "No safe checkpoint available for rollback",
      diagnostic,
    };
  }

  try {
    const result = rollbackTo(safeCheckpoint.id);
    return {
      level: 3,
      success: result.success,
      action: `rollback to ${safeCheckpoint.id}`,
      details: result.message,
      diagnostic,
    };
  } catch (e: any) {
    return {
      level: 3,
      success: false,
      action: "rollback failed",
      details: e.message,
      diagnostic,
    };
  }
}

/**
 * Targeted repair for stuck agent processes.
 * Called by heartbeat when individual agents timeout (doesn't need full pipeline).
 */
export function repairStuckAgents(timeoutAgentIds: string[]): RepairResult {
  console.log(`[SelfRepair] Repairing stuck agents: ${timeoutAgentIds.join(", ")}`);

  const killed = killStuckProcesses(15); // Lower threshold for targeted repair

  if (killed > 0) {
    return {
      level: 2,
      success: true,
      action: `killed ${killed} stuck CLI process(es)`,
      details: `Cleaned up ${killed} stuck processes for agents: ${timeoutAgentIds.join(", ")}`,
    };
  }

  return {
    level: 2,
    success: false,
    action: "no stuck processes found",
    details: `Agents ${timeoutAgentIds.join(", ")} timed out but no stuck processes detected`,
  };
}

/**
 * Full repair pipeline — escalate through all levels
 */
export function repair(): RepairResult {
  console.log("[SelfRepair] Starting repair pipeline...");

  // Level 0: Always clean up stuck processes first
  const killed = killStuckProcesses(30);
  if (killed > 0) {
    console.log(`[SelfRepair] Pre-cleanup: killed ${killed} stuck processes`);
  }

  // Level 1: Diagnose
  const diagnostic = diagnose();
  console.log(`[SelfRepair] Health: ${diagnostic.health.overall}, patterns: ${diagnostic.errorPatterns.join(", ") || "none"}`);

  if (diagnostic.health.overall !== "fail") {
    return {
      level: 1,
      success: true,
      action: "diagnose",
      details: `System health is ${diagnostic.health.overall} — no repair needed${killed > 0 ? ` (cleaned ${killed} stuck processes)` : ""}`,
      diagnostic,
    };
  }

  // Level 2: Auto-fix
  const autoFixResult = tryAutoFix(diagnostic);
  if (autoFixResult.success) {
    pushToRemote();
    return autoFixResult;
  }

  // Level 3: Rollback (rollbackTo already pushes)
  const rollbackResult = tryRollback(diagnostic);
  if (rollbackResult.success) return rollbackResult;

  // Level 4: Escalate — generate full diagnostic report for user
  return {
    level: 4,
    success: false,
    action: "escalate",
    details: "All repair attempts failed — requires manual intervention",
    diagnostic,
  };
}
