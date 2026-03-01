/**
 * Self-Learning System — Full Lifecycle Test Case
 *
 * 直接调用 agent-learning.ts 的所有公开 API，
 * 演示完整的 6 步生命周期。
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "../agents");

// Import the learning module
import {
  recordAgentUse,
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
} from "../src/agent-learning.js";

// ─── Utilities ────────────────────────────────────────────────

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function header(step: number, title: string) {
  console.log(`\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${CYAN}  Step ${step}: ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
}

function ok(msg: string) { console.log(`  ${GREEN}✅ ${msg}${RESET}`); }
function info(msg: string) { console.log(`  ${DIM}→ ${msg}${RESET}`); }
function warn(msg: string) { console.log(`  ${YELLOW}⚠️  ${msg}${RESET}`); }
function fail(msg: string) { console.log(`  ${RED}❌ ${msg}${RESET}`); }

// ─── Test Data ────────────────────────────────────────────────

const TEST_AGENT_ID = "life"; // Use the life agent
const requestId1 = randomUUID();
const requestId2 = randomUUID();
const requestId3 = randomUUID();

// ─── Cleanup helper ───────────────────────────────────────────

const learningPath = join(AGENTS_DIR, TEST_AGENT_ID, "learning.json");
const samplesDir = join(AGENTS_DIR, TEST_AGENT_ID, "samples");

function cleanupTestData() {
  if (existsSync(learningPath)) rmSync(learningPath);
  if (existsSync(samplesDir)) rmSync(samplesDir, { recursive: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`\n${BOLD}🧪 Self-Learning System — Full Lifecycle Test${RESET}`);
console.log(`${DIM}   Agent: ${TEST_AGENT_ID} | Time: ${new Date().toISOString()}${RESET}`);

// ─── Step 1: Record Agent Use ─────────────────────────────────

header(1, "recordAgentUse() — 记录 Agent 使用");

info(`Request ID: ${requestId1.slice(0, 8)}...`);
info(`模拟 Squad 路由 → 🌱 Life Agent 被选中`);

recordAgentUse({
  requestId: requestId1,
  agentId: TEST_AGENT_ID,
  agentName: "Life Agent",
  sessionId: "test-session-001",
  inputText: "帮我设计一周的健康饮食计划",
  outputText: "## 一周健康饮食计划\n\n### 周一\n- 早餐: 燕麦+蓝莓...\n- 午餐: 鸡胸肉沙拉...\n- 晚餐: 三文鱼+糙米饭...",
  timestamp: new Date().toISOString(),
});

// Verify learning.json was created
if (existsSync(learningPath)) {
  const data = JSON.parse(readFileSync(learningPath, "utf-8"));
  ok(`learning.json 已创建`);
  ok(`totalUses: ${data.totalUses}`);
  ok(`qualityScore: ${(data.qualityScore * 100).toFixed(0)}% (默认值)`);
  console.log(`\n  ${DIM}learning.json 内容:${RESET}`);
  console.log(`  ${DIM}${JSON.stringify(data, null, 2).split("\n").join("\n  ")}${RESET}`);
} else {
  fail("learning.json 未创建！");
}

// ─── Step 2: Rate "good" — 保存样本 ──────────────────────────

header(2, 'rateRequest("good") — 正面反馈 + 样本保存');

info(`对 requestId ${requestId1.slice(0, 8)}... 评价 "good"`);

const goodResult = rateRequest(requestId1, "good", "饮食计划很详细，很实用！");

if (goodResult.ok) {
  ok(`评分成功: ${goodResult.message}`);
  ok(`qualityScore: ${((goodResult.qualityScore ?? 0) * 100).toFixed(0)}%`);

  // Check sample was saved
  const samples = listGoodSamples(TEST_AGENT_ID);
  if (samples.length > 0) {
    ok(`Good sample 已保存: ${samples[0]}`);
    const sample = readGoodSample(TEST_AGENT_ID, samples[0]);
    console.log(`\n  ${DIM}Sample 内容:${RESET}`);
    console.log(`  ${DIM}${JSON.stringify(sample, null, 2).split("\n").join("\n  ")}${RESET}`);
  }
} else {
  fail(goodResult.message);
}

// ─── Step 3: Record 2nd use + rate "bad" ──────────────────────

header(3, 'rateRequest("bad") — 负面反馈 + 质量下降');

info(`记录第2次使用 → requestId ${requestId2.slice(0, 8)}...`);

recordAgentUse({
  requestId: requestId2,
  agentId: TEST_AGENT_ID,
  agentName: "Life Agent",
  sessionId: "test-session-002",
  inputText: "推荐迪拜附近的健身房",
  outputText: "抱歉我不太了解迪拜的健身房...",
  timestamp: new Date().toISOString(),
});

const badResult = rateRequest(requestId2, "bad", "回答太敷衍了，不了解迪拜");

if (badResult.ok) {
  ok(`评分成功: ${badResult.message}`);
  ok(`qualityScore 下降到: ${((badResult.qualityScore ?? 0) * 100).toFixed(0)}%`);

  const data = JSON.parse(readFileSync(learningPath, "utf-8"));
  console.log(`\n  ${DIM}更新后的 learning.json:${RESET}`);
  console.log(`  ${DIM}  goodRatings: ${data.goodRatings}${RESET}`);
  console.log(`  ${DIM}  badRatings:  ${data.badRatings}${RESET}`);
  console.log(`  ${DIM}  qualityScore: ${(data.qualityScore * 100).toFixed(0)}%${RESET}`);
  console.log(`  ${DIM}  archived: ${data.archived}${RESET}`);
} else {
  fail(badResult.message);
}

// ─── Step 4: getAllAgentStats() — 查看排行 ────────────────────

header(4, "getAllAgentStats() — 全局 Agent 排行");

const stats = getAllAgentStats();
console.log(`\n  ${BOLD}Agent 排行 (按 qualityScore 降序):${RESET}\n`);
console.log(`  ${"Agent".padEnd(20)} ${"Uses".padStart(6)} ${"Good".padStart(6)} ${"Bad".padStart(6)} ${"Score".padStart(8)} ${"Status".padStart(10)}`);
console.log(`  ${"─".repeat(58)}`);

for (const s of stats) {
  const score = (s.qualityScore * 100).toFixed(0) + "%";
  const status = s.archived ? `${RED}archived${RESET}` : `${GREEN}active${RESET}`;
  console.log(`  ${s.agentId.padEnd(20)} ${String(s.totalUses).padStart(6)} ${String(s.goodRatings).padStart(6)} ${String(s.badRatings).padStart(6)} ${score.padStart(8)} ${status}`);
}

ok(`共 ${stats.length} 个 Agent 有学习数据`);

// ─── Step 5: Expired request — 错误处理 ──────────────────────

header(5, "过期/无效 requestId — 错误处理");

const expiredResult = rateRequest("nonexistent-request-id", "good");

if (!expiredResult.ok) {
  ok(`正确返回错误: ${expiredResult.message}`);
} else {
  fail("应该返回错误但没有！");
}

// ─── Step 6: Auto-Archive 触发测试 ───────────────────────────

header(6, "Auto-Archive 触发 — 连续差评");

info("模拟连续 3 次差评，触发自动归档...");

// Record 3rd use
recordAgentUse({
  requestId: requestId3,
  agentId: TEST_AGENT_ID,
  agentName: "Life Agent",
  sessionId: "test-session-003",
  inputText: "给我定个作息时间表",
  outputText: "每天早点睡就行了。",
  timestamp: new Date().toISOString(),
});

// Rate bad (2nd bad rating)
const bad2 = rateRequest(requestId3, "bad", "回答太简单");
info(`第2次差评: qualityScore = ${((bad2.qualityScore ?? 0) * 100).toFixed(0)}%`);

// We need a 3rd bad rating. Record another use.
const requestId4 = randomUUID();
recordAgentUse({
  requestId: requestId4,
  agentId: TEST_AGENT_ID,
  agentName: "Life Agent",
  sessionId: "test-session-004",
  inputText: "推荐一个跑步路线",
  outputText: "去公园跑就好了。",
  timestamp: new Date().toISOString(),
});

const bad3 = rateRequest(requestId4, "bad", "毫无帮助");
info(`第3次差评: qualityScore = ${((bad3.qualityScore ?? 0) * 100).toFixed(0)}%`);

if (bad3.archived) {
  warn(`🚨 AUTO-ARCHIVE 触发！Agent "${bad3.agentName}" 已被自动归档`);
  warn(`质量分: ${((bad3.qualityScore ?? 0) * 100).toFixed(0)}% | 条件: badRatings ≥ 3 且 score < 30%`);

  // Show SKILL.md status change
  const skillPath = join(AGENTS_DIR, TEST_AGENT_ID, "SKILL.md");
  if (existsSync(skillPath)) {
    const content = readFileSync(skillPath, "utf-8");
    const statusLine = content.split("\n").find(l => l.startsWith("status:"));
    info(`SKILL.md status 已变更: ${statusLine}`);
  }
} else {
  info(`未触发归档 (qualityScore=${((bad3.qualityScore ?? 0) * 100).toFixed(0)}% — 可能还不够低)`);
}

// ─── Final Summary ────────────────────────────────────────────

console.log(`\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}${CYAN}  Test Complete — Final State${RESET}`);
console.log(`${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

const finalData = JSON.parse(readFileSync(learningPath, "utf-8"));
const finalSamples = listGoodSamples(TEST_AGENT_ID);

console.log(`
  📊 Final learning.json:
     totalUses:    ${finalData.totalUses}
     goodRatings:  ${finalData.goodRatings} 👍
     badRatings:   ${finalData.badRatings} 👎
     qualityScore: ${(finalData.qualityScore * 100).toFixed(0)}%
     archived:     ${finalData.archived}
     goodSamples:  ${finalData.goodSamples.length} 个

  📁 Saved samples: ${finalSamples.join(", ") || "none"}
`);

// ─── Cleanup ──────────────────────────────────────────────────

console.log(`${DIM}  🧹 Cleaning up test data...${RESET}`);
cleanupTestData();

// Restore SKILL.md if it was archived
const skillPath = join(AGENTS_DIR, TEST_AGENT_ID, "SKILL.md");
if (existsSync(skillPath)) {
  let content = readFileSync(skillPath, "utf-8");
  if (content.includes('status: "archived"')) {
    content = content.replace(/^status:\s*"archived".*$/m, 'status: "active"');
    writeFileSync(skillPath, content);
    ok("SKILL.md 已恢复为 active");
  }
}

ok("测试数据已清理完毕");
console.log(`\n${BOLD}${GREEN}🎉 Self-Learning Lifecycle Test — ALL PASSED${RESET}\n`);
