/**
 * 企业微信消息加解密
 * 实现 WeCom callback 的签名验证和 AES 消息加解密
 */

import crypto from "node:crypto";

/**
 * 验证回调签名
 * SHA1(sort(token, timestamp, nonce, encrypt))
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  msgSignature: string
): boolean {
  const sorted = [token, timestamp, nonce, encrypt].sort().join("");
  const hash = crypto.createHash("sha1").update(sorted).digest("hex");
  return hash === msgSignature;
}

/**
 * 生成签名（用于回复消息）
 */
export function generateSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string
): string {
  const sorted = [token, timestamp, nonce, encrypt].sort().join("");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

/**
 * 解码 EncodingAESKey → AES Key (32 bytes)
 * EncodingAESKey 是 43 字符的 Base64 编码，补上 "=" 后解码得到 32 字节 key
 */
export function decodeAESKey(encodingAESKey: string): Buffer {
  return Buffer.from(encodingAESKey + "=", "base64");
}

/**
 * 解密企业微信消息
 * AES-256-CBC, key = decodedAESKey, iv = key.slice(0, 16)
 * 解密后格式: random(16) + msgLen(4, network byte order) + msg + corpId
 */
export function decryptMessage(
  encodingAESKey: string,
  encryptedText: string,
  corpId: string
): string {
  const aesKey = decodeAESKey(encodingAESKey);
  const iv = aesKey.subarray(0, 16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([
    decipher.update(encryptedText, "base64"),
    decipher.final(),
  ]);

  // Remove PKCS#7 padding
  const padLen = decrypted[decrypted.length - 1]!;
  const unpaddedLen = decrypted.length - padLen;
  const unpadded = decrypted.subarray(0, unpaddedLen);

  // Parse: random(16) + msgLen(4) + msg + corpId
  const msgLen = unpadded.readUInt32BE(16);
  const msg = unpadded.subarray(20, 20 + msgLen).toString("utf8");
  const extractedCorpId = unpadded.subarray(20 + msgLen).toString("utf8");

  if (extractedCorpId !== corpId) {
    throw new Error(`CorpId mismatch: expected ${corpId}, got ${extractedCorpId}`);
  }

  return msg;
}

/**
 * 加密消息（用于被动回复）
 * AES-256-CBC, 格式: random(16) + msgLen(4) + msg + corpId + PKCS#7 padding
 */
export function encryptMessage(
  encodingAESKey: string,
  message: string,
  corpId: string
): string {
  const aesKey = decodeAESKey(encodingAESKey);
  const iv = aesKey.subarray(0, 16);

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(message, "utf8");
  const corpIdBuf = Buffer.from(corpId, "utf8");

  // msgLen as 4-byte big-endian
  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32BE(msgBuf.length, 0);

  const plaintext = Buffer.concat([random, msgLenBuf, msgBuf, corpIdBuf]);

  // PKCS#7 padding to 32-byte block size
  const blockSize = 32;
  const padLen = blockSize - (plaintext.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  const padded = Buffer.concat([plaintext, padding]);

  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);

  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

// ── Simple XML helpers (no external dependency) ────────────────────────────────

/**
 * Extract a value from XML by tag name
 * Handles both <Tag><![CDATA[value]]></Tag> and <Tag>value</Tag>
 */
export function xmlExtract(xml: string, tag: string): string {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  if (cdataMatch) return cdataMatch[1]!;

  const plainMatch = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (plainMatch) return plainMatch[1]!;

  return "";
}

/**
 * Build encrypted reply XML
 */
export function buildEncryptedXml(
  encrypt: string,
  signature: string,
  timestamp: string,
  nonce: string
): string {
  return `<xml>
<Encrypt><![CDATA[${encrypt}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}
