# Agent Base Harness

单 Agent Client 应用与低上下文 Runtime。

已实现：[阶段 4.6.0：思考模式重构设计方案](docs/阶段方案/阶段4.6.0-思考模式重构设计方案.md)，采用 Codex 的原生 phase 优先与未知兼容原则，包含流式展示、提示词变化、修改步骤和示例。

新增待实施设计：[阶段 4.7.0：Runtime（运行时）独立化开发架构设计](docs/阶段方案/阶段4.7.0-Runtime独立化开发架构设计.md)。4.7.0 将交付独立 Node.js 服务及 CLI（命令行）/Electron（桌面）双客户端，Web（浏览器）和手机端后续接入；包含组件内部结构、迁移工作包和关键时序图。以下已完成能力仍描述当前代码，不表示独立服务已经上线。

## 项目状态

阶段 1 Client 基础平台、阶段 2 Headless 单 Agent Runtime V1 和阶段 3 Client 主界面已完成；界面状态和交互均来自真实 Bridge、Runtime Projection 与管理快照，不使用参考项目的 Mock 逻辑。阶段 4 聚焦模型能力目录、DeepSeek/百炼供应商预制和完整上下文管理；阶段 4.5 已接入通用 MCP Tool Bridge，并将官方 Memory MCP 作为默认本地服务，同时参考 Pi Agent 定义 `read`、`write`、`edit`、`bash` 四个第一方基础工具。

已完成能力：

- 四入口工程与构建、Runtime Worker Supervisor（创建/ready/崩溃重建/generation/优雅关闭）
- Bridge 契约：`apiVersion`、请求 UTF-8 字节上限、响应 Schema 校验、生命周期事件校验、用户切换 epoch 防竞态
- 导航白名单基于 URL 精确校验（协议 + host + port + 入口路径），IPC 二次校验 senderFrame URL
- 单 SQLite 双用户隔离、EventStore、Model/Skill 完整 Repository 与 SkillCatalog 业务闭环
- Credential：macOS Keychain 适配器接入生产链路，health 返回真实可用状态
- ProcessRunner：真实路径（realpath）校验 symlink 逃逸、环境变量 allowlist 约束
- macOS arm64 Runtime Pack：固定 Node.js 24.20.0 与 Python 3.13.15，国内/官方双源下载、SHA-256 校验、应用内离线执行
- 默认 Memory MCP：固定 `@modelcontextprotocol/server-memory@2026.7.4`，随 Runtime Pack 离线运行，为两个本地用户分别预置、存储和发现工具
- 单 Agent Session Driver：Turn/Step、Queue、Steer、队列项“立刻介入”、Cancel、Interaction 与跨 Session 并行
- SQLite V2：持久 Inbox、输入幂等、Session lease、ConversationEvent/Exchange 与可重建 Projection
- Runtime：稳定 Prompt、上下文预算、Event 压缩、History Tool、Skill 按需加载和宿主命令工具
- Provider：不可变模型快照、OpenAI-compatible 真实 HTTP/SSE Adapter、OpenAI/Anthropic 流式归一化、chunk/final 与 usage 事实
- 恢复与 Bridge：未知工具副作用修复、Snapshot/cursor 增量订阅、双用户全链路隔离
- Client UI：会话与聊天、流式输出、执行过程、持久 Queue、“立刻介入”、Cancel、Interaction 和双用户切换
- 管理 UI：模型服务/密钥/连接测试/模型发现/默认模型，以及标准 Skill 目录托管导入、详情与启停
- SQLite V3：模型与 Skill 配置版本、Skill 设置与凭据绑定、Runtime 设置及附件表结构

## 技术栈

- Electron + React + TypeScript + Vite
- SQLite：`better-sqlite3`
- IPC Schema 校验：`zod`
- 测试：Vitest（单元/集成/契约/安全）+ Playwright（Electron E2E）

阶段内关键技术决策见 [`docs/设计文档/ADR/0005-阶段1技术选型.md`](docs/设计文档/ADR/0005-阶段1技术选型.md)。

## 目录结构

```text
src/
  main/                 Electron Main、Worker Supervisor、Bridge Controller
  preload/              contextBridge 固定 API
  client-contracts/     Renderer-safe DTO、Schema 与纯投影
  worker/               Runtime Worker 入口与应用服务
  runtime/              单 Agent Driver、Inbox、Context、Tool、Provider Contract
  infrastructure/       SQLite、Credential、进程、Skill 解析、日志
  shared/contracts/     IPC、Schema、错误码、DTO
  shared/domain/        用户、Session、配置领域类型
ui/
  index.html             Vite Renderer 入口
  src/                   正式 React Client、会话 Projection 与模型/Skill 设置
tests/
  unit/ integration/ contract/  fixtures/
docs/  reference_ui/  resources/  scripts/
```

`ui/` 只能导入 `@client-contracts` 与 UI 自身模块，调用核心能力必须经过 `window.agentClient` 的 Preload 白名单桥。`npm run check:ui-boundary` 会阻止 UI 直接依赖 Main、Worker、Runtime、Infrastructure、Electron 或 Node builtin。

## 开发命令

```bash
npm install
npm run dev            # Vite + Electron 开发模式
npm run build          # 四入口生产构建
npm run runtime:prepare # 准备并校验 macOS arm64 内置 Node/Python
npm run runtime:verify  # 实际执行 node/npm/python/pip 验证 Runtime Pack
npm run pack           # 构建 arm64 .app，并进行本地 ad-hoc 签名验证
npm run typecheck      # strict 类型检查
npm run lint           # ESLint
npm run format         # Prettier
npm test               # Vitest 全部测试
npm run e2e            # Playwright Electron E2E
```

开发端口默认是 `5173`；端口冲突时可使用 `AGENT_CLIENT_DEV_PORT=5174 npm run dev`。启动器只有在 Vite 成功监听后才会创建 Electron 窗口。

> 说明：`better-sqlite3` 的 Node 与 Electron ABI 不同。启动桌面端或 E2E 时会自动准备 Electron ABI，
> 运行 Vitest 时会自动恢复 Node ABI，不需要手工切换。

## 阶段 2 验收要点

- 四个入口独立构建，Renderer 产物不含 Node builtin。
- Worker 创建/ready/异常退出/重建/generation 重同步。
- 固定 Bridge 契约覆盖 Session、Inbox、Turn、Interaction、Projection Query 与 cursor Subscription。
- 单 SQLite 双用户隔离、复合外键阻止跨用户访问。
- 仅追加 EventStore：连续 seq、版本冲突、整批回滚。
- Model/Skill 配置 Repository、config revision、Credential 仅存 `credential_ref`。
- 标准 Agent Skills 目录解析、内置优先的 Node/Python 与宿主 Shell 探测、受控 ProcessRunner。
- 结构化日志脱敏、健康 Snapshot、测试 Harness 与 CI 门禁。
- 同 Session 串行、跨 Session 有界并行；lease 丢失后旧 Driver 无法继续写入。
- 普通补充进入 `next-turn`；“立刻介入”保持同一 InboxItem 并原子提升至 `next-step`。
- Tool Result 完整持久化、显式安全工具有界并行、独占屏障与有序提交。
- 流式 final、上下文硬预算、Event 压缩、取消和崩溃恢复均有确定事件结果。

阶段 2 设计与测试依据：[`docs/阶段方案/阶段2-单AgentRuntime-V1开发架构设计.md`](docs/阶段方案/阶段2-单AgentRuntime-V1开发架构设计.md)、[`docs/阶段方案/阶段2-单AgentRuntime-V1测试用例.md`](docs/阶段方案/阶段2-单AgentRuntime-V1测试用例.md)。

真实 Provider Smoke 测试位于 `tests/live/openai-runtime.live.test.ts`，仅在调用方显式提供 `LIVE_MODEL_API_KEY`、`LIVE_MODEL_ENDPOINT` 与 `LIVE_MODEL_ID` 时运行；凭据只进入测试进程内存，不进入仓库与 SQLite。
