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

/**
 * Invoke Claude Code CLI in non-interactive mode.
 * Always uses stream-json for responsiveness.
 * Returns an async iterable of parsed JSON lines.
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
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_AGENT_")) {
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

  const rl = createInterface({ input: proc.stdout! });
  let lineCount = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: CLIOutputLine = JSON.parse(trimmed);
      lineCount++;
      if (lineCount <= 3 || parsed.type === "result") {
        console.log("[cli] Event:", parsed.type, lineCount <= 3 ? "" : `(total: ${lineCount})`);
      }
      yield parsed;
    } catch {
      // Non-JSON line (debug output, etc.)
      console.log("[cli:raw]", trimmed.slice(0, 200));
    }
  }

  console.log("[cli] Stream ended, total events:", lineCount);

  // Wait for process to exit
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

function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", () => resolve(1));
  });
}
