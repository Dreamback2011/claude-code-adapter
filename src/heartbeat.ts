/**
 * Heartbeat — Agent Health Check System
 *
 * Every 13 minutes (via CronScheduler), triggers each interactive agent
 * to perform a self-check by sending a real request through the adapter.
 *
 * This is NOT passive metrics reading — each agent independently processes
 * a health check prompt through the full pipeline (adapter → CLI → Agent).
 *
 * If an agent is busy, the request queues behind (concurrency control handles this).
 *
 * Exports:
 *   runHeartbeat()       — execute one health check cycle (called by CronScheduler)
 *   getHeartbeatStatus() — latest health check results (for /v1/heartbeat endpoint)
 */

import { readdirSync, existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { sendToChannel } from "./webhook-config.js";
import { AGENTS_DIR } from "./paths.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Timeout per agent health check (90 seconds) */
const AGENT_CHECK_TIMEOUT_MS = 90_000;

/** Agents excluded from heartbeat (cron-only / non-interactive) */
const EXCLUDED_AGENTS = ["alpha", "evaluator"];

/** Critical infrastructure services to monitor */
const INFRA_SERVICES = [
  { name: "openclaw-gateway", processName: "openclaw-gateway", critical: true, matchMode: "exact" as const },
  { name: "telegram-userbot", processName: "userbot.py", critical: true, matchMode: "pattern" as const },
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentCheckResult {
  agentId: string;
  status: "ok" | "timeout" | "error";
  responseTimeMs: number;
  /** Truncated agent response (first 500 chars) */
  responsePreview: string | null;
  error: string | null;
}

export interface InfraCheckResult {
  service: string;
  status: "up" | "down";
  pid: number | null;
  uptimeSec: number | null;
  error: string | null;
}

export interface HeartbeatStatus {
  timestamp: string;
  durationMs: number;
  infrastructure: InfraCheckResult[];
  results: AgentCheckResult[];
  summary: { ok: number; timeout: number; error: number; total: number; infraDown: number };
}

// ─── State ───────────────────────────────────────────────────────────────────

let latestStatus: HeartbeatStatus | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get list of interactive agent IDs to check.
 * Reads agents/ directory, excludes cron-only and archived agents.
 */
function getInteractiveAgentIds(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const ids: string[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "archive") continue;

    const skillPath = join(AGENTS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    // Parse SKILL.md frontmatter for id, type, status
    try {
      const content = readFileSync(skillPath, "utf-8");
      if (/^type:\s*"?scheduled"?/m.test(content)) continue;
      if (/^status:\s*"?archived"?/m.test(content)) continue;

      // Use the id field from SKILL.md (must match agent-registry registration)
      const idMatch = content.match(/^id:\s*"?([^"\n]+)"?/m);
      const agentId = idMatch ? idMatch[1].trim() : entry.name;

      // Exclude by both directory name and resolved agent id
      if (EXCLUDED_AGENTS.includes(entry.name) || EXCLUDED_AGENTS.includes(agentId)) continue;

      ids.push(agentId);
    } catch {
      continue;
    }
  }
  return ids;
}

/**
 * Send a health check request to a specific agent via the adapter.
 * Uses metadata.agent_id for force-routing (bypasses classifier).
 */
async function checkAgent(agentId: string): Promise<AgentCheckResult> {
  const port = process.env.PORT || "3456";
  const apiKey = process.env.LOCAL_API_KEY || "";
  const startTime = Date.now();

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    metadata: {
      agent_id: agentId,
      heartbeat: true,
    },
    system: "You are performing an automated health check. Respond briefly in Chinese. Keep it under 100 words.",
    messages: [
      {
        role: "user",
        content: `[Heartbeat 自检] 这是定时健康检查。请简要确认：
1. 你正常运行
2. 你的核心能力可用
3. 如果你发现任何异常请报告

简短回复即可。`,
      },
    ],
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_CHECK_TIMEOUT_MS),
    });

    const responseTimeMs = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        agentId,
        status: "error",
        responseTimeMs,
        responsePreview: null,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
      };
    }

    const result = (await response.json()) as any;

    // Extract text from Anthropic-format response
    const text = (result.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    return {
      agentId,
      status: "ok",
      responseTimeMs,
      responsePreview: text.slice(0, 500) || null,
      error: null,
    };
  } catch (err: any) {
    const responseTimeMs = Date.now() - startTime;
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";

    return {
      agentId,
      status: isTimeout ? "timeout" : "error",
      responseTimeMs,
      responsePreview: null,
      error: err.message,
    };
  }
}

// ─── Infrastructure Check ────────────────────────────────────────────────────

/** Parse ps etime format (DD-HH:MM:SS or HH:MM:SS or MM:SS) to seconds */
function parseElapsedTime(elapsed: string): number {
  const parts = elapsed.trim().replace(/-/g, ":").split(":").reverse().map(Number);
  let sec = parts[0] || 0;
  if (parts[1]) sec += parts[1] * 60;
  if (parts[2]) sec += parts[2] * 3600;
  if (parts[3]) sec += parts[3] * 86400;
  return sec;
}

/** Format seconds into human-readable uptime string */
function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function checkInfraService(service: { name: string; processName: string; critical: boolean; matchMode?: "exact" | "pattern" }): InfraCheckResult {
  try {
    const pgrepFlag = service.matchMode === "pattern" ? "-f" : "-x";
    const output = execSync(`pgrep ${pgrepFlag} "${service.processName}"`, { encoding: "utf-8", timeout: 5000 }).trim();
    const pids = output.split("\n").filter(Boolean);
    if (pids.length > 0) {
      const pid = parseInt(pids[0], 10);
      // Try to get uptime via ps
      let uptimeSec: number | null = null;
      try {
        const elapsed = execSync(`ps -o etime= -p ${pid}`, { encoding: "utf-8", timeout: 5000 }).trim();
        uptimeSec = parseElapsedTime(elapsed);
      } catch {}
      return { service: service.name, status: "up", pid, uptimeSec, error: null };
    }
    return { service: service.name, status: "down", pid: null, uptimeSec: null, error: "Process not found" };
  } catch {
    return { service: service.name, status: "down", pid: null, uptimeSec: null, error: "Process not found" };
  }
}

// ─── Discord Alert ───────────────────────────────────────────────────────────

async function sendHeartbeatAlert(status: HeartbeatStatus): Promise<void> {
  const infraDown = status.infrastructure.filter((i) => i.status === "down");
  const agentFailures = status.results.filter((r) => r.status !== "ok");
  if (infraDown.length === 0 && agentFailures.length === 0) return;

  const lines = [
    `⚠️ **Heartbeat Alert** (${new Date(status.timestamp).toLocaleTimeString("zh-CN", { hour12: false })})`,
    "",
  ];

  // Infrastructure failures first (higher priority)
  for (const i of infraDown) {
    lines.push(`🚨 **${i.service}**: DOWN — ${i.error || "unknown"}`);
  }

  // Agent failures
  for (const f of agentFailures) {
    const emoji = f.status === "timeout" ? "⏰" : "🔴";
    lines.push(`${emoji} **${f.agentId}**: ${f.status} — ${f.error || "unknown"} (${(f.responseTimeMs / 1000).toFixed(1)}s)`);
  }

  const okCount = status.results.filter((r) => r.status === "ok").length;
  const infraUpCount = status.infrastructure.filter((i) => i.status === "up").length;
  lines.push("", `✅ ${infraUpCount}/${status.infrastructure.length} infra up, ${okCount}/${status.summary.total} agents healthy`);

  try {
    await sendToChannel("debug", lines.join("\n"), "Heartbeat");
    console.log("[heartbeat] Discord alert sent");
  } catch (err: any) {
    console.error("[heartbeat] Discord alert failed:", err.message);
  }
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Run one heartbeat cycle: check all interactive agents sequentially.
 * Called by CronScheduler every 13 minutes.
 */
export async function runHeartbeat(): Promise<void> {
  const startTime = Date.now();

  // ─── Phase 1: Infrastructure checks (fast, synchronous) ───────────────
  console.log(`[heartbeat] Checking ${INFRA_SERVICES.length} infrastructure service(s)...`);
  const infraResults: InfraCheckResult[] = [];

  for (const service of INFRA_SERVICES) {
    const result = checkInfraService(service);
    infraResults.push(result);

    if (result.status === "up") {
      const uptimeStr = result.uptimeSec != null ? `, uptime ${formatUptime(result.uptimeSec)}` : "";
      console.log(`[heartbeat] 🏗️ ${result.service}: up (PID ${result.pid}${uptimeStr})`);
    } else {
      console.log(`[heartbeat] 🚨 ${result.service}: DOWN`);
    }
  }

  // Send CRITICAL alert immediately if any critical service is down
  const criticalDown = INFRA_SERVICES.filter((s) => s.critical)
    .map((s) => infraResults.find((r) => r.service === s.name))
    .filter((r): r is InfraCheckResult => r != null && r.status === "down");

  if (criticalDown.length > 0) {
    const critLines = [
      `🚨 **CRITICAL: Infrastructure Down**`,
      "",
      ...criticalDown.map((r) => `🚨 **${r.service}**: DOWN — ${r.error || "unknown"}`),
    ];
    try {
      await sendToChannel("debug", critLines.join("\n"), "Heartbeat");
      console.log("[heartbeat] Critical infra alert sent");
    } catch (err: any) {
      console.error("[heartbeat] Critical infra alert failed:", err.message);
    }
  }

  // ─── Phase 2: Agent checks ────────────────────────────────────────────
  const agentIds = getInteractiveAgentIds();

  if (agentIds.length === 0) {
    console.log("[heartbeat] No interactive agents found, skipping agent checks");
  } else {
    console.log(`[heartbeat] Starting health check for ${agentIds.length} agents: ${agentIds.join(", ")}`);
  }

  const results: AgentCheckResult[] = [];

  // Check agents sequentially to avoid overwhelming the adapter
  for (const agentId of agentIds) {
    console.log(`[heartbeat] Checking ${agentId}...`);
    const result = await checkAgent(agentId);

    const emoji = result.status === "ok" ? "🟢" : result.status === "timeout" ? "🟡" : "🔴";
    console.log(`[heartbeat] ${emoji} ${agentId}: ${result.status} (${(result.responseTimeMs / 1000).toFixed(1)}s)`);

    results.push(result);
  }

  // Build summary
  const infraDownCount = infraResults.filter((r) => r.status === "down").length;
  const summary = {
    ok: results.filter((r) => r.status === "ok").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    error: results.filter((r) => r.status === "error").length,
    total: results.length,
    infraDown: infraDownCount,
  };

  const durationMs = Date.now() - startTime;

  const status: HeartbeatStatus = {
    timestamp: new Date().toISOString(),
    durationMs,
    infrastructure: infraResults,
    results,
    summary,
  };

  latestStatus = status;

  console.log(
    `[heartbeat] Complete: ${summary.ok}🟢 ${summary.timeout}🟡 ${summary.error}🔴 infra-down:${summary.infraDown} (${(durationMs / 1000).toFixed(1)}s total)`
  );

  // Alert on failures (agent or infra)
  if (summary.timeout > 0 || summary.error > 0 || summary.infraDown > 0) {
    await sendHeartbeatAlert(status);

    // ─── Targeted repair: kill stuck processes for timed-out agents ───
    const timedOutAgents = results.filter((r) => r.status === "timeout").map((r) => r.agentId);
    if (timedOutAgents.length > 0) {
      console.log(`[heartbeat] ${timedOutAgents.length} agent(s) timed out — cleaning stuck processes...`);
      try {
        const { repairStuckAgents } = await import("../agents/github-updates/self-repair.js");
        const stuckResult = repairStuckAgents(timedOutAgents);
        console.log(`[heartbeat] Stuck process repair: ${stuckResult.action}`);

        await sendToChannel("debug", [
          `🔧 **卡顿进程清理** — ${timedOutAgents.join(", ")}`,
          `Action: ${stuckResult.action}`,
          `Result: ${stuckResult.success ? "✅ 已清理" : "⚠️ 未发现可清理进程"}`,
        ].join("\n"), "SelfRepair").catch(() => {});
      } catch (stuckErr: any) {
        console.error(`[heartbeat] Stuck process repair failed:`, stuckErr.message);
      }
    }

    // ─── Full self-repair: if ≥30% agents are failing (lowered from 50%) ───
    if (summary.total > 0) {
      const failRatio = (summary.timeout + summary.error) / summary.total;
      if (failRatio >= 0.3) {
        console.log(`[heartbeat] ${Math.round(failRatio * 100)}% agents unhealthy — triggering full self-repair...`);
        try {
          const { repair } = await import("../agents/github-updates/self-repair.js");
          const repairResult = repair();
          console.log(`[heartbeat] Self-repair result: level=${repairResult.level}, success=${repairResult.success}, action=${repairResult.action}`);

          // Notify Discord about repair attempt
          const repairLines = [
            `🔧 **Self-Repair 自动触发** (${Math.round(failRatio * 100)}% agents 异常)`,
            "",
            `Level: ${repairResult.level}`,
            `Action: ${repairResult.action}`,
            `Result: ${repairResult.success ? "✅ 修复成功" : "❌ 修复失败"}`,
            `Detail: ${repairResult.details.slice(0, 200)}`,
          ];
          await sendToChannel("debug", repairLines.join("\n"), "SelfRepair");
        } catch (repairErr: any) {
          console.error(`[heartbeat] Self-repair failed:`, repairErr.message);
          await sendToChannel("debug", `🔧 Self-Repair 异常: ${repairErr.message}`, "SelfRepair").catch(() => {});
        }
      }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the most recent heartbeat status.
 * Returns null if heartbeat hasn't run yet.
 */
export function getHeartbeatStatus(): HeartbeatStatus | null {
  return latestStatus;
}
