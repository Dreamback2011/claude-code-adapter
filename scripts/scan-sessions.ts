#!/usr/bin/env npx tsx
/**
 * Session Scanner — 扫描所有 Claude Code 会话，提取关键信息并自动打标签
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, basename } from "path";

const PROJECTS_DIR = join(process.env.HOME!, ".claude/projects");
const OUTPUT_FILE = join(process.env.HOME!, ".claude/session-tags.json");

interface SessionInfo {
  sessionId: string;
  project: string;
  firstMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  model: string;
  fileSizeKB: number;
  hasSubagents: boolean;
  subagentCount: number;
  tags: string[];
  source: string; // "cron", "discord", "direct", "unknown"
  sender: string; // extracted sender info
}

// Tag rules: [pattern, tag]
const TAG_RULES: Array<[RegExp, string]> = [
  // Source/channel
  [/\[cron:/, "cron"],
  [/X Alpha Feed|X Crypto Alpha|ClawFeed/i, "x-feed"],
  [/播报|broadcast/i, "broadcast"],
  [/PonziCurator|x_scraper/i, "x-scraper"],

  // Task types
  [/debug|调试|排查|fix.*bug|修复/i, "debug"],
  [/refactor|重构/i, "refactor"],
  [/test|测试|jest|vitest/i, "test"],
  [/deploy|部署|pm2|systemd/i, "deploy"],
  [/git commit|git push|commit.*message/i, "git"],
  [/PR|pull request/i, "pr"],

  // Feature areas
  [/streaming|stream|SSE|EventSource/i, "streaming"],
  [/session|会话|resume/i, "session"],
  [/adapter|转发|forward/i, "adapter"],
  [/agent|代理|squad|routing/i, "agent"],
  [/skill|技能/i, "skill"],
  [/discord|频道|channel/i, "discord"],
  [/webhook|钩子/i, "webhook"],
  [/auth|认证|API.?key/i, "auth"],
  [/model|模型|claude-sonnet|claude-opus|haiku/i, "model"],
  [/timeout|超时|hang|卡住/i, "timeout"],
  [/error|错误|crash|崩溃|fail/i, "error"],
  [/env|环境变量|\.env/i, "env"],
  [/spawn|child.?process|pgrep/i, "process"],
  [/memory|内存|MEMORY\.md/i, "memory"],
  [/config|配置|setup/i, "config"],
  [/script|脚本|automation|自动化/i, "automation"],
  [/manage\.sh|startup|启动/i, "startup"],
  [/log|日志|verbose/i, "logging"],
  [/token|计费|usage|cost/i, "cost"],
  [/OpenClaw|openclaw/i, "openclaw"],
  [/ClawdTalk|voice|语音|call|通话|SMS/i, "clawdtalk"],
  [/pending.?tasks|待办/i, "pending-tasks"],
  [/work.?related|工作/i, "work-channel"],
  [/MCP|mcp-cli/i, "mcp"],
  [/learn|学习|SubAgent.*learn/i, "learning"],
  [/registry|注册/i, "registry"],
];

function extractFirstUserMessage(filePath: string): { message: string; timestamp: string; sender: string; source: string } {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  let firstMsg = "";
  let timestamp = "";
  let sender = "unknown";
  let source = "direct";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      // Extract timestamp from queue-operation or message
      if (!timestamp && obj.timestamp) {
        timestamp = obj.timestamp;
      }

      // Find first user message
      if (obj.type === "user" && obj.message?.role === "user") {
        const msgContent = typeof obj.message.content === "string"
          ? obj.message.content
          : Array.isArray(obj.message.content)
            ? obj.message.content.map((c: any) => c.text || "").join(" ")
            : "";

        firstMsg = msgContent.slice(0, 500);
        if (!timestamp) timestamp = obj.timestamp || "";

        // Detect source
        if (msgContent.includes("[cron:")) {
          source = "cron";
          const cronMatch = msgContent.match(/\[cron:[^\]]+\s+([^\]]+)\]/);
          if (cronMatch) sender = cronMatch[1].trim();
        } else if (msgContent.includes("Conversation info")) {
          source = "discord";
          const senderMatch = msgContent.match(/"sender":\s*"([^"]+)"/);
          if (senderMatch) sender = senderMatch[1];
          const channelMatch = msgContent.match(/"group_channel":\s*"([^"]+)"/);
          if (channelMatch) sender = channelMatch[1];
        } else if (msgContent.includes("is_group_chat")) {
          source = "discord";
        }

        break;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { message: firstMsg, timestamp, sender, source };
}

function extractLastTimestamp(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.timestamp) return obj.timestamp;
      if (obj.message?.stop_timestamp) return obj.message.stop_timestamp;
    } catch {}
  }
  return "";
}

function extractModel(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.message?.model) return obj.message.model;
    } catch {}
  }
  return "unknown";
}

function countMessages(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" || (obj.message?.role === "assistant" && obj.message?.type === "message")) {
        count++;
      }
    } catch {}
  }
  return count;
}

function autoTag(info: SessionInfo): string[] {
  const tags: string[] = [];
  const text = info.firstMessage + " " + info.source;

  for (const [pattern, tag] of TAG_RULES) {
    if (pattern.test(text)) {
      tags.push(tag);
    }
  }

  // Size-based tags
  if (info.fileSizeKB > 80) tags.push("long-session");
  if (info.messageCount <= 2) tags.push("short");

  if (tags.length === 0) tags.push("untagged");

  return [...new Set(tags)];
}

// Main
console.log("🔍 Scanning all Claude Code sessions...\n");

const allSessions: SessionInfo[] = [];
const projects = readdirSync(PROJECTS_DIR).filter(d => {
  try { return statSync(join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
});

for (const project of projects) {
  const projectDir = join(PROJECTS_DIR, project);
  const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

  for (const file of files) {
    const sessionId = basename(file, ".jsonl");
    const filePath = join(projectDir, file);
    const stat = statSync(filePath);
    const fileSizeKB = Math.round(stat.size / 1024);

    // Check for subagents
    const subagentDir = join(projectDir, sessionId, "subagents");
    let hasSubagents = false;
    let subagentCount = 0;
    try {
      const subs = readdirSync(subagentDir).filter(f => f.endsWith(".jsonl"));
      hasSubagents = subs.length > 0;
      subagentCount = subs.length;
    } catch {}

    const { message, timestamp, sender, source } = extractFirstUserMessage(filePath);
    const lastTimestamp = extractLastTimestamp(filePath);
    const model = extractModel(filePath);
    const messageCount = countMessages(filePath);

    const info: SessionInfo = {
      sessionId,
      project,
      firstMessage: message,
      firstTimestamp: timestamp,
      lastTimestamp,
      messageCount,
      model,
      fileSizeKB,
      hasSubagents,
      subagentCount,
      tags: [],
      source,
      sender,
    };

    info.tags = autoTag(info);
    allSessions.push(info);
  }
}

// Sort by timestamp (newest first)
allSessions.sort((a, b) => (b.firstTimestamp || "").localeCompare(a.firstTimestamp || ""));

// Save full results
writeFileSync(OUTPUT_FILE, JSON.stringify(allSessions, null, 2));
console.log(`✅ Scanned ${allSessions.length} sessions → ${OUTPUT_FILE}\n`);

// Print summary
const tagCounts: Record<string, number> = {};
const sourceCounts: Record<string, number> = {};
const modelCounts: Record<string, number> = {};

for (const s of allSessions) {
  for (const t of s.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  sourceCounts[s.source] = (sourceCounts[s.source] || 0) + 1;
  modelCounts[s.model] = (modelCounts[s.model] || 0) + 1;
}

console.log("📊 Tag Distribution:");
Object.entries(tagCounts)
  .sort((a, b) => b[1] - a[1])
  .forEach(([tag, count]) => console.log(`  ${tag}: ${count}`));

console.log("\n📡 Source Distribution:");
Object.entries(sourceCounts)
  .sort((a, b) => b[1] - a[1])
  .forEach(([src, count]) => console.log(`  ${src}: ${count}`));

console.log("\n🤖 Model Distribution:");
Object.entries(modelCounts)
  .sort((a, b) => b[1] - a[1])
  .forEach(([model, count]) => console.log(`  ${model}: ${count}`));

console.log("\n📋 Recent 20 Sessions:");
for (const s of allSessions.slice(0, 20)) {
  const time = s.firstTimestamp ? new Date(s.firstTimestamp).toLocaleString("zh-CN", { timeZone: "Asia/Dubai" }) : "?";
  const preview = s.firstMessage.slice(0, 80).replace(/\n/g, " ");
  console.log(`  [${time}] [${s.tags.join(",")}] ${preview}...`);
}
