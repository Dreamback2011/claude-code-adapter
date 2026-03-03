/**
 * CronScheduler — Generic task scheduler for periodic jobs.
 *
 * Built-in tasks:
 *   - evaluation: daily at 23:00 (agent health report)
 *   - alpha-timeline: every 1 hour (scrape X/Twitter timeline + AI analysis)
 *   - rss-daily: daily at 22:00 UTC (RSS feed collection + AI summarization)
 *
 * Uses setTimeout/setInterval — no external cron library needed.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { runHeartbeat } from "./heartbeat.js";
import { PROJECT_ROOT } from "./paths.js";
import { sendToChannel } from "./webhook-config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CronTask {
  name: string;
  /** Interval in milliseconds (for repeating tasks) */
  intervalMs: number;
  /** Specific hour to run at (0-23), or null for interval-based */
  atHour: number | null;
  /** The function to execute */
  callback: () => Promise<void> | void;
  /** Internal timer reference */
  timerId: ReturnType<typeof setTimeout> | null;
  /** Execution stats */
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: "success" | "error" | "running" | "pending";
  lastError: string | null;
  nextRunAt: string | null;
  runCount: number;
}

export interface CronTaskStatus {
  name: string;
  intervalMs: number;
  atHour: number | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: string;
  lastError: string | null;
  nextRunAt: string | null;
  runCount: number;
}

// ─── Task Registry ──────────────────────────────────────────────────────────

const tasks = new Map<string, CronTask>();

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Register a named task with the scheduler.
 */
function registerTask(opts: {
  name: string;
  intervalMs: number;
  atHour?: number | null;
  callback: () => Promise<void> | void;
}): void {
  if (tasks.has(opts.name)) {
    console.warn(`[cron] Task "${opts.name}" already registered, skipping`);
    return;
  }

  const task: CronTask = {
    name: opts.name,
    intervalMs: opts.intervalMs,
    atHour: opts.atHour ?? null,
    callback: opts.callback,
    timerId: null,
    lastRunAt: null,
    lastDurationMs: null,
    lastStatus: "pending",
    lastError: null,
    nextRunAt: null,
    runCount: 0,
  };

  tasks.set(opts.name, task);
  console.log(`[cron] Registered task: ${opts.name} (interval=${opts.intervalMs}ms, atHour=${opts.atHour ?? "none"})`);
}

/**
 * Execute a task and update its stats.
 */
async function executeTask(task: CronTask): Promise<void> {
  const startTime = Date.now();
  task.lastStatus = "running";
  task.lastRunAt = new Date().toISOString();
  console.log(`[cron] ▶ ${task.name} started`);

  try {
    await task.callback();
    const durationMs = Date.now() - startTime;
    task.lastDurationMs = durationMs;
    task.lastStatus = "success";
    task.lastError = null;
    task.runCount++;
    console.log(`[cron] ✓ ${task.name} completed in ${durationMs}ms`);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    task.lastDurationMs = durationMs;
    task.lastStatus = "error";
    task.lastError = err.message || String(err);
    task.runCount++;
    console.error(`[cron] ✗ ${task.name} failed after ${durationMs}ms:`, err.message);
  }
}

/**
 * Schedule a task that runs at a specific hour each day (e.g., 23:00).
 */
function scheduleDailyTask(task: CronTask): void {
  if (task.atHour === null) return;

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(task.atHour, 0, 0, 0);

  // If the target hour already passed today, schedule for tomorrow
  if (now >= nextRun) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const msUntilFirst = nextRun.getTime() - now.getTime();
  task.nextRunAt = nextRun.toISOString();

  const hoursUntil = (msUntilFirst / 3600000).toFixed(1);
  console.log(`[cron] ${task.name}: first run in ${hoursUntil}h (at ${task.atHour}:00), then every 24h`);

  task.timerId = setTimeout(async () => {
    await executeTask(task);

    // Schedule repeating every 24 hours
    const oneDayMs = 24 * 60 * 60 * 1000;
    task.timerId = setInterval(async () => {
      task.nextRunAt = new Date(Date.now() + oneDayMs).toISOString();
      await executeTask(task);
    }, oneDayMs);

    // Update next run time after first execution
    task.nextRunAt = new Date(Date.now() + oneDayMs).toISOString();
  }, msUntilFirst);
}

/**
 * Schedule an interval-based task (e.g., every 1 hour).
 */
function scheduleIntervalTask(task: CronTask): void {
  task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();

  const intervalDesc =
    task.intervalMs >= 3600000
      ? `${(task.intervalMs / 3600000).toFixed(1)}h`
      : `${(task.intervalMs / 60000).toFixed(0)}min`;
  console.log(`[cron] ${task.name}: runs every ${intervalDesc}`);

  // Run first one immediately, then repeat
  (async () => {
    await executeTask(task);
    task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();
  })();

  task.timerId = setInterval(async () => {
    task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();
    await executeTask(task);
  }, task.intervalMs);
}

// ─── Built-in: Evaluation Task ──────────────────────────────────────────────

async function runEvaluation(): Promise<void> {
  // Dynamic import to avoid circular dependencies
  const { runScheduledEvaluation } = await import("./agent-evaluation.js");
  runScheduledEvaluation();
}

// ─── Built-in: Alpha-Timeline Task ──────────────────────────────────────────

const SCRAPER_PYTHON = `${process.env.HOME}/.openclaw/workspace/clawfeed-x/venv/bin/python3`;
const SCRAPER_SCRIPT = `${process.env.HOME}/.openclaw/workspace/clawfeed-x/x_scraper.py`;
const SCRAPER_TIMEOUT_MS = 60_000;

/**
 * Run the x_scraper.py and return its JSON output.
 */
function runScraper(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Scraper uses positional args: x_scraper.py <hours> <max_tweets>
    const child = execFile(
      SCRAPER_PYTHON,
      [SCRAPER_SCRIPT, "1", "80"],
      { timeout: SCRAPER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) {
          console.log(`[alpha-timeline] scraper stderr: ${stderr.trim()}`);
        }
        if (error) {
          reject(new Error(`Scraper failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Send scraped tweets to the local adapter for AI analysis.
 */
async function sendToAdapter(tweetsJson: string, totalCount: number, scrapedAt: string): Promise<void> {
  const port = process.env.PORT || "3456";
  const apiKey = process.env.LOCAL_API_KEY || "";

  // Read the system prompt from SKILL.md
  const systemPrompt = `You are an X/Twitter timeline monitoring agent.
Your job is to analyze the scraped tweets and present them in a structured format.

When presenting results:
- Group tweets by topic/relevance where possible
- Highlight high-engagement tweets (many likes/retweets)
- Flag crypto/Web3 relevant content for BD purposes
- Keep output concise — quality > quantity

Chinese preferred.`;

  const userMessage = `[cron: Alpha-Timeline 每小时播报]

以下是过去 1 小时从 X Timeline 抓取的 ${totalCount} 条推文 (${scrapedAt}):

${tweetsJson}

请按以下格式输出 AI 分级摘要：

**P1 必看 (影响大、时效强)**
- ...

**P2 关注 (趋势信号、值得跟踪)**
- ...

**P3 了解 (行业动态、背景信息)**
- ...

**总结** (2-3 句话概括当前市场情绪 + 对 BGW BD 的影响)

规则：
- 只输出中文
- 每个级别最多 5 条
- 忽略纯 meme/垃圾信息
- 如果有 BGW/Bitget 相关的直接标注`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  const url = `http://127.0.0.1:${port}/v1/messages`;
  console.log(`[alpha-timeline] Sending ${totalCount} tweets to adapter for analysis...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // 2 min timeout for AI analysis
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Adapter responded ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json() as any;

  // Extract text from response
  const aiText = (result.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  if (aiText) {
    console.log(`[alpha-timeline] AI analysis complete (${aiText.length} chars)`);

    // Deliver to Discord via webhook
    const header = `🐦 **X Alpha 动态** | ${scrapedAt} (${totalCount} tweets)\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    const footer = `\n\n---\n_Agent: **Alpha Agent** | Cron: alpha-timeline_`;
    try {
      await sendToChannel("work", header + aiText + footer, "Alpha Agent 👁");
      console.log(`[alpha-timeline] Delivered to Discord #work (${aiText.length} chars)`);
    } catch (whErr: any) {
      console.error(`[alpha-timeline] Discord delivery failed:`, whErr.message);
    }
  } else {
    console.warn(`[alpha-timeline] AI returned empty response`);
  }
}

/**
 * Full Alpha-Timeline execution flow:
 *   1. Run scraper
 *   2. Parse output
 *   3. Send to adapter for AI analysis
 */
async function runXTimeline(): Promise<void> {
  // Step 1: Run scraper
  console.log(`[alpha-timeline] Running scraper (timeout=${SCRAPER_TIMEOUT_MS / 1000}s)...`);
  const rawOutput = await runScraper();

  if (!rawOutput || rawOutput.trim().length === 0) {
    console.warn(`[alpha-timeline] Scraper returned empty output, skipping`);
    return;
  }

  // Step 2: Parse JSON output
  let scraperData: { scraped_at?: string; hours?: number; total?: number; tweets?: any[]; error?: string };
  try {
    scraperData = JSON.parse(rawOutput);
  } catch (parseErr: any) {
    console.error(`[alpha-timeline] Failed to parse scraper JSON: ${parseErr.message}`);
    console.error(`[alpha-timeline] Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`);
    return;
  }

  // Check for scraper-level errors
  if (scraperData.error) {
    console.error(`[alpha-timeline] Scraper error: ${scraperData.error}`);
    return;
  }

  const totalTweets = scraperData.total || 0;
  const scrapedAt = scraperData.scraped_at || "unknown";

  if (totalTweets === 0) {
    console.warn(`[alpha-timeline] 0 tweets scraped, skipping AI analysis`);
    return;
  }

  console.log(`[alpha-timeline] Scraped ${totalTweets} tweets (${scrapedAt})`);

  // Step 3: Send to adapter for AI analysis
  // Pass the full tweets JSON so the AI can see all data
  const tweetsText = JSON.stringify(scraperData.tweets, null, 2);
  await sendToAdapter(tweetsText, totalTweets, scrapedAt);
}

// ─── Built-in: RSS Daily Task ────────────────────────────────────────────────

// PROJECT_ROOT is imported from ./paths.js
const RSS_TIMEOUT_MS = 180_000; // 3 min — fetching 186 feeds / AI summarization

/**
 * Full RSS Daily execution flow:
 *   1. Run rss-daily.ts (data collection from 186 feeds)
 *   2. Run rss-summarize.ts (AI summarization via adapter)
 */
async function runRssDaily(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // Step 1: Collect RSS feeds
  console.log(`[rss-daily] Step 1/2: Collecting RSS feeds for ${today}...`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "npx",
      ["tsx", "agents/research/rss-daily.ts", `--date=${today}`],
      { cwd: PROJECT_ROOT, timeout: RSS_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) {
          console.log(`[rss-daily] collect stderr: ${stderr.trim()}`);
        }
        if (error) {
          reject(new Error(`RSS collect failed: ${error.message}`));
          return;
        }
        if (stdout) {
          console.log(`[rss-daily] collect output: ${stdout.trim().slice(0, 300)}`);
        }
        resolve();
      }
    );
  });

  // Step 2: AI summarization (only runs if step 1 succeeded)
  console.log(`[rss-daily] Step 2/2: Summarizing RSS feeds for ${today}...`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "npx",
      ["tsx", "agents/research/rss-summarize.ts", `--date=${today}`],
      { cwd: PROJECT_ROOT, timeout: RSS_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) {
          console.log(`[rss-daily] summarize stderr: ${stderr.trim()}`);
        }
        if (error) {
          reject(new Error(`RSS summarize failed: ${error.message}`));
          return;
        }
        if (stdout) {
          console.log(`[rss-daily] summarize output: ${stdout.trim().slice(0, 300)}`);
        }
        resolve();
      }
    );
  });

  console.log(`[rss-daily] Completed for ${today}`);
}

// ─── Built-in: Auto-Checkpoint Task ──────────────────────────────────────────

/**
 * Auto-checkpoint: scan for uncommitted changes every 5 minutes.
 * If dirty files exist → create checkpoint with auto-push to GitHub.
 * This ensures atomic, rollback-friendly version history.
 */
async function runAutoCheckpoint(): Promise<void> {
  try {
    // Dynamic import to avoid rootDir constraint (agents/ is outside src/)
    const { createCheckpoint, getStatus: getCheckpointStatus, markHealth } = await import("../agents/github-updates/checkpoint.js");
    const { runQuickHealthCheck } = await import("../agents/github-updates/health-check.js");

    const status = getCheckpointStatus();
    const totalDirty = status.staged.length + status.unstaged.length + status.untracked.length;

    if (totalDirty === 0) {
      console.log("[auto-checkpoint] Working tree clean, skipping");
      return;
    }

    console.log(`[auto-checkpoint] Found ${totalDirty} dirty files (${status.staged.length} staged, ${status.unstaged.length} unstaged, ${status.untracked.length} untracked)`);

    // Generate summary from changed files
    const allFiles = [...status.staged, ...status.unstaged, ...status.untracked];
    const dirs = [...new Set(allFiles.map(f => f.split("/")[0]))];
    const summary = `auto-checkpoint: ${totalDirty} file(s) in ${dirs.join(", ")}`;

    // Create checkpoint with auto-push (push=true is now default)
    const checkpoint = createCheckpoint(summary, {
      commitType: "chore",
    });

    // Run quick health check and mark the checkpoint
    const health = runQuickHealthCheck();
    markHealth(checkpoint.id, health.overall === "fail" ? "fail" : "pass");

    console.log(`[auto-checkpoint] ✅ ${checkpoint.id} @ ${checkpoint.commit} → pushed (health: ${health.overall})`);
  } catch (err: any) {
    // "Nothing to commit" is expected when tree is clean between status check and commit
    if (err.message?.includes("Nothing to commit")) {
      console.log("[auto-checkpoint] Nothing to commit (race condition, OK)");
      return;
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Manually trigger a registered task by name.
 * Returns true if task was found and triggered, false otherwise.
 */
export async function triggerTask(name: string): Promise<{ found: boolean; error?: string }> {
  const task = tasks.get(name);
  if (!task) {
    return { found: false, error: `Task "${name}" not found` };
  }

  console.log(`[cron] Manual trigger: ${name}`);
  await executeTask(task);

  if (task.lastStatus === "error") {
    return { found: true, error: task.lastError || "Unknown error" };
  }
  return { found: true };
}

/**
 * Get status of all registered cron tasks.
 */
export function getStatus(): CronTaskStatus[] {
  const statuses: CronTaskStatus[] = [];
  for (const task of tasks.values()) {
    statuses.push({
      name: task.name,
      intervalMs: task.intervalMs,
      atHour: task.atHour,
      lastRunAt: task.lastRunAt,
      lastDurationMs: task.lastDurationMs,
      lastStatus: task.lastStatus,
      lastError: task.lastError,
      nextRunAt: task.nextRunAt,
      runCount: task.runCount,
    });
  }
  return statuses;
}

/**
 * Initialize and start the cron scheduler.
 * Call this once from index.ts on server startup.
 */
export function setupCronScheduler(): void {
  console.log("[cron] Initializing scheduler...");

  // ── Task 1: Evaluation — daily at 23:00 ─────────────────────────────────
  registerTask({
    name: "evaluation",
    intervalMs: 24 * 60 * 60 * 1000,  // 24h (for reference)
    atHour: 23,
    callback: runEvaluation,
  });

  // ── Task 2: Alpha-Timeline — every 1 hour ──────────────────────────────
  registerTask({
    name: "alpha-timeline",
    intervalMs: 60 * 60 * 1000,  // 1 hour
    callback: runXTimeline,
  });

  // ── Task 3: Heartbeat — every 13 minutes ────────────────────────────────
  registerTask({
    name: "heartbeat",
    intervalMs: 13 * 60 * 1000,  // 13 minutes
    callback: runHeartbeat,
  });

  // ── Task 4: RSS Daily — daily at 08:00 Dubai (UTC 04:00) ────────────────
  registerTask({
    name: "rss-daily",
    intervalMs: 24 * 60 * 60 * 1000,  // 24h
    atHour: 8,
    callback: runRssDaily,
  });

  // ── Task 5: Auto-Checkpoint — every 5 minutes ───────────────────────────
  // Scans for uncommitted changes → commit + push to GitHub
  // Ensures atomic rollback points for self-repair
  registerTask({
    name: "auto-checkpoint",
    intervalMs: 5 * 60 * 1000,  // 5 minutes
    callback: runAutoCheckpoint,
  });

  // Start all tasks
  for (const task of tasks.values()) {
    if (task.atHour !== null) {
      scheduleDailyTask(task);
    } else {
      scheduleIntervalTask(task);
    }
  }

  // ── Catch-up: if today's evaluation report is missing, run immediately ────
  const today = new Date().toISOString().slice(0, 10);
  const todayReportPath = join(PROJECT_ROOT, 'agents', 'evaluator', 'reports', `${today}.json`);
  if (!existsSync(todayReportPath)) {
    const evalTask = tasks.get("evaluation");
    if (evalTask) {
      console.log(`[cron] Catch-up: today's evaluation report missing, running now...`);
      // Run async, don't block startup
      executeTask(evalTask).catch(err => console.error("[cron] Catch-up evaluation failed:", err.message));
    }
  }

  console.log(`[cron] Scheduler started with ${tasks.size} tasks`);
}
