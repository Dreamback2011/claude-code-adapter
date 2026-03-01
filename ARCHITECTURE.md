# OpenClaw + Claude Code Adapter 架构文档

> 最后更新: 2026-03-02

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构总览](#2-架构总览)
3. [核心服务器 (src/)](#3-核心服务器-src)
4. [Agent 系统](#4-agent-系统)
5. [Skills 技能库](#5-skills-技能库)
6. [记忆系统](#6-记忆系统)
7. [定时任务](#7-定时任务)
8. [外部集成](#8-外部集成)
9. [个性化定制](#9-个性化定制)
10. [部署与运维](#10-部署与运维)
11. [技术栈](#11-技术栈)
12. [已知问题与修复](#12-已知问题与修复)

---

## 1. 项目概述

OpenClaw 是一套围绕 **本地 Anthropic Messages API 适配服务器** 构建的多智能体 AI 编排系统。它让第三方工具（OpenClaw 客户端、Discord 机器人、Telegram 机器人、企业微信等）能够通过标准 HTTP API 与 Claude Code CLI 进行通信。

### 核心理念

所有请求统一经由官方 Claude Code CLI (`claude -p`) 转发 —— **无需额外 API Key**，直接复用现有 Claude Max 订阅额度。

```
第三方客户端  →  本地适配服务器 (localhost:3456)  →  Claude Code CLI  →  Claude AI
```

### 基本信息

- **所有者**: Alex Gu (山哥), BD & Key Projects Lead @ Bitget Wallet, 常驻迪拜
- **GitHub**: https://github.com/Dreamback2011/claude-code-adapter
- **服务端口**: 3456
- **协议兼容**: Anthropic Messages API (streaming + non-streaming)

---

## 2. 架构总览

### 请求流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端层 (Clients)                        │
│                                                                  │
│   OpenClaw App    Discord Bot    Telegram Bot    WeCom Webhook   │
│       │               │              │               │           │
│       └───────────────┼──────────────┼───────────────┘           │
│                       ▼                                          │
│            POST /v1/messages                                     │
│            (Anthropic-compatible API)                             │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              Claude Code Adapter (localhost:3456)                 │
│                                                                  │
│   ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│   │ Auth 认证 │→│ Router   │→│ Adapter   │→│ CLI Manager  │  │
│   │ (auth.ts)│  │(server.ts)│  │(adapter.ts)│  │(claude-cli.ts)│ │
│   └──────────┘  └──────────┘  └───────────┘  └──────┬───────┘  │
│                                                       │          │
│   ┌──────────────┐  ┌────────────┐  ┌──────────────┐│          │
│   │ Memory 记忆   │  │ Cron 定时   │  │ Agent 路由   ││          │
│   │ (memory/)    │  │ (cron-*.ts)│  │ (agents/)    ││          │
│   └──────────────┘  └────────────┘  └──────────────┘│          │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼ Spawn: claude -p "prompt" --output-format stream-json
┌─────────────────────────────────────────────────────────────────┐
│                  Claude Code CLI (官方工具)                       │
│                                                                  │
│          使用 Claude Max 订阅  →  返回 AI 响应                    │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼ SSE / JSON Response
                    返回客户端
```

### 详细请求处理流程

```
1. Client  ─── POST /v1/messages ──→  Express Server
2. Server  ─── x-api-key / Bearer ──→  Auth 验证
3. Server  ─── Extract session ─────→  Session Store (24h TTL)
4. Server  ─── Build prompt ────────→  Adapter 提示词构建
5. Adapter ─── spawn claude -p ─────→  CLI Manager
6. CLI     ─── stream-json + verbose → 实时流事件
7. Adapter ─── SSE forward ─────────→  Client (近零转换开销)
```

---

## 3. 核心服务器 (src/)

### 文件结构与职责

#### 主入口

**`src/index.ts`** — 系统入口

- 加载 `.env` 环境变量
- 启动 Express 服务器
- 初始化 QMD 语义搜索内存索引
- 启动定时任务调度器 (evaluation, RSS, x-timeline, heartbeat)
- 清理嵌套会话环境变量 (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*`, `CLAUDE_DEV`)
- 并发限制: 最多 20 个并行 CLI 进程

#### API 路由层

**`src/server.ts`** — Express 路由定义 (~780 行)

| 路由 | 方法 | 用途 |
|------|------|------|
| `/health` | GET | 服务状态 + 并发会话数 |
| `/v1/models` | GET | 可用模型列表 |
| `/v1/messages` | POST | **主 API** (streaming + non-streaming) |
| `/v1/sessions` | GET | 会话统计信息 |
| `/v1/tasks` | GET | 任务列表 |
| `/v1/tasks/:id` | GET | 单任务详情 |
| `/v1/tasks/:id/stream` | GET | 任务流式监控 |
| `/v1/cron/status` | GET | 定时任务状态 |
| `/v1/cron/trigger/:name` | POST | 手动触发定时任务 |
| `/wecom/callback` | POST | 企业微信 Webhook (免认证) |

#### 核心适配层

**`src/adapter.ts`** — Anthropic API 与 CLI 之间的翻译层 (~15.5KB)

- **Non-streaming 模式**: 捕获 result 事件，聚合完整响应后返回
- **Streaming 模式**: 将 CLI 的 stream-json 输出直接转发为 SSE，近零转换开销
- **提示词构建**: 支持单消息 / 历史记录 / 会话恢复三种模式

**`src/claude-cli.ts`** — CLI 进程管理器 (~15.2KB)

- 智能超时机制:
  - 思考阶段: 5 分钟
  - 工具调用阶段: 30 分钟
  - 响应阶段: 5 分钟
  - 空闲超时: 10 分钟
  - 硬超时: 24 小时
- 通过 stream events 检测当前状态
- 每 30 秒通过 `pgrep -P <pid>` 检测活跃子进程，防止误杀长时间运行的工具/bash
- 支持通过 `--resume` 标志恢复会话

#### 认证与类型

- **`src/auth.ts`** — API Key 验证 (`x-api-key` header 或 `Bearer` token)
- **`src/types.ts`** — Anthropic Messages API 的 TypeScript 类型定义

#### 会话与调度

- **`src/session-store.ts`** — 会话持久化 (24 小时 TTL, 存储于 `.sessions.json`)
- **`src/cron-scheduler.ts`** — 定时任务调度器
- **`src/heartbeat.ts`** — 健康监测，每 13 分钟 ping 所有交互式 Agent (90 秒超时)

#### Agent 管理

- **`src/agent-metrics.ts`** — 按 Agent 统计使用量
- **`src/agent-learning.ts`** — 学习记忆更新
- **`src/agent-evaluation.ts`** — 性能评估 (4 维度评分)

#### 记忆子系统 (src/memory/)

| 文件 | 职责 |
|------|------|
| `memory-store.ts` | 基于文件的 JSONL 存储 |
| `qmd-search.ts` | 语义向量搜索 |
| `rag-retriever.ts` | RAG 检索管线 |
| `auto-extract.ts` | 从对话中自动提取事实 |
| `quality-learner.ts` | 重要性评分 |
| `progress-tracker.ts` | 任务进度追踪 |
| `identity-resolver.ts` | 用户/联系人身份解析 |
| `permission-gate.ts` | 访问权限控制 |

#### 企业微信子系统 (src/wecom/)

| 文件 | 职责 |
|------|------|
| `api.ts` | WeCom API 客户端 |
| `handler.ts` | 消息处理逻辑 |
| `webhook.ts` | 签名验证 |
| `contacts.ts` | 联系人管理 |
| `crypto.ts` | AES 加密/解密 |

---

## 4. Agent 系统

### Agent Squad 架构

通过环境变量 `USE_AGENT_SQUAD=true` 启用。消息首先经过 **5 大类别路由器** 分发:

```
                    ┌─────────────┐
                    │  消息输入    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐  ┌────────┐
         │Work 💼 │  │Signal📡│  │Life 🌱 │
         └────────┘  └────────┘  └────────┘
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐
         │OpenClaw│  │General │
         │  🤖    │  │  📎    │
         └────────┘  └────────┘
```

### 完整 Agent 列表 (16 个)

| ID | 名称 | 类别 | 职责描述 | 累计调用 |
|----|------|------|----------|----------|
| `openclaw` | OpenClaw Agent 🤖 | openclaw | AI 自动化专家, Tech Co-founder 模式 (PM), 通过 Task subagent 委派任务 | 183 |
| `general` | General Agent 📎 | general | 通用回退 Agent，处理未分类任务 | 62 |
| `work` | Work Agent 💼 | work | 加密/Web3 战略 BD 顾问, Anti-Messenger, Results-Only, ADHD Mode | - |
| `research` | Research Agent 🔬 | research | 投资研究 (美股/加密/宏观), RSS 每日摘要, 4 个研究领域 | 4 |
| `signal` | Signal Agent 📡 | signal | 实时加密市场情报与 Alpha 信号 | 5 |
| `proceed-subagent` | Proceed-Subagent 🔐 | finance | 链上钱包与交易 (Web3Auth MPC, Li.Fi, 0x, Polymarket, Hyperliquid, RWA) | 12 |
| `life` | Life Agent 🌱 | life | 个人健康/生活方式教练, 迪拜本地化, ADHD 友好 | 27 |
| `health` | Health Agent 💪 | health | WHOOP 生物指标与健康追踪 (HRV, 睡眠, 恢复, 负荷) | 3 |
| `telegram` | Telegram Agent 📨 | communication | Telegram 消息收发与联系人管理 | 11 |
| `wecom` | WeCom Agent 💬 | communication | 企业微信智能回复, "损友型助手"语气 | - |
| `github-updates` | GitHub Updates 🔔 | devops | DevOps 与自修复, checkpoint 系统, 回滚, 外部仓库监控 | 12 |
| `evaluator` | Evaluator Agent 🔍 | system | 健康监测, 4 维度评分 (活跃/成功/失败/韧性) | 6 |
| `x-timeline` | X-Timeline 🐦 | scheduled | 每小时 X/Twitter 抓取 (Playwright, 80 tweets/周期) | - |
| `whoop` | WHOOP Agent 💓 | health | 专用 WHOOP 数据拉取 (恢复/睡眠/训练/周期/身体) | - |
| `archive` | Archive 📦 | system | 停用占位符 | - |
| `unrouted` | Unrouted | system | 捕获未分类消息 | - |

### Agent 文件结构

每个 Agent 目录 (`agents/<id>/`) 包含:

```
agents/<agent-id>/
├── SKILL.md          # 系统提示词、路由关键词、能力定义
├── learning.json     # 质量评分、使用统计、好/坏样本
└── metrics/
    └── YYYY-MM-DD.json  # 每日指标
```

### Discord 频道路由

通过 `config/discord-routing.json` 配置，共 10 个频道:

| 频道 | 用途 |
|------|------|
| general | 通用消息 |
| work | 工作/BD 相关 |
| pending | 待处理事项 |
| personal | 个人事务 |
| skills | 技能相关 |
| creative | 创意内容 |
| moltbook | 读书笔记 |
| debug | 调试信息 |
| company | 公司动态 |
| reflection | 反思/复盘 |

每个 Agent 映射到特定的 Discord 频道进行通知推送。

---

## 5. Skills 技能库

共 18 个 Skills，存放于 `~/.openclaw/workspace/skills/`（部分为指向 `.agents/skills/` 的符号链接）。

### 投资研究类 (5 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 1 | `tech-earnings-deepdive` | 科技股财报深度分析 (33.7KB, 16 模块 + 6 投资哲学 + 估值矩阵) |
| 2 | `us-value-investing` | 巴菲特式 4 维价值评估 (ROE / 债务 / FCF / 护城河) |
| 3 | `us-market-sentiment` | 市场情绪 5 指标仪表盘 (NAAIM / 机构配置 / 散户买入 / 远期PE / 对冲杠杆) |
| 4 | `macro-liquidity` | 宏观流动性 4 指标监控 (Fed 净流动性 / SOFR / MOVE / 日元套利) |
| 5 | `btc-bottom-model` | BTC 抄底 6 指标模型 (RSI / 缩量 / MVRV / 恐惧 / 矿工 / LTH) |

### 加密/Web3 类 (1 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 6 | `bitget-wallet-skill` | Bitget Wallet API (代币信息 / swap / 安全审计 / K 线) |

### 健康类 (1 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 7 | `whoop-openclaw-skill` | WHOOP 健身数据整合 (OAuth + Python scripts) |

### AI/创作类 (3 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 8 | `ai-image-generation` | 50+ 模型 AI 图像生成 (FLUX / Gemini / Grok / Seedream / Reve) |
| 9 | `fal-image-edit` | FAL API 图像编辑 |
| 10 | `image-enhancer` | 图像增强与放大 |

### 设计类 (2 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 11 | `ui-ux-pro-max` | 专业 UI/UX 设计 (67 样式 / 96 配色 / 57 字体 / 25 图表 / 13 技术栈 / 99 UX 准则) |
| 12 | `web-design-guidelines` | Web 设计标准 |

### 开发类 (3 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 13 | `vercel-react-best-practices` | React 最佳实践 |
| 14 | `vercel-composition-patterns` | 组件组合模式 |
| 15 | `vercel-react-native-skills` | React Native 开发 |

### 系统类 (2 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 16 | `self-improving-agent` | 自我改进 (错误日志 / 学习日志 / 功能请求日志) |
| 17 | `find-skills` | 技能发现与管理 |

### 通信类 (1 个)

| # | Skill ID | 描述 |
|---|----------|------|
| 18 | `clawdtalk-client` | 语音通话、短信和 AI Missions |

### Skill 联动

- `tech-earnings-deepdive` 分析完毕后，可用 `us-value-investing` 交叉验证
- `macro-liquidity` 可联动 `us-market-sentiment` 进行宏观-情绪综合判断
- 所有投资研究类 Skill 依赖 `web_search` 获取实时数据

---

## 6. 记忆系统

### 三层记忆架构

```
┌─────────────────────────────────────────────────┐
│           Layer 1: 语义记忆 (QMD)                │
│   sentence-transformers 向量搜索                  │
│   服务器启动时预加载索引                           │
│   用途: 语义相似度检索, 关联记忆                   │
└─────────────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────────────┐
│           Layer 2: 文件记忆 (JSONL)              │
│   分类存储: context / progress / daily / agent   │
│   用途: 结构化事实存储, 任务进度                   │
└─────────────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────────────┐
│           Layer 3: 自动提取 (Auto-Extract)       │
│   从对话中自动提取实体/事实                       │
│   用途: 被动知识积累, 无需手动标记                │
└─────────────────────────────────────────────────┘
```

### 辅助模块

| 模块 | 功能 |
|------|------|
| Identity Resolver | 用户/联系人身份解析，跨平台关联 |
| Permission Gate | 访问权限控制 |
| Quality Learner | 信息重要性评分 |
| Progress Tracker | 持续项目的进度追踪 |

### 存储位置

- **项目级记忆**: `/Users/dreamback/claude-mcp-cli/memory/`
- **全局记忆**: `~/.openclaw/memory/main.sqlite`

---

## 7. 定时任务

### 4 个 Cron 任务

| 任务 | 执行频率 | 描述 |
|------|----------|------|
| `evaluation` | 每天 23:00 UTC | Agent 健康报告 (4 维度评分: 活跃度/成功率/失败率/韧性) |
| `x-timeline` | 每 1 小时 | X/Twitter 时间线抓取 (Playwright, 每周期 80 条推文) |
| `rss-daily` | 每天 22:00 UTC | RSS 聚合器 (45+ 信息源 → AI 中文摘要) |
| `heartbeat` | 每 13 分钟 | Ping 所有交互式 Agent (90 秒超时, 排除 x-timeline 和 evaluator) |

### 健康等级划分

```
🟢 ≥ 80  HEALTHY            — 运行正常
🟡 60-79 NEEDS_OPTIMIZATION — 需要优化
🟠 40-59 NEEDS_OVERHAUL     — 需要大修
🔴 < 40  CRITICAL           — 严重问题
```

### API 端点

- `GET /v1/cron/status` — 查看所有定时任务状态
- `POST /v1/cron/trigger/:name` — 手动触发指定任务

---

## 8. 外部集成

### 通信平台

| 平台 | 集成方式 | 功能 |
|------|----------|------|
| **Discord** | 10 个 Webhook 频道 | Agent 通知推送, 按频道分类 |
| **WeCom (企业微信)** | Webhook 接收 + 智能回复 | AES 加密, 身份识别, 主动消息推送 |
| **Telegram** | `send_tg.py` (Userbot) | 消息收发, 历史搜索 |

### 健康与运动

| 平台 | 集成方式 | 功能 |
|------|----------|------|
| **WHOOP** | OAuth API | 生物指标采集 (HRV / 睡眠 / 恢复 / 负荷) |

### 社交媒体

| 平台 | 集成方式 | 功能 |
|------|----------|------|
| **X/Twitter** | Playwright 爬虫 (`x_scraper.py`) | 每小时时间线采集, 80 条/周期 |

### Web3/加密

| 平台 | 集成方式 | 功能 |
|------|----------|------|
| **Web3Auth** | MPC 钱包 (Node SDK v5) | 非托管钱包, Google OAuth 登录 |
| **Li.Fi + 0x** | 聚合 API | 跨链 Swap 聚合 |
| **Polymarket** | 交易 API | 预测市场交易 |
| **Hyperliquid** | 交易 API | 永续合约 |
| **Bitget Wallet API** | 数据 API | 代币数据 / Swap / 安全审计 / K 线 |

### 数据流向总览

```
WHOOP ──────→ Health Agent ──→ 健康数据分析
X/Twitter ──→ x-timeline ────→ 社交信号采集
RSS (45+) ──→ rss-daily ─────→ AI 中文每日摘要
WeCom ──────→ wecom/handler ─→ 智能回复
Discord ←───── Agent 通知 ←── 各 Agent 输出
Telegram ←──── send_tg.py ←── 消息推送
Web3Auth ───→ Proceed ───────→ 链上交易执行
```

---

## 9. 个性化定制

### 1. BD Advisor 模式 (Work Agent)

Work Agent 作为战略 BD 顾问运行，具备以下特性:

- **Anti-Messenger**: 不做信使，只做决策者
- **Results-Only**: 只关注结果，不关注过程
- **ADHD Mode**: 每轮最多 3 个 action items，简洁输出
- **5 维合作伙伴评估矩阵**: 总分 ≥20 推进, 14-19 标准跟进, <14 放弃
- **Kill Filter**: 停滞 >2 周 + 无决策人 + 与其他项目重复 = 直接终止

### 2. Tech Co-founder 模式 (OpenClaw Agent)

OpenClaw Agent 作为产品经理 (PM) 运行:

- 5 阶段流程: Discovery → Planning → Building → Polish → Handoff
- 通过 Task subagent 委派具体开发任务
- 强调反问、选项式决策
- Push Back 权限: 可以质疑不合理需求
- 交付后脱离对话依赖

### 3. ADHD 友好设计

- 所有 Agent 输出控制在每轮最多 3 个 action items
- 避免长篇大论，优先列表和要点

### 4. 迪拜本地化 (Life Agent)

- GMT+4 时区适配
- 气候因素纳入健康/出行建议

### 5. 损友型助手 (WeCom Agent)

- 企业微信回复采用轻松的"损友"口吻
- 非正式但有用的交互风格

### 6. 自修复系统 (GitHub Updates Agent)

4 级故障升级:

```
Level 1: 诊断问题 (diagnose)
Level 2: 自动修复 (auto-fix)
Level 3: 回滚到 checkpoint (rollback)
Level 4: 告警通知 (alert)
```

### 7. Checkpoint 系统

- 原子提交 + 回滚点
- 确保系统稳定性，任何变更都可追溯

### 8. 链上交易安全 (Proceed-Subagent)

- 大额操作需 2 次确认
- $5,000 以上交易触发警告
- 10 倍以上杠杆触发警告

---

## 10. 部署与运维

### 快速安装

```bash
git clone https://github.com/Dreamback2011/claude-code-adapter.git
cd claude-code-adapter
bash setup.sh  # 一键: 检查 Node>=18, 安装依赖, 生成 .env, 测试服务器
```

### 日常管理

```bash
bash scripts/manage.sh start     # 启动服务
bash scripts/manage.sh stop      # 停止服务
bash scripts/manage.sh restart   # 重启服务
bash scripts/manage.sh status    # 查看状态
bash scripts/manage.sh logs      # 查看日志
```

### macOS 开机自启

通过 LaunchAgent 实现 (`com.claude-adapter.plist`):

- `KeepAlive: true` — 进程退出后自动重启
- 随系统启动

### 环境变量 (.env)

| 变量 | 用途 |
|------|------|
| `LOCAL_API_KEY` | 客户端认证密钥 |
| `PORT` | 服务端口 (默认 3456) |
| `ALLOWED_TOOLS` | CLI 可用工具列表 |
| `MAX_CONCURRENT` | 最大并发数 (默认 20) |
| `USE_AGENT_SQUAD` | 启用 Agent Squad (true/false) |
| `WHOOP_CLIENT_ID` | WHOOP OAuth Client ID |
| `WHOOP_CLIENT_SECRET` | WHOOP OAuth Client Secret |
| `WECOM_CORP_ID` | 企业微信 Corp ID |
| `WECOM_SECRET` | 企业微信 Secret |
| `WECOM_AGENT_ID` | 企业微信 Agent ID |
| `WECOM_TOKEN` | 企业微信回调 Token |
| `WECOM_ENCODING_AES_KEY` | 企业微信 AES 加密密钥 |

### 健康检查

```bash
curl http://127.0.0.1:3456/health
```

返回服务状态和当前并发会话数。

---

## 11. 技术栈

| 层级 | 技术 |
|------|------|
| **服务器** | Express.js, TypeScript |
| **运行时** | Node.js 18+ (tsx, 无需构建步骤) |
| **CLI** | `claude -p` (官方 Anthropic CLI) |
| **流式传输** | Server-Sent Events (SSE) |
| **记忆系统** | QMD 语义搜索, sentence-transformers |
| **加密/Web3** | Web3Auth SDK, ethers.js, EVM 链 |
| **通信** | Discord Webhooks, WeCom API, Telegram (Userbot) |
| **RSS** | RSS Parser, 45+ 全球新闻源 |
| **健康数据** | WHOOP API |
| **社交媒体** | Playwright (X/Twitter 爬虫) |
| **编排调度** | agent-squad npm 包 |
| **进程管理** | Bash 脚本, launchctl |

### 核心 npm 依赖

```
express, dotenv, uuid, rss-parser, @web3auth/node-sdk,
ethers, agent-squad, open
```

---

## 12. 已知问题与修复

### 1. 嵌套会话挂起 (Nested Session Hang)

**问题**: 当服务器在 Claude Desktop/Claude Code 内部运行时，环境变量 `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*`, `CLAUDE_DEV` 会导致子进程 `claude -p` 检测到嵌套会话后静默挂起。

**修复**: 在 3 个位置清理这些环境变量:
- `src/index.ts` (进程级别)
- `src/claude-cli.ts` (spawn 环境)
- `scripts/manage.sh` (启动脚本)

### 2. EPIPE/ECONNRESET 崩溃

**问题**: 客户端断开连接时触发 EPIPE 或 ECONNRESET 错误，可能导致服务器崩溃。

**修复**: 全局错误处理器忽略这两类错误，防止服务器意外退出。

### 3. 空闲超时误杀

**问题**: 长时间运行的工具调用（如 bash 命令）可能触发空闲超时，导致 CLI 进程被误杀。

**修复**: 每 30 秒通过 `pgrep -P <pid>` 检测活跃子进程，若存在子进程则重置空闲计时器。

---

> 本文档描述的是 OpenClaw + Claude Code Adapter 系统截至 2026-03-02 的完整架构。随着系统持续迭代，部分细节可能已发生变化。
