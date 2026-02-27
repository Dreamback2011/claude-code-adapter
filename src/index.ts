// Clean environment BEFORE anything else —
// prevents "nested session" detection when spawning claude CLI
delete process.env.CLAUDECODE;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_AGENT_")) {
    delete process.env[key];
  }
}

import "dotenv/config";
import { createServer } from "./server.js";
import { pruneOldMessages } from "./message-logger.js";

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
├─────────────────────────────────────────────┤
│  OpenClaw Config:                           │
│  Base URL: http://127.0.0.1:${String(config.port).padEnd(15)}│
│  Endpoint: Anthropic-compatible (/messages) │
└─────────────────────────────────────────────┘
  `);
});
