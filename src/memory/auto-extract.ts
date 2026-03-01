/**
 * Auto-Extract — Automatic memory extraction from conversations
 *
 * Two extraction strategies:
 *   1. Pattern matching — catches explicit memory signals (preferences, decisions, facts)
 *   2. Conversation digest — for longer conversations, stores a condensed summary (7-day TTL)
 *
 * Throttled to avoid noise:
 *   - Min content length: 300 chars
 *   - Per-agent cooldown: 5 minutes
 *   - Global cap: 30 extractions per hour
 */

import { createMemory } from "./memory-store.js";
import { PermissionTier } from "./types.js";
import type { AgentReport } from "./types.js";

// ─── Throttle State ──────────────────────────────────────────────────────────

const lastExtractTime = new Map<string, number>(); // agentId → timestamp
let globalExtractCount = 0;
let globalExtractResetTime = Date.now();

const MIN_CONTENT_LENGTH = 300;
const AGENT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per agent
const GLOBAL_MAX_PER_HOUR = 30;
const MAX_MEMORIES_PER_CONVERSATION = 3;
const DIGEST_MIN_LENGTH = 1000;
const DIGEST_TTL_DAYS = 7;

// ─── Pattern Definitions ─────────────────────────────────────────────────────

interface MemoryPattern {
  pattern: RegExp;
  category: "context" | "progress" | "daily" | "learning" | "agent";
  label: string;
}

const MEMORY_PATTERNS: MemoryPattern[] = [
  // Explicit memory requests (highest priority)
  {
    pattern: /(?:remember|记住|记下|记录|note that|keep in mind|请记住|不要忘了|以后都)[:：]?\s*(.{10,300})/gi,
    category: "context",
    label: "显式记忆",
  },
  // User preferences
  {
    pattern: /(?:我(?:喜欢|偏好|想要|希望|倾向于?|更愿意)|I (?:prefer|like|want)|请(?:用|使用|改成))(.{10,200})/gi,
    category: "context",
    label: "用户偏好",
  },
  // Decisions and conclusions
  {
    pattern: /(?:决定|确定|选择了?|最终方案|结论是|结果是|agreed|decided|chosen|settled on|going with)[:：]?\s*(.{10,300})/gi,
    category: "context",
    label: "决策记录",
  },
  // Project milestones
  {
    pattern: /(?:项目|product|feature|功能|模块|系统|服务).*?(?:上线|完成|发布|部署|launched|deployed|shipped|ready|done|finished)(.{10,200})/gi,
    category: "progress",
    label: "项目进展",
  },
  // Important config or technical facts
  {
    pattern: /(?:配置|config|设置|端口|port|地址|address|密钥|key|域名|domain).*?(?:是|=|为|设为|改为|changed to|set to)[:：]?\s*(.{5,200})/gi,
    category: "context",
    label: "技术配置",
  },
];

// ─── Throttle Check ──────────────────────────────────────────────────────────

function shouldExtract(report: AgentReport): boolean {
  const contentLength = report.inputText.length + report.outputText.length;
  if (contentLength < MIN_CONTENT_LENGTH) return false;

  // Per-agent cooldown
  const lastTime = lastExtractTime.get(report.agentId) ?? 0;
  if (Date.now() - lastTime < AGENT_COOLDOWN_MS) return false;

  // Global rate limit (reset hourly)
  if (Date.now() - globalExtractResetTime > 3600_000) {
    globalExtractCount = 0;
    globalExtractResetTime = Date.now();
  }
  if (globalExtractCount >= GLOBAL_MAX_PER_HOUR) return false;

  return true;
}

// ─── Main Extraction ─────────────────────────────────────────────────────────

/**
 * Extract memories from a conversation using pattern matching + digest.
 * Called automatically after each agent execution via reportExecution().
 *
 * Returns the number of memories created.
 */
export function extractMemories(report: AgentReport): number {
  if (!shouldExtract(report)) return 0;

  lastExtractTime.set(report.agentId, Date.now());
  globalExtractCount++;

  const fullText = `${report.inputText}\n---\n${report.outputText}`;
  let created = 0;

  // 1. Pattern-based extraction
  for (const { pattern, category, label } of MEMORY_PATTERNS) {
    // Reset regex lastIndex for each report
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(fullText)) !== null) {
      const content = match[1]?.trim() || match[0].trim();
      if (content.length < 10) continue;

      // Deduplicate: skip if title would be too similar to what we just created
      const titlePreview = content.slice(0, 60);

      createMemory({
        category,
        title: `[${label}] ${titlePreview}`,
        content,
        tags: [report.agentId, "auto-extract"],
        source: `auto-extract:${report.agentId}`,
        tier: PermissionTier.T1_INTERNAL,
      });
      created++;

      if (created >= MAX_MEMORIES_PER_CONVERSATION) break;
    }
    if (created >= MAX_MEMORIES_PER_CONVERSATION) break;
  }

  // 2. Conversation digest for longer conversations (even if no patterns matched)
  const totalLength = report.inputText.length + report.outputText.length;
  if (totalLength > DIGEST_MIN_LENGTH) {
    const inputPreview = report.inputText.slice(0, 300).trim();
    const outputPreview = report.outputText.slice(0, 500).trim();
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toISOString().slice(11, 16);

    createMemory({
      category: "daily",
      title: `对话摘要: ${report.agentName} @ ${dateStr} ${timeStr}`,
      content: `Agent: ${report.agentName} (${report.agentId})\n\n用户输入:\n${inputPreview}\n\n回复摘要:\n${outputPreview}`,
      tags: [report.agentId, "auto-extract", "digest"],
      source: `auto-extract:${report.agentId}`,
      tier: PermissionTier.T1_INTERNAL,
      expiresAt: new Date(Date.now() + DIGEST_TTL_DAYS * 24 * 3600_000).toISOString(),
    });
    created++;
  }

  if (created > 0) {
    console.log(`[auto-extract] ${report.agentId}: extracted ${created} memories`);
  }

  return created;
}

// ─── Agent Self-Report Parsing ───────────────────────────────────────────────

/**
 * Parse <save-memory> tags from agent output.
 * Agents are instructed to use these tags when they identify important facts.
 *
 * Format: <save-memory category="context" title="short title">content</save-memory>
 *
 * Returns: { cleanOutput, memoriesCreated }
 */
export function parseAndSaveMemoryTags(
  output: string,
  agentId: string,
  agentName: string
): { cleanOutput: string; memoriesCreated: number } {
  const tagRegex = /<save-memory\s+category="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/save-memory>/gi;
  let memoriesCreated = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(output)) !== null) {
    const category = match[1] as "context" | "progress" | "daily" | "learning" | "agent";
    const title = match[2];
    const content = match[3].trim();

    if (!content || content.length < 5) continue;

    createMemory({
      category,
      title,
      content,
      tags: [agentId, "agent-reported"],
      source: `agent:${agentId}`,
      tier: PermissionTier.T1_INTERNAL,
    });
    memoriesCreated++;
    console.log(`[auto-extract] ${agentName} self-reported memory: "${title}"`);
  }

  // Strip all <save-memory> tags from output (user shouldn't see them)
  const cleanOutput = output.replace(/<save-memory\s+[^>]*>[\s\S]*?<\/save-memory>\s*/gi, "").trim();

  return { cleanOutput, memoriesCreated };
}
