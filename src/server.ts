import express from "express";
import { createAuthMiddleware } from "./auth.js";
import { handleNonStreaming, handleStreaming } from "./adapter.js";
import type { AnthropicRequest } from "./types.js";
import type { AgentSquad } from "agent-squad";
import { logMessage } from "./message-logger.js";
import { SessionStore } from "./session-store.js";
import { createWeComRouter, type WeComConfig } from "./wecom/index.js";
import { taskManager } from "./task-manager.js";
import { runTaskAsync } from "./task-runner.js";
import { recordMetric, normalizeAgentId } from "./agent-metrics.js";
import { sendToChannel, resolveChannelName, DISCORD_CHANNELS, type ChannelName } from "./webhook-config.js";
import { rateRequest, reportExecution, searchMemories, createMemory, getMemory, updateMemory, deleteMemory, getSystemStatus } from "./memory/index.js";
import { isEmptyResponse, extractOutput } from "./utils.js";

export interface ServerConfig {
  port: number;
  apiKey: string;
  allowedTools: string;
  useAgentSquad?: boolean;
}

// Session store: maps external session IDs → Claude CLI session IDs
// TTL = 24 hours, persists to .sessions.json
const sessions = new SessionStore(24);

// Concurrency control: limit parallel CLI processes to prevent resource exhaustion
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "20", 10);
let activeCLI = 0;
const waitQueue: Array<() => void> = [];

function acquireCLISlot(): Promise<void> {
  if (activeCLI < MAX_CONCURRENT) {
    activeCLI++;
    console.log(`[concurrency] Acquired slot (${activeCLI}/${MAX_CONCURRENT})`);
    return Promise.resolve();
  }
  console.log(`[concurrency] Queue full (${activeCLI}/${MAX_CONCURRENT}), waiting...`);
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseCLISlot(): void {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    console.log(`[concurrency] Released slot to queued request (${waitQueue.length} still waiting)`);
    next();
  } else {
    activeCLI--;
    console.log(`[concurrency] Released slot (${activeCLI}/${MAX_CONCURRENT})`);
  }
}

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
 * Checks: header → metadata → OpenClaw channel ID embedded in message text.
 */
function extractSessionId(req: express.Request, body: AnthropicRequest): string {
  // 1. Explicit header
  if (req.headers["x-session-id"]) return req.headers["x-session-id"] as string;

  // 2. Metadata fields
  if (body.metadata?.session_id) return body.metadata.session_id as string;
  if (body.metadata?.user_id) return body.metadata.user_id as string;

  // 3. OpenClaw embeds channel info in message text like "channel id:1466904527449100359"
  const lastMsg = body.messages?.[body.messages.length - 1];
  if (lastMsg) {
    const text = typeof lastMsg.content === "string"
      ? lastMsg.content
      : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const channelMatch = text.match(/channel id:(\d{10,})/);
    if (channelMatch) return `discord-${channelMatch[1]}`;
  }

  return "default";
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
      concurrency: { active: activeCLI, max: MAX_CONCURRENT, queued: waitQueue.length },
      tasks: taskManager.stats(),
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

  // ── WeCom Webhook (企业微信回调，无需 API Key 认证) ──────────────────────────
  const wecomCorpId = process.env.WECOM_CORP_ID;
  const wecomCorpSecret = process.env.WECOM_CORP_SECRET;
  const wecomAgentId = process.env.WECOM_AGENT_ID;
  const wecomToken = process.env.WECOM_TOKEN;
  const wecomEncodingAESKey = process.env.WECOM_ENCODING_AES_KEY;

  if (wecomCorpId && wecomCorpSecret && wecomAgentId && wecomToken && wecomEncodingAESKey) {
    const wecomConfig: WeComConfig = {
      corpId: wecomCorpId,
      corpSecret: wecomCorpSecret,
      agentId: parseInt(wecomAgentId, 10),
      token: wecomToken,
      encodingAESKey: wecomEncodingAESKey,
    };
    app.use("/wecom/callback", createWeComRouter(wecomConfig));
    console.log("[wecom] Webhook endpoint registered at /wecom/callback");
  } else {
    console.log("[wecom] Disabled — missing env vars (WECOM_CORP_ID, WECOM_CORP_SECRET, WECOM_AGENT_ID, WECOM_TOKEN, WECOM_ENCODING_AES_KEY)");
  }

  // ── Task Monitoring endpoints ─────────────────────────────────────────────

  // List all tasks
  app.get("/v1/tasks", createAuthMiddleware(config.apiKey), (_req, res) => {
    res.json({ tasks: taskManager.list(), stats: taskManager.stats() });
  });

  // Get single task
  app.get("/v1/tasks/:taskId", createAuthMiddleware(config.apiKey), (req, res) => {
    const task = taskManager.get(req.params.taskId as string);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  // SSE stream for real-time task monitoring
  app.get("/v1/tasks/:taskId/stream", createAuthMiddleware(config.apiKey), (req, res) => {
    const taskId = req.params.taskId as string;
    const task = taskManager.get(taskId);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.on("error", (err: any) => {
      console.warn("[tasks] Stream error:", err.message);
    });

    // Send current state first (replay all events)
    for (const event of task.events) {
      res.write(`event: task_update\ndata: ${JSON.stringify(event)}\n\n`);
    }

    // If already terminal, close
    if (task.status === "done" || task.status === "failed") {
      res.write(`event: task_end\ndata: ${JSON.stringify({ status: task.status })}\n\n`);
      res.end();
      return;
    }

    // Subscribe to future events
    const listener = (event: any) => {
      res.write(`event: task_update\ndata: ${JSON.stringify(event)}\n\n`);

      // Close stream on terminal status
      if (event.status === "done" || event.status === "failed") {
        res.write(`event: task_end\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
        res.end();
      }
    };

    taskManager.on(`task:${taskId}`, listener);

    // Cleanup on disconnect
    req.on("close", () => {
      taskManager.removeListener(`task:${taskId}`, listener);
    });
  });

  // ── Memory Feedback ──────────────────────────────────────────────────────
  app.post("/v1/memory/feedback", createAuthMiddleware(config.apiKey), (req, res) => {
    const { requestId, rating, comment } = req.body;
    if (!requestId || !["good", "bad"].includes(rating)) {
      res.status(400).json({ error: "requestId and rating ('good'|'bad') required" });
      return;
    }
    try {
      rateRequest(requestId, rating);
      // TODO: store comment for future analysis
      if (comment) {
        console.log(`[memory] Feedback comment for ${requestId}: ${comment}`);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Memory Search ───────────────────────────────────────────────────────
  app.post("/v1/memory/search", createAuthMiddleware(config.apiKey), (req, res) => {
    const { query, category, tags, source, limit } = req.body;
    try {
      const results = searchMemories({ search: query, category, tags, source, limit });
      res.json({ results, count: results.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Memory CRUD ────────────────────────────────────────────────────────
  app.post("/v1/memory/items", createAuthMiddleware(config.apiKey), (req, res) => {
    const { category, title, content, tags, source, tier, expiresAt } = req.body;
    if (!category || !title || !content || !source) {
      res.status(400).json({ error: "category, title, content, and source are required" });
      return;
    }
    try {
      const item = createMemory({ category, title, content, tags, source, tier, expiresAt });
      res.status(201).json(item);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/v1/memory/items", createAuthMiddleware(config.apiKey), (req, res) => {
    const { category, tags, source, search, limit } = req.query;
    try {
      const results = searchMemories({
        category: category as any,
        tags: tags ? (tags as string).split(",") : undefined,
        source: source as string | undefined,
        search: search as string | undefined,
        limit: limit ? parseInt(limit as string, 10) : 20,
      });
      res.json({ results, count: results.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/v1/memory/items/:id", createAuthMiddleware(config.apiKey), (req, res) => {
    const id = req.params.id as string;
    const item = getMemory(id);
    if (!item) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(item);
  });

  app.patch("/v1/memory/items/:id", createAuthMiddleware(config.apiKey), (req, res) => {
    const id = req.params.id as string;
    const { title, content, tags, tier, category, expiresAt } = req.body;
    const updated = updateMemory(id, { title, content, tags, tier, category, expiresAt });
    if (!updated) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(updated);
  });

  app.delete("/v1/memory/items/:id", createAuthMiddleware(config.apiKey), (req, res) => {
    const id = req.params.id as string;
    const deleted = deleteMemory(id);
    if (!deleted) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ success: true });
  });

  // ── Memory Status ─────────────────────────────────────────────────────
  app.get("/v1/memory/status", createAuthMiddleware(config.apiKey), (_req, res) => {
    const status = getSystemStatus();
    res.json(status);
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

    // ── Async mode: fire-and-forget + webhook ─────────────────────────────
    if (body.metadata?.async && config.useAgentSquad) {
      const { v4: uuidv4 } = await import("uuid");
      const taskId = uuidv4();
      const webhookUrl = body.metadata.webhook_url as string | undefined;

      // Create task and return 202 immediately
      const task = taskManager.create(taskId, msgText, webhookUrl);
      console.log(`[messages] Async task created: ${taskId}, webhook=${webhookUrl || "none"}`);

      // Fire-and-forget: run in background, don't await
      const squad = await getSquad(config);
      runTaskAsync(taskId, msgText, squad, webhookUrl, externalSessionId).catch((err) => {
        console.error(`[messages] Async task ${taskId} unhandled error:`, err.message);
      });

      res.status(202).json({
        task_id: taskId,
        status: "queued",
        monitor: `/v1/tasks/${taskId}`,
        stream: `/v1/tasks/${taskId}/stream`,
        created_at: task.createdAt,
      });
      return;
    }

    // ── Sync mode (original path) ───────────────────────────────────────

    // Look up existing CLI session for this external session
    const existingSession = sessions.get(externalSessionId);
    const cliSessionId = existingSession?.cliSessionId;

    if (cliSessionId) {
      console.log(`[messages] Resuming CLI session: ${cliSessionId} (${existingSession!.messageCount} msgs)`);
    } else {
      console.log(`[messages] New CLI session for: ${externalSessionId}`);
    }

    // Acquire a CLI slot (queues if at max concurrency)
    await acquireCLISlot();

    let lastAgentId = "unrouted";
    try {
      if (config.useAgentSquad) {
        const result = await handleAgentSquad(body, res, config, externalSessionId, cliSessionId);
        lastAgentId = result.agentId;
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

      // Record error metric with captured agent context
      if (config.useAgentSquad) {
        recordMetric({ type: "error", agentId: lastAgentId, latencyMs: 0 });
      }

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
    } finally {
      releaseCLISlot();
    }
  };
}

/**
 * Route a request through Agent Squad.
 * Also supports session resumption.
 * If the primary agent returns an empty/error response, falls back to the general agent.
 */
async function handleAgentSquad(
  body: AnthropicRequest,
  res: express.Response,
  config: ServerConfig,
  externalSessionId: string,
  cliSessionId?: string
): Promise<{ agentId: string }> {
  const { v4: uuidv4 } = await import("uuid");

  const lastMsg = body.messages[body.messages.length - 1];
  const userInput = typeof lastMsg.content === "string"
    ? lastMsg.content
    : (lastMsg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

  // Extract user identity from message metadata (e.g., Discord sender_id)
  const metaUserId = body.metadata?.user_id as string | undefined;
  const senderIdMatch = userInput.match(/"sender_id":\s*"(\d+)"/);
  const userId = metaUserId ?? senderIdMatch?.[1] ?? "default";
  const sessionId = externalSessionId;
  const requestId = uuidv4();

  console.log(`[squad] Routing: session=${sessionId}, requestId=${requestId}, resume=${cliSessionId ?? "none"}`);

  const squad = await getSquad(config);
  const startTime = Date.now();
  let agentResponse = await squad.routeRequest(userInput, userId, sessionId);
  const latencyMs = Date.now() - startTime;

  let rawOutput = extractOutput(agentResponse.output);
  let agentId: string = normalizeAgentId((agentResponse.metadata as any).agentId);
  let agentName: string = agentResponse.metadata.agentName || "Unknown";

  // Fallback: if primary agent returned empty/error, retry with general agent
  if (isEmptyResponse(rawOutput) && agentId !== "general") {
    console.warn(`[squad] Empty response from agent=${agentName} (${agentId}), retrying with general agent...`);

    // Record routing-level events: original agent failed + fallback triggered
    recordMetric({ type: "empty_response", agentId, latencyMs });
    recordMetric({ type: "fallback", agentId: "general", originalAgentId: agentId });

    try {
      const fallbackStart = Date.now();
      agentResponse = await squad.routeRequest(
        `[System: previous agent "${agentName}" failed to respond. Please handle this directly.]\n\n${userInput}`,
        userId,
        `${sessionId}-fallback`
      );
      const fallbackLatency = Date.now() - fallbackStart;
      const fallbackOutput = extractOutput(agentResponse.output);
      if (!isEmptyResponse(fallbackOutput)) {
        rawOutput = fallbackOutput;
        const fallbackAgentId = normalizeAgentId((agentResponse.metadata as any).agentId);
        agentId = fallbackAgentId === "unrouted" ? "general" : fallbackAgentId;
        agentName = agentResponse.metadata.agentName || "General";
        console.log(`[squad] Fallback succeeded: agent=${agentName}, length=${rawOutput.length}`);
      } else {
        console.warn(`[squad] Fallback also returned empty, using original response`);
      }
    } catch (fallbackErr: any) {
      recordMetric({ type: "error", agentId: "general", latencyMs: Date.now() - startTime });
      console.error(`[squad] Fallback failed:`, fallbackErr.message);
    }
  }

  console.log(`[squad] Response from agent=${agentName}, length=${rawOutput.length}`);

  const footer = `\n\n---\n_Agent: **${agentName}** | Feedback ID: \`${requestId}\`_`;
  const outputText = rawOutput + footer;

  // Fire-and-forget: report execution to memory system
  try {
    reportExecution({
      agentId,
      agentName,
      requestId,
      sessionId,
      inputText: userInput,
      outputText: rawOutput,
      latencyMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn("[memory] reportExecution failed:", err.message);
  }

  // Auto-deliver via Discord webhook — 所有来自 Discord 的请求都走 Webhook
  let webhookDelivered = false;
  const channelMatch = userInput.match(/"group_channel":\s*"#?([\w-]+)"/);
  const isGroupChat = /"is_group_chat":\s*true/.test(userInput);

  if (channelMatch || isGroupChat) {
    // 确定目标频道：group_channel → agent 默认频道 → general
    let sourceChannel: ChannelName;
    const rawChannel = channelMatch?.[1];

    if (rawChannel && rawChannel in DISCORD_CHANNELS) {
      sourceChannel = rawChannel as ChannelName;
    } else {
      sourceChannel = resolveChannelName(agentId);
      if (rawChannel) {
        console.log(`[squad] Channel "${rawChannel}" not in webhook config, falling back to agent default: ${sourceChannel}`);
      }
    }

    console.log(`[squad] Webhook auto-delivery: attempting #${sourceChannel} for agent=${agentName}`);
    try {
      await sendToChannel(sourceChannel, outputText, agentName);
      webhookDelivered = true;
      console.log(`[squad] Webhook delivered to #${sourceChannel} for agent=${agentName} (${outputText.length} chars)`);
    } catch (whErr: any) {
      console.error(`[squad] Webhook delivery to #${sourceChannel} failed:`, whErr.message);
      // Fall through to normal HTTP response
    }
  } else {
    console.log(`[squad] No group_channel/is_group_chat found — skipping webhook auto-delivery`);
  }

  // Webhook already delivered — return 204 so Gateway doesn't send a duplicate
  if (webhookDelivered) {
    res.status(204).end();
    return { agentId };
  }

  const responseText = outputText;

  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Agent-Id", agentId);
    res.setHeader("X-Agent-Name", agentName);

    res.on("error", (err: any) => {
      console.warn("[squad] Response stream error:", err.message);
    });

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
    emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: responseText } });
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: responseText.split(" ").length },
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
      content: [{ type: "text", text: responseText }],
      model: body.model || "claude-code-cli",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: userInput.length,
        output_tokens: responseText.split(" ").length,
      },
    });
  }

  return { agentId };
}
