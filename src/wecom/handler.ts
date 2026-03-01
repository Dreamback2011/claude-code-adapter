/**
 * 企业微信消息处理管道
 * 收消息 → 识别身份 → 分析内容 → AI 回复（带边界）
 */

import fs from "node:fs";
import path from "node:path";
import type { WeComConfig, WeComMessage, WeComMessageLog, ContactTag } from "./types.js";
import type { CLIStreamEvent, CLIResultEvent } from "../types.js";
import { sendTextMessage, getUserInfo } from "./api.js";
import { getContact, getContactTags, upsertContact, findContactByName, migrateContactUserId } from "./contacts.js";
import { invokeClaudeCLI } from "../claude-cli.js";

const MESSAGE_LOG = path.resolve("agents/wecom/messages.log");
const SKILL_MD = path.resolve("agents/wecom/SKILL.md");

// ── Per-user conversation history (in-memory) ──────────────────────────────
const MAX_HISTORY_TURNS = 10; // keep last 10 exchanges per user
const conversationHistory = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

// ── Cached system prompt from SKILL.md ─────────────────────────────────────
let cachedSystemPrompt: string | null = null;

function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const content = fs.readFileSync(SKILL_MD, "utf8");
    const match = content.match(/## System Prompt\n([\s\S]*)$/);
    cachedSystemPrompt = match ? match[1].trim() : "You are a WeChat Work assistant.";
    console.log(`[wecom] System prompt loaded (${cachedSystemPrompt.length} chars)`);
  } catch {
    cachedSystemPrompt = "You are a WeChat Work assistant.";
  }
  return cachedSystemPrompt;
}

/**
 * 处理收到的企业微信消息
 * 这是核心管道入口
 */
export async function handleIncomingMessage(
  config: WeComConfig,
  msg: WeComMessage
): Promise<void> {
  const userId = msg.fromUserName;
  const msgType = msg.msgType;

  console.log(`[wecom] Incoming: from=${userId} type=${msgType} content=${msg.content?.slice(0, 50) ?? "(non-text)"}`);

  // 1. 识别身份
  const tags = getContactTags(userId);
  let contactName = getContact(userId)?.name;

  // If unknown user, try to fetch name from WeCom API
  if (!contactName) {
    try {
      const userInfo = await getUserInfo(config, userId);
      if (userInfo.name) {
        contactName = userInfo.name;
        // Check if this person was pre-registered with a placeholder UserId
        const preRegistered = findContactByName(contactName);
        if (preRegistered && preRegistered.userId !== userId) {
          // Migrate placeholder to real UserId
          migrateContactUserId(preRegistered.userId, userId);
          console.log(`[wecom] Matched pre-registered contact: ${contactName} (${preRegistered.userId} → ${userId})`);
        } else if (!preRegistered) {
          // Auto-register with "unknown" tag
          upsertContact({ userId, name: contactName, tags: ["unknown"] });
          console.log(`[wecom] Auto-registered contact: ${contactName} (${userId})`);
        }
      }
    } catch {
      contactName = userId;
    }
  }

  // 2. 记录消息
  const logEntry: WeComMessageLog = {
    ts: new Date().toISOString(),
    from: userId,
    fromName: contactName,
    tags,
    msgType,
    content: msg.content ?? `[${msgType}]`,
    replied: false,
  };

  // 3. 只处理文本消息（其他类型先记录不回复）
  if (msgType !== "text" || !msg.content) {
    appendLog(logEntry);
    console.log(`[wecom] Non-text message logged, no reply`);
    return;
  }

  // 4. 生成回复
  const reply = await generateReply(msg.content, userId, contactName ?? userId, tags);

  if (reply) {
    // 5. 发送回复
    const result = await sendTextMessage(config, userId, reply);
    logEntry.replied = result.errcode === 0;
    logEntry.replyContent = reply;
    console.log(`[wecom] Replied to ${contactName}: ${reply.slice(0, 80)}`);
  } else {
    console.log(`[wecom] No reply generated for message from ${contactName}`);
  }

  appendLog(logEntry);
}

/**
 * 通过 Claude CLI 生成 AI 回复
 * 带身份上下文 + 对话历史 + 信息边界
 */
async function generateReply(
  content: string,
  userId: string,
  name: string,
  tags: ContactTag[]
): Promise<string | null> {
  const systemPrompt = loadSystemPrompt();

  // Build identity context header
  const tagLabel = tags.join(", ");
  const identityLine = `[发送者: ${name}, UserID: ${userId}, 标签: ${tagLabel}]`;

  // Get or create conversation history for this user
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId)!;

  // Build prompt with conversation history
  let prompt = identityLine + "\n\n";
  if (history.length > 0) {
    prompt += "--- 对话历史 ---\n";
    for (const turn of history) {
      prompt += `${turn.role === "user" ? name : "你"}: ${turn.content}\n`;
    }
    prompt += "--- 新消息 ---\n";
  }
  prompt += `${name}: ${content}`;

  console.log(`[wecom] AI generating reply for ${name} (${tagLabel}), prompt=${prompt.length} chars`);

  let response = "";
  try {
    for await (const line of invokeClaudeCLI({
      prompt,
      systemPrompt,
      // No tools — pure text generation for fast response
      allowedTools: "none",
      // Use haiku for speed (enterprise chat needs quick replies)
      model: "haiku",
      // Budget cap per reply
      maxBudgetUsd: 0.02,
    })) {
      if (line.type === "result") {
        const r = line as CLIResultEvent;
        if (!response && r.result) response = r.result;
      } else if (line.type === "stream_event") {
        const se = line as CLIStreamEvent;
        const evt = se.event;
        if (evt?.type === "content_block_delta") {
          const delta = (evt.delta as any);
          if (delta?.type === "text_delta") {
            response += delta.text ?? "";
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[wecom] AI reply failed: ${err.message}`);
    return fallbackReply(content, name, tags);
  }

  const reply = response.trim();
  if (!reply) {
    console.warn(`[wecom] AI returned empty response, using fallback`);
    return fallbackReply(content, name, tags);
  }

  // Update conversation history
  history.push({ role: "user", content });
  history.push({ role: "assistant", content: reply });
  // Trim to max history
  while (history.length > MAX_HISTORY_TURNS * 2) {
    history.shift();
  }

  console.log(`[wecom] AI reply generated (${reply.length} chars)`);
  return reply;
}

/**
 * 规则型 fallback — 当 AI 回复失败时使用
 */
function fallbackReply(content: string, name: string, tags: ContactTag[]): string | null {
  const text = content.trim().toLowerCase();

  // 简单问候
  const greetings = ["你好", "hi", "hello", "hey", "嗨", "在吗", "在不在"];
  if (greetings.some((g) => text === g || text === g + "!")) {
    return `你好！有什么可以帮你的吗？`;
  }

  // VIP → 转交山哥
  if (tags.includes("vip")) {
    return `收到，我让山哥尽快回复你。`;
  }

  // Unknown → 基本回复
  if (tags.includes("unknown")) {
    return `你好，请问有什么事情？我会转达给相关同事。`;
  }

  // 其他 → 通用 fallback
  return `收到你的消息，稍后回复你。`;
}

/**
 * 追加消息日志
 */
function appendLog(entry: WeComMessageLog): void {
  try {
    fs.mkdirSync(path.dirname(MESSAGE_LOG), { recursive: true });
    fs.appendFileSync(MESSAGE_LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch (err: any) {
    console.error(`[wecom] Failed to write log: ${err.message}`);
  }
}
