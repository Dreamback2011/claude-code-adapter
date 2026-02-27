import { Agent, AgentOptions } from "agent-squad";
import type { ConversationMessage } from "agent-squad";
import { invokeClaudeCLI } from "../claude-cli.js";
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
    _userId: string,
    _sessionId: string,
    chatHistory: ConversationMessage[],
    _additionalParams?: Record<string, string>
  ): Promise<ConversationMessage> {
    // Build a prompt that includes recent conversation history
    const historyText = chatHistory
      .slice(-10) // last 5 turns
      .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${
        Array.isArray(m.content)
          ? m.content.map((c: any) => c.text ?? "").join("")
          : String(m.content)
      }`)
      .join("\n");

    const fullPrompt = historyText
      ? `${historyText}\nHuman: ${inputText}`
      : inputText;

    let resultText = "";

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
