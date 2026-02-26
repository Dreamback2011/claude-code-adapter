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
} from "./types.js";

/**
 * Extract the prompt text from the Anthropic messages array.
 */
function extractPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      const textParts = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      return textParts.join("\n");
    }
  }
  return "";
}

function extractSystemPrompt(system: string | SystemBlock[] | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

function buildCLIOptions(req: AnthropicRequest, allowedTools: string): CLIOptions {
  return {
    prompt: extractPrompt(req.messages),
    systemPrompt: extractSystemPrompt(req.system),
    allowedTools,
  };
}

/**
 * Handle a non-streaming request.
 * Internally uses streaming CLI, collects result, returns JSON response.
 */
export async function handleNonStreaming(
  req: AnthropicRequest,
  allowedTools: string
): Promise<AnthropicResponse> {
  console.log("[adapter] handleNonStreaming - starting CLI");
  const cliOptions = buildCLIOptions(req, allowedTools);

  let resultText = "";

  for await (const line of invokeClaudeCLI(cliOptions)) {
    if (line.type === "result") {
      const r = line as CLIResultEvent;
      resultText = r.result || resultText;
    } else if (line.type === "stream_event") {
      const se = line as CLIStreamEvent;
      if (se.event?.type === "content_block_delta") {
        const delta = se.event.delta as any;
        if (delta?.type === "text_delta") {
          resultText += delta.text || "";
        }
      }
    }
  }

  console.log("[adapter] handleNonStreaming - done, result length:", resultText.length);

  return {
    id: `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: resultText || "(no response)" }],
    model: req.model || "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Handle a streaming request.
 * Forwards CLI stream events as Anthropic SSE.
 */
export async function handleStreaming(
  req: AnthropicRequest,
  res: Response,
  allowedTools: string
): Promise<void> {
  console.log("[adapter] handleStreaming - starting CLI");
  const cliOptions = buildCLIOptions(req, allowedTools);

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

  try {
    for await (const line of invokeClaudeCLI(cliOptions)) {
      if (res.closed) {
        console.log("[adapter] Client disconnected");
        break;
      }

      if (line.type === "stream_event") {
        const streamEvent = line as CLIStreamEvent;
        const event = streamEvent.event;

        // Skip nested events from tool use
        if (streamEvent.parent_tool_use_id) {
          continue;
        }

        // Debug: log every event type from CLI
        console.log("[cli-event]", event.type, "parent:", streamEvent.parent_tool_use_id ?? "none");

        if (event.type === "message_start") {
          // Only send the FIRST message_start, skip all subsequent ones
          if (sentMessageStart) {
            console.log("[adapter] Skipping duplicate message_start");
            continue;
          }
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
          // Only forward text blocks, skip tool_use blocks
          if (event.content_block && (event.content_block as any).type === "tool_use") {
            continue;
          }
          sendSSE(res, "content_block_start", event);
          hasOpenBlock = true;
          contentBlockIndex = (event.index ?? contentBlockIndex) + 1;
        } else if (event.type === "content_block_delta") {
          if (!sentMessageStart) continue;
          // Only forward text deltas
          const deltaType = (event.delta as any)?.type;
          if (deltaType && deltaType !== "text_delta") {
            continue;
          }
          sendSSE(res, "content_block_delta", event);
          if (deltaType === "text_delta") {
            resultText += (event.delta as any).text || "";
          }
        } else if (event.type === "content_block_stop") {
          if (!sentMessageStart || !hasOpenBlock) continue;
          sendSSE(res, "content_block_stop", event);
          hasOpenBlock = false;
        } else if (event.type === "message_delta") {
          if (!sentMessageStart) continue;
          // Don't forward message_delta from mid-stream, we send our own at the end
          continue;
        } else if (event.type === "message_stop") {
          // Don't forward message_stop from CLI — we send our own after result
          console.log("[adapter] Skipping CLI message_stop (will send after result)");
          continue;
        } else if (event.type === "ping") {
          sendSSE(res, "ping", { type: "ping" });
        }
      } else if (line.type === "result") {
        const resultEvent = line as CLIResultEvent;
        resultText = resultEvent.result || resultText;
        console.log("[adapter] Got result, length:", resultText.length);

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
      sendSyntheticStream(res, msgId, req.model || "claude-sonnet-4-6", `Error: ${err.message}`);
    }
  }

  console.log("[adapter] handleStreaming - done");
  res.end();
}

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
  console.log("[sse]", event);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
