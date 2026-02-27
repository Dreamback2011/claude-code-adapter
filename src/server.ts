import express from "express";
import { createAuthMiddleware } from "./auth.js";
import { handleNonStreaming, handleStreaming } from "./adapter.js";
import type { AnthropicRequest } from "./types.js";
import type { AgentSquad } from "agent-squad";
import { logMessage } from "./message-logger.js";
import { SessionStore } from "./session-store.js";
import {
  recordAgentUse,
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
} from "./agent-learning.js";

export interface ServerConfig {
  port: number;
  apiKey: string;
  allowedTools: string;
  useAgentSquad?: boolean;
}

// Session store: maps external session IDs → Claude CLI session IDs
// TTL = 24 hours, persists to .sessions.json
const sessions = new SessionStore(24);

// Lazily initialized AgentSquad
let squadInstance: AgentSquad | null = null;

async function getSquad(config: ServerConfig): Promise<AgentSquad> {
  if (!squadInstance) {
    const { createSquad } = await import("./squad.js");
    squadInstance = createSquad(config.allowedTools);
  }
  return squadInstance;
}

/**
 * Extract session ID from request.
 * Checks multiple sources so OpenClaw/Discord can send it however they want.
 */
function extractSessionId(req: express.Request, body: AnthropicRequest): string {
  return (
    (req.headers["x-session-id"] as string) ||
    (body.metadata?.session_id as string) ||
    (body.metadata?.user_id as string) ||
    "default"
  );
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

  // ── Health & Info ──────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    const stats = sessions.stats();
    res.json({
      status: "ok",
      service: "claude-code-adapter",
      sessions: stats.total,
      agentSquad: config.useAgentSquad ? "enabled" : "disabled",
    });
  });

  // Session monitoring endpoint
  app.get("/v1/sessions", createAuthMiddleware(config.apiKey), (_req, res) => {
    res.json(sessions.stats());
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
  app.get("/models", (_req, res) => {
    res.json({ data: [modelInfo] });
  });
  app.get("/models/:modelId", (_req, res) => {
    res.json(modelInfo);
  });

  // ── Agent Learning endpoints ───────────────────────────────────────────────

  app.post("/v1/agent-feedback", createAuthMiddleware(config.apiKey), (req, res) => {
    const { requestId, rating, comment } = req.body as {
      requestId?: string;
      rating?: string;
      comment?: string;
    };

    if (!requestId || !rating) {
      res.status(400).json({ error: 'Missing required fields: requestId, rating ("good" or "bad")' });
      return;
    }
    if (rating !== "good" && rating !== "bad") {
      res.status(400).json({ error: 'rating must be "good" or "bad"' });
      return;
    }

    const result = rateRequest(requestId, rating, comment);
    res.json(result);
  });

  app.get("/v1/agent-stats", createAuthMiddleware(config.apiKey), (_req, res) => {
    res.json(getAllAgentStats());
  });

  app.get("/v1/agent-sessions/:agentId", createAuthMiddleware(config.apiKey), (req, res) => {
    const files = listGoodSamples(req.params.agentId);
    res.json({ agentId: req.params.agentId, samples: files });
  });

  app.get("/v1/agent-sessions/:agentId/:filename", createAuthMiddleware(config.apiKey), (req, res) => {
    const sample = readGoodSample(req.params.agentId, req.params.filename);
    if (!sample) {
      res.status(404).json({ error: "Sample not found" });
      return;
    }
    res.json(sample);
  });

  // ── Messages endpoint ──────────────────────────────────────────────────────

  app.post("/messages", messagesHandler(config));
  app.post("/v1/messages", messagesHandler(config));

  return app;
}

function messagesHandler(config: ServerConfig) {
  return async (req: express.Request, res: express.Response) => {
    const body = req.body as AnthropicRequest;

    // Extract session ID for multi-session support
    const externalSessionId = extractSessionId(req, body);
    console.log(`[messages] session=${externalSessionId} body=${JSON.stringify(body).slice(0, 300)}`);

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

    // Quick ping detection
    const lastMsg = body.messages[body.messages.length - 1];
    const msgText = typeof lastMsg.content === "string"
      ? lastMsg.content
      : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const isVerification = body.max_tokens <= 1 || msgText.length <= 2;

    if (isVerification) {
      console.log("[messages] Verification ping detected");
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

    // Look up existing CLI session for this external session
    const existingSession = sessions.get(externalSessionId);
    const cliSessionId = existingSession?.cliSessionId;

    if (cliSessionId) {
      console.log(`[messages] Resuming CLI session: ${cliSessionId} (${existingSession!.messageCount} msgs)`);
    } else {
      console.log(`[messages] New CLI session for: ${externalSessionId}`);
    }

    try {
      if (config.useAgentSquad) {
        await handleAgentSquad(body, res, config, externalSessionId, cliSessionId);
      } else if (body.stream) {
        const result = await handleStreaming(body, res, config.allowedTools, cliSessionId);

        // Store CLI session ID for future resumption
        if (result.cliSessionId) {
          sessions.set(externalSessionId, result.cliSessionId);
        }

        logMessage(msgText, result.streamedText);
      } else {
        const result = await handleNonStreaming(body, config.allowedTools, cliSessionId);

        // Store CLI session ID for future resumption
        if (result.cliSessionId) {
          sessions.set(externalSessionId, result.cliSessionId);
        }

        const outText = result.response.content?.map((b: any) => b.text ?? "").join("") ?? "";
        logMessage(msgText, outText, result.response.usage?.input_tokens, result.response.usage?.output_tokens);
        res.json(result.response);
      }
    } catch (err: any) {
      console.error("[adapter] Error:", err.message);

      // If resume failed, clear the stale session so next request starts fresh
      if (cliSessionId) {
        console.log(`[sessions] Clearing stale session: ${externalSessionId}`);
        sessions.remove(externalSessionId);
      }

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
 * Route a request through Agent Squad.
 * Also supports session resumption.
 */
async function handleAgentSquad(
  body: AnthropicRequest,
  res: express.Response,
  config: ServerConfig,
  externalSessionId: string,
  cliSessionId?: string
): Promise<void> {
  const { v4: uuidv4 } = await import("uuid");

  const lastMsg = body.messages[body.messages.length - 1];
  const userInput = typeof lastMsg.content === "string"
    ? lastMsg.content
    : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

  const userId = "default";
  const sessionId = externalSessionId;
  const requestId = uuidv4();

  console.log(`[squad] Routing: session=${sessionId}, requestId=${requestId}, resume=${cliSessionId ?? "none"}`);

  const squad = await getSquad(config);
  const agentResponse = await squad.routeRequest(userInput, userId, sessionId);

  const rawOutput = typeof agentResponse.output === "string"
    ? agentResponse.output
    : agentResponse.output instanceof Object && "getAccumulatedData" in (agentResponse.output as any)
      ? (agentResponse.output as any).getAccumulatedData()
      : String(agentResponse.output);

  const agentId: string = (agentResponse.metadata as any).agentId ?? "unknown";
  const agentName: string = agentResponse.metadata.agentName ?? "Unknown";

  console.log(`[squad] Response from agent=${agentName}, length=${rawOutput.length}`);

  recordAgentUse({
    requestId,
    agentId,
    agentName,
    sessionId,
    inputText: userInput,
    outputText: rawOutput,
    timestamp: new Date().toISOString(),
  });

  const footer = `\n\n---\n_Agent: **${agentName}** | Feedback ID: \`${requestId}\`_`;
  const outputText = rawOutput + footer;

  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Agent-Id", agentId);
    res.setHeader("X-Agent-Name", agentName);

    const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 20)}`;

    const emit = (event: string, data: object) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model: body.model || "claude-code-cli",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: userInput.length, output_tokens: 0 },
      },
    });
    emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
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
    res.setHeader("X-Agent-Id", agentId);
    res.setHeader("X-Agent-Name", agentName);
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
