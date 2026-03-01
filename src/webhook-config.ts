/**
 * Webhook Configuration — Discord 频道 Webhook 管理
 *
 * 核心设计：
 * - 配置从 config/discord-routing.json 动态加载，修改即生效，无需重启 adapter
 * - 每个 agent 都能发到任何频道（通用能力）
 * - agentDefaults 只是默认路由，不是限制
 * - sendToChannel() 是给所有 agent 用的通用发送函数
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── 动态配置加载 ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RoutingConfig {
  channels: Record<string, string>;
  agentDefaults: Record<string, string>;
  fallbackChannel: string;
}

const CONFIG_PATH = join(__dirname, "..", "config", "discord-routing.json");

/**
 * 每次调用都从磁盘读取最新配置。
 * 修改 config/discord-routing.json 后即时生效，无需重启。
 */
function loadConfig(): RoutingConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    console.error(`[webhook-config] Failed to load ${CONFIG_PATH}:`, err.message);
    // 最小回退：只有 general 频道
    return { channels: {}, agentDefaults: {}, fallbackChannel: "general" };
  }
}

// ── 类型（保持向后兼容）────────────────────────────────────────────────────────

export type ChannelName = string;

// ── 兼容属性：DISCORD_CHANNELS（动态 getter）────────────────────────────────────

/** @deprecated 优先用 getChannelWebhook() 或 sendToChannel()，保留仅为兼容 */
export function getDiscordChannels(): Record<string, string> {
  return loadConfig().channels;
}

// 为了不破坏 server.ts 中 `rawChannel in DISCORD_CHANNELS` 的用法，
// 导出一个 Proxy 对象，每次属性访问都读最新配置
export const DISCORD_CHANNELS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) {
    return loadConfig().channels[prop];
  },
  has(_target, prop: string) {
    return prop in loadConfig().channels;
  },
  ownKeys() {
    return Object.keys(loadConfig().channels);
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const config = loadConfig();
    if (prop in config.channels) {
      return { configurable: true, enumerable: true, value: config.channels[prop] };
    }
    return undefined;
  },
});

// ── 通用发送函数（任何 agent 都可以用）────────────────────────────────────────

/**
 * 发送消息到指定 Discord 频道。
 * 任何 agent 都可以调用，不受默认路由限制。
 */
export async function sendToChannel(
  channel: ChannelName,
  content: string,
  username?: string
): Promise<void> {
  const config = loadConfig();
  const url = config.channels[channel];
  if (!url) throw new Error(`Unknown channel: ${channel}`);

  const chunks = splitForDiscord(content);

  for (const chunk of chunks) {
    const body: Record<string, string> = { content: chunk };
    if (username) body.username = username;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Discord ${channel} HTTP ${res.status}: ${res.statusText}`);
    }

    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * 发送到多个频道（广播）
 */
export async function broadcastToChannels(
  channels: ChannelName[],
  content: string,
  username?: string
): Promise<void> {
  await Promise.allSettled(
    channels.map((ch) => sendToChannel(ch, content, username))
  );
}

// ── 路由解析 ─────────────────────────────────────────────────────────────────

/**
 * 根据 Agent ID 获取默认 Webhook URL
 * 优先级: 请求中的 webhook_url > agent 默认频道 > fallback
 */
export function resolveWebhookUrl(agentId?: string, requestWebhookUrl?: string): string {
  if (requestWebhookUrl) return requestWebhookUrl;

  const config = loadConfig();
  const channel = agentId ? config.agentDefaults[agentId] : undefined;
  const targetChannel = channel ?? config.fallbackChannel;
  return config.channels[targetChannel] ?? config.channels[config.fallbackChannel] ?? "";
}

/**
 * 根据 Agent ID 解析默认频道名称
 * 优先 agent 默认映射 → 兜底 fallbackChannel
 */
export function resolveChannelName(agentId?: string): ChannelName {
  const config = loadConfig();
  const channel = agentId ? config.agentDefaults[agentId] : undefined;
  return channel ?? config.fallbackChannel;
}

/**
 * 获取指定频道的 Webhook URL
 */
export function getChannelWebhook(channel: string): string | undefined {
  return loadConfig().channels[channel];
}

/**
 * 列出所有可用频道名称
 */
export function listChannels(): ChannelName[] {
  return Object.keys(loadConfig().channels);
}

// ── Discord 消息格式 ─────────────────────────────────────────────────────────

const DISCORD_MAX_LENGTH = 2000;

/**
 * 将长文本拆分为 Discord 消息块（每条最多 2000 字符）
 */
export function splitForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    }
    if (splitAt < DISCORD_MAX_LENGTH * 0.3) {
      splitAt = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
