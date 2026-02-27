import express from "express";
import { createAuthMiddleware } from "./auth.js";
import { handleNonStreaming, handleStreaming } from "./adapter.js";
import type { AnthropicRequest } from "./types.js";
import type { AgentSquad } from "agent-squad";
import { logMessage } from "./message-logger.js";

export interface ServerConfig {
  port: number;
  apiKey: string;
  allowedTools: string;
  useAgentSquad?: boolean;
}

// Lazily initialized AgentSquad — created once on first use if enabled
let squadInstance: AgentSquad | null = null;

async function getSquad(config: ServerConfig): Promise<AgentSquad> {
  if (!squadInstance) {
    const { createSquad } = await import("./squad.js");
    squadInstance = createSquad(config.allowedTools);
  }
  return squadInstance;
}

export function createServer(config: ServerConfig) {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Request logging
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // Auth middleware
  app.use("/v1", createAuthMiddleware(config.apiKey));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "claude-code-adapter" });
  });

  const modelInfo = {
    id: "claude-sonnet-4-6",
    object: "model",
    created: Date.now(),
    owned_by: "anthropic",
    display_name: "Claude Code CLI (Sonnet 4.6)",
    context_window: 200000,
    max_output_tokens: 128000,
  };

  // Models endpoint (for OpenClaw discovery)
  app.get("/v1/models", (_req, res) => {
    res.json({ data: [modelInfo] });
  });
  app.get("/v1/models/:modelId", (_req, res) => {
    res.json(modelInfo);
  });

  // Also serve models without /v1 prefix
  app.get("/models", (_req, res) => {
    res.json({ data: [modelInfo] });
  });
  app.get("/models/:modelId", (_req, res) => {
    res.json(modelInfo);
  });

  // Messages endpoint — also without /v1 prefix
  app.post("/messages", messagesHandler(config));
  // Messages endpoint — core
  app.post("/v1/messages", messagesHandler(config));

  return app;
}

function messagesHandler(config: ServerConfig) {
  return async (req: express.Request, res: express.Response) => {
    const body = req.body as AnthropicRequest;

    console.log("[messages] Body:", JSON.stringify(body).slice(0, 500));

    // Basic validation
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages array is required and must not be empty",
        },
      });
      return;
    }

    // Quick ping detection: if max_tokens <= 1 or message is very short,
    // treat as verification and return instant synthetic response
    const lastMsg = body.messages[body.messages.length - 1];
    const msgText = typeof lastMsg.content === "string"
      ? lastMsg.content
      : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const isVerification = body.max_tokens <= 1 || msgText.length <= 2;

    if (isVerification) {
      console.log("[messages] Verification ping detected, returning quick response");
      const { v4: uuidv4 } = await import("uuid");
      res.json({
        id: `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        model: body.model || "claude-code-cli",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }

    try {
      if (config.useAgentSquad) {
        // Route through Agent Squad: classify intent → dispatch to specialist agent
        await handleAgentSquad(body, res, config);
      } else if (body.stream) {
        const streamResult = await handleStreaming(body, res, config.allowedTools);
        logMessage(msgText, streamResult);
      } else {
        const response = await handleNonStreaming(body, config.allowedTools);
        const outText = response.content?.map((b: any) => b.text ?? "").join("") ?? "";
        logMessage(msgText, outText, response.usage?.input_tokens, response.usage?.output_tokens);
        res.json(response);
      }
    } catch (err: any) {
      console.error("[adapter] Error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({
          type: "error",
          error: {
            type: "api_error",
            message: err.message || "Internal server error",
          },
        });
      }
    }
  };
}

/**
 * Route a request through Agent Squad:
 * 1. Classify intent → pick the best specialized agent
 * 2. Agent processes the request via Claude Code CLI
 * 3. Wrap result in Anthropic Messages API response format
 */
async function handleAgentSquad(
  body: AnthropicRequest,
  res: express.Response,
  config: ServerConfig
): Promise<void> {
  const { v4: uuidv4 } = await import("uuid");

  // Extract user input text
  const lastMsg = body.messages[body.messages.length - 1];
  const userInput = typeof lastMsg.content === "string"
    ? lastMsg.content
    : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

  // Use message ID as sessionId so the same conversation routes to the same agent context
  const userId = "default";
  const sessionId = body.metadata?.user_id ?? "session-default";

  console.log(`[squad] Routing request for session=${sessionId}, input="${userInput.slice(0, 100)}..."`);

  const squad = await getSquad(config);
  const agentResponse = await squad.routeRequest(userInput, userId, sessionId);

  const outputText = typeof agentResponse.output === "string"
    ? agentResponse.output
    : agentResponse.output instanceof Object && "getAccumulatedData" in (agentResponse.output as any)
      ? (agentResponse.output as any).getAccumulatedData()
      : String(agentResponse.output);

  console.log(`[squad] Response from agent=${agentResponse.metadata.agentName}, length=${outputText.length}`);

  if (body.stream) {
    // Emit SSE stream with the result
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`;

    const emit = (event: string, data: object) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: body.model || "claude-code-cli",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: userInput.length, output_tokens: 0 },
      },
    });

    emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    emit("ping", { type: "ping" });
    emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: outputText } });
    emit("content_block_stop", { type: "content_block_stop", index: 0 });

    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputText.split(" ").length },
    });
    emit("message_stop", { type: "message_stop" });

    res.end();
  } else {
    res.json({
      id: `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: outputText }],
      model: body.model || "claude-code-cli",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: userInput.length,
        output_tokens: outputText.split(" ").length,
      },
    });
  }
}
