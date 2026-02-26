# 架构详解

## 数据流

```
┌──────────────┐     HTTP POST      ┌──────────────────┐    spawn     ┌──────────────┐
│  OpenClaw /   │ ──────────────────→│  Express Server   │ ──────────→│  claude -p    │
│  Discord Bot  │     /v1/messages   │  (adapter)        │            │  (CLI)        │
│               │ ←──────────────────│                   │ ←──────────│              │
└──────────────┘   SSE stream / JSON └──────────────────┘  stream-json└──────────────┘
```

## 模块职责

### `src/index.ts` — 入口

- 在任何 import 之前清理 Claude 相关环境变量（`CLAUDECODE`、`CLAUDE_CODE_*`、`CLAUDE_AGENT_*`）
- 加载 `.env` 配置
- 启动 Express 服务器

### `src/server.ts` — 路由

- `GET /health` — 健康检查
- `GET /v1/models` — 返回模型信息供客户端发现
- `POST /v1/messages` — 核心消息端点
- 内置验证 ping 检测：当 `max_tokens <= 1` 或消息极短时返回合成响应，避免调用 CLI

### `src/adapter.ts` — 核心适配层

- `extractPrompt()` — 从 Anthropic Messages 格式提取纯文本 prompt
- `handleNonStreaming()` — 调用 CLI，收集全部结果后返回 JSON
- `handleStreaming()` — 调用 CLI，将 stream-json 事件逐条转换为 SSE 转发
- 过滤嵌套事件：跳过 `parent_tool_use_id` 不为空的事件，只转发顶层消息
- 兜底合成流：当 CLI 只返回 `result` 而未发送 stream event 时，构造完整的 SSE 序列

### `src/claude-cli.ts` — CLI 调用

- 使用 `spawn("claude", args)` 启动非交互模式
- 参数：`-p <prompt> --output-format stream-json --verbose --include-partial-messages`
- spawn 前清理所有 Claude 环境变量，防止嵌套会话检测
- spawn 后立即关闭 stdin（`proc.stdin.end()`），防止 CLI 等待输入
- 通过 readline 逐行解析 stdout 的 JSON 输出

### `src/auth.ts` — 认证

- 支持 `x-api-key` header 或 `Authorization: Bearer` token
- 未配置 key 时跳过认证

### `src/types.ts` — 类型定义

- Anthropic Messages API 请求/响应类型
- CLI stream-json 输出类型（`CLIStreamEvent`、`CLIResultEvent`）

## 已知问题和修复

### 1. 嵌套会话挂起

**问题**：从 Claude Desktop 或 Claude Code 内部启动服务时，`claude -p` 检测到 `CLAUDECODE=1` 等环境变量后认为处于嵌套会话中，静默挂起不产生任何输出。

**修复**：在 `index.ts` 进程级别和 `claude-cli.ts` spawn 环境中删除所有 `CLAUDECODE`、`CLAUDE_CODE_*`、`CLAUDE_AGENT_*` 环境变量。

### 2. stdin 未关闭导致挂起

**问题**：spawn 使用 `stdio: ["pipe", "pipe", "pipe"]`，stdin 保持打开状态。CLI 可能等待 stdin 关闭后才开始处理。

**修复**：spawn 后立即调用 `proc.stdin?.end()`。

### 3. 嵌套消息事件

**问题**：当 CLI 使用工具（如 Bash、Read）时，会产生嵌套的 `message_start`/`message_stop` 事件。如果全部转发，客户端会因为收到多个 `message_start` 而报错。

**修复**：检查 `streamEvent.parent_tool_use_id`，跳过所有非顶层事件。

## CLI 流式输出格式

CLI 使用 `--output-format stream-json` 时，每行输出一个 JSON 对象：

```jsonc
// 系统信息（忽略）
{"type": "system", "session_id": "...", ...}

// 流式事件（转发）
{"type": "stream_event", "event": {"type": "message_start", ...}, "parent_tool_use_id": null}
{"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}, "parent_tool_use_id": null}

// 嵌套事件（过滤掉）
{"type": "stream_event", "event": {"type": "message_start", ...}, "parent_tool_use_id": "toolu_xxx"}

// 最终结果
{"type": "result", "result": "完整回复文本", "cost_usd": 0.01, "duration_ms": 3000}
```
