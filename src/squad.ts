import { AgentSquad, InMemoryChatStorage } from "agent-squad";
import { ClaudeCodeAgent } from "./agents/claude-code-agent.js";
import { CLIClassifier } from "./classifiers/cli-classifier.js";
import { loadAgentDefinitions } from "./agents/agent-registry.js";

/**
 * Creates an AgentSquad with agents dynamically loaded from agents/{id}/SKILL.md
 *
 * Categories:
 *   💼 work     — BD, crypto, Bitget Wallet, partnerships
 *   📡 signal   — Price signals, alpha, regulatory risk
 *   🔬 research — 投研分析、美股、Crypto、宏观、时事
 *   🌱 life     — Health, lifestyle, travel, personal development
 *   🤖 openclaw — AI tools, Claude, automation, development
 *   📎 general  — Default fallback (everything else)
 */
export function createSquad(allowedTools: string): AgentSquad {
  const classifier = new CLIClassifier({ allowedTools });

  const squad = new AgentSquad({
    storage: new InMemoryChatStorage(),
    classifier,
    config: {
      USE_DEFAULT_AGENT_IF_NONE_IDENTIFIED: true,
      LOG_AGENT_CHAT: false,
      LOG_CLASSIFIER_OUTPUT: true,
    },
  });

  // Load agent definitions from agents/*/SKILL.md
  const definitions = loadAgentDefinitions();

  let defaultAgent: ClaudeCodeAgent | null = null;

  for (const def of definitions) {
    const agent = new ClaudeCodeAgent({
      name: def.name,
      description: `${def.emoji} ${def.description}`,
      allowedTools,
      systemPrompt: def.systemPrompt || undefined,
    });

    // Override auto-generated ID with SKILL.md id for consistent metrics/learning paths
    agent.id = def.id;

    squad.addAgent(agent);

    // "general" is the default fallback
    if (def.id === "general") {
      defaultAgent = agent;
    }
  }

  // If no SKILL.md-based agents loaded, fall back to a minimal built-in agent
  if (definitions.length === 0) {
    console.warn("[squad] No SKILL.md agents found — using built-in fallback");
    const fallback = new ClaudeCodeAgent({
      name: "General Assistant",
      description: "📎 General purpose assistant",
      allowedTools,
    });
    squad.addAgent(fallback);
    squad.setDefaultAgent(fallback);
  } else {
    if (defaultAgent) {
      squad.setDefaultAgent(defaultAgent);
    }
  }

  console.log(
    `[squad] AgentSquad ready — ${definitions.length} agents loaded:`,
    definitions.map((d) => `${d.emoji}${d.id}`).join(", ")
  );

  return squad;
}
