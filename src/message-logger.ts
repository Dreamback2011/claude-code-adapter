/**
 * message-logger.ts
 * 记录每条 messages 请求到 messages.log 文件
 * 只保留最近 5 天的记录，启动时自动清理
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.resolve(__dirname, "..", "messages.log");
const KEEP_DAYS = 5;

/** 返回 "YYYY-MM-DD HH:MM:SS" 格式的本地时间字符串 */
function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 启动时清理超过 KEEP_DAYS 天的旧记录 */
export function pruneOldMessages(): void {
  if (!fs.existsSync(LOG_FILE)) return;

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");

  const kept = lines.filter((line) => {
    if (!line.trim()) return false;
    // 格式: [2026-02-27 10:30:00] ...
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    if (!m) return true; // 无法解析的行保留
    const lineTime = new Date(m[1] + "Z").getTime();
    return lineTime >= cutoff;
  });

  fs.writeFileSync(LOG_FILE, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  console.log(`[message-logger] Pruned log — kept ${kept.length} entries (last ${KEEP_DAYS} days)`);
}

/**
 * 记录一条消息请求
 * @param input  用户输入文本（截断到 200 字符）
 * @param output 助手回复文本（截断到 200 字符）
 * @param inputTokens  输入 token 数（可选）
 * @param outputTokens 输出 token 数（可选）
 */
export function logMessage(
  input: string,
  output: string,
  inputTokens?: number,
  outputTokens?: number
): void {
  const ts = timestamp();
  const inputSnippet = input.replace(/\n/g, " ").slice(0, 200);
  const outputSnippet = output.replace(/\n/g, " ").slice(0, 200);
  const tokenInfo = inputTokens != null
    ? ` [in:${inputTokens} out:${outputTokens ?? "?"}]`
    : "";

  const entry = `[${ts}] IN: "${inputSnippet}" | OUT: "${outputSnippet}"${tokenInfo}\n`;
  fs.appendFileSync(LOG_FILE, entry, "utf8");
}
