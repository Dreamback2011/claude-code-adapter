# Claude Code Adapter

> Local Anthropic Messages API server that forwards requests to Claude Code CLI.
>
> 本地 Anthropic Messages API 适配服务器 — 将 API 请求转发给 Claude Code CLI（`claude -p`）。

```
Client  →  POST /v1/messages  →  Local Adapter  →  claude -p  →  Claude Code CLI
```

---

## Why? / 为什么需要这个？

**EN:** In early 2026, Anthropic blocked third-party tools from using Claude subscriptions via OAuth tokens. If you're paying $200/mo for Claude Max, you can only use it through Claude.ai and Claude Code CLI. Want to use Claude in OpenClaw, Discord bots, or other tools? You'd need to pay extra for an API key.

**This adapter bridges that gap** — it runs a local HTTP server that speaks the Anthropic Messages API, and forwards requests to the official Claude Code CLI. Any Anthropic-compatible client can connect. No extra API key needed.

**中文：** 2026 年初，Anthropic 封锁了第三方工具通过 OAuth 访问 Claude API。花了 $200/月订阅 Claude Max，却只能在官方客户端用。

**Claude Code Adapter 解决了这个问题** — 在本地启动一个兼容 Anthropic Messages API 的 HTTP 服务器，将请求通过官方 Claude Code CLI 转发。无需额外的 API Key。

### What it solves / 解决了什么

| Problem | Solution |
|---------|----------|
| Third-party tools blocked from Claude | Routes through official CLI |
| Claude Code has no HTTP API | Adapter exposes standard Anthropic Messages API |
| CLI doesn't support SSE streaming | Converts CLI stream-json to standard SSE |
| Nested session hangs from Claude Desktop | Auto-cleans environment variables |

---

## Quick Start / 快速开始

### Prerequisites / 前置条件

- **Node.js >= 18** — [Download](https://nodejs.org)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Claude CLI logged in** — `claude auth login`

### One-Click Setup / 一键安装

```bash
git clone https://github.com/Dreamback2011/claude-code-adapter.git
cd claude-code-adapter
bash setup.sh
```

The setup script will:
1. Check all prerequisites (Node.js, Claude CLI, auth status)
2. Install npm dependencies
3. Generate `.env` with a random API key
4. Test the server startup
5. Show you the next steps

### Manual Setup / 手动安装

```bash
git clone https://github.com/Dreamback2011/claude-code-adapter.git
cd claude-code-adapter
npm install
cp .env.example .env
# Edit .env to set your API key
npm start
```

---

## ⚠️ Keep the Server Running / 保持服务运行

**This is important!** The adapter is an HTTP server — it must be running whenever you want to use Claude through OpenClaw or other clients.

**重要提示！** 适配器是一个 HTTP 服务，使用 OpenClaw 等客户端时必须保持运行。

### Option A: Foreground / 前台运行

```bash
npm start
```

Keep the terminal open. Press `Ctrl+C` to stop.

### Option B: Background with manage script / 后台运行（推荐）

```bash
bash scripts/manage.sh start     # Start / 启动
bash scripts/manage.sh stop      # Stop / 停止
bash scripts/manage.sh restart   # Restart / 重启
bash scripts/manage.sh status    # Check status / 查看状态
bash scripts/manage.sh logs      # View logs / 查看日志
```

### Option C: Auto-start on boot (macOS) / 开机自启（macOS）

Create a LaunchAgent to start the adapter automatically:

```bash
cat > ~/Library/LaunchAgents/com.claude-adapter.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-adapter</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which npx)</string>
        <string>tsx</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-adapter.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-adapter.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.claude-adapter.plist
```

To stop auto-start: / 取消自启:

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-adapter.plist
```

---

## Configure OpenClaw / 配置 OpenClaw 自定义模型

After the adapter is running, configure OpenClaw to use it as a custom model provider:

适配器运行后，在 OpenClaw 中配置自定义模型：

### Step-by-step / 分步教程

**Step 1** — Run the OpenClaw configure wizard / 运行配置向导:

```bash
openclaw configure
```

**Step 2** — Select **Model** / 选择「Model」:

```
┌ OpenClaw Configuration ─────────────────────┐
│                                              │
│  ○ Workspace                                 │
│  ● Model          ← select this / 选这个     │
│  ○ Web tools                                 │
│  ○ Gateway                                   │
│  ○ Channels                                  │
│  ○ Skills                                    │
│                                              │
└──────────────────────────────────────────────┘
```

**Step 3** — Select **Custom Provider** / 选择「Custom Provider」:

```
┌ Model/auth provider ────────────────────────┐
│                                              │
│  ○ Anthropic                                 │
│  ○ OpenAI                                    │
│  ○ Google                                    │
│  ...                                         │
│  ● Custom Provider  ← select this / 选这个   │
│  ○ Skip for now                              │
│                                              │
└──────────────────────────────────────────────┘
```

**Step 4** — Enter your adapter details / 填写适配器信息:

```
┌ Custom Provider Configuration ──────────────┐
│                                              │
│  API Base URL:                               │
│  > http://127.0.0.1:3456                     │
│                        ↑                     │
│               your .env PORT / 你 .env 的端口 │
│                                              │
│  API Key:                                    │
│  > sk-local-xxxxxxxxxxxx                     │
│                   ↑                          │
│       your .env LOCAL_API_KEY / .env 里的 Key │
│                                              │
│  Endpoint compatibility:                     │
│  ● Anthropic-compatible  ← select this       │
│  ○ OpenAI-compatible                         │
│  ○ Unknown (detect automatically)            │
│                                              │
│  Model ID:                                   │
│  > claude-sonnet-4-6                         │
│                                              │
└──────────────────────────────────────────────┘
```

**Step 5** — Wait for verification / 等待验证:

```
  Verifying...
  ✔ Connected to http://127.0.0.1:3456
```

**Step 6** — Set alias (optional) / 设置别名（可选）:

```
  Endpoint ID: custom-127-0-0-1-3456
  Model alias: local          ← makes it easy to switch
```

**Done!** OpenClaw will now use your local Claude Code Adapter as the primary model.

**完成！** OpenClaw 现在会使用你本地的 Claude Code Adapter 作为主模型。

### Verify it works / 验证是否生效

```bash
# Check adapter is running
curl http://127.0.0.1:3456/health
# Expected: {"status":"ok","service":"claude-code-adapter"}

# Check model discovery
curl http://127.0.0.1:3456/v1/models
# Expected: {"data":[{"id":"claude-sonnet-4-6",...}]}

# Test with OpenClaw
openclaw agent --message "Hello, say hi in one sentence"
```

### Manual config (alternative) / 手动配置

If you prefer to edit the config file directly, add this to `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "claude-adapter": {
        "baseUrl": "http://127.0.0.1:3456",
        "apiKey": "sk-local-xxxxxxxxxxxx",    // your LOCAL_API_KEY
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Code CLI",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 128000
          }
        ]
      }
    }
  }
}
```

---

## API Endpoints / API 端点

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check / 健康检查 |
| `/v1/models` | GET | List available models / 模型列表 |
| `/v1/messages` | POST | Messages API (supports `stream: true/false`) |

---

## Configuration / 配置说明

Edit `.env` in the project root:

```env
# API key for client authentication (leave empty to disable auth)
# 客户端认证密钥（留空则不验证）
LOCAL_API_KEY=sk-local-your-secret-key

# Server port / 服务端口
PORT=3456

# Claude CLI allowed tools (comma-separated)
# 允许 Claude CLI 使用的工具
ALLOWED_TOOLS=Read,Write,Edit,Bash,Grep,Glob
```

---

## How It Works / 工作原理

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Client (OpenClaw / Discord Bot / any Anthropic client)      │
│                                                              │
│  POST /v1/messages  { stream: true, messages: [...] }        │
│                          │                                   │
└──────────────────────────┼───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Claude Code Adapter (this project)     http://127.0.0.1:3456│
│                                                              │
│  1. Validate request & auth                                  │
│  2. Extract prompt from messages                             │
│  3. Spawn: claude -p "prompt"                                │
│        --output-format stream-json                           │
│        --verbose --include-partial-messages                   │
│  4. Stream CLI events → Convert to SSE → Respond to client   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Claude Code CLI (official Anthropic tool)                    │
│                                                              │
│  Uses your Claude Max subscription — no extra API key needed │
│  使用你的 Claude Max 订阅 — 无需额外 API Key                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Key design decisions / 关键设计

- **SSE streaming**: CLI's `stream-json` output is translated to standard Server-Sent Events with near-zero overhead
- **Nested session fix**: Cleans `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*` env vars at both process and spawn level to prevent hangs
- **Smart filtering**: Skips tool-use blocks and nested events, only forwards user-facing text to clients
- **Quick ping detection**: Short/empty requests return instant synthetic responses (for client handshakes)

---

## Troubleshooting / 常见问题

### Server won't start / 服务启动失败

```bash
# Check if port is already in use
lsof -i :3456

# Check Claude CLI is working
claude -p "hello" --output-format json
```

### OpenClaw verification fails / OpenClaw 验证失败

```bash
# 1. Make sure adapter is running
curl http://127.0.0.1:3456/health

# 2. Make sure API key matches
# .env:          LOCAL_API_KEY=sk-local-xxx
# OpenClaw:      API Key = sk-local-xxx  (must be identical)

# 3. Make sure you selected "Anthropic-compatible"
```

### Streaming not working / 流式输出不工作

Make sure your client sends `"stream": true` in the request body. The adapter supports both streaming and non-streaming modes.

### Adapter hangs / 适配器卡死

This usually means the Claude CLI nested session issue. Make sure you're NOT running the adapter from inside Claude Desktop or Claude Code. If you must, the adapter auto-cleans env vars, but restarting in a fresh terminal is safest.

---

## Tech Stack / 技术栈

- TypeScript + Express + tsx (no build step / 无需编译)
- Zero external AI dependencies (only uses Claude Code CLI)

## License

MIT

---

> **Note:** This tool forwards requests through Claude Code CLI. It uses your existing Claude subscription quota. Please use within Anthropic's terms of service.
>
> **注意：** 本工具通过 Claude Code CLI 转发请求，消耗的是你 Claude 订阅的配额。请在 Anthropic 服务条款允许的范围内使用。
