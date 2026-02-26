---
name: claude-adapter
description: This skill should be used when the user asks to "start the adapter server", "start claude adapter", "manage adapter", "configure local API server", "set up OpenClaw backend", "stop adapter", "restart adapter", "check adapter status", or mentions running a local Anthropic-compatible API that proxies to Claude Code CLI.
version: 1.0.0
---

# Claude Code Adapter

## 目的

Claude Code Adapter 是一个本地 Express 服务器，提供 Anthropic Messages API 兼容接口，将请求转发给 Claude Code CLI（`claude -p`）。这使得 OpenClaw、Discord 机器人等第三方工具能够通过标准 API 格式调用 Claude Code 的全部能力（包括文件读写、命令执行等工具）。

## 核心架构

```
第三方客户端 → POST /v1/messages → Express 服务器 → claude -p "prompt" → Claude Code CLI → 流式响应
```

## 配置

1. 复制 `.env.example` 为 `.env`，设置以下变量：
   - `LOCAL_API_KEY` — 本地认证密钥
   - `PORT` — 服务端口（默认 3456）
   - `ALLOWED_TOOLS` — Claude CLI 可用工具（逗号分隔）

2. 安装依赖：运行 `npm install`

## 启动和管理服务

使用管理脚本进行服务生命周期管理：

```bash
# 启动服务
bash skills/claude-adapter/scripts/manage.sh start

# 查看状态
bash skills/claude-adapter/scripts/manage.sh status

# 查看日志
bash skills/claude-adapter/scripts/manage.sh logs

# 重启服务
bash skills/claude-adapter/scripts/manage.sh restart

# 停止服务
bash skills/claude-adapter/scripts/manage.sh stop
```

也可以前台运行：`npm start`

## 客户端配置

在 OpenClaw 或其他兼容 Anthropic API 的客户端中配置：

- **Base URL**: `http://127.0.0.1:3456`
- **API Key**: 与 `.env` 中 `LOCAL_API_KEY` 一致
- **Model**: `claude-sonnet-4-6`

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /v1/models` | 模型列表 |
| `POST /v1/messages` | 消息接口（支持流式和非流式） |

## 重要注意事项

- 从 Claude Desktop 终端启动时，服务器会自动清理嵌套会话相关环境变量
- 流式模式下自动过滤工具调用产生的嵌套事件，只转发顶层消息
- 详细架构说明参见 `references/architecture.md`
