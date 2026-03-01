/**
 * 企业微信 API Client
 * 处理 access_token 管理和消息发送
 */

import type {
  WeComConfig,
  WeComAccessTokenResponse,
  WeComSendMessage,
  WeComSendResponse,
  WeComUserInfo,
} from "./types.js";

const BASE_URL = "https://qyapi.weixin.qq.com/cgi-bin";

// Token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * 获取 access_token（带缓存，提前 5 分钟刷新）
 */
export async function getAccessToken(config: WeComConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  console.log("[wecom] Fetching new access_token...");
  const url = `${BASE_URL}/gettoken?corpid=${config.corpId}&corpsecret=${config.corpSecret}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as WeComAccessTokenResponse;

  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`[wecom] Failed to get access_token: ${data.errcode} ${data.errmsg}`);
  }

  cachedToken = data.access_token;
  // Refresh 5 minutes before expiry
  tokenExpiresAt = now + (data.expires_in! - 300) * 1000;
  console.log(`[wecom] access_token obtained, expires in ${data.expires_in}s`);

  return cachedToken;
}

/**
 * 主动发送文本消息
 */
export async function sendTextMessage(
  config: WeComConfig,
  toUser: string,
  content: string
): Promise<WeComSendResponse> {
  const token = await getAccessToken(config);

  const msg: WeComSendMessage = {
    touser: toUser,
    msgtype: "text",
    agentid: config.agentId,
    text: { content },
  };

  const resp = await fetch(`${BASE_URL}/message/send?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });

  const result = (await resp.json()) as WeComSendResponse;
  if (result.errcode !== 0) {
    console.error(`[wecom] Send failed: ${result.errcode} ${result.errmsg}`);
  } else {
    console.log(`[wecom] Message sent to ${toUser}, msgid=${result.msgid}`);
  }

  return result;
}

/**
 * 获取用户信息（通过 UserID）
 */
export async function getUserInfo(
  config: WeComConfig,
  userId: string
): Promise<WeComUserInfo> {
  const token = await getAccessToken(config);
  const resp = await fetch(`${BASE_URL}/user/get?access_token=${token}&userid=${userId}`);
  return (await resp.json()) as WeComUserInfo;
}

/**
 * 清除 token 缓存（当 token 失效时调用）
 */
export function clearTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}
