import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CLIOutputLine } from "./types.js";

export interface CLIOptions {
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string;
  model?: string;
  maxTokens?: number;
  stream?: boolean;
  sessionId?: string;
  continueSession?: boolean;
  maxBudgetUsd?: number;
}

// Timeout: kill CLI if no output for this many ms
const CLI_IDLE_TIMEOUT_MS = 600_000; // 10 minutes
// Hard timeout: kill CLI after this many ms regardless
const CLI_HARD_TIMEOUT_MS = 86_400_000; // 24 hours
// How often to check if CLI has active child processes (tools/bash running)
const ACTIVE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Invoke Claude Code CLI in non-interactive mode.
 * Always uses stream-json for responsiveness.
 * Returns an async iterable of parsed JSON lines.
 *
 * === Stop Hook Ordering ===
 * Claude Code runs Stop Hooks BEFORE closing stdout:
 *   result event → stop hook runs → process exits → stdout EOF → readline ends
 *
 * So: all hook output IS captured by the readline loop naturally.
 * BUT we must not exit early. We collect ALL stdout data into a buffer
 * BEFORE parsing, so even if readline ends mid-hook, nothing is lost.
 *
 * Strategy:
 *   1. Pipe stdout into a raw data buffer (captures everything)
 *   2. readline reads from the SAME stream (for line-by-line yielding)
 *   3. After readline closes, drain any unparsed bytes from the buffer
 *   4. Then waitForExit (confirms process + all hooks completed)
 */
export async function* invokeClaudeCLI(
  options: CLIOptions
): AsyncGenerator<CLIOutputLine, void, unknown> {
  const args = buildArgs(options);

  console.log("[cli] Spawning: claude", args.join(" ").slice(0, 200) + "...");

  // Build clean env: remove ALL Claude-related env vars
  // to prevent nested session detection
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("CLAUDE_AGENT_") ||
      key === "CLAUDE_DEV"
    ) {
      delete env[key];
    }
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  console.log("[cli] Process spawned, pid:", proc.pid);

  // Close stdin immediately — we don't send any input
  proc.stdin?.end();

  // Capture stderr for error reporting
  let stderrData = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrData += text;
    console.log("[cli:stderr]", text.trim());
  });

  proc.on("error", (err) => {
    console.error("[cli] Process error:", err.message);
  });

  // === RAW BUFFER — captures ALL stdout bytes, even after readline ends ===
  // This is the safety net for Stop Hook output that arrives late.
  // readline reads from the same stdout stream, so it gets the same data.
  // After readline ends, we check if rawBuffer has any unparsed lines.
  const rawLines: string[] = [];
  let rawPartial = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const combined = rawPartial + text;
    const parts = combined.split("\n");
    rawPartial = parts.pop() ?? ""; // last part might be incomplete
    for (const part of parts) {
      if (part.trim()) rawLines.push(part);
    }
  });

  proc.stdout?.on("end", () => {
    // Flush any remaining partial line
    if (rawPartial.trim()) {
      rawLines.push(rawPartial);
      rawPartial = "";
    }
    console.log("[cli] stdout ended, total raw lines buffered:", rawLines.length);
  });

  // Hard timeout — kill process after max time
  const hardTimer = setTimeout(() => {
    console.error("[cli] Hard timeout reached, killing process", proc.pid);
    killProc(proc);
  }, CLI_HARD_TIMEOUT_MS);

  // Idle timeout — kill if no output for a while
  let idleTimer = setTimeout(() => {
    console.error("[cli] Idle timeout reached, killing process", proc.pid);
    killProc(proc);
  }, CLI_IDLE_TIMEOUT_MS);

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error("[cli] Idle timeout reached, killing process", proc.pid);
      killProc(proc);
    }, CLI_IDLE_TIMEOUT_MS);
  };

  const rl = createInterface({ input: proc.stdout! });
  let lineCount = 0;
  // Track which raw lines we've already yielded via readline
  // (to avoid double-yielding in the drain phase)
  const yieldedLines = new Set<number>();
  let rawLineIndex = 0;

  // Periodically check if CLI has active child processes (e.g. running bash/tools).
  // If so, reset the idle timer so long-running tools don't get killed mid-task.
  const activeCheckInterval = setInterval(() => {
    if (proc.pid && hasActiveChildren(proc.pid)) {
      console.log("[cli] Active child processes detected, resetting idle timer");
      resetIdleTimer();
    }
  }, ACTIVE_CHECK_INTERVAL_MS);

  try {
    for await (const line of rl) {
      resetIdleTimer();
      const trimmed = line.trim();
      if (!trimmed) {
        rawLineIndex++;
        continue;
      }
      try {
        const parsed: CLIOutputLine = JSON.parse(trimmed);
        lineCount++;
        yieldedLines.add(rawLineIndex);
        rawLineIndex++;
        if (lineCount <= 3 || parsed.type === "result") {
          console.log("[cli] Event:", parsed.type, lineCount <= 3 ? "" : `(total: ${lineCount})`);
        }
        yield parsed;
      } catch {
        // Non-JSON line (debug output, etc.)
        console.log("[cli:raw]", trimmed.slice(0, 200));
        rawLineIndex++;
      }
    }

    // === DRAIN PHASE ===
    // readline has ended (stdout EOF), but Stop Hooks might have written lines
    // that ended up in rawLines but weren't reached by the readline loop.
    // Wait briefly for the raw buffer to settle, then drain unparsed lines.
    await new Promise((r) => setTimeout(r, 100));

    const drainStart = rawLineIndex;
    let drainCount = 0;
    for (let i = drainStart; i < rawLines.length; i++) {
      const trimmed = rawLines[i].trim();
      if (!trimmed) continue;
      try {
        const parsed: CLIOutputLine = JSON.parse(trimmed);
        drainCount++;
        lineCount++;
        console.log("[cli] Drain event:", parsed.type, `(line ${i})`);
        yield parsed;
      } catch {
        console.log("[cli:drain:raw]", trimmed.slice(0, 200));
      }
    }
    if (drainCount > 0) {
      console.log("[cli] Drained", drainCount, "lines after readline EOF (stop hook output)");
    }

  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    clearInterval(activeCheckInterval);
  }

  console.log("[cli] Stream ended, total events:", lineCount);

  // Wait for process to exit — ensures Stop Hook has fully completed
  // before we return. This prevents the caller from starting a new request
  // while the previous hook is still running.
  const exitCode = await waitForExit(proc);
  console.log("[cli] Process exited with code:", exitCode);

  if (exitCode !== 0 && stderrData) {
    throw new Error(`Claude CLI exited with code ${exitCode}: ${stderrData.trim()}`);
  }
}

function buildArgs(options: CLIOptions): string[] {
  const args: string[] = ["-p", options.prompt];

  // Always use stream-json with partial messages for real-time output
  args.push("--output-format", "stream-json");
  args.push("--verbose");
  args.push("--include-partial-messages");

  if (options.allowedTools) {
    args.push("--allowedTools", options.allowedTools);
  }

  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  } else if (options.continueSession) {
    args.push("--continue");
  }

  if (options.maxBudgetUsd) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  return args;
}

/**
 * Check if a process has active child processes.
 * Uses `ps` to list processes whose parent PID matches.
 * Returns true if any children exist (CLI is running a tool/bash command).
 */
function hasActiveChildren(pid: number): boolean {
  try {
    // pgrep -P <pid> lists child processes; exit code 0 = children found
    const result = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function killProc(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 3000);
  } catch {}
}

function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", () => resolve(1));
  });
}
