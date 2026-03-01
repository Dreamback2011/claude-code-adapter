// Clean environment BEFORE anything else —
// prevents "nested session" detection when spawning claude CLI
delete process.env.CLAUDECODE;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_AGENT_")) {
    delete process.env[key];
  }
}

// Global EPIPE protection — prevent pipe errors from crashing the server
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET") {
    console.warn("[global] Caught EPIPE/ECONNRESET (client disconnected):", err.message);
    return; // Don't crash
  }
  console.error("[global] Uncaught exception:", err);
  process.exit(1);
});

import "dotenv/config";
import { createServer } from "./server.js";
import { pruneOldMessages } from "./message-logger.js";
import { getMemoryStats, reloadIndex, searchMemories, preloadModel, qmdFullSync } from "./memory/index.js";
import { setupEvaluationCron } from "./agent-evaluation.js";

const useAgentSquad = process.env.USE_AGENT_SQUAD === "true";

const config = {
  port: parseInt(process.env.PORT || "3456", 10),
  apiKey: process.env.LOCAL_API_KEY || "",
  allowedTools: process.env.ALLOWED_TOOLS || "Read,Write,Edit,Bash,Grep,Glob",
  useAgentSquad,
};

// Clean up log entries older than 5 days on every startup
pruneOldMessages();

const app = createServer(config);

app.listen(config.port, () => {
  console.log(`
┌─────────────────────────────────────────────┐
│  Claude Code Adapter Server                 │
├─────────────────────────────────────────────┤
│  Port:     ${String(config.port).padEnd(33)}│
│  Auth:     ${(config.apiKey ? "enabled" : "disabled").padEnd(33)}│
│  Tools:    ${config.allowedTools.padEnd(33)}│
│  AgentSquad: ${(useAgentSquad ? "ENABLED" : "disabled").padEnd(31)}│
│  X-Timeline: ${"ACTIVE (every 1h)".padEnd(31)}│
│  Semantic:  ${"QMD vsearch".padEnd(33)}│
├─────────────────────────────────────────────┤
│  OpenClaw Config:                           │
│  Base URL: http://127.0.0.1:${String(config.port).padEnd(15)}│
│  Endpoint: Anthropic-compatible (/messages) │
└─────────────────────────────────────────────┘
  `);

  // Pre-load memory index
  reloadIndex();
  const memStats = getMemoryStats();
  console.log(`[memory] Index pre-loaded: ${memStats.total} items (${Object.entries(memStats.byCategory).map(([k,v]) => `${k}:${v}`).join(', ')})`);

  // Initialize QMD semantic search + full sync
  preloadModel().then(() => {
    const allItems = searchMemories({ limit: 9999 });
    if (allItems.length > 0) {
      qmdFullSync(allItems).then(() => {
        console.log(`[QMD] Full sync complete: ${allItems.length} items indexed`);
      });
    }
  });

  // Start daily agent evaluation cron (runs at 23:00 local time)
  setupEvaluationCron();
  console.log('[Evaluation] Cron job initialized');
});
