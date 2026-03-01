/**
 * Task Runner — 异步执行 Agent Squad 任务 + Discord Webhook 回传
 *
 * 流程:
 * 1. server.ts 收到带 async:true 的请求 → 创建 task → 返回 202
 * 2. runTaskAsync() fire-and-forget:
 *    a. routing → Agent Squad 分类
 *    b. executing → Agent 执行
 *    c. delivering → POST 结果到 Discord Webhook（自动按 agent 路由频道）
 *    d. done / failed
 */

import type { AgentSquad } from "agent-squad";
import { taskManager } from "./task-manager.js";
import { recordAgentUse } from "./agent-learning.js";
import { recordMetric, normalizeAgentId } from "./agent-metrics.js";
import { resolveWebhookUrl, splitForDiscord, getChannelWebhook } from "./webhook-config.js";
import { isEmptyResponse, extractOutput } from "./utils.js";

// ── Discord Webhook Delivery ─────────────────────────────────────────────────

async function deliverToDiscord(webhookUrl: string, content: string): Promise<void> {
  const maxRetries = 2;
  const chunks = splitForDiscord(content);

  for (const chunk of chunks) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: chunk }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        console.log(`[webhook] Discord chunk delivered (attempt ${attempt + 1})`);
        break; // chunk success, move to next
      } catch (err: any) {
        console.error(`[webhook] Discord delivery failed (attempt ${attempt + 1}/${maxRetries + 1}):`, err.message);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          throw err;
        }
      }
    }

    // Small delay between chunks to avoid Discord rate limits
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ── Task Runner ───────────────────────────────────────────────────────────────

/**
 * Run a task asynchronously through Agent Squad and deliver via Discord Webhook.
 * This is fire-and-forget — caller does not await.
 *
 * Webhook resolution priority:
 * 1. Explicit webhook_url from request metadata
 * 2. Auto-resolve by agent ID → channel mapping (webhook-config.ts)
 * 3. Fallback to "general" channel
 */
export async function runTaskAsync(
  taskId: string,
  userInput: string,
  squad: AgentSquad,
  webhookUrl?: string,
  sessionId?: string
): Promise<void> {
  const requestId = taskId;
  let agentId = "unknown";
  let agentName = "Unknown";

  try {
    // ── Step 1: Routing ──────────────────────────────────────────────────
    taskManager.update(taskId, "routing", "Classifying intent via Agent Squad");

    const userId = "default";
    const sqSessionId = sessionId || `async-${taskId}`;
    const startTime = Date.now();

    let agentResponse = await squad.routeRequest(userInput, userId, sqSessionId);
    const latencyMs = Date.now() - startTime;

    let rawOutput = extractOutput(agentResponse.output);
    agentId = normalizeAgentId((agentResponse.metadata as any).agentId);
    agentName = agentResponse.metadata.agentName || "Unknown";

    // ── Step 2: Executing (classify completed → record) ──────────────────
    taskManager.update(taskId, "executing", `Agent "${agentName}" is processing`, {
      agentId,
      agentName,
    });

    // Fallback: if primary agent returned empty, try general
    if (isEmptyResponse(rawOutput) && agentId !== "general") {
      console.warn(`[task-runner] Empty response from ${agentName}, retrying with general...`);
      recordMetric({ type: "empty_response", agentId, latencyMs });
      recordMetric({ type: "fallback", agentId: "general", originalAgentId: agentId });

      try {
        const fallbackStart = Date.now();
        agentResponse = await squad.routeRequest(
          `[System: previous agent "${agentName}" failed to respond. Please handle this directly.]\n\n${userInput}`,
          userId,
          `${sqSessionId}-fallback`
        );
        const fallbackOutput = extractOutput(agentResponse.output);
        const fallbackLatency = Date.now() - fallbackStart;

        if (!isEmptyResponse(fallbackOutput)) {
          rawOutput = fallbackOutput;
          const fallbackAgentId = normalizeAgentId((agentResponse.metadata as any).agentId);
          agentId = fallbackAgentId === "unknown" ? "general" : fallbackAgentId;
          agentName = agentResponse.metadata.agentName || "General";
          recordMetric({ type: "success", agentId, latencyMs: fallbackLatency });
          taskManager.update(taskId, "executing", `Fallback to "${agentName}" succeeded`, {
            agentId,
            agentName,
          });
        } else {
          recordMetric({ type: "empty_response", agentId: "general", latencyMs: fallbackLatency });
        }
      } catch (fallbackErr: any) {
        recordMetric({ type: "error", agentId: "general", latencyMs: Date.now() - startTime });
        console.error(`[task-runner] Fallback failed:`, fallbackErr.message);
      }
    } else if (isEmptyResponse(rawOutput)) {
      recordMetric({ type: "empty_response", agentId, latencyMs });
    } else {
      recordMetric({ type: "success", agentId, latencyMs });
    }

    // Record learning
    recordAgentUse({
      requestId,
      agentId,
      agentName,
      sessionId: sqSessionId,
      inputText: userInput,
      outputText: rawOutput,
      timestamp: new Date().toISOString(),
    });

    const footer = `\n\n---\n_Agent: **${agentName}** | Feedback ID: \`${requestId}\`_`;
    const outputText = rawOutput + footer;

    // ── Step 3: Deliver via Discord Webhook ───────────────────────────────
    // Resolve webhook: explicit URL > agent→channel mapping > general
    const resolvedUrl = resolveWebhookUrl(agentId, webhookUrl);

    taskManager.update(taskId, "delivering", `Posting result to Discord`);

    try {
      await deliverToDiscord(resolvedUrl, outputText);

      taskManager.update(taskId, "done", "Discord webhook delivered successfully", {
        output: outputText,
        webhookDelivered: true,
        webhookChannel: resolvedUrl.includes("discord") ? "discord" : "custom",
      });
    } catch (whErr: any) {
      // Webhook failed but task itself succeeded
      taskManager.update(taskId, "done", `Task done, but webhook failed: ${whErr.message}`, {
        output: outputText,
        webhookDelivered: false,
        webhookError: whErr.message,
      });
    }

    console.log(`[task-runner] Task ${taskId} completed: agent=${agentName}, output=${rawOutput.length} chars`);
  } catch (err: any) {
    console.error(`[task-runner] Task ${taskId} failed:`, err.message);
    recordMetric({ type: "error", agentId, latencyMs: 0 });

    taskManager.update(taskId, "failed", `Error: ${err.message}`);

    // Try to deliver error via Discord webhook (to debug channel)
    const errorWebhook = getChannelWebhook("debug");
    if (errorWebhook) {
      try {
        await deliverToDiscord(errorWebhook, `**Task Failed** \`${taskId}\`\n\nError: ${err.message}`);
      } catch (_) {
        // Best effort
      }
    }
  }
}
