/**
 * 企业微信联系人管理
 * 本地 contacts.json 存储身份标签和备注
 */

import fs from "node:fs";
import path from "node:path";
import type { ContactInfo, ContactTag } from "./types.js";

const CONTACTS_FILE = path.resolve("agents/wecom/contacts.json");

let contacts: Map<string, ContactInfo> = new Map();

/**
 * 加载联系人配置
 */
export function loadContacts(): void {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")) as ContactInfo[];
      contacts = new Map(data.map((c) => [c.userId, c]));
      console.log(`[wecom] Loaded ${contacts.size} contacts`);
    } else {
      // Create empty contacts file
      fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
      fs.writeFileSync(CONTACTS_FILE, "[]", "utf8");
      console.log("[wecom] Created empty contacts.json");
    }
  } catch (err: any) {
    console.error(`[wecom] Failed to load contacts: ${err.message}`);
  }
}

/**
 * 查找联系人信息
 */
export function getContact(userId: string): ContactInfo | undefined {
  return contacts.get(userId);
}

/**
 * 获取联系人标签（未知用户返回 ["unknown"]）
 */
export function getContactTags(userId: string): ContactTag[] {
  const contact = contacts.get(userId);
  return contact?.tags ?? ["unknown"];
}

/**
 * 添加或更新联系人
 */
export function upsertContact(info: ContactInfo): void {
  contacts.set(info.userId, info);
  saveContacts();
}

/**
 * 保存联系人到文件
 */
function saveContacts(): void {
  const data = Array.from(contacts.values());
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 按名字查找联系人（用于匹配预注册的占位联系人）
 */
export function findContactByName(name: string): ContactInfo | undefined {
  for (const c of contacts.values()) {
    if (c.name === name) return c;
  }
  return undefined;
}

/**
 * 更新联系人的 UserID（把占位 ID 替换为真实 ID）
 */
export function migrateContactUserId(oldId: string, newId: string): void {
  const contact = contacts.get(oldId);
  if (!contact) return;
  contacts.delete(oldId);
  contact.userId = newId;
  contacts.set(newId, contact);
  saveContacts();
  console.log(`[wecom] Migrated contact ${contact.name}: ${oldId} → ${newId}`);
}

/**
 * 获取所有联系人
 */
export function getAllContacts(): ContactInfo[] {
  return Array.from(contacts.values());
}
