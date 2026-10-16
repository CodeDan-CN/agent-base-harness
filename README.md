# Agent Base Harness

独立部署的 Agent Runtime，以及连接它的 Web、Desktop 和 CLI 客户端。Mobile 已有轻量聊天首版与 Android 壳源码，APK/真机验收待完成，详见 [Mobile](apps/mobile/README.md)。

已实现：[阶段 4.6.0：思考模式重构设计方案](docs/阶段方案/阶段4.6.0-思考模式重构设计方案.md)，采用 Codex 的原生 phase 优先与未知兼容原则，包含流式展示、提示词变化、修改步骤和示例。

项目采用 npm workspaces。Server 默认托管 Web；Desktop 安装包和 CLI 通过服务器地址连接 Runtime，不内置或自动启动服务。工程边界、命令与手机端约定见 [多端工程架构](docs/多端工程拆分与远程客户端架构.md)。

## 项目状态

阶段 1 Client 基础平台、阶段 2 Headless 单 Agent Runtime V1 和阶段 3 Client 主界面已完成；界面状态和交互均来自真实 Bridge、Runtime Projection 与管理快照，不使用参考项目的 Mock 逻辑。阶段 4 聚焦模型能力目录、DeepSeek/百炼供应商预制和完整上下文管理；阶段 4.5 已接入通用 MCP Tool Bridge，并将官方 Memory MCP 作为默认本地服务，同时参考 Pi Agent 定义 `read`、`write`、`edit`、`bash` 四个第一方基础工具。

已完成能力：

- 四入口工程与构建、Runtime Worker Supervisor（创建/ready/崩溃重建/generation/优雅关闭）
- Bridge 契约：`apiVersion`、请求 UTF-8 字节上限、响应 Schema 校验、生命周期事件校验、用户切换 epoch 防竞态
- 导航白名单基于 URL 精确校验（协议 + host + port + 入口路径），IPC 二次校验 senderFrame URL
- 单 SQLite 双用户隔离、EventStore、Model/Skill 完整 Repository 与 SkillCatalog 业务闭环
- Credential：macOS、Ubuntu/Linux、Windows 统一由 Runtime SQLite 保存 API Key；无系统钥匙串或独立加密文件依赖，见[凭据存储与迁移](docs/Runtime凭据存储与迁移.md)
- ProcessRunner：真实路径（realpath）校验 symlink 逃逸、环境变量 allowlist 约束
- macOS arm64 Runtime Pack：固定 Node.js 24.20.0 与 Python 3.13.15，国内/官方双源下载、SHA-256 校验、应用内离线执行
- 默认 Memory MCP：固定 `@modelcontextprotocol/server-memory@2026.7.4`，随 Runtime Pack 离线运行，为每个本地用户分别预置、存储和发现工具
- 单 Agent Session Driver：Turn/Step、Queue、Steer、队列项“立刻介入”、Cancel、Interaction 与跨 Session 并行
- SQLite V2：持久 Inbox、输入幂等、Session lease、ConversationEvent/Exchange 与可重建 Projection
- Runtime：稳定 Prompt、上下文预算、Event 压缩、History Tool、Skill 按需加载和宿主命令工具
- Provider：不可变模型快照、OpenAI-compatible 真实 HTTP/SSE Adapter、OpenAI/Anthropic 流式归一化、chunk/final 与 usage 事实
- 恢复与 Bridge：未知工具副作用修复、Snapshot/cursor 增量订阅、双用户全链路隔离
- Client UI：会话与聊天、流式输出、执行过程、持久 Queue、“立刻介入”、Cancel、Interaction 和双用户切换
- 管理 UI：模型服务/密钥/连接测试/模型发现/上下文配置，以及标准 Skill 目录托管导入、详情与启停；Web/Desktop 在聊天输入框中选择模型和思考程度
- SQLite V3：模型与 Skill 配置版本、Skill 设置与凭据绑定、Runtime 设置及附件表结构

## 技术栈

- Electron + React + TypeScript + Vite
- SQLite：`better-sqlite3`
- IPC Schema 校验：`zod`
- 测试：Vitest（单元/集成/契约/安全）+ Playwright（Electron E2E）

阶段内关键技术决策见 [`docs/设计文档/ADR/0005-阶段1技术选型.md`](docs/设计文档/ADR/0005-阶段1技术选型.md)。

## 目录结构

```text
apps/
  server/       Server 与管理员入口
  web/          浏览器入口
  desktop/      Electron Main / Preload / Renderer
  cli/          远程命令行客户端
  mobile/       手机界面、远程适配与 Android 壳（不含 Runtime）
packages/
  protocol/     公共契约、Schema、投影
  client-sdk/   HTTP / SSE、认证、上传下载
  app-ui/       Web / Desktop 共享界面
  server-core/  Gateway、Application、RuntimeFacade
  runtime-core/ Agent 执行内核
  storage/      SQLite 与 Repository
  execution/    文件、工作区、进程、凭据、MCP 执行依赖
  test-kit/     共享测试 Fixture
build-support/  打包工具与服务分发模板
tests/          单元、契约、集成和 E2E
docs/ resources/ scripts/
```

共享 UI 通过注入的 AgentClientApi 访问服务，Desktop 使用固定 Preload 桥，Web 使用网络 SDK。npm run check:boundaries 检查客户端不能导入服务端 workspace，并验证声明的包依赖。

## 启动与开发

仅构建和运行 Web + Runtime 时，用 `npm run install:runtime` 安装依赖、`npm run typecheck:runtime` 检查类型，不安装 Electron 及桌面打包工具。Ubuntu/CentOS 的 Runtime 部署入口已自动使用这条路径。完整桌面开发使用下面的全量安装：

```bash
npm ci
npm run build:server
npm start                 # 只启动 Server，默认 http://127.0.0.1:4317 提供 Web
# 远程访问：
npm start -- --host 0.0.0.0
```

当前账号创建和密码校验在客户端本地完成。注册只需账号和密码，用户标识由系统自动生成并用于内部数据归属，界面不展示，也不提供填写或绑定入口。已有本地账号继续使用原数据。接口约定见[用户边界](docs/多端工程拆分与远程客户端架构.md#客户端用户与-runtime-数据归属)。更多配置见 [部署指南](DEPLOYMENT.md)。

```bash
npm run dev               # 本地 Runtime + Web Vite + Desktop
npm run dev:server        # 单独运行本地 Runtime
npm run dev:web           # Web Vite，默认 5174
npm run dev:desktop       # Electron + Renderer Vite，默认 5173
npm run start:desktop     # 启动已构建的 Desktop
node dist/cli/index.cjs --server http://127.0.0.1:4317 login
```

开发 Runtime 默认沿用服务端的本机数据目录；macOS 上已有 `~/Library/Application Support/agent-base-harness/database/app.db` 时，继续使用该目录中的原有数据。`AGENT_HARNESS_DATA_DIR` 可覆盖目录，例如设为 `app-data/development` 使用独立开发数据。AGENT_HARNESS_SERVER_URL 控制 Web 开发代理与 Desktop/CLI 的服务器地址。Desktop 也可在首屏填写地址；不在线时只提示连接失败。手机端不参加默认开发流程。

## 构建、打包与检查

```bash
npm run build             # Server + Web + CLI + Desktop
npm run build:desktop     # 仅桌面客户端构建
npm run pack:desktop      # 纯客户端 .app 目录
npm run dist              # macOS DMG
npm run pack:server       # Server npm 包及干净安装冒烟
npm run pack:cli          # 独立远程 CLI npm 包
npm run pack:runtime      # 交互选择系统/架构，生成 Runtime + Web 平台包
npm run pack:ubuntu       # Ubuntu 一键准备依赖、打 Runtime + Web 并验证
npm run pack:ubuntu -- --all # 同时生成 Linux Desktop AppImage/tar.gz
npm run pack:runtime:macos # 带 Node/Python/MCP 的 macOS arm64 Server Runtime
npm run typecheck
npm run lint
npm test
npm run verify:remote     # 真实浏览器、Electron、CLI 连接独立 Server
npm run verify:desktop-package
```

源码开发和轻量 Server 包要求 Node 22+（建议使用 Lock 中的 Node 24.20.0）。SQLite 只在 Server 的 Node 进程中使用，Desktop 不需要重建 Electron SQLite ABI。之前运行过旧版桌面开发的环境，可先执行 npm run rebuild:node。

平台选择、Linux 下载源和当前支持范围见 [Runtime 多平台打包入口](docs/Runtime多平台打包入口.md)。Linux x64 已在 Ubuntu 24.04.4 原生打包并执行服务功能验证，详见 [实机报告](deployment/ubuntu24.04/VALIDATION-20260911.md)；其他目标的实测范围分别记录，Windows Runtime 菜单明确标注未实现。

Ubuntu 24.04.4 的环境准备、Runtime＋Web / Linux Desktop 打包、部署与验证，请按 [Ubuntu 详细操作步骤](deployment/ubuntu24.04/RUNBOOK.md) 执行；相关配置与验收模板见 [部署目录](deployment/README.md)。

服务与 CLI 包分别输出到 release/server、release/cli；macOS 桌面应用输出到 release/mac-arm64，DMG 位于 release。Runtime Pack 只随自包含服务器包交付。

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

## HTTP MCP 连接配置

在设置 → MCP 服务中选择 `Streamable HTTP`，填写服务的 MCP Endpoint。默认凭据使用 `Authorization: Bearer <token>`；服务要求 `X-API-Key` 时，将“认证方式”切换为 `X-API-Key`，在 API Key 输入框填写密钥原值，不加 `Bearer` 前缀。密钥仍通过凭据存储保存，不放入普通配置或管理快照。

企业内网 MCP（如 `http://10.3.75.164:8000/mcp/`）默认允许访问，界面不再提供局域网开关；旧配置中的 allowPrivateNetwork 字段不再影响连接。允许 RFC1918 IPv4 和 IPv6 ULA，不放开链路本地地址；127.0.0.1/localhost 使用“本地 loopback MCP”，指向 Runtime 所在机器。请求由 Runtime 发起，部署服务器必须能访问 MCP 地址。

测试连接成功后会显示工具列表，再保存服务和所需工具。认证失败、内网地址未允许等诊断会直接显示；服务端和 Web 必须同时更新，以支持新增配置及错误字段。

技能与 MCP 统一按名称加载：`capability_search` 返回候选 `name`，分别调用 `skill_load({"name":"weekly-report-summary"})` 或 `mcp_load({"name":"本智能体记忆"})`。共享记忆使用独立名称“用户共享记忆”；普通 MCP 使用目录返回的服务名称。Skill/MCP 候选不暴露内部 ID，加载不接受 `capabilityId`、`skillName` 或额外 scope。后台仍使用内部 ID 和当前 Step 授权校验，不能通过名称越权加载；MCP 名称歧义时明确拒绝加载。智能体委派参数不变。
