# Agent Base Harness 项目协作指南

## 1. 文档用途

本文档用于帮助参与本仓库的开发者和编码 Agent 快速理解项目背景、目标、边界、参考资料以及协作规范。

开始任何设计或编码工作前，应先阅读：

1. 本文件 `AGENT.md`。
2. [`docs/Agent Client完整技术解决方案.md`](docs/Agent%20Client完整技术解决方案.md)。
3. [`docs/单Agent低上下文Runtime打造设计.md`](docs/单Agent低上下文Runtime打造设计.md)。
4. 当前开发阶段的技术落地方案（存在时）。
5. 与当前任务直接相关的参考项目代码；只有需要追溯早期分析时，才查阅 `docs/设计文档/` 中的初始草案。

若阶段技术落地方案与总体方案冲突，应先确认并同步修订总体方案，不能由实现代码自行选择语义。若用户在当前任务中提出了更新要求，以用户的明确要求为准，并同步更新相关文档。

## 2. 当前状态

本项目是一个 **Client 应用开发项目**。阶段 1 的 Client 基础运行平台、阶段 2 的 Headless 单 Agent Runtime V1 和阶段 3 的正式 Client UI 主链路已经完成；阶段 4“模型能力与上下文管理”已形成实施方案，阶段 4.5“通用 MCP 接入与可插拔长期记忆”也已完成开发架构和测试设计。实际开发以当前阶段对应设计和测试文档为准。

仓库当前主要包含：

- `ui/`：独立构建的正式 React Renderer，只能依赖公开 Client Contract 和 Preload 白名单 API。
- `src/`：Electron Main、Preload、Runtime Worker、公开 Client Contract、单 Agent Runtime 与基础设施正式代码。
- `tests/`：阶段 1～3 已有的单元、契约、安全与集成测试，以及阶段 4/4.5 将扩展的模型能力、Compaction、MCP Tool Bridge、长期记忆和迁移测试。
- `src/infrastructure/llm/`：OpenAI-compatible 真实 HTTP/SSE Adapter；阶段 4 在其上增加 DeepSeek/百炼预制和思考参数映射，不建立通用真实 Provider 兼容矩阵。
- `docs/`：Client 总体方案、Runtime 目标设计、各阶段技术落地方案和早期设计草案。
- `reference_ui/`：未来应用的视觉和布局参考原型。

`reference_ui` 只用于参考和复刻 UI 设计、页面比例、间距、配色、组件形态及交互入口。它内部的本地状态、Mock 数据、延时模拟、类型定义和业务处理逻辑均不是目标实现，不应直接迁移到正式项目。

项目的基本原则是：

> 视觉参考 `reference_ui`，业务逻辑与运行语义遵循设计文档并重新实现。

这里的 Runtime 是 Client 应用的核心执行引擎，不是本项目脱离客户端产品后单独交付的通用 Runtime 库。所有 Runtime、持久化、API/命令接口和事件投影设计，最终都服务于完整的客户端用户体验。

## 3. 项目背景

本项目计划使用 Node.js 和 TypeScript 构建一个完整的 Agent Client 应用。应用包含两个内置本地用户、单 Agent Runtime、本地持久化、模型与工具集成、事件投影，以及面向用户的聊天和设置界面。

项目的交付主体是可供用户直接使用的 Client，而不是纯后端服务、SDK、框架或命令行 Harness。单 Agent Runtime 是 Client 内部最重要的基础能力，负责驱动会话、模型调用、工具执行、队列、取消、恢复和上下文管理；客户端 UI 负责将这些能力组织成一致、可观察、可操作的产品体验。

当前技术方案采用 Electron + React + Vite，单 Agent Runtime 运行在独立 Node Worker 中，数据使用单个 SQLite 数据库。项目不是 Web SaaS 后端或独立 Runtime 服务。

项目吸收两个已有 Runtime 的成熟经验：

- 从 DeepSeek Harness 借鉴稳定、可恢复的执行骨架。
- 从 Agent Base 借鉴低上下文、会话记忆、事件分组、压缩和边界校验经验。

本项目不是两者的复制或拼接。目标是删除 Worker、Subagent、独立 Decider、Harness Evaluator、Answer Generator 等会增加调用次数、上下文重复和实现复杂度的链路，形成一个以精简单 Agent Runtime 为内核的 Client 应用。

## 4. 核心目标

首要目标不是堆积功能，而是打造一个可直接使用、可持续演进的 Agent Client，并确保其核心 Runtime 足够精简和稳定：

> 使用尽可能少的提示词、工具 Schema、历史上下文和模型调用，使一个 Agent 在多轮会话、工具调用、用户追加、软打断、取消和崩溃恢复中稳定运行。

必须长期保持的核心方向包括：

- 只有一个 Agent，不引入 Worker、Subagent、多 Agent 路由或结果合并。
- 使用模型原生 Tool Call 驱动 Turn/Step 循环。
- 纯文本任务原则上只进行一次主模型调用。
- 以仅追加的 Session Event Log 作为运行事实来源。
- 同一 Session 的模型决策串行，不同 Session 可以并行。
- 一个 Step 中明确安全的工具可以有界并行；未声明安全或具有副作用的工具默认独占。
- Inbox 持久化，并明确区分 `next-turn` 和 `next-step`。
- Queue、Steer、队列项从 `next-turn` 立刻介入 `next-step`、Inject、Cancel 均具有确定、可测试、可恢复的语义。
- 完整保存 Tool Result 事实；在上下文压力达到阈值时，允许只对模型可见 Surface 生成可追溯的头尾预裁剪投影，但不得改写原始 Event 或拆分 Tool Call/Result 配对。
- 通过 Context Projector 贯彻“存全，发少”，控制模型上下文增长。
- 采集 provider 返回的精确 usage，并单独记录上下文组成估算。
- UI、执行轨迹、Inbox 和 Token 统计都应由持久事件投影得到，而不是依赖前端临时状态成为事实。
- Client 内置两个本地用户；会话、事件、模型、Skill、凭据引用和 Agent 上下文必须按 `userId` 隔离。
- Client 应用必须提供完整的会话、输入、运行过程、队列、停止、模型配置和能力管理体验，而不是只实现不可交互的 Runtime 核心。
- 模型管理和 Skill 管理是正式 Client 产品模块，必须覆盖持久化、校验、凭据/授权、启停、用户隔离和 Runtime 配置快照，不能只做静态设置页面。
- Runtime 与 UI 必须通过明确的命令和事件/Projection 契约连接，使客户端刷新或重启后仍能恢复一致状态。

详细的不变量、生命周期和验收标准以目标设计文档为准。

## 5. 关键领域概念

实现和命名应统一使用设计文档中的概念：

- `LocalUser`：两个内置本地用户之一，是 Session、模型、Skill 和其他用户私有数据的顶层作用域。
- `Session`：一段可持久化会话；同时最多存在一个活动 Driver。
- `Inbox`：已接纳但尚未在安全边界领取的输入，目标为 `next-turn` 或 `next-step`。
- `ExecutionTurn`：Agent 对一条排队请求的完整执行过程。
- `Step`：一次模型请求以及该响应产生的全部 Tool Call。
- `SessionLogEvent`：记录 Runtime 技术事实的仅追加事件。
- `ConversationEvent`：当前聊天中围绕同一事项形成的用户可见问答集合。
- `ConversationExchange`：ConversationEvent 中的一次用户问题及对应的用户可见助手回答。
- `Surface`：从持久事件投影出的当前模型可见消息。
- `Projection`：从 Event Log 构建的可重建读模型，不是第二事实源。
- `ModelConfigSnapshot`：某个 Step 实际使用的不可变模型服务、模型参数和凭据引用快照。
- `SkillDefinition`：兼容通用 Agent Skills 目录的 Skill 定义，以 `SKILL.md` 为入口，可包含 `scripts/`、`references/` 和 `assets/`。
- `SkillInstallation`：某个 LocalUser 对 Skill 的安装来源、启用状态、授权状态和运行兼容性记录。
- `McpServerConfig`：某个 LocalUser 显式配置的 stdio 或 Streamable HTTP MCP Server；秘密只使用 Credential 引用。
- `McpToolCatalog`：完整发现但不直接进入 Prompt 的用户级 MCP Tool 管理目录。
- `ToolCatalogSnapshot`：某个 Step 实际获得的第一方 Tool 与已审核 MCP Tool 的不可变定义和路由快照。
- `MemoryProvider`：跨 Session 长期记忆的可替换边界；正文由 Provider 持有，不进入核心 SQLite 内容表。

代码中不要使用含糊的 `Event` 同时表示技术日志和业务事项。应明确使用 `SessionLogEvent` 与 `ConversationEvent`。

## 6. 未来项目结构

项目采用常规的单包 Node.js + TypeScript Client 脚手架，不使用 monorepo。客户端外壳已经确定为 Electron Main + Preload + React Renderer，单 Agent Runtime 位于独立 Node Worker。

```text
.
├── src/
│   ├── main/                # Electron Main、窗口、Bridge 与 Worker Supervisor
│   ├── preload/             # contextBridge 固定安全 API
│   ├── client-contracts/    # Renderer-safe DTO、Schema 与纯投影逻辑
│   ├── worker/              # Runtime Worker 入口、组合根与请求分派
│   ├── runtime/             # 单 Agent Runtime、工具、上下文与 Provider 契约
│   ├── infrastructure/      # SQLite、Credential、进程、Skill、日志适配
│   └── shared/              # 跨进程契约与领域基础类型
├── ui/                      # 与宿主核心物理分离的 React Renderer 工程
│   ├── index.html           # Vite 页面入口
│   └── src/                 # 页面、组件、交互状态、Client facade 与 UI Projection
├── tests/
│   ├── unit/                # 无外部依赖的确定性单元测试
│   ├── integration/         # Runtime、存储和适配器集成测试
│   ├── e2e/                 # Client 关键用户流程测试
│   └── fixtures/            # Mock LLM、脚本化工具和测试数据
├── resources/               # 客户端打包资源，如图标和应用元数据
├── scripts/                 # 开发、构建、检查和发布辅助脚本
├── docs/                    # 架构、技术方案、阶段计划和决策文档
├── reference_ui/            # 只读的视觉与比例参考原型
├── package.json             # 单包项目依赖和统一命令
├── tsconfig.json            # TypeScript 基础配置
├── tsconfig.ui.json         # 无 Node 类型的 Renderer 独立类型边界
├── vite.config.ts           # UI 开发与构建配置
├── eslint.config.js         # 静态检查配置
├── .prettierrc              # 格式化配置
├── .env.example             # 可公开的环境变量示例，不包含真实密钥
└── README.md                # 项目启动、开发和构建说明
```

各一级源码目录的职责如下：

- `src/main`、`src/preload`、`src/worker` 共同组成安全进程边界；Renderer 不直接访问 Node、SQLite 或任意 IPC。
- `ui` 是 `reference_ui` 的正式复刻位置，负责页面和用户交互，但不自行维护 Runtime 事实；不得直接导入 `src/main`、`src/preload`、`src/worker`、`src/runtime` 或 `src/infrastructure`。
- `src/client-contracts` 是 UI 唯一允许静态导入的核心侧目录，只能包含跨进程 DTO、运行时 Schema 和无宿主权限的纯投影逻辑。
- `src/runtime` 保存设计文档定义的 Agent 执行内核。其内部 Turn、Step、Inbox、Context、Tool 等目录等技术方案确定后再拆分。
- `src/infrastructure` 放置模型 Provider、数据库、文件系统、网络和客户端平台能力的具体适配，避免外部实现细节侵入 Runtime 核心。
- `src/shared` 只放真正跨层使用的契约和无领域状态工具，不作为无法分类代码的兜底目录。
- `tests` 从一开始区分单元、集成和端到端层级，但只按当前阶段逐步增加实际测试文件。
- `ui/public` 面向 Vite 页面资源，`resources` 面向最终客户端安装包资源；若后续技术选型证明不需要其中某项，可以删除。
- `reference_ui` 始终作为独立参考保留，不导入正式构建，也不在其中继续实现产品逻辑。

当前已经使用 Electron + React + Vite，并由独立 Node Worker 承载 Runtime。以下内容仍按后续阶段细化：

- `ui/src` 内部的正式 feature、组件和设计 token 进一步分层。
- `src/runtime` 随实现规模增长后的进一步模块拆分。
- Runtime 是否在未来具备独立复用价值；现阶段不拆独立 package。

后续按技术解决方案的阶段计划逐步细化目录，不一次性创建尚未使用的空模块。

## 7. 参考资料及作用

### 7.1 Client 完整技术解决方案

地址：

```text
./docs/Agent Client完整技术解决方案.md
```

作用：本项目产品形态、技术栈、进程架构、模块协作、核心业务流程、质量策略和开发阶段的主要依据。

### 7.2 单 Agent Runtime 目标设计

地址：

```text
./docs/单Agent低上下文Runtime打造设计.md
```

作用：本项目 Runtime 语义、边界、不变量、数据模型、V1 实现工作包和验收标准的主要依据。

### 7.3 阶段技术落地方案与初始设计草案

地址：

```text
./docs/阶段方案/             # 各阶段开始前创建，存在时作为该阶段实施依据
./docs/设计文档/             # 早期分析草案，仅供按需追溯
```

项目不设置独立“阶段 0”，也不要求在正式编码前一次性评审全部详细设计。每个开发阶段开始前，围绕该阶段范围单独输出一份完整技术落地方案，至少包含背景与目标、范围、架构、模块设计、核心流程、数据与接口、安全边界、测试方案、交付物和验收标准。

`docs/设计文档/` 是前期形成的分析素材，不再作为阶段 1 开工门槛或实现权威。阶段方案可以吸收其中仍然有效的内容，但必须重新核对总体方案和当前决策，不能未经评审直接照搬。

### 7.4 参考 UI

地址：

```text
./reference_ui/
```

作用：参考并复刻未来用户应用的视觉设计和页面比例，包括：

- 左侧会话列表与用户设置入口。
- 中央聊天区与流式回答区域。
- 可展开的执行过程卡片。
- 输入框、等待队列、停止及队列操作入口。
- 模型配置和技能管理页面。
- 整体配色、圆角、留白、间距、字号和响应式比例。

明确限制：

- 不复制其 Mock 执行模拟。
- 不沿用其临时 React 状态作为正式事实来源。
- 不依据其现有函数推导 Queue、Steer 或 Cancel 的正式语义。
- 不要求保留其当前类型和组件组织方式。
- 参考 UI 与目标设计冲突时，保留视觉意图，重写交互逻辑。

### 7.5 DeepSeek Harness

本机参考地址：

```text
../deepseek-harness/deepseek-harness/
```

绝对路径示例：

```text
/Users/codedan/local/project/deepseek-harness/deepseek-harness/
```

主要参考作用：

- 原生 Tool Call 驱动的 Agent Loop。
- 持久化 Inbox 及 `next-turn`、`next-step` 语义。
- Turn/Step 生命周期。
- Queue、Steer、持久 Queue Item 的“立刻介入”、Inject 和 Cancel。
- 并行工具滚动池、独占屏障和按模型顺序提交结果。
- Session Surface、事件类型、崩溃修复和持久化串行。
- provider usage 翻译、Token Meter 和可观测性。
- 基于连续区域和版本校验的上下文压缩事务。

优先阅读位置见目标设计文档第 17 节。常用入口包括：

```text
packages/core/agent/src/inbox.ts
packages/core/agent-loop/src/agent.ts
packages/core/agent-loop/src/tool-calls.ts
packages/core/session/src/index.ts
packages/core/session/src/types.ts
packages/core/session/src/repair.ts
packages/session/session-persistence/src/coordinator.ts
packages/llm/token-meter/src/index.ts
packages/compaction/compaction-basic/src/region.ts
packages/mcp/mcp-client/src/index.ts
packages/mcp/mcp-client/src/connection.ts
packages/mcp/mcp-client/src/tools.ts
packages/mcp/mcp-client/src/transport.ts
```

明确不引入：Subagent、Workflow Worker、自修改插件及完整 Cordis 组合层。阶段 4 引入 DeepSeek Harness 风格的压力触发 Tool Result 预裁剪；阶段 4.5 借鉴其 MCP Tool Bridge 的 transport、动态发现、generation、结果适配与有界重连，但增加逐工具审核和用户级 Prompt 预算。原始 Tool Result 永久保留且可回查。

### 7.6 Agent Base

本机参考地址：

```text
../private-learn/agent-base/
```

绝对路径示例：

```text
/Users/codedan/local/project/private-learn/agent-base/
```

主要参考作用：

- Context Assembler 的职责拆分。
- 上下文去重与当前轮保护。
- Session Summary 和分层历史压缩。
- ConversationEvent 式的同一事项问答组织。
- 当前事件和相关事件的有界加载。
- Schema 缺参分类以及工具输入、输出校验。
- UI 协议适配和异步 Hook 设计。

优先阅读位置见目标设计文档第 18 节。常用入口包括：

```text
runtime/context/assembler.py
runtime/context/context_deduplicator.py
runtime/context/session_context_manager.py
runtime/context/session_context_compressor.py
runtime/context/event_preloader.py
runtime/events/manager.py
runtime/tools/schema_validator.py
runtime/tools/skill_executor.py
runtime/ag_ui/adapter.py
runtime/hooks/runtime_hook.py
schema/db/agent_event.py
schema/db/conversation_turn.py
```

明确不引入：main/Worker 架构、独立 Decider、Harness Evaluator、独立 Answer Generator，以及每次请求前通过 LLM 判断历史相关性的链路。

### 7.7 使用参考代码的原则

- 先理解机制解决了什么问题，再为本项目重新建模。
- 不做整目录复制，不保留与单 Agent 目标无关的抽象层。
- 不为了与参考项目 API 一致而牺牲本项目的不变量。
- 引入参考机制时，应有相应测试证明取消、并发、恢复或上下文语义正确。
- 不修改两个外部参考项目，除非用户明确提出独立任务。

## 8. TypeScript 与代码编写规范

### 8.1 基础要求

- 使用 Node.js 当前项目指定的 LTS 版本和 TypeScript strict mode。
- 优先使用小型、显式接口和依赖注入，避免隐式全局状态和过度框架化。
- 默认使用 `async/await`；异步链路必须明确处理失败、超时和取消。
- 不使用 `any` 逃避边界建模；确需使用时必须局部化并说明原因。
- 外部输入先视为 `unknown`，经过 Schema 校验后再进入领域逻辑。
- 公共类型、事件 payload、工具参数和工具结果应具有明确类型。
- 避免无意义的缩写；领域命名应与设计文档保持一致。
- 注释用于解释原因、不变量和非显然约束，不复述代码表面行为。

### 8.2 模块与依赖

- 领域逻辑不得直接依赖 UI 框架。
- Runtime 核心不得直接绑定某一家模型 provider。
- 持久化通过 `EventStore` 等接口隔离，不能将数据库细节散落到主循环。
- 时间、ID、模型、工具注册表和 Event Store 应通过依赖注入提供，以便确定性测试。
- 禁止形成 `runtime → projection/UI → runtime` 循环依赖。
- 新增抽象前应证明至少存在明确的替换点或测试价值。

### 8.3 UI 编写规范

- 正式 UI 应尽量还原 `reference_ui` 的视觉比例和交互形态。
- UI 类型应来自正式 API/Projection 契约，不复用 Mock 类型作为领域模型。
- Chat、Trajectory、Queue、Turn 结束状态和 Token 展示必须能由持久事件重建。
- 流式内容可以使用临时渲染状态，但最终状态必须以服务端持久事件为准。
- UI 应明确区分“加入队列”“下一 Step 补充”和“停止当前执行”，避免用一个模糊按钮承载不同 Runtime 语义。
- 组件优先保持职责单一，视觉组件与数据订阅/命令提交逻辑适当分离。
- 保持键盘操作、焦点状态、可读标签、颜色对比度和基础响应式支持。

## 9. Git 协作规范

不要主动push，先询问
