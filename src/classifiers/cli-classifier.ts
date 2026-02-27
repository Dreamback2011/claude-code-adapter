import { Classifier, ClassifierResult } from "agent-squad";
import type { ConversationMessage } from "agent-squad";
import { invokeClaudeCLI } from "../claude-cli.js";
import type { CLIResultEvent, CLIStreamEvent } from "../types.js";

/**
 * Agent Squad classifier that uses Claude Code CLI directly for intent routing.
 * No HTTP roundtrip — no circular dependency with the local adapter server.
 *
 * Sends a special classification prompt to Claude CLI and parses the XML response
 * to determine which registered agent should handle the request.
 */
export class CLIClassifier extends Classifier {
  private allowedTools: string;
  private model?: string;

  constructor(options?: { allowedTools?: string; model?: string }) {
    super();
    this.allowedTools = options?.allowedTools ?? "none";
    this.model = options?.model;
  }

  async processRequest(
    inputText: string,
    _chatHistory: ConversationMessage[]
  ): Promise<ClassifierResult> {
    // Build classification prompt using Agent Squad's system prompt (contains agent descriptions)
    // Category guidance injected to help the LLM understand the routing intent
    const categoryHint = `
ROUTING CATEGORIES (use these as primary signals):
- 💼 work-agent    : BD strategy, crypto/Web3 industry, Bitget Wallet, partnerships, TradFi, WaaS, XRPL/Solana/Base
- 📡 signal-agent  : Price signals, alpha opportunities, regulatory risk, exchange events, on-chain data
- 🌱 life-agent    : Health, diet, meal planning, fitness, sleep, travel, personal development, lifestyle
- 🤖 openclaw-agent: AI tools, Claude, MCP, automation, TypeScript/coding, OpenClaw configuration, skills
- 📎 general-agent : Everything else — general questions, writing, research, math, history, culture
`;

    const classificationPrompt = `${this.systemPrompt}
${categoryHint}
<user_input>${inputText}</user_input>

Based on the user input and the routing categories above, select the BEST agent.
The agentId must exactly match one of the registered agent IDs shown in the agents list above.
Respond ONLY with valid XML in exactly this format, nothing else:
<classification>
  <agentId>AGENT_ID_HERE</agentId>
  <confidence>0.9</confidence>
</classification>`;

    let rawOutput = "";

    try {
      for await (const line of invokeClaudeCLI({
        prompt: classificationPrompt,
        allowedTools: this.allowedTools,
        model: this.model,
      })) {
        if (line.type === "result") {
          const r = line as CLIResultEvent;
          rawOutput = r.result || rawOutput;
        } else if (line.type === "stream_event") {
          const se = line as CLIStreamEvent;
          if (se.event?.type === "content_block_delta") {
            const delta = (se.event.delta as any);
            if (delta?.type === "text_delta") {
              rawOutput += delta.text ?? "";
            }
          }
        }
      }
    } catch (err: any) {
      console.error("[CLIClassifier] Error calling CLI:", err.message);
      return this.getFallback();
    }

    return this.parseClassification(rawOutput);
  }

  private parseClassification(raw: string): ClassifierResult {
    try {
      const agentIdMatch = raw.match(/<agentId>(.*?)<\/agentId>/s);
      const confidenceMatch = raw.match(/<confidence>([\d.]+)<\/confidence>/s);

      if (!agentIdMatch) {
        console.warn("[CLIClassifier] Could not parse agentId from:", raw.slice(0, 200));
        return this.getFallback();
      }

      const agentId = agentIdMatch[1].trim();
      const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.8;

      const agent = this.getAgentById(agentId);
      if (!agent) {
        console.warn("[CLIClassifier] Agent not found:", agentId, "— using fallback");
        return this.getFallback();
      }

      console.log(`[CLIClassifier] Routed to: ${agentId} (confidence: ${confidence})`);
      return { selectedAgent: agent, confidence };
    } catch (err: any) {
      console.error("[CLIClassifier] Parse error:", err.message);
      return this.getFallback();
    }
  }

  private getFallback(): ClassifierResult {
    // Fall back to first registered agent or null
    const agents = Object.values(this.agents ?? {});
    const fallback = agents.find((a) => a.id === "general") ?? agents[0] ?? null;
    return { selectedAgent: fallback, confidence: 0.5 };
  }
}
