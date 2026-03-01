/**
 * 企业微信 (WeCom) Types
 */

// ── Config ─────────────────────────────────────────────────────────────────────

export interface WeComConfig {
  corpId: string;         // 企业ID
  corpSecret: string;     // 应用Secret
  agentId: number;        // 应用AgentId
  token: string;          // 回调Token（用于签名验证）
  encodingAESKey: string; // 回调EncodingAESKey（43字符，用于消息加解密）
}

// ── Inbound messages (from WeCom callback) ─────────────────────────────────────

export interface WeComMessage {
  toUserName: string;     // 企业微信CorpID
  fromUserName: string;   // 发送者UserID
  createTime: number;     // 消息创建时间（Unix timestamp）
  msgType: string;        // 消息类型: text, image, voice, video, location, link, event
  content?: string;       // 文本消息内容
  msgId?: string;         // 消息ID
  agentId?: number;       // 企业应用ID
  picUrl?: string;        // 图片链接（image类型）
  mediaId?: string;       // 媒体文件ID
  event?: string;         // 事件类型（event类型消息）
  eventKey?: string;      // 事件KEY
}

// ── Outbound messages (send via API) ───────────────────────────────────────────

export interface WeComTextMessage {
  touser: string;         // UserID，多人用 "|" 分隔
  msgtype: "text";
  agentid: number;
  text: { content: string };
}

export interface WeComMarkdownMessage {
  touser: string;
  msgtype: "markdown";
  agentid: number;
  markdown: { content: string };
}

export type WeComSendMessage = WeComTextMessage | WeComMarkdownMessage;

// ── API Responses ──────────────────────────────────────────────────────────────

export interface WeComAccessTokenResponse {
  errcode: number;
  errmsg: string;
  access_token?: string;
  expires_in?: number;
}

export interface WeComSendResponse {
  errcode: number;
  errmsg: string;
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
  msgid?: string;
}

export interface WeComUserInfo {
  errcode: number;
  errmsg: string;
  userid?: string;
  name?: string;
  department?: number[];
  position?: string;
  mobile?: string;
  email?: string;
  avatar?: string;
  status?: number;      // 1=已激活 2=已禁用 4=未激活 5=退出企业
}

// ── Contact tags (local config) ────────────────────────────────────────────────

export type ContactTag = "vip" | "team" | "partner" | "friend" | "unknown";

export interface ContactInfo {
  userId: string;
  name: string;
  tags: ContactTag[];
  notes?: string;       // 备注信息
}

// ── Message log ────────────────────────────────────────────────────────────────

export interface WeComMessageLog {
  ts: string;           // ISO timestamp
  from: string;         // UserID
  fromName?: string;    // 发送者名称
  tags: ContactTag[];   // 身份标签
  msgType: string;
  content: string;
  replied: boolean;     // 是否已回复
  replyContent?: string;
}
