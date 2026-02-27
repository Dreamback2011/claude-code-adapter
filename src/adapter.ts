import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { invokeClaudeCLI, type CLIOptions } from "./claude-cli.js";
import type {
  AnthropicRequest,
  AnthropicResponse,
  CLIStreamEvent,
  CLIResultEvent,
  Message,
  SystemBlock,
  TextBlock,
} from "./types.js";

// ── Result types ─────────────────────────────────────────────────────────────

export interface NonStreamingResult {
  response: AnthropicResponse;
  cliSessionId?: string;
}

export interface StreamingResult {
  streamedText: string;
  cliSessionId?: string;
}

// ── Prompt extraction ────────────────────────────────────────────────────────

/**
 * Extract text from a single message.
 */
function messageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Build the prompt to send to Claude CLI.
 *
 * - Resuming session (has cliSessionId): only send the latest user message,
 *   because CLI already has the full conversation in its session.
 * - New session with history (multiple messages): format full conversation
 *   so Claude has context from the start.
 * - New session, single message: just send it directly.
 */
function buildPrompt(messages: Message[], isResuming: boolean): string {
  // Get the latest user message
  let latestUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      latestUserText = messageText(messages[i]);
      break;
    }
  }

  // Resuming: CLI has history, only send new message
  if (isResuming) {
    return latestUserText;
  }

  // Single message or only user messages: just send it
  if (messages.length <= 1) {
    return latestUserText;
  }

  // Multiple messages (new session with history): include full context
  const historyParts: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    historyParts.push(`${role}: ${messageText(msg)}`);
  }

  return `[Previous conversation]\n${historyParts.join("\n\n")}\n\n[Current message]\n${latestUserText}`;
}

function extractSystemPrompt(system: string | SystemBlock[] | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

function buildCLIOptions(
  req: AnthropicRequest,
  allowedTools: string,
  cliSessionId?: string
): CLIOptions {
  return {
    prompt: buildPrompt(req.messages, !!cliSessionId),
    systemPrompt: extractSystemPrompt(req.system),
    allowedTools,
    model: req.model || undefined,
    sessionId: cliSessionId,
  };
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ── Non-streaming ────────────────────────────────────────────────────────────

/**
 * Handle a non-streaming request.
 * Supports session resumption via cliSessionId.
 * Returns the response + CLI session ID for session tracking.
 */
export async function handleNonStreaming(
  req: AnthropicRequest,
  allowedTools: string,
  cliSessionId?: string
): Promise<NonStreamingResult> {
  const cliOptions = buildCLIOptions(req, allowedTools, cliSessionId);
  let lastError: Error | null = null;
  let capturedSessionId: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[adapter] handleNonStreaming - retry ${attempt}/${MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));

      // If first attempt with --resume failed, try without it (fresh session)
      if (attempt === 1 && cliSessionId) {
        console.log("[adapter] Retrying without --resume (session may have expired)");
        cliOptions.sessionId = undefined;
        cliOptions.prompt = buildPrompt(req.messages, false);
      }
    }

    console.log(
      "[adapter] handleNonStreaming - attempt",
      attempt + 1,
      cliOptions.sessionId ? `(resuming ${cliOptions.sessionId})` : "(new session)"
    );
    let resultText = "";

    try {
      for await (const line of invokeClaudeCLI(cliOptions)) {
        if (line.type === "result") {
          const r = line as CLIResultEvent;
          capturedSessionId = r.session_id || capturedSessionId;
          if (!resultText && r.result) {
            resultText = r.result;
          }
        } else if (line.type === "stream_event") {
          const se = line as CLIStreamEvent;
          capturedSessionId = se.session_id || capturedSessionId;
          if (se.event?.type === "content_block_delta") {
            const delta = se.event.delta as any;
            if (delta?.type === "text_delta") {
              resultText += delta.text || "";
            }
          }
        }
      }

      console.log(
        "[adapter] handleNonStreaming - done, length:",
        resultText.length,
        "session:",
        capturedSessionId ?? "none"
      );

      return {
        response: {
          id: `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: resultText || "(no response)" }],
          model: req.model || "claude-sonnet-4-6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        cliSessionId: capturedSessionId,
      };
    } catch (err: any) {
      lastError = err;
      console.error(`[adapter] handleNonStreaming attempt ${attempt + 1} failed:`, err.message);
    }
  }

  throw lastError || new Error("All retry attempts failed");
}

// ── Streaming ────────────────────────────────────────────────────────────────

/**
 * Handle a streaming request.
 * Forwards CLI stream events as Anthropic SSE.
 * Supports session resumption and returns CLI session ID.
 */
export async function handleStreaming(
  req: AnthropicRequest,
  res: Response,
  allowedTools: string,
  cliSessionId?: string
): Promise<StreamingResult> {
  const cliOptions = buildCLIOptions(req, allowedTools, cliSessionId);
  console.log(
    "[adapter] handleStreaming -",
    cliOptions.sessionId ? `resuming ${cliOptions.sessionId}` : "new session"
  );

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`;
  let sentMessageStart = false;
  let contentBlockIndex = 0;
  let hasOpenBlock = false;
  let resultText = "";
  let capturedSessionId: string | undefined;

  try {
    for await (const line of invokeClaudeCLI(cliOptions)) {
      if (res.closed) {
        console.log("[adapter] Client disconnected");
        break;
      }

      if (line.type === "stream_event") {
        const streamEvent = line as CLIStreamEvent;
        const event = streamEvent.event;
        capturedSessionId = streamEvent.session_id || capturedSessionId;

        // Skip nested events from tool use
        if (streamEvent.parent_tool_use_id) continue;

        if (event.type === "message_start") {
          if (sentMessageStart) continue;
          const msg = event.message || {};
          sendSSE(res, "message_start", {
            type: "message_start",
            message: {
              ...{
                id: msgId,
                type: "message",
                role: "assistant",
                content: [],
                model: req.model || "claude-sonnet-4-6",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
              ...msg,
              id: msgId,
            },
          });
          sentMessageStart = true;
        } else if (event.type === "content_block_start") {
          if (!sentMessageStart) continue;
          if (event.content_block && (event.content_block as any).type === "tool_use") continue;
          sendSSE(res, "content_block_start", event);
          hasOpenBlock = true;
          contentBlockIndex = (event.index ?? contentBlockIndex) + 1;
        } else if (event.type === "content_block_delta") {
          if (!sentMessageStart) continue;
          const deltaType = (event.delta as any)?.type;
          if (deltaType && deltaType !== "text_delta") continue;
          sendSSE(res, "content_block_delta", event);
          if (deltaType === "text_delta") {
            resultText += (event.delta as any).text || "";
          }
        } else if (event.type === "content_block_stop") {
          if (!sentMessageStart || !hasOpenBlock) continue;
          sendSSE(res, "content_block_stop", event);
          hasOpenBlock = false;
        } else if (event.type === "message_delta") {
          continue; // We send our own at the end
        } else if (event.type === "message_stop") {
          continue; // We send our own after result
        } else if (event.type === "ping") {
          sendSSE(res, "ping", { type: "ping" });
        }
      } else if (line.type === "result") {
        const resultEvent = line as CLIResultEvent;
        capturedSessionId = resultEvent.session_id || capturedSessionId;
        resultText = resultEvent.result || resultText;
        console.log(
          "[adapter] Got result, length:",
          resultText.length,
          "session:",
          capturedSessionId ?? "none"
        );

        if (!sentMessageStart) {
          sendSyntheticStream(res, msgId, req.model || "claude-sonnet-4-6", resultText);
        } else {
          if (hasOpenBlock) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: contentBlockIndex - 1,
            });
          }
          sendSSE(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          });
          sendSSE(res, "message_stop", { type: "message_stop" });
        }
      }
    }
  } catch (err: any) {
    console.error("[adapter] Stream error:", err.message);

    if (!sentMessageStart) {
      // If resuming failed, retry as fresh session
      if (cliSessionId) {
        console.log("[adapter] Resume failed, retrying as fresh session...");
        cliOptions.sessionId = undefined;
        cliOptions.prompt = buildPrompt(req.messages, false);
      }

      try {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        for await (const line of invokeClaudeCLI(cliOptions)) {
          if (res.closed) break;

          if (line.type === "stream_event") {
            const streamEvent = line as CLIStreamEvent;
            const event = streamEvent.event;
            capturedSessionId = streamEvent.session_id || capturedSessionId;
            if (streamEvent.parent_tool_use_id) continue;

            if (event.type === "message_start" && !sentMessageStart) {
              sendSSE(res, "message_start", {
                type: "message_start",
                message: {
                  id: msgId,
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: req.model || "claude-sonnet-4-6",
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              });
              sentMessageStart = true;
            } else if (event.type === "content_block_start" && sentMessageStart) {
              if (event.content_block && (event.content_block as any).type === "tool_use") continue;
              sendSSE(res, "content_block_start", event);
              hasOpenBlock = true;
            } else if (event.type === "content_block_delta" && sentMessageStart) {
              const deltaType = (event.delta as any)?.type;
              if (deltaType && deltaType !== "text_delta") continue;
              sendSSE(res, "content_block_delta", event);
              if (deltaType === "text_delta") {
                resultText += (event.delta as any).text || "";
              }
            } else if (event.type === "content_block_stop" && sentMessageStart && hasOpenBlock) {
              sendSSE(res, "content_block_stop", event);
              hasOpenBlock = false;
            }
          } else if (line.type === "result") {
            const resultEvent = line as CLIResultEvent;
            capturedSessionId = resultEvent.session_id || capturedSessionId;
            resultText = resultEvent.result || resultText;
            if (!sentMessageStart) {
              sendSyntheticStream(res, msgId, req.model || "claude-sonnet-4-6", resultText);
              sentMessageStart = true;
            } else {
              if (hasOpenBlock)
                sendSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
              sendSSE(res, "message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 0 },
              });
              sendSSE(res, "message_stop", { type: "message_stop" });
            }
          }
        }
      } catch (retryErr: any) {
        console.error("[adapter] Stream retry also failed:", retryErr.message);
        sendSyntheticStream(
          res,
          msgId,
          req.model || "claude-sonnet-4-6",
          `Error: ${retryErr.message}`
        );
      }
    }
  }

  res.end();
  return { streamedText: resultText, cliSessionId: capturedSessionId };
}

// ── SSE helpers ──────────────────────────────────────────────────────────────

function sendSyntheticStream(res: Response, msgId: string, model: string, text: string): void {
  sendSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  sendSSE(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sendSSE(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  sendSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sendSSE(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 0 },
  });
  sendSSE(res, "message_stop", { type: "message_stop" });
}

function sendSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
