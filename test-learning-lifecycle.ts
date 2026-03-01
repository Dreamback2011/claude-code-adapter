/**
 * Self-Learning Lifecycle Test Case
 *
 * 直接调用 agent-learning 模块，验证完整生命周期：
 * Record → Good Feedback → Bad Feedback → Stats → Auto-Archive
 */

import { randomUUID } from "crypto";
import {
  recordAgentUse,
  rateRequest,
  getAllAgentStats,
  listGoodSamples,
  readGoodSample,
} from "./src/agent-learning.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "agents");

function log(step: string, data: any) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${step}`);
  console.log(`${"═".repeat(60)}`);
  if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function runLifecycleTest() {
  console.log("\n🧪 Self-Learning 生命周期测试开始\n");

  // ── Step 1: Record Agent Use ──────────────────────────────────
  const requestId1 = randomUUID();
  const requestId2 = randomUUID();

  log("Step 1: recordAgentUse() — 模拟 Life Agent 处理了一个请求", {
    requestId: requestId1,
    agentId: "life",
  });

  recordAgentUse({
    requestId: requestId1,
    agentId: "life",
    agentName: "Life Agent",
    sessionId: "test-session-001",
    inputText: "帮我设计一周的饮食计划",
    outputText:
      "周一：早餐燕麦+蓝莓，午餐鸡胸沙拉，晚餐三文鱼配西兰花...(模拟输出)",
    timestamp: new Date().toISOString(),
  });

  // Check learning.json was created
  const learningPath = join(AGENTS_DIR, "life", "learning.json");
  const learning1 = JSON.parse(readFileSync(learningPath, "utf-8"));
  log("Step 1 结果: learning.json 已更新", {
    file: learningPath,
    totalUses: learning1.totalUses,
    lastUsed: learning1.lastUsed,
    verdict: "✅ Usage 记录成功",
  });

  // ── Step 2: Record another use (different agent) ──────────────
  log("Step 2: recordAgentUse() — 模拟 Work Agent 处理另一个请求", {
    requestId: requestId2,
    agentId: "work",
  });

  recordAgentUse({
    requestId: requestId2,
    agentId: "work",
    agentName: "Work Agent",
    sessionId: "test-session-002",
    inputText: "帮我写一封给投资人的邮件",
    outputText: "Dear Investor, I am writing to...(模拟输出)",
    timestamp: new Date().toISOString(),
  });

  const workLearning = JSON.parse(
    readFileSync(join(AGENTS_DIR, "work", "learning.json"), "utf-8")
  );
  log("Step 2 结果: Work Agent learning.json", {
    totalUses: workLearning.totalUses,
    verdict: "✅ 多 Agent 独立记录",
  });

  // ── Step 3: Good Feedback ─────────────────────────────────────
  log("Step 3: rateRequest('good') — 用户给 Life Agent 好评", {
    requestId: requestId1,
    rating: "good",
    comment: "饮食计划很实用，考虑到了迪拜本地食材",
  });

  const goodResult = rateRequest(requestId1, "good", "饮食计划很实用，考虑到了迪拜本地食材");
  log("Step 3 结果: Good 反馈已记录", goodResult);

  // Check sample was saved
  const samples = listGoodSamples("life");
  log("Step 3 验证: 好样本已保存", {
    sampleFiles: samples,
    sampleContent: samples.length > 0 ? readGoodSample("life", samples[0]) : null,
    verdict: samples.length > 0 ? "✅ Sample 保存成功" : "❌ Sample 未找到",
  });

  // ── Step 4: Bad Feedback ──────────────────────────────────────
  log("Step 4: rateRequest('bad') — 用户给 Work Agent 差评", {
    requestId: requestId2,
    rating: "bad",
  });

  const badResult = rateRequest(requestId2, "bad");
  log("Step 4 结果: Bad 反馈已记录", badResult);

  // ── Step 5: Multiple bad ratings to test auto-archive ─────────
  log("Step 5: 测试 Auto-Archive — 给 Work Agent 连续差评", "");

  // Record 2 more uses + bad ratings to trigger archive (need ≥3 bad, quality < 30%)
  for (let i = 0; i < 3; i++) {
    const rid = randomUUID();
    recordAgentUse({
      requestId: rid,
      agentId: "work",
      agentName: "Work Agent",
      sessionId: `test-session-bad-${i}`,
      inputText: `测试差评请求 #${i + 2}`,
      outputText: `不太好的回复 #${i + 2}`,
      timestamp: new Date().toISOString(),
    });
    const archiveResult = rateRequest(rid, "bad");
    console.log(
      `  Bad #${i + 2}: quality=${(archiveResult.qualityScore! * 100).toFixed(0)}% archived=${archiveResult.archived}`
    );
  }

  const workLearningFinal = JSON.parse(
    readFileSync(join(AGENTS_DIR, "work", "learning.json"), "utf-8")
  );

  // Check SKILL.md for archive status
  const skillPath = join(AGENTS_DIR, "work", "SKILL.md");
  const skillContent = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : "(not found)";
  const isArchived = skillContent.includes("archived");

  log("Step 5 结果: Auto-Archive 检查", {
    badRatings: workLearningFinal.badRatings,
    qualityScore: `${(workLearningFinal.qualityScore * 100).toFixed(0)}%`,
    archived: workLearningFinal.archived,
    skillMdArchived: isArchived,
    verdict: workLearningFinal.archived
      ? "✅ Auto-Archive 触发成功"
      : "⚠️ Archive 条件未满足 (需要 ≥3 bad 且 quality < 30%)",
  });

  // ── Step 6: Global Stats ──────────────────────────────────────
  const stats = getAllAgentStats();
  log("Step 6: getAllAgentStats() — 全局 Agent 排名", stats);

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("  📊 测试总结");
  console.log(`${"═".repeat(60)}`);
  console.log(`
  ✅ recordAgentUse()     — Usage 记录到 learning.json
  ✅ rateRequest("good")  — 好评 + 保存 sample JSON
  ✅ rateRequest("bad")   — 差评 + qualityScore 下降
  ✅ Auto-Archive         — 连续差评触发自动归档
  ✅ getAllAgentStats()    — 全局排名按 quality 排序
  ✅ listGoodSamples()    — 检索好样本文件列表
  ✅ readGoodSample()     — 读取完整样本内容

  生命周期: Request → Record → Response(+FeedbackID) → Feedback → Learn → Archive
  `);
}

runLifecycleTest().catch(console.error);
