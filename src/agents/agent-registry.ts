import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agents/ directory is at repo root: ../../agents/ relative to src/agents/
const AGENTS_DIR = join(__dirname, "../../agents");

export interface AgentDefinition {
  name: string;
  id: string;
  emoji: string;
  category: string;
  description: string;
  status: "active" | "archived";
  systemPrompt: string;
}

/**
 * Parse frontmatter (---...---) and body from a SKILL.md file.
 */
function parseSKILL(content: string): AgentDefinition | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Parse simple key: value frontmatter
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2].trim();
  }

  // Extract system prompt from body (section after "## System Prompt")
  const sysPromptMatch = body.match(/## System Prompt\n([\s\S]*)$/);
  const systemPrompt = sysPromptMatch ? sysPromptMatch[1].trim() : "";

  if (!meta.name || !meta.id) return null;

  return {
    name: meta.name,
    id: meta.id,
    emoji: meta.emoji ?? "📎",
    category: meta.category ?? meta.id,
    description: meta.description ?? "",
    status: (meta.status as "active" | "archived") ?? "active",
    systemPrompt,
  };
}

/**
 * Load all active agent definitions from agents/*/SKILL.md
 */
export function loadAgentDefinitions(): AgentDefinition[] {
  if (!existsSync(AGENTS_DIR)) {
    console.warn("[AgentRegistry] agents/ directory not found at:", AGENTS_DIR);
    return [];
  }

  const defs: AgentDefinition[] = [];

  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;

    const skillPath = join(AGENTS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    try {
      const content = readFileSync(skillPath, "utf-8");
      const def = parseSKILL(content);
      if (def && def.status === "active") {
        defs.push(def);
        console.log(`[AgentRegistry] Loaded: ${def.emoji} ${def.name} (${def.id})`);
      }
    } catch (err: any) {
      console.warn(`[AgentRegistry] Failed to parse ${skillPath}:`, err.message);
    }
  }

  return defs;
}
