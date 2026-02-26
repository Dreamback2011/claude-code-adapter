import express from "express";
import { createAuthMiddleware } from "./auth.js";
import { handleNonStreaming, handleStreaming } from "./adapter.js";
import type { AnthropicRequest } from "./types.js";

export interface ServerConfig {
  port: number;
  apiKey: string;
  allowedTools: string;
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
      if (body.stream) {
        await handleStreaming(body, res, config.allowedTools);
      } else {
        const response = await handleNonStreaming(body, config.allowedTools);
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
