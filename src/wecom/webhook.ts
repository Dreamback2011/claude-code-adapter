/**
 * 企业微信 Webhook 路由
 * 处理回调 URL 验证 (GET) 和消息接收 (POST)
 */

import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import express from "express";
import type { WeComConfig, WeComMessage } from "./types.js";
import crypto from "node:crypto";
import {
  verifySignature,
  decryptMessage,
  encryptMessage,
  generateSignature,
  xmlExtract,
  buildEncryptedXml,
} from "./crypto.js";
import { handleIncomingMessage } from "./handler.js";
import { loadContacts } from "./contacts.js";

/**
 * 创建企业微信 webhook 路由
 * 挂载到 /wecom/callback
 */
export function createWeComRouter(config: WeComConfig): Router {
  const router = createRouter();

  // 需要 raw body 来解析 XML
  router.use(express.text({ type: ["text/xml", "application/xml"] }));
  // 也接受 urlencoded（某些场景）
  router.use(express.urlencoded({ extended: true }));

  // 加载联系人配置
  loadContacts();

  /**
   * GET /wecom/callback — URL 验证
   * 企业微信在配置回调 URL 时会发送 GET 请求验证
   * 需要解密 echostr 并返回明文
   */
  router.get("/", (req: Request, res: Response) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query as Record<string, string>;

    console.log(`[wecom] URL verification: timestamp=${timestamp} nonce=${nonce}`);
    console.log(`[wecom] DEBUG: msg_signature=${msg_signature}`);
    console.log(`[wecom] DEBUG: echostr=${echostr}`);
    console.log(`[wecom] DEBUG: token length=${config.token?.length}, token first4=${config.token?.slice(0, 4)}`);
    console.log(`[wecom] DEBUG: aesKey length=${config.encodingAESKey?.length}`);

    if (!msg_signature || !timestamp || !nonce || !echostr) {
      console.error("[wecom] Missing verification params");
      res.status(400).send("Missing params");
      return;
    }

    // 调试：手动计算签名看差异
    const sorted = [config.token, timestamp, nonce, echostr].sort().join("");
    const computed = crypto.createHash("sha1").update(sorted).digest("hex");
    console.log(`[wecom] DEBUG: computed sig=${computed}`);
    console.log(`[wecom] DEBUG: received sig=${msg_signature}`);
    console.log(`[wecom] DEBUG: match=${computed === msg_signature}`);

    // 验证签名
    if (!verifySignature(config.token, timestamp, nonce, echostr, msg_signature)) {
      console.error("[wecom] Signature verification failed");
      res.status(403).send("Invalid signature");
      return;
    }

    // 解密 echostr 并返回明文
    try {
      const decrypted = decryptMessage(config.encodingAESKey, echostr, config.corpId);
      console.log(`[wecom] URL verified successfully`);
      res.type("text/plain").send(decrypted);
    } catch (err: any) {
      console.error(`[wecom] Decryption failed: ${err.message}`);
      res.status(500).send("Decryption failed");
    }
  });

  /**
   * POST /wecom/callback — 接收消息
   * 消息体是加密的 XML
   */
  router.post("/", async (req: Request, res: Response) => {
    const { msg_signature, timestamp, nonce } = req.query as Record<string, string>;

    if (!msg_signature || !timestamp || !nonce) {
      res.status(400).send("Missing params");
      return;
    }

    try {
      // 解析外层加密 XML
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const encrypt = xmlExtract(rawBody, "Encrypt");

      if (!encrypt) {
        console.error("[wecom] No Encrypt field in body");
        res.status(400).send("No Encrypt field");
        return;
      }

      // 验证签名
      if (!verifySignature(config.token, timestamp, nonce, encrypt, msg_signature)) {
        console.error("[wecom] Message signature verification failed");
        res.status(403).send("Invalid signature");
        return;
      }

      // 解密消息
      const decryptedXml = decryptMessage(config.encodingAESKey, encrypt, config.corpId);
      console.log(`[wecom] Decrypted message XML: ${decryptedXml.slice(0, 200)}`);

      // 解析消息字段
      const msg: WeComMessage = {
        toUserName: xmlExtract(decryptedXml, "ToUserName"),
        fromUserName: xmlExtract(decryptedXml, "FromUserName"),
        createTime: parseInt(xmlExtract(decryptedXml, "CreateTime") || "0", 10),
        msgType: xmlExtract(decryptedXml, "MsgType"),
        content: xmlExtract(decryptedXml, "Content") || undefined,
        msgId: xmlExtract(decryptedXml, "MsgId") || undefined,
        agentId: parseInt(xmlExtract(decryptedXml, "AgentID") || "0", 10) || undefined,
        event: xmlExtract(decryptedXml, "Event") || undefined,
        eventKey: xmlExtract(decryptedXml, "EventKey") || undefined,
      };

      // 先快速回复 "success"（企业微信要求 5 秒内响应）
      // 然后异步处理消息
      res.type("text/plain").send("success");

      // 异步处理消息（发送回复通过主动发送 API）
      handleIncomingMessage(config, msg).catch((err) => {
        console.error(`[wecom] Message handling error:`, err);
      });

    } catch (err: any) {
      console.error(`[wecom] Webhook error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send("Internal error");
      }
    }
  });

  return router;
}
