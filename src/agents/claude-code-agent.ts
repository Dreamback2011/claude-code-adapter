import { Agent, AgentOptions } from "agent-squad";
import type { ConversationMessage } from "agent-squad";
import { invokeClaudeCLI } from "../claude-cli.js";
import { recordMetric } from "../agent-metrics.js";
import { enrichContext, formatEnrichment } from "../memory/index.js";
import type { CLIStreamEvent, CLIResultEvent } from "../types.js";

export interface ClaudeCodeAgentOptions extends AgentOptions {
  systemPrompt?: string;
  allowedTools?: string;
  model?: string;
}

/**
 * Agent Squad agent that wraps our Claude Code CLI directly.
 * No HTTP roundtrip — calls invokeClaudeCLI() under the hood.
 *
 * IMPORTANT: processRequest must return ConversationMessage (not AgentResponse).
 * The orchestrator's dispatchToAgent expects: { role, content: [{ text }] }
 */
export class ClaudeCodeAgent extends Agent {
  private systemPrompt?: string;
  private allowedTools: string;
  private model?: string;

  constructor(options: ClaudeCodeAgentOptions) {
    super(options);
    this.systemPrompt = options.systemPrompt;
    this.allowedTools = options.allowedTools ?? process.env.ALLOWED_TOOLS ?? "none";
    this.model = options.model;
  }

  async processRequest(
    inputText: string,
    userId: string,
    sessionId: string,
    chatHistory: ConversationMessage[],
    _additionalParams?: Record<string, string>
  ): Promise<ConversationMessage> {
    // === Memory enrichment: load relevant memories + active progress ===
    let memoryContext = "";
    try {
      const callerCtx = { sessionId, userId, agentId: this.id };
      const enrichment = await enrichContext(this.id, callerCtx, inputText);
      memoryContext = formatEnrichment(enrichment);
      if (memoryContext) {
        console.log(
          `[agent:${this.id}] Memory enriched: ${enrichment.memories.length} memories, ${enrichment.activeProgress.length} progress`
        );
      }
    } catch (err: any) {
      // Non-fatal: proceed without memory context
      console.warn(`[agent:${this.id}] Memory enrichment failed:`, err.message);
    }

    // Build a prompt that includes recent conversation history
    const historyText = chatHistory
      .slice(-10) // last 5 turns
      .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${
        Array.isArray(m.content)
          ? m.content.map((c: any) => c.text ?? "").join("")
          : String(m.content)
      }`)
      .join("\n");

    const fullPrompt = memoryContext
      + (historyText ? `${historyText}\nHuman: ${inputText}` : inputText);

    let resultText = "";
    const agentStartTime = Date.now();
    let cliCostUsd = 0;
    let cliDurationMs = 0;

    try {
      for await (const line of invokeClaudeCLI({
        prompt: fullPrompt,
        systemPrompt: this.systemPrompt,
        allowedTools: this.allowedTools,
        model: this.model,
      })) {
        if (line.type === "result") {
          const r = line as CLIResultEvent;
          console.log(`[agent:${this.id}] result: streamed=${resultText.length} result=${(r.result || "").length}`);
          if (!resultText && r.result) {
            resultText = r.result;
          }
          // Capture cost and duration from CLI result
          if (r.cost_usd) cliCostUsd = r.cost_usd;
          if (r.duration_ms) cliDurationMs = r.duration_ms;
        } else if (line.type === "stream_event") {
          const se = line as CLIStreamEvent;
          const evt = se.event;
          if (evt?.type === "content_block_delta") {
            const delta = (evt.delta as any);
            if (delta?.type === "text_delta") {
              resultText += delta.text ?? "";
            }
          }
        }
      }
    } catch (err: any) {
      const errorLatency = Date.now() - agentStartTime;
      // Check if it's a timeout error
      if (err.message?.includes("timeout") || err.message?.includes("Idle timeout")) {
        recordMetric({ type: "timeout", agentId: this.id });
      } else {
        recordMetric({ type: "error", agentId: this.id, latencyMs: errorLatency });
      }
      resultText = `[ClaudeCodeAgent error: ${err.message}]`;
    }

    // Return ConversationMessage format — this is what the orchestrator expects
    // dispatchToAgent reads: response.content[0].text
    return {
      role: "assistant" as any,
      content: [{ text: resultText || "(no response)" }],
    };
  }
}
