/**
 * 企业微信模块入口
 */

export { createWeComRouter } from "./webhook.js";
export { sendTextMessage, getUserInfo, clearTokenCache } from "./api.js";
export { loadContacts, getContact, upsertContact, getAllContacts } from "./contacts.js";
export type { WeComConfig, WeComMessage, ContactInfo, ContactTag } from "./types.js";
