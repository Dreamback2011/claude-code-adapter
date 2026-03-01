# OpenClaw Architecture

> **OpenClaw** -- 基于 Claude Code CLI 的 AI 多智能体平台
>
> GitHub: [Dreamback2011/claude-code-adapter](https://github.com/Dreamback2011/claude-code-adapter)
>
> 最后更新: 2026-03-02

---

## 目录

1. [概述 (Overview)](#1-概述)
2. [系统架构 (System Architecture)](#2-系统架构)
3. [核心组件 (Core Components)](#3-核心组件)
4. [智能体系统 (Agent System)](#4-智能体系统)
5. [子系统详解 (Subsystems)](#5-子系统详解)
6. [跨 Agent 协作 (Cross-Agent Collaboration)](#6-跨-agent-协作)
7. [API 端点 (API Endpoints)](#7-api-端点)
8. [配置与部署 (Configuration & Deployment)](#8-配置与部署)
9. [个性化调整 (Customizations)](#9-个性化调整)
10. [项目统计 (Statistics)](#10-项目统计)

---

## 1. 概述

### 什么是 OpenClaw?

OpenClaw 是一个运行在本地的 **AI 多智能体平台**。它的核心是一个 Anthropic Messages API 适配器（代号 `claude-code-adapter`），将标准的 Anthropic API 请求转发给 Claude Code CLI，使得任何兼容 Anthropic API 的客户端 -- Discord Bot、企业微信、Telegram Bot 等 -- 都能无缝接入 Claude 的全部能力。

所有请求统一经由官方 Claude Code CLI (`claude -p`) 转发，**无需额外 API Key**，直接复用现有 Claude Max 订阅额度。

### 核心设计理念

| 设计原则 | 说明 |
|---------|------|
| **零构建运行** | TypeScript + tsx，无编译步骤，修改即生效 |
| **CLI 即引擎** | 不直接调用 Anthropic API，而是以 Claude Code CLI 作为底层推理引擎，天然继承其全部工具链 |
| **多智能体路由** | 基于 Agent Squad (awslabs) 的意图分类，自动将请求路由到最匹配的 Agent |
| **流式优先** | CLI 输出 `stream-json` 格式，Adapter 近乎零转换成本地转为 SSE |
| **个人优先** | 为个人使用场景设计，强调 ADHD 友好、中文优先、结构化输出 |

### 一句话总结

> 把 Claude Code CLI 变成一个可编程的多智能体 API 服务器，14 个专业 Agent 各司其职，覆盖工作、投资、链上资产、生活、健康等领域。

### 基本信息

- **所有者**: Alex Gu (山哥), BD & Key Projects Lead @ Bitget Wallet
- **GitHub**: https://github.com/Dreamback2011/claude-code-adapter
- **服务端口**: 3456
- **协议兼容**: Anthropic Messages API (streaming + non-streaming)

---

## 2. 系统架构

### 整体架构图

```
                        外部客户端
          ┌──────────┬──────────┬──────────┐
          │ Discord  │  WeChat  │ Telegram │  ...
          │   Bot    │  企业号   │   Bot    │
          └────┬─────┴────┬─────┴────┬─────┘
               │          │          │
               └──────────┼──────────┘
                          │
                  POST /v1/messages
                          │
               ┌──────────▼──────────┐
               │   Express Server    │
               │   localhost:3456    │
               │                     │
               │  ┌───────────────┐  │
               │  │   Auth 验证    │  │  x-api-key / Bearer token
               │  └───────┬───────┘  │
               │          │          │
               │  ┌───────▼───────┐  │
               │  │  Agent Squad  │  │  意图分类 → Agent 路由
               │  │    Router     │  │
               │  └───────┬───────┘  │
               │          │          │
               │  ┌───────▼───────┐  │
               │  │   Adapter     │  │  Anthropic API ↔ CLI I/O
               │  └───────┬───────┘  │
               └──────────┼──────────┘
                          │
               ┌──────────▼──────────┐
               │  Claude Code CLI    │
               │  claude -p "..."    │
               │  --output-format    │
               │  stream-json        │
               │  --model <model>    │
               └──────────┬──────────┘
                          │
               ┌──────────▼──────────┐
               │  stream_event.event │
               │  (raw Claude API    │
               │   events)           │
               └──────────┬──────────┘
                          │
                  SSE / JSON Response
                          │
               ┌──────────▼──────────┐
               │     外部客户端       │
               └─────────────────────┘
```

### 请求生命周期

```
1. 客户端发送 POST /v1/messages (Anthropic Messages API 格式)
       │
2. Auth 中间件验证 API Key (x-api-key / Bearer token)
       │
3. 并发控制检查 (MAX_CONCURRENT = 20)
       │
4. Agent Squad 分析消息意图，选择目标 Agent
       │
5. Session Store 查询/创建 session (24h TTL)
       │
6. Adapter 将请求转换为 CLI 参数，构建提示词
       │
7. 生成 claude -p 子进程 (带自适应超时)
       │
8. CLI 输出 stream-json → Adapter 转换为 SSE
       │
9. 响应流式返回客户端
       │
10. Session 持久化 + 指标记录 + 日志归档
```

### 数据流向

```
                    ┌─────────────┐
     请求 ─────────►│  server.ts  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
      ┌───────▼───┐ ┌─────▼─────┐ ┌───▼────────┐
      │ session-  │ │ adapter.ts│ │ webhook-   │
      │ store.ts  │ │           │ │ config.ts  │
      └───────────┘ └─────┬─────┘ └────────────┘
                          │
                   ┌──────▼──────┐
                   │ claude-     │
                   │ cli.ts      │
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
      ┌───────▼───┐ ┌────▼────┐ ┌───▼──────┐
      │ agent-    │ │ message-│ │ agent-   │
      │ metrics.ts│ │ logger  │ │ learning │
      └───────────┘ └─────────┘ └──────────┘
```

---

## 3. 核心组件

### 3.1 源码文件总览

#### 主模块 (`src/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 75 | 入口文件，加载 `.env`，清理嵌套 session 环境变量，启动服务器 |
| `server.ts` | 716 | Express 路由中枢：健康检查、模型列表、消息处理、任务管理、心跳、内存接口 |
| `adapter.ts` | 434 | **核心转换层**: Anthropic Messages API 请求 <-> Claude CLI I/O |
| `claude-cli.ts` | 458 | CLI 进程管理：生成 `claude -p` 进程、自适应超时、子进程状态检测 |
| `auth.ts` | 38 | API Key 认证中间件 (`x-api-key` / `Bearer token`) |
| `types.ts` | 137 | Anthropic Messages API TypeScript 类型定义 |
| `session-store.ts` | 187 | Session 持久化 (24h TTL, `.sessions.json`, 每5分钟保存) |
| `agent-metrics.ts` | 317 | Agent 指标追踪 (成功率 / 延迟 / 错误 / 日维度 & 周维度) |
| `agent-learning.ts` | 282 | Agent 学习系统 (模式识别 / 经验积累) |
| `agent-evaluation.ts` | 498 | 4 维健康评估 (活跃度 / 成功率 / 故障率 / 坚固程度) |
| `task-manager.ts` | 135 | 异步任务生命周期管理 (创建 / 查询 / 流式) |
| `task-runner.ts` | 195 | 任务执行引擎 + Webhook 投递 |
| `cron-scheduler.ts` | 556 | 定时任务调度器 (评估 / X 抓取 / 心跳 / RSS) |
| `heartbeat.ts` | 314 | 13 分钟心跳检查 |
| `message-logger.ts` | 61 | 请求/响应日志 (5 天自动清理) |
| `webhook-config.ts` | 197 | Discord Webhook 路由 (10 个频道映射) |
| `squad.ts` | 76 | Agent Squad (awslabs) 集成封装 |
| `utils.ts` | 28 | 工具函数 |

#### Agent 注册 (`src/agents/`)

| 文件 | 职责 |
|------|------|
| `agent-registry.ts` | 从 `agents/*/SKILL.md` frontmatter 动态加载 Agent 定义 |
| `claude-code-agent.ts` | Claude Code 专用路由适配 |

#### 流事件分类 (`src/classifiers/`)

| 文件 | 职责 |
|------|------|
| `cli-classifier.ts` | 解析 CLI stream-json 输出，分类事件类型 (thinking / tool / text / error) |

#### 记忆系统 (`src/memory/`, 11 个文件)

| 文件 | 职责 |
|------|------|
| `index.ts` | 模块聚合导出 |
| `types.ts` | 记忆条目类型定义 |
| `memory-store.ts` | CRUD 操作 + 去重 + 索引 |
| `permission-gate.ts` | 敏感度分级访问控制 |
| `identity-resolver.ts` | 调用者身份识别 |
| `progress-tracker.ts` | 任务进度监控 |
| `quality-learner.ts` | 质量学习与反馈 |
| `rag-retriever.ts` | RAG 语义检索 |
| `qmd-search.ts` | QMD 向量搜索 |
| `auto-extract.ts` | 对话知识自动提取 |
| `embeddings.ts` | 向量嵌入生成 |

#### 企业微信模块 (`src/wecom/`, 7 个文件)

| 文件 | 职责 |
|------|------|
| `index.ts` | 模块入口 |
| `types.ts` | WeCom 类型定义 |
| `api.ts` | 企业微信 API 封装 |
| `contacts.ts` | 通讯录管理 |
| `crypto.ts` | 消息 AES 加解密 |
| `handler.ts` | 消息处理逻辑 |
| `webhook.ts` | Webhook 签名验证与回调处理 |

---

### 3.2 Adapter -- 系统的心脏

Adapter (`adapter.ts`) 是 OpenClaw 最核心的组件，负责两个世界之间的翻译：

```
Anthropic Messages API                     Claude Code CLI
─────────────────────                     ──────────────────
{                                         claude -p "..." \
  model: "claude-sonnet-4-...",       →     --model claude-sonnet-4-... \
  messages: [...],                          --output-format stream-json \
  stream: true                              --verbose
}                                           --include-partial-messages

SSE: event: content_block_delta       ←   {"type":"stream_event",
      data: {"delta":{"text":"..."}}        "event":{"type":"content_block_delta",...}}
```

**关键设计**: CLI 的 `stream_event.event` 字段本身就是原始 Claude API 事件，Adapter 几乎零转换成本地将其转为 SSE 格式。这意味着客户端收到的响应与直接调用 Anthropic API 几乎完全一致。

两种工作模式：

| 模式 | 说明 |
|------|------|
| **Non-streaming** | 捕获 result 事件，聚合完整响应后一次性返回 JSON |
| **Streaming** | 将 CLI 的 stream-json 输出直接转发为 SSE，近零转换开销 |

提示词构建支持三种模式：单消息 / 历史记录 / 会话恢复 (resume)。

---

### 3.3 CLI 进程管理

`claude-cli.ts` 负责生成和监控 CLI 子进程：

```typescript
// 生成命令示意
spawn('claude', [
  '-p', prompt,
  '--model', model,
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages'
], {
  env: cleanedEnv  // 清理嵌套 session 变量
});
```

核心特性：
- **自适应超时**: 根据 CLI 当前状态 (thinking / tool_running / responding) 动态调整超时阈值
- **活跃检测**: 每 30 秒 `pgrep -P <pid>` 检查子进程，防止误杀长时间运行的工具操作
- **会话恢复**: 支持 `--resume` 标志恢复之前的 CLI 会话
- **环境隔离**: 清理所有可能导致嵌套 session 检测的环境变量

---

### 3.4 认证系统

简洁的 API Key 中间件，支持两种认证方式：

```
x-api-key: sk-local-xxxxx              # Header 方式
Authorization: Bearer sk-local-xxxxx   # Bearer 方式
```

API Key 通过 `.env` 文件中的 `LOCAL_API_KEY` 配置。

---

### 3.5 Session 管理

```
外部 Session ID  ──映射──►  Claude CLI Session ID

存储: .sessions.json
TTL:  24 小时
保存: 每 5 分钟自动持久化
清理: 每小时移除过期 session
```

---

## 4. 智能体系统

### 4.1 Agent 目录结构

每个 Agent 遵循统一的标准结构：

```
agents/{agent-id}/
├── SKILL.md              # Agent 定义 (Frontmatter + 系统提示词)
├── learning.json         # 学习指标
├── metrics/              # 性能仪表板
│   ├── monthly.json      #   月度统计
│   ├── weekly.json       #   周度统计
│   └── daily.json        #   日度统计
└── [特定文件]             # Agent 专属配置/代码/日志
```

### 4.2 SKILL.md 规范

每个 Agent 的 `SKILL.md` 文件包含 YAML frontmatter 和系统提示词：

```yaml
---
name: "Agent Name"
id: "agent-id"
emoji: "🔍"
category: "category-name"
description: "One-line summary"
status: "active"
type: "interactive"    # interactive = 用户触发, scheduled = 定时触发
created: 2026-02-27
---

[系统提示词正文，定义 Agent 的行为、能力、约束]
```

Agent 注册表 (`agent-registry.ts`) 在启动时扫描所有 `agents/*/SKILL.md`，解析 frontmatter 并注册到 Agent Squad 路由器。

### 4.3 全部 Agent 一览

| # | ID | 标识 | 类别 | 类型 | 用途 |
|---|----------|------|------|------|------|
| 1 | `openclaw` | 🤖 | openclaw | interactive | **AI 平台管理器** -- 产品经理模式，通过 Task 工具委托子 Agent 执行，不直接写代码 |
| 2 | `work` | 💼 | work | interactive | **BD 战略顾问** -- Bitget Wallet BD 支持，Anti-Messenger 原则，5 维合作伙伴评估矩阵 |
| 3 | `research` | 🔬 | research | interactive | **投资研究分析师** -- 美股/宏观/Crypto 深度分析，5 个专业 Skill，98 个 RSS 源 |
| 4 | `proceed-subagent` | 🔐 | finance | interactive | **链上资产管理** -- Web3Auth MPC 非托管钱包，Li.Fi 跨链交易，Polymarket/Hyperliquid/RWA |
| 5 | `signal` | 📡 | signal | interactive | **实时市场情报** -- 价格信号、监管风险预警、交易所事件监控 |
| 6 | `x-timeline` | 🐦 | scheduled | scheduled | **X/Twitter 抓取** -- 每小时定时抓取，市场情绪数据源 |
| 7 | `wecom` | 💬 | communication | interactive | **企业微信助手** -- 身份识别、信息边界管理、损友风格交互 |
| 8 | `telegram` | 📨 | communication | interactive | **Telegram 消息助手** -- 合作伙伴通知与消息管理 |
| 9 | `whoop` | 💪 | health | interactive | **WHOOP 生物指标追踪** -- 恢复评分/睡眠分析/训练负荷/HRV 监控 |
| 10 | `life` | 🌱 | life | interactive | **个人生活教练** -- 健康管理/旅行规划/个人发展 |
| 11 | `general` | 📎 | general | interactive | **通用兜底助手** -- 无法匹配其他 Agent 时的 fallback |
| 12 | `github-updates` | 🔔 | devops | both | **GitHub 系统监控** -- 外部仓库监控 + 原子提交 + 回滚 + 自修复 |
| 13 | `evaluator` | 🔍 | system | scheduled | **Agent 健康评估器** -- 每日 4D 评分，生成健康报告 |
| 14 | `health` | 💪 | health | interactive | **健康监控协调器** -- 与 WHOOP Agent 配合，统一健康数据视图 |

### 4.4 Agent 路由机制

```
用户消息
    │
    ▼
Agent Squad Router (awslabs)
    │
    ├─ 意图分类: 分析消息内容，匹配最合适的 Agent
    │
    ├─ 匹配成功 → 路由到目标 Agent (加载其 SKILL.md 系统提示词)
    │
    └─ 匹配失败 → Fallback 到 "general" Agent
```

路由基于 Agent Squad 库的意图分类能力，结合每个 Agent 在 `SKILL.md` 中定义的 description 和系统提示词进行匹配。

### 4.5 重点 Agent 详解

#### OpenClaw (🤖 平台管理器)

作为整个系统的 "产品经理"：
- **不直接执行代码**，通过 Task 工具委托给子 Agent
- 技术联合创始人模式：5 阶段工作流 (Discovery → Planning → Building → Polish → Handoff)
- 管理 Agent 配置、Skill 定义、系统设置
- 强调反问、选项式决策、Push Back 权限
- 交付后脱离对话依赖

#### Research (🔬 投资研究)

最复杂的 Agent 之一，包含 5 个专业投资分析 Skill：

| Skill | 用途 |
|-------|------|
| `tech-earnings-deepdive` | 科技股财报深度分析 (16 模块 + 6 投资哲学 + 估值矩阵) |
| `us-value-investing` | 巴菲特式 4 维价值评估 (ROE / 债务 / FCF / 护城河) |
| `us-market-sentiment` | 市场情绪 5 指标仪表盘 (NAAIM / 机构配置 / 散户买入 / 远期PE / 对冲杠杆) |
| `macro-liquidity` | 宏观流动性 4 指标监控 (Fed 净流动性 / SOFR / MOVE / 日元套利) |
| `btc-bottom-model` | BTC 抄底 6 信号模型 (RSI / 缩量 / MVRV / 恐惧 / 矿工 / LTH) |

配合 98 个全球新闻 RSS 源，每日自动汇总生成中文摘要。所有 Skill 依赖 `web_search` 获取实时数据，Skill 之间可交叉联动验证。

#### Proceed-Subagent (🔐 链上资产管理)

模块化的链上金融管理系统：

```
┌─────────────────────────────────────────────────┐
│               Proceed-Subagent                   │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ M1 钱包   │  │ M2 交易   │  │ M3 信息   │      │
│  │ Google    │  │ Li.Fi    │  │ BGW API  │      │
│  │ OAuth →   │  │ 25+链    │  │ 价格     │      │
│  │ Web3Auth  │  │ + 0x     │  │ 持仓     │      │
│  │ MPC 钱包  │  │ API      │  │ 鲸鱼追踪  │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ E1       │  │ E2       │  │ E3       │      │
│  │ Poly-    │  │ Hyper-   │  │ RWA      │      │
│  │ market   │  │ liquid   │  │ 美债     │      │
│  │ 预测市场  │  │ 永续合约  │  │ 代币化   │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│                                                  │
│  安全机制:                                        │
│  - 所有交易需 2 步确认                             │
│  - > $5,000 交易额触发警告                        │
│  - > 10x 杠杆触发警告                             │
└─────────────────────────────────────────────────┘

认证流程: Google OAuth → Web3Auth Node SDK v5 → MPC 钱包 (非托管)
Session 存储: ~/.proceed-subagent/auth.json
```

#### GitHub Updates (🔔 系统监控)

四大核心能力：

| 能力 | 说明 |
|------|------|
| **外部监控** | 跟踪 Anthropic claude-code/SDK、AWS agent-squad 的 release/PR/issue |
| **原子提交** | 每个开发步骤 = 1 commit + 1 checkpoint |
| **回滚** | 按 checkpoint 回滚或选择性文件回滚 |
| **自修复** | 错误模式匹配 → 自动修复 → 回滚 → 告警 (4 级升级) |

**Watchlist:**

| 仓库 | 优先级 |
|------|--------|
| `anthropics/claude-code` | High |
| `anthropics/anthropic-sdk-typescript` | Medium |
| `awslabs/agent-squad` | High |
| `anthropics/courses` | Low |
| `Dreamback2011/claude-code-adapter` (Self) | Auto-checkpoint |

#### Work (💼 BD 战略顾问)

专为 Bitget Wallet BD 工作设计：

- **Anti-Messenger**: 不做信使，只做决策者
- **Results-Only**: 只关注结果，不关注过程
- **ADHD Mode**: 每轮最多 3 个 action items，简洁输出
- **5 维合作伙伴评估矩阵**: 总分 >= 20 推进, 14-19 标准跟进, <14 放弃
- **Kill Filter**: 停滞 >2 周 + 无决策人 + 与其他项目重复 = 直接终止
- 关键优先级: TradFi/WaaS (O4, 最高), Ripple/Doppler/Polymarket (O1), AI x Blockchain (O3)

---

## 5. 子系统详解

### 5.1 自适应超时系统

传统固定超时无法适应 AI 工作负载的多样性。OpenClaw 根据 CLI 当前状态动态调整：

```
┌──────────────────┬────────────┬─────────────────────────────────┐
│ 状态              │ 超时时长    │ 说明                             │
├──────────────────┼────────────┼─────────────────────────────────┤
│ thinking         │ 5 分钟     │ Claude 正在推理                   │
│ tool_running     │ 30 分钟    │ CLI 工具执行 (Bash/编辑/搜索等)    │
│ responding       │ 5 分钟     │ 流式文本输出中                     │
│ idle             │ 10 分钟    │ 兜底超时                          │
│ hard (绝对上限)   │ 24 小时    │ 无论状态如何强制终止               │
└──────────────────┴────────────┴─────────────────────────────────┘
```

**活跃 session 检测**: 每 30 秒通过 `pgrep -P <pid>` 检查子进程。如果存在活跃子进程（说明 CLI 正在执行工具操作），则重置 idle 计时器，防止误杀正在执行长时间工具操作的 CLI。

### 5.2 并发控制

```
MAX_CONCURRENT: 20 (可通过 .env 配置)

请求进入
    │
    ├─ 并发槽位可用 → 获取槽位 → 执行 → 完成 → 释放槽位
    │
    └─ 槽位已满 → 排队等待 → 槽位释放 → 获取 → 执行
```

所有槽位的获取和释放都有日志记录，方便排查并发问题。

### 5.3 定时任务调度

`cron-scheduler.ts` 管理 4 个核心定时任务：

| 任务名 | 周期 | 用途 |
|--------|------|------|
| `eval` | 每天 23:00 UTC | 触发 Evaluator Agent，生成所有 Agent 的 4D 健康报告 |
| `x-timeline` | 每 1 小时 | 触发 X-Timeline Agent，抓取 Twitter 时间线 |
| `heartbeat` | 每 13 分钟 | 系统心跳检查，监控各组件存活状态 |
| `rss-daily` | 每天 22:00 UTC | RSS 源汇总，生成中文摘要 |

所有定时任务支持通过 API 手动触发：
```
POST /v1/cron/trigger/:taskName
GET  /v1/cron/status
```

### 5.4 Agent 评估系统 (4D Score)

每日自动评估所有 Agent 的健康状态，输出综合评分：

```
总分 = 活跃度 x 20% + 成功率 x 30% + 故障率 x 30% + 坚固程度 x 20%

┌─────────────┬────────┬─────────────────────────────────────┐
│ 维度         │ 权重   │ 计算方式                              │
├─────────────┼────────┼─────────────────────────────────────┤
│ 活跃度       │ 20%    │ 今日请求数 / 7 日平均基线              │
│ 成功率       │ 30%    │ 正常完成数 / 总请求数                  │
│ 故障率       │ 30%    │ (错误 + 超时 + 空响应) 加权 / 总量     │
│ 坚固程度     │ 20%    │ 连续稳定天数 + 长期成功率               │
└─────────────┴────────┴─────────────────────────────────────┘

健康等级:
  🟢 >= 80    优秀 (HEALTHY)
  🟡 60-79   正常 (NEEDS_OPTIMIZATION)
  🟠 40-59   需关注 (NEEDS_OVERHAUL)
  🔴 < 40    严重问题 (CRITICAL)
```

### 5.5 记忆系统

11 个子模块组成的完整记忆系统，支持语义搜索和 RAG：

```
                     ┌──────────────────┐
                     │   memory-store   │
                     │  CRUD + 去重     │
                     │  + 索引          │
                     └────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
  ┌───────▼──────┐   ┌───────▼──────┐   ┌───────▼──────┐
  │ permission-  │   │ identity-    │   │ progress-    │
  │ gate         │   │ resolver     │   │ tracker      │
  │ 敏感度分级   │   │ 调用者识别   │   │ 进度监控     │
  └──────────────┘   └──────────────┘   └──────────────┘

  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ rag-         │   │ qmd-search   │   │ embeddings   │
  │ retriever    │   │ QMD 向量搜索 │   │ 向量嵌入     │
  │ 语义检索     │   │              │   │ 生成         │
  └──────────────┘   └──────────────┘   └──────────────┘

  ┌──────────────┐   ┌──────────────┐
  │ quality-     │   │ auto-extract │
  │ learner      │   │ 知识自动提取 │
  │ 质量学习     │   │              │
  └──────────────┘   └──────────────┘
```

三层记忆架构：

| 层级 | 技术 | 用途 |
|------|------|------|
| Layer 1: 语义记忆 | QMD 向量搜索 | 语义相似度检索，关联记忆 |
| Layer 2: 文件记忆 | JSONL 分类存储 | 结构化事实存储，任务进度 |
| Layer 3: 自动提取 | Auto-Extract | 从对话中被动积累知识 |

API 接口：
```
POST   /v1/memory/search        语义搜索
POST   /v1/memory/items         创建记忆
GET    /v1/memory/items         查询记忆
PATCH  /v1/memory/items         更新记忆
DELETE /v1/memory/items         删除记忆
```

### 5.6 Discord Webhook 集成

10 个频道路由配置 (`config/discord-routing.json`)：

| 频道 | 用途 |
|------|------|
| `general` | 通用消息 |
| `work` | 工作相关 (BD/合作) |
| `pending` | 待处理任务 |
| `personal` | 个人事务 |
| `skills` | Skill 更新通知 |
| `creative` | 创意内容 |
| `moltbook` | 读书笔记 |
| `debug` | 调试日志 |
| `company` | 公司相关 |
| `reflection` | 反思总结 |

特性：
- 每个 Agent 有默认频道映射
- 消息自动分片 (Discord 2000 字符限制)
- 重试逻辑 (最多 2 次 + 指数退避)

### 5.7 心跳监控

每 13 分钟执行一次系统健康检查 (90 秒超时)：

```
检查项:
  ├─ CLI 可用性
  ├─ Express 服务响应
  ├─ Session Store 状态
  ├─ 并发槽位使用率
  └─ 最近错误率

排除: x-timeline 和 evaluator (定时 Agent 不参与心跳)
```

### 5.8 消息日志

- 记录所有请求和响应
- 自动保留 5 天
- 定期清理过期日志

### 5.9 GitHub 自修复系统

4 级升级机制：

```
Level 1: 错误模式匹配 → 自动修复 (diagnose + auto-fix)
    │
    └─ 失败
        │
Level 2: 回滚到最近 checkpoint (rollback)
    │
    └─ 失败
        │
Level 3: 选择性文件回滚 (selective rollback)
    │
    └─ 失败
        │
Level 4: 告警通知 (Discord 告警 + 人工介入)
```

### 5.10 Research RSS 系统

```
98 个全球新闻 RSS 源
    │
    ▼ 每日 22:00 UTC 自动抓取
    │
    ▼ rss-daily.ts 汇总聚合
    │
    ▼ rss-summarize.ts 生成中文摘要
    │
    ▼ 投递到 Discord / 供 Research Agent 使用
```

### 5.11 嵌套 Session 修复 (关键)

当 adapter 在 Claude Desktop 或 Claude Code 内运行时，以下环境变量会导致 spawned CLI 检测为嵌套 session 而**静默挂起**：

```
CLAUDECODE
CLAUDE_CODE_*
CLAUDE_AGENT_*
CLAUDE_DEV
```

**修复方案** (三层清理)：

| 层级 | 文件 | 清理方式 |
|------|------|----------|
| 进程级 | `src/index.ts` | 启动时 `delete process.env[...]` |
| Spawn 级 | `src/claude-cli.ts` | 子进程 env 中剔除 |
| 脚本级 | `scripts/manage.sh` | Shell 启动时 `unset` |

---

## 6. 跨 Agent 协作

Agent 之间通过消息传递和任务委托实现协作。以下是完整的协作网络：

```
                        ┌──────────┐
                ┌──────►│ 🤖 Open  │◄─────┐
                │       │   Claw   │      │
                │       └────┬─────┘      │
                │            │ 配置/委托    │
                │            ▼            │
        ┌───────┴──┐   ┌─────────┐   ┌───┴──────┐
        │ 🔔 GitHub│   │ 🔍 Eval │   │ 📎 General│
        │ Updates  │──►│ uator   │   │          │
        └──────────┘   └─────────┘   └──────────┘
              │              │
              │   系统监控    │  健康评估
              ▼              ▼
        ┌──────────────────────────────────┐
        │         全部 Agent                │
        └──────────────────────────────────┘

        ┌─────────────────────────────────────┐
        │          业务协作网络                  │
        │                                     │
        │   🔬 Research ◄──► 📡 Signal        │
        │       │    │           │             │
        │       │    │           │             │
        │       ▼    ▼           ▼             │
        │   💼 Work ◄───────────┘             │
        │       │                              │
        │       ▼                              │
        │   🔐 Proceed                         │
        │       ▲                              │
        │       │                              │
        │   🔬 Research (执行分析结论)           │
        └─────────────────────────────────────┘

        ┌─────────────────────────────────────┐
        │          通信协作网络                  │
        │                                     │
        │   💬 WeChat ──► 💼 Work (商业咨询)   │
        │   📨 Telegram ──► 💼 Work (合作通知) │
        │   🐦 X-Timeline ──► 🔬 Research     │
        │                     (情绪数据)       │
        └─────────────────────────────────────┘
```

### 协作路径详表

| 来源 | 目标 | 协作内容 |
|------|------|----------|
| 🔬 Research | 📡 Signal | 发送价格信号请求 |
| 🔬 Research | 💼 Work | 标记 BD 商业机会 |
| 🔬 Research | 🔐 Proceed | 链上交易执行 |
| 📡 Signal | 🔬 Research | 请求深度分析 |
| 📡 Signal | 💼 Work | 监管/交易所风险预警 |
| 💼 Work | 🔬 Research | 请求投资分析 |
| 💼 Work | 📡 Signal | 请求监控竞争对手 |
| 🔐 Proceed | 🔬 Research | 执行分析结论 |
| 💬 WeChat | 💼 Work | 转发商业咨询 |
| 📨 Telegram | 💼 Work | 通知合作伙伴动态 |
| 🐦 X-Timeline | 🔬 Research | 提供市场情绪数据 |
| 🔔 GitHub | 全部 Agent | 系统健康监控 |
| 🔍 Evaluator | 全部 Agent | 4D 健康评估 |
| 🤖 OpenClaw | 全部 Agent | 配置/Skill 管理/任务委托 |

---

## 7. API 端点

### 核心端点

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `GET` | `/health` | 否 | 服务器状态 + 并发统计 + 运行时间 |
| `GET` | `/v1/models` | 是 | 可用模型列表 |
| `POST` | `/v1/messages` | 是 | **主端点** -- 兼容 Anthropic Messages API (支持流式/非流式) |

### Session 管理

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `GET` | `/v1/sessions` | 是 | 列出所有活跃 session |

### 异步任务

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `GET` | `/v1/tasks` | 是 | 异步任务列表 |
| `GET` | `/v1/tasks/:taskId` | 是 | 单个任务详情 |
| `GET` | `/v1/tasks/:taskId/stream` | 是 | 实时 SSE 任务输出流 |

### 定时任务

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `POST` | `/v1/cron/trigger/:taskName` | 是 | 手动触发定时任务 |
| `GET` | `/v1/cron/status` | 是 | 查看所有定时器状态 |

### 记忆系统

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `POST` | `/v1/memory/search` | 是 | 语义搜索记忆 |
| `POST` | `/v1/memory/items` | 是 | 创建记忆条目 |
| `GET` | `/v1/memory/items` | 是 | 查询记忆条目 |
| `PATCH` | `/v1/memory/items` | 是 | 更新记忆条目 |
| `DELETE` | `/v1/memory/items` | 是 | 删除记忆条目 |

### 监控与评估

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `GET` | `/v1/heartbeat` | 是 | 最新心跳检查结果 |
| `GET` | `/v1/agent-evaluation` | 是 | Agent 4D 健康评估报告 |

### 外部集成

| 方法 | 路径 | 认证 | 用途 |
|------|------|------|------|
| `POST` | `/wecom/callback` | 否 | 企业微信 Webhook 回调入口 (WeCom 自带签名验证) |

### 请求示例

```bash
# 流式请求
curl -X POST http://localhost:3456/v1/messages \
  -H "x-api-key: sk-local-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 4096,
    "stream": true,
    "messages": [
      {"role": "user", "content": "分析一下最近的美股市场"}
    ]
  }'

# 非流式请求
curl -X POST http://localhost:3456/v1/messages \
  -H "x-api-key: sk-local-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 4096,
    "stream": false,
    "messages": [
      {"role": "user", "content": "帮我查看 BTC 当前价格"}
    ]
  }'

# 健康检查
curl http://localhost:3456/health

# 手动触发定时任务
curl -X POST http://localhost:3456/v1/cron/trigger/eval \
  -H "x-api-key: sk-local-xxxxx"

# 语义搜索记忆
curl -X POST http://localhost:3456/v1/memory/search \
  -H "x-api-key: sk-local-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"query": "Bitget Wallet 合作伙伴"}'
```

---

## 8. 配置与部署

### 8.1 环境变量 (.env)

```bash
# === 必需 ===
LOCAL_API_KEY=sk-local-<random>       # API 认证密钥

# === 服务配置 ===
PORT=3456                              # 服务端口 (默认 3456)
MAX_CONCURRENT=20                      # 最大并发 CLI 进程数
USE_AGENT_SQUAD=true                   # 启用 Agent Squad 路由

# === CLI 配置 ===
ALLOWED_TOOLS=Read,Write,Edit,Bash,Grep,Glob  # Claude CLI 工具白名单

# === Proceed-Subagent (可选) ===
GOOGLE_CLIENT_ID=...                   # Google OAuth Client ID
GOOGLE_CLIENT_SECRET=...               # Google OAuth Secret
WEB3AUTH_CLIENT_ID=...                 # Web3Auth Client ID
WEB3AUTH_AUTH_CONNECTION_ID=...         # Web3Auth Connection ID
```

### 8.2 部署方式

#### 一键安装

```bash
bash setup.sh
# 自动执行: 检查 Node >= 18, 安装 npm 依赖, 生成 .env, 测试服务器
```

#### 前台运行 (开发)

```bash
npm start
# 或
npx tsx src/index.ts
```

#### 后台管理 (生产)

```bash
bash scripts/manage.sh start      # 启动
bash scripts/manage.sh stop       # 停止
bash scripts/manage.sh restart    # 重启
bash scripts/manage.sh status     # 查看状态
bash scripts/manage.sh logs       # 查看日志
```

#### macOS 自启动

```bash
bash scripts/install-service.sh
# 安装为 launchd 服务 (com.claude-adapter.plist)
# KeepAlive: true — 进程退出后自动重启
```

#### 公网暴露 (ngrok)

```bash
bash scripts/start-ngrok.sh
# 通过 ngrok 将 localhost:3456 暴露到公网
```

### 8.3 核心依赖

```json
{
  "dependencies": {
    "agent-squad": "^1.0.1",            // AWS Labs 多智能体路由
    "express": "^4.21.0",               // HTTP 服务框架
    "dotenv": "^16.4.5",                // 环境变量加载
    "uuid": "^11.0.0",                  // UUID 生成
    "rss-parser": "^3.13.0",            // RSS 源解析
    "ethers": "^6.16.0",                // 以太坊交互
    "@web3auth/node-sdk": "^5.0.0",     // Web3Auth MPC 钱包
    "@web3auth/base": "^9.7.0",         // Web3Auth 基础库
    "@web3auth/ethereum-provider": "^9.7.0",  // Web3Auth EVM Provider
    "open": "^11.0.0"                   // 浏览器打开
  },
  "devDependencies": {
    "typescript": "^5.6.0",             // TypeScript 编译器
    "tsx": "^4.19.0",                   // TypeScript 直接执行 (无需构建)
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0"
  }
}
```

---

## 9. 个性化调整

OpenClaw 不是一个通用平台，而是为特定用户场景深度定制的系统。以下是 10 项核心个性化配置：

| # | 定制项 | 说明 |
|---|--------|------|
| 1 | **PM 委托模式** | OpenClaw Agent 作为产品经理，不直接写代码，通过 Task 工具委托子 Agent 执行 |
| 2 | **技术联合创始人模式** | 5 阶段工作流: Discovery → Planning → Building → Polish → Handoff |
| 3 | **BD Advisor 框架** | Anti-Messenger 原则, Results-Only, ADHD Mode, 5 维合作伙伴评估矩阵 |
| 4 | **损友型微信助手** | WeChat Work Agent 以朋友风格 (非机器人语气) 回复消息 |
| 5 | **ADHD 友好设计** | 所有 Agent 强调结构化输出、清晰步骤、批量处理，减少认知负担 |
| 6 | **中文优先** | 所有 Agent 默认中文通信，技术术语保留英文 |
| 7 | **投资研究体系** | 5 个专业 Skill 覆盖美股 / 宏观经济 / Crypto 三大领域 |
| 8 | **链上交易安全** | 2 步确认制、$5,000 大额警告、10x 杠杆警告 |
| 9 | **原子提交 + 回滚** | 每个开发步骤 = 1 commit + 1 checkpoint，支持精确回滚 |
| 10 | **98 RSS 源** | 全球新闻自动汇总，每日生成中文摘要 |

---

## 10. 项目统计

### 代码规模

| 指标 | 数值 |
|------|------|
| TypeScript 源文件 | 39 个 |
| TypeScript 总行数 | ~15,300 行 |
| 主模块 (`src/*.ts`) | 17 个文件, ~4,700 行 |
| 记忆系统 (`src/memory/`) | 11 个文件 |
| 企业微信模块 (`src/wecom/`) | 7 个文件 |
| Agent 注册模块 (`src/agents/`) | 2 个文件 |
| 分类器 (`src/classifiers/`) | 1 个文件 |

### Agent 规模

| 指标 | 数值 |
|------|------|
| 活跃 Agent | 14 个 |
| Agent 目录 | 16 个 (含 archive + unrouted) |
| SKILL.md 文件 | 13 个 |
| Agent 类别 | 10 个 |
| 投资分析 Skill | 5 个 |

### 子系统规模

| 指标 | 数值 |
|------|------|
| API 端点 | 15+ 个 |
| Discord Webhook 频道 | 10 个 |
| 全球 RSS 新闻源 | 98 个 |
| 定时任务 | 4 个 |
| GitHub Watchlist 仓库 | 5 个 |
| 记忆系统模块 | 11 个 |
| 超时状态类型 | 5 个 |
| 评估维度 | 4 个 |
| 自修复升级级别 | 4 个 |

### 技术栈总览

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js + tsx (无构建步骤) |
| HTTP 框架 | Express 4.x |
| 流式传输 | Server-Sent Events (SSE) |
| 多智能体路由 | Agent Squad (awslabs) |
| 推理引擎 | Claude Code CLI (`claude -p`) |
| 钱包 | Web3Auth MPC (非托管) |
| 链上交易 | Li.Fi (25+ 链) + 0x API |
| 以太坊 | ethers.js 6.x |
| RSS 解析 | rss-parser |
| 通信集成 | Discord Webhooks, WeCom API, Telegram |
| 进程管理 | Bash 脚本 + launchctl |

---

> **OpenClaw** -- 让 Claude 的能力服务于你的整个生活。
>
> Built by Alex Gu | Powered by Claude Code CLI + Agent Squad
