import { spawn, type ChildProcess } from "node:child_process";
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

// === Adaptive timeouts based on CLI state ===
const TIMEOUT_THINKING_MS = 300_000;      // 5 min — Claude should produce output regularly
const TIMEOUT_TOOL_RUNNING_MS = 1_800_000; // 30 min — tools like bash can run long
const TIMEOUT_RESPONDING_MS = 300_000;     // 5 min — streaming text response
const TIMEOUT_IDLE_MS = 600_000;           // 10 min — fallback for unknown/idle state
// Hard timeout: kill CLI after this many ms regardless
const CLI_HARD_TIMEOUT_MS = 86_400_000;    // 24 hours

// === Progress tracking ===

export type CLIState = 'idle' | 'thinking' | 'tool_running' | 'responding' | 'done' | 'error';

export interface CLIProgress {
  pid: number;
  state: CLIState;
  lastEventType: string;
  lastEventTime: number;  // Date.now()
  eventCount: number;
  startTime: number;
  toolName?: string;      // current tool being used
}

/** Registry of all active CLI processes and their progress */
const activeProcesses = new Map<number, CLIProgress>();

/** Get the current state of all active CLI processes */
export function getActiveProcesses(): CLIProgress[] {
  return Array.from(activeProcesses.values());
}

/** Get the timeout duration for a given CLI state */
function getTimeoutForState(state: CLIState): number {
  switch (state) {
    case 'thinking':     return TIMEOUT_THINKING_MS;
    case 'tool_running': return TIMEOUT_TOOL_RUNNING_MS;
    case 'responding':   return TIMEOUT_RESPONDING_MS;
    default:             return TIMEOUT_IDLE_MS;
  }
}

/**
 * Determine the CLI state from a parsed stream-json event.
 *
 * Stream event types from Claude CLI:
 * - "system"    — startup info
 * - "assistant" — message with content blocks (text, tool_use, tool_result)
 * - "result"    — final result, CLI is done
 *
 * For "assistant" events, we inspect message.content blocks:
 * - tool_use block   → tool_running (extract tool name)
 * - tool_result block → thinking (tool finished, back to thinking)
 * - text block        → responding (Claude is writing text)
 *
 * For stream_event types, we look at the inner event:
 * - content_block_start with tool_use → tool_running
 * - content_block_start with text     → responding
 * - content_block_delta with text     → responding
 * - message_start / message_delta     → thinking
 */
function detectState(parsed: CLIOutputLine): { state: CLIState; toolName?: string } {
  const eventType = parsed.type;

  // Final result — done
  if (eventType === 'result') {
    return { state: 'done' };
  }

  // System event — still starting up / thinking
  if (eventType === 'system') {
    return { state: 'thinking' };
  }

  // Assistant message — inspect content blocks
  if (eventType === 'assistant') {
    const msg = (parsed as { message?: { content?: Array<{ type: string; name?: string }> } }).message;
    const content = msg?.content;
    if (Array.isArray(content) && content.length > 0) {
      // Check blocks in reverse order — last block is the most recent activity
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (block.type === 'tool_use') {
          return { state: 'tool_running', toolName: block.name };
        }
        if (block.type === 'tool_result') {
          // Tool just finished, Claude is thinking about what to do next
          return { state: 'thinking' };
        }
        if (block.type === 'text') {
          return { state: 'responding' };
        }
      }
    }
    return { state: 'thinking' };
  }

  // Stream event — inspect the inner event
  if (eventType === 'stream_event') {
    const inner = (parsed as { event?: { type?: string; content_block?: { type: string; name?: string }; delta?: { type?: string } } }).event;
    if (inner) {
      if (inner.type === 'content_block_start') {
        if (inner.content_block?.type === 'tool_use') {
          return { state: 'tool_running', toolName: inner.content_block.name };
        }
        if (inner.content_block?.type === 'text') {
          return { state: 'responding' };
        }
      }
      if (inner.type === 'content_block_delta') {
        if (inner.delta?.type === 'text_delta') {
          return { state: 'responding' };
        }
        if (inner.delta?.type === 'input_json_delta') {
          return { state: 'tool_running' };
        }
      }
      if (inner.type === 'message_start' || inner.type === 'message_delta') {
        return { state: 'thinking' };
      }
    }
  }

  // Unknown event type — don't change state
  return { state: 'idle' };
}

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
 *
 * === Progress Monitoring ===
 * Instead of blind idle timeouts + pgrep polling, this function parses
 * each stream-json event to determine CLI state (thinking, tool_running,
 * responding, done) and applies adaptive timeouts per state.
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

  // Guard pipes against EPIPE — prevents unhandled errors from crashing the server
  proc.stdout?.on("error", (err) => {
    console.warn("[cli] stdout pipe error:", err.message);
  });
  proc.stderr?.on("error", (err) => {
    console.warn("[cli] stderr pipe error:", err.message);
  });
  proc.stdin?.on("error", (err) => {
    console.warn("[cli] stdin pipe error:", err.message);
  });

  // Close stdin immediately — we don't send any input
  proc.stdin?.end();

  // === Initialize progress tracking ===
  const pid = proc.pid ?? 0;
  const progress: CLIProgress = {
    pid,
    state: 'idle',
    lastEventType: '',
    lastEventTime: Date.now(),
    eventCount: 0,
    startTime: Date.now(),
  };
  if (pid > 0) {
    activeProcesses.set(pid, progress);
  }

  /** Update progress state and log transitions */
  function updateProgress(parsed: CLIOutputLine): void {
    const { state: newState, toolName } = detectState(parsed);
    const oldState = progress.state;

    progress.lastEventType = parsed.type;
    progress.lastEventTime = Date.now();
    progress.eventCount++;

    // Only log meaningful state transitions (not idle → idle)
    if (newState !== 'idle' && newState !== oldState) {
      const toolInfo = toolName ? ` (tool: ${toolName})` : '';
      const elapsed = oldState !== 'idle'
        ? ` (after ${Math.round((Date.now() - progress.startTime) / 1000)}s)`
        : '';
      console.log(`[cli:progress] pid=${pid} ${oldState} → ${newState}${toolInfo}${elapsed}`);
      progress.state = newState;
    }

    if (toolName) {
      progress.toolName = toolName;
    }
    // Clear tool name when leaving tool_running state
    if (newState !== 'tool_running' && newState !== 'idle') {
      progress.toolName = undefined;
    }
  }

  // Capture stderr for error reporting
  let stderrData = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrData += text;
    console.log("[cli:stderr]", text.trim());
  });

  proc.on("error", (err) => {
    console.error("[cli] Process error:", err.message);
    progress.state = 'error';
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
    progress.state = 'error';
    killProc(proc);
  }, CLI_HARD_TIMEOUT_MS);

  // Adaptive idle timeout — duration depends on current CLI state
  let idleTimer = setTimeout(() => {
    console.error(`[cli] Adaptive timeout reached in state '${progress.state}', killing process`, proc.pid);
    progress.state = 'error';
    killProc(proc);
  }, getTimeoutForState(progress.state));

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    const timeout = getTimeoutForState(progress.state);
    idleTimer = setTimeout(() => {
      console.error(`[cli] Adaptive timeout reached in state '${progress.state}' (${Math.round(timeout / 1000)}s), killing process`, proc.pid);
      progress.state = 'error';
      killProc(proc);
    }, timeout);
  };

  const rl = createInterface({ input: proc.stdout! });
  let lineCount = 0;
  // Track which raw lines we've already yielded via readline
  // (to avoid double-yielding in the drain phase)
  const yieldedLines = new Set<number>();
  let rawLineIndex = 0;

  try {
    for await (const line of rl) {
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

        // Update progress tracking (side effect — does not alter parsed event)
        updateProgress(parsed);
        // Reset idle timer AFTER updating state, so the new timeout
        // duration matches the current state
        resetIdleTimer();

        if (lineCount <= 3 || parsed.type === "result") {
          console.log("[cli] Event:", parsed.type, lineCount <= 3 ? "" : `(total: ${lineCount})`);
        }
        yield parsed;
      } catch {
        // Non-JSON line (debug output, etc.)
        console.log("[cli:raw]", trimmed.slice(0, 200));
        rawLineIndex++;
        // Still reset idle timer on any output
        resetIdleTimer();
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
        updateProgress(parsed);
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
    // Mark as done and remove from active registry
    if (progress.state !== 'error') {
      progress.state = 'done';
    }
    if (pid > 0) {
      activeProcesses.delete(pid);
    }
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
    // Split comma-separated tools into individual arguments
    // Claude Code CLI --allowedTools is variadic: expects each tool as a separate arg
    const tools = options.allowedTools.split(",").map((t) => t.trim()).filter(Boolean);
    if (tools.length > 0) {
      args.push("--allowedTools", ...tools);
    }
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
