# 阶段 2：提示词工程与 Prompt 清单

- 文档状态：待评审
- 所属阶段：阶段 2（单 Agent Runtime V1 完整实现）
- 更新日期：2026-08-19
- 上位方案：`docs/Agent Client完整技术解决方案.md`
- Runtime 目标设计：`docs/单Agent低上下文Runtime打造设计.md`
- 配套设计：`docs/阶段方案/阶段2-单AgentRuntime-V1开发架构设计.md`
- 配套测试：`docs/阶段方案/阶段2-单AgentRuntime-V1测试用例.md`

## 1. 文档目的

本文档定义阶段 2 中参与模型请求的全部**提示词（Prompt）**的分类、职责、稳定性约束与初版内容原则，作为 M05 Context Projector、M07 Event Compaction 与 M06 Interaction 实现时组装 LLM Input 的依据。

本文档只覆盖**固定或半固定的提示词文本**。动态上下文内容（Session Summary、Event Context、当前 ExecutionTurn Surface、History Tool 结果）属于「存全，发少」投影出的运行时数据，不是提示词文案，遵循 Runtime 目标设计的预算与完整性规则，不在本文档定义措辞。

阶段 2 只有一个 Agent、一条模型决策链。所有提示词都以「最少、稳定、可缓存」为目标；具体业务规则放入 Tool Schema、确定性校验和 Tool Result，不持续堆入通用 System Prompt。

## 2. 提示词与上下文的边界

| 类别                                                     | 是否提示词        | 稳定性                      | 纳入时机                     |
| -------------------------------------------------------- | ----------------- | --------------------------- | ---------------------------- |
| System Prompt                                            | 是                | 固定，字节稳定              | 每次请求                     |
| Tool Schema（name/description/inputSchema/outputSchema） | 是                | 半固定，prompt epoch 内稳定 | 每次请求                     |
| Compaction 摘要提示词                                    | 是                | 固定                        | 仅 Event 压缩时              |
| Interaction 提示（approval/selection/form）              | 是                | 固定                        | 工具 `request_user_input` 时 |
| Skill 指令（`SKILL.md`）                                 | 是                | 按需，内容随 Skill 变化     | 模型选中 Skill 后            |
| （可选）两级能力加载 `tool_catalog`/`tool_load`          | 是                | 半固定                      | 仅启用两级加载时             |
| Session Summary                                          | 否（动态内容）    | 变化                        | 预算内自动加入               |
| User Memory Profile                                      | 否（动态内容）    | 用户级文件变化              | 每次请求                     |
| Event Context（用户可见问答 / Summary + raw tail）       | 否（动态内容）    | 变化                        | 预算内自动加入               |
| 当前 ExecutionTurn Surface                               | 否（动态内容）    | 变化                        | 每次请求                     |
| History Tool 结果（`event_read`/`turn_read` 等）         | 否（Tool Result） | 变化                        | 模型显式调用后               |

LLM Input 的组合顺序（稳定内容在前，本轮变化内容在后）：

```text
LLM Input = 稳定前缀（System Prompt + Tool Schema）
          + User Memory Profile
          + Session Summary
          + Event Context
          + 当前 ExecutionTurn Surface
          + History Tool 结果（模型显式调用后）
```

## 3. L0 System Prompt

### 3.1 职责

- 声明 Agent 身份与边界。
- 声明工具使用原则。
- 声明不编造工具结果。
- 声明缺少必要信息时向用户询问。
- 声明回答应优先直接完成任务。
- 声明浅层记忆写入用户级 `memory-profile.md`，复杂记忆继续使用 MCP。

### 3.2 初版内容原则

初版只包含最短的通用约束，不包含任何业务规则：

```text
你是本客户端的单 Agent 助手。

使用原则：
- 使用工具完成需要访问本机或检索信息的能力；不要编造工具结果。
- 缺少完成任务所需的必要信息时，向用户询问，不要擅自假设。
- 能直接给出答案时优先直接完成，不做多余调用。

安全边界：
- 不得声称执行了你没有调用过工具的操作。
- 工具结果即事实，除非结果明确为错误，否则不得改写。
```

具体业务规则（例如某类任务的固定流程）一律放入对应 Tool 的 `description`、确定性校验或 Tool Result 中，不写入 System Prompt。

当前用户的 `memory-profile.md` 位于用户工作区根目录，由 `read/write/edit` 按现有权限规则访问。文件内容以 `<user_memory_profile>` 动态拼入 System Message，仅作为事实与偏好参考；空文件不产生动态片段。用户明确要求记住浅层偏好、称呼或稳定约束时先完成文件写入，复杂或详细内容仍走长期记忆 MCP。

### 3.3 稳定约束

- 不包含时间戳、请求 ID、Session ID、用户 ID 或任何变动统计。
- 字节内容在配置不变时保持稳定，以命中 provider prompt cache。
- 修改 System Prompt 属于配置变更，必须产生新的 prompt epoch。

## 4. L1 Tool Schema

Tool Schema 是发给模型的工具级提示，由每个 `ToolDefinition` 的 `name`、`description`、`inputSchema`、`outputSchema` 组成。`description` 应包含：工具用途、何时使用、输入输出要点与副作用声明。

### 4.1 内置 History Tools

| 工具                                 | 用途                                                  | description 要点                                                                 |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `event_search`                       | 当前用户当前 Session 内按标题、摘要、可见文本索引检索 | 返回有界候选：`id + title + status + summary/近期关键词 + updatedAt`，不返回全文 |
| `event_read(eventId, cursor, limit)` | 按 Event 和 Exchange 范围读取用户可见原始问答         | 只返回调用前选定范围内的内容，运行时不在结果生成后截断                           |
| `turn_list(eventId?, cursor, limit)` | 分页列出 ExecutionTurn 索引                           | 返回各 Exchange 对应 ExecutionTurn 的元数据，不含技术轨迹                        |
| `turn_read(turnId, range)`           | 读取指定 Turn 的完整技术轨迹与原始 Tool Result        | 必须用游标 / Exchange 范围 / 日志序号约束读取量，返回完整结果                    |

History Tool 结果与普通 Tool Result 遵守同一完整性规则，不允许跨用户或跨 Session 隐式召回。它们属于 L6（显式调用后的完整 Tool Result），不自动预注入。

### 4.2 宿主命令工具

阶段 2 内置一个受控宿主命令工具（工具名在实现时确定），作为 Skill 脚本执行与通用本机能力的唯一下发通道：

- 使用 `executable + argv`，不拼接任意 Shell 字符串。
- `cwd` 必须落在 Worker 受控根内；环境变量走 allowlist；超时与输出有界。
- 解释器或依赖缺失返回明确 Tool Result，不自动安装依赖。
- description 应声明：具备副作用、默认独占执行、需要用户/运行时授权。

### 4.3 Interaction 工具

| 工具                 | 用途                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `request_user_input` | 产生 `approval`（确认）、`selection`（选择）、`form`（表单）三类结构化交互，自带确定 Schema |

`interaction.resolve` 是用户/桥接侧的 Command，不是模型工具，不属于提示词清单。Interaction 的三类 Schema 是发给模型的「如何提问」的结构化提示，普通聊天不得伪造结构化 resolution。

### 4.4 （可选）两级能力加载

仅在 Tool Schema 已成为上下文主要成本时才引入，且必须先经真实 token 统计证明收益，不在 V1 默认启用：

```text
常驻工具：tool_catalog、tool_load、必要通用工具
领域工具：通过 tool_load 在后续 Step 加入当前 prompt epoch
```

`tool_catalog` 只返回短 ID、一句话描述和分类，不返回全量 Schema。启用两级加载时，提示词结构随 prompt epoch 变化，需在 `request.context` 中可解释。

## 5. Compaction 摘要提示词

Event Compaction 使用一次独立的摘要模型调用，其提示词是固定结构，输入与输出严格按 Schema：

- 触发：completed Exchange 后廉价 token 检查，默认超过 Event Context 预算 75% 才调用。
- 目标：压缩到 45%；至少保留最近 1 个 Exchange 原文。
- 输入：
  - 首次：完整已闭合的用户可见问答（ConversationExchange 原文）。
  - 后续：旧 Summary + 覆盖位置之后未覆盖的 raw tail。
- 输出：结构化 Summary，必须通过 Schema 校验、携带 `summaryVersion` 与覆盖位置。

摘要提示词需要明确约束：

```text
只总结用户可见的问答内容，不得改写、截断或替换任何工具结果或执行轨迹。
只压缩已闭合 Exchange，不压缩当前开放事项。
仅保留跨事件仍有效的约束、用户信息和事件索引。
```

压缩只作用于 ConversationEvent 的用户可见问答原文；原始 Tool Result 在事件日志中永久完整保留，`turn_read` 仍逐字段返回原内容。

## 6. Interaction 结构化提示

`request_user_input` 的三类 Schema，是发给模型的结构化提问契约，前端与 Runtime 共用同一份 Schema：

- `approval`：二元/有限选项确认，附说明与后果。
- `selection`：单选/多选，附候选项与是否必选。
- `form`：多个带类型的字段，附校验规则。

Schema 字段不含自由文本的理由注入（不得借 Interaction 向 Prompt 塞内部状态）。Interaction 结果只作为持久 Tool Result / 用户输入进入后续 Step，不走临时前端状态。

## 7. Skill/MCP 统一能力发现与按需加载

Skill 的 `SKILL.md` 与 MCP Tool Schema 都不直接作为完整目录常驻 Prompt：

- 常驻 `capability_search` 一次同时检索当前用户启用的 Skill Catalog 和已审核启用的 MCP Catalog，分别返回有界轻量候选；两类来源在结果中显式同级。
- Agent 必须基于同一份返回结果判断使用 Skill、MCP、两者或都不使用，不能先搜索其中一类再决定是否查看另一类。
- 选择 Skill 后调用 `skill_load` 读取完整 `SKILL.md` 及其显式引用资源（`scripts/`、`references/`、`assets/`）。
- 选择 MCP Server 后调用 `mcp_load`，从下一 Step 暴露该 Server 已审核启用工具的完整 Schema。
- 普通 Skill 不自动注册原生 Tool Schema，不修改 Agent Loop；脚本通过宿主命令工具执行。

统一搜索只读取管理目录中的摘要和 Schema 元信息，不加载 Skill 正文、不调用 MCP 业务工具。Skill 指令内容由 Skill 提供方决定，运行时只负责受控边界与完整性，不修改其正文。

## 8. 稳定前缀与 prompt epoch

为命中 provider prompt cache，所有固定提示词遵守：

1. System Prompt 不加时间戳、requestId、sessionId、userId 和变动统计。
2. Tool Schema 使用稳定排序与确定性 JSON 序列化。
3. 稳定内容放前，本轮变化内容放后。
4. 启用工具集或 Skill 可见性发生有效变化时，更新 prompt epoch，而不是在同一 epoch 内偷偷变更工具定义。
5. 不把 UI 展示字段、运行轨迹、token 计数或内部理由注入 Prompt。

`request.context` 需可解释每次请求实际使用的 prompt epoch、工具集与预算裁剪决策，供 Projection 与诊断使用。

## 9. 提示词验收

- System Prompt、Tool Schema、摘要提示词与 Interaction Schema 都作为配置事实维护，修改走同一配置 revision/prompt epoch 机制。
- 阶段 2 测试需覆盖：System Prompt 字节稳定（同配置不抖动）、Tool Schema 排序稳定、prompt epoch 随有效配置变更、摘要只覆盖用户可见问答且不改写 Tool Result、Interaction Schema 前后端一致。
- 不在 System Prompt 中堆入任何业务规则；相关「提示词膨胀」负向检查纳入实现评审。
