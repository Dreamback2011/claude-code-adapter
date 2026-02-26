# Claude Code Adapter

本地 Anthropic Messages API 适配服务器，将标准 API 请求转发给 Claude Code CLI（`claude -p`），使 OpenClaw、Discord 机器人等第三方工具能通过标准 API 格式调用 Claude Code。

## 背景：为什么需要这个工具？

2026 年 1 月，Anthropic 开始封锁第三方工具通过 Claude Pro/Max 订阅的 OAuth 令牌访问 Claude API。OpenClaw、Cline、Roo Code 等大量第三方客户端一夜之间无法再使用用户的 Claude 订阅。

**核心矛盾**：用户付费订阅了 Claude Max（$200/月），却只能通过 Anthropic 官方的 Claude.ai 和 Claude Code CLI 两个入口使用。想在 Discord 机器人、自动化工具中调用 Claude？要么额外购买 API Key 按量付费，要么放弃。

**Claude Code Adapter 提供了一条路径**：Claude Code CLI（`claude -p`）是 Anthropic 官方产品，本项目在本地启动一个兼容 Anthropic Messages API 的 HTTP 服务器，将 API 请求翻译为 CLI 调用。任何支持 Anthropic API 的客户端都可以连接，无需额外的 API Key。

```
OpenClaw / 客户端 → POST /v1/messages → 本地 Adapter → claude -p → Claude Code CLI
```

### 它解决了什么

| 问题 | 本工具的方案 |
|------|-------------|
| 第三方工具被禁用 OAuth | 通过官方 CLI 间接调用，不直接使用 OAuth 令牌 |
| Claude Code 没有 API 接口 | 适配层暴露标准 Anthropic Messages API |
| 想在 Discord/Slack 用 Claude | 本地服务器作为桥梁，客户端配置 Base URL 即可 |
| CLI 不支持流式 SSE | 将 CLI 的 stream-json 格式转换为标准 SSE |
| 从 Claude Desktop 启动时卡死 | 自动清理嵌套会话环境变量 |

> **注意**：本工具通过 Claude Code CLI 转发请求，实际消耗的仍是你 Claude 订阅的配额。请在 Anthropic 服务条款允许的范围内使用。

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/dreamback/claude-code-adapter.git
cd claude-code-adapter
npm install
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
LOCAL_API_KEY=sk-local-your-secret-key
PORT=3456
ALLOWED_TOOLS=Read,Write,Edit,Bash,Grep,Glob
```

### 3. 启动

```bash
npm start
```

或使用管理脚本（后台运行）：

```bash
bash skills/claude-adapter/scripts/manage.sh start
```

### 4. 客户端配置

在 OpenClaw 或其他 Anthropic API 兼容客户端中：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://127.0.0.1:3456` |
| API Key | 与 `.env` 中 `LOCAL_API_KEY` 一致 |
| Model | `claude-sonnet-4-6` |

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/v1/models` | GET | 模型列表 |
| `/v1/messages` | POST | 消息接口（支持 `stream: true/false`） |

## 服务管理

```bash
bash skills/claude-adapter/scripts/manage.sh start    # 启动
bash skills/claude-adapter/scripts/manage.sh stop     # 停止
bash skills/claude-adapter/scripts/manage.sh restart  # 重启
bash skills/claude-adapter/scripts/manage.sh status   # 查看状态
bash skills/claude-adapter/scripts/manage.sh logs     # 查看日志
```

## 作为 Claude Code Plugin 安装

```bash
claude plugin add /path/to/claude-code-adapter
```

安装后，在 Claude Code 中提到"启动 adapter"、"管理 adapter 服务"等关键词时，Skill 会自动触发并提供引导。

## 前置条件

- Node.js >= 18
- 已安装 Claude Code CLI（`claude --version`）
- Claude Code 已登录（`claude auth`）

## 技术栈

- TypeScript + Express + tsx（无需编译步骤）
- 流式传输：CLI `--output-format stream-json` 事件直接转为 SSE

## 许可

MIT
