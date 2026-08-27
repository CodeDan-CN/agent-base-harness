# 阶段 3：Client 与单 Agent Runtime 联合测试用例

- 文档状态：联合验收基线
- 所属阶段：阶段 3（Client 产品接线与功能实现）
- 覆盖范围：阶段 2 Runtime 全部能力 + 阶段 3 Client 产品能力
- 更新日期：2026-08-24
- 对应设计：`阶段2-单AgentRuntime-V1开发架构设计.md`、`阶段3-Client产品功能开发架构设计.md`

## 1. 测试目的

阶段 3 是阶段 2 Runtime 第一次通过真实桌面 Client 对外提供能力，因此不能只验证“页面能打开”，也不能只把阶段 2 的 Headless 测试当作前置回归。本阶段必须同时证明：

1. 阶段 2 的运行语义在 Worker 内成立；
2. Renderer 发出的 Command 参数没有改变 Runtime 语义；
3. Event、Projection、Subscription 经 Preload/Main 接线后没有丢失或重复；
4. 用户在真实 Electron 界面看到的状态与 SQLite 持久事实一致；
5. 双用户、模型、Skill、Credential 和历史数据仍按用户作用域隔离；
6. 刷新、切换、流式输出、取消和 Worker 恢复不会破坏一致性。

本文档取代“阶段 2 只做回归、阶段 3 只测 UI”的分离方式，作为阶段 3 唯一联合验收清单。

## 2. 联合验收模型

### 2.1 三层验证

| 验证层            | 验证对象                                                           | 主要证据                                               |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| A：Runtime 语义层 | Inbox、Turn/Step、Context、Memory、Tool、Interaction、恢复         | Runtime 集成测试、Event Log、SQLite Projection         |
| B：Client 接线层  | Renderer 输入策略、Bridge Schema、订阅 cursor、Reducer、用户 epoch | Contract/Integration 测试、Command 入参、Snapshot 对比 |
| C：产品行为层     | Electron 页面、队列操作、流式展示、设置与双用户切换                | Playwright Electron E2E、截图和可见状态                |

任何核心能力必须至少通过 A+B；用户可见功能必须通过 A+B+C。只通过 A 层不代表阶段 3 已完成。

### 2.2 权威状态与断言顺序

```text
用户操作
→ Command accepted（只代表接纳）
→ SessionLogEvent（持久权威事实）
→ Runtime Projection（确定性状态）
→ Session Subscription（连续 cursor）
→ Renderer Projection（前端副本）
→ DOM（用户可见结果）
```

测试应从右向左核对：DOM 状态必须能追溯到 Renderer Projection，Projection 必须能追溯到 Event；不得根据 Command 返回值提前显示“已完成”。

### 2.3 自动化状态标识

| 标识     | 含义                                           |
| -------- | ---------------------------------------------- |
| 已覆盖   | 当前仓库已有自动化测试并纳入门禁               |
| 部分覆盖 | 底层已测，但缺真实 Bridge 或 Electron 产品路径 |
| 待实现   | 对应产品能力尚未完整实现，不可伪造为通过       |

## 3. 阶段 2—阶段 3 能力接线矩阵

| 阶段 2 能力                | 阶段 3 产品入口/展示     | 关键接线参数或事件                           | 状态     |
| -------------------------- | ------------------------ | -------------------------------------------- | -------- |
| Session 创建、重命名、归档 | 侧栏与聊天标题           | session.create/rename/archive                | 部分覆盖 |
| 普通输入与连续追问         | 输入框“发送”             | 空闲时 `startNewEvent=false`                 | 已覆盖   |
| 运行中 Queue               | 输入框“加入队列”         | `mode=queue`、next-turn                      | 已覆盖   |
| Steer                      | “补充当前任务”           | `mode=steer`、next-step                      | 已覆盖   |
| 立刻介入                   | Queue 行“立刻介入”       | inbox.promote + expectedTurnId               | 已覆盖   |
| Cancel                     | 输入区停止按钮           | turn.cancel，默认保留 next-turn              | 已覆盖   |
| Turn/Step/Tool 轨迹        | 执行过程卡片             | Runtime Projection                           | 部分覆盖 |
| 流式回答                   | 聊天气泡                 | assistant.chunk + assistant.message 校准     | 已覆盖   |
| Interaction                | approval/selection/form  | interaction.requested/resolved               | 部分覆盖 |
| Event 记忆与压缩           | 连续聊天，无独立设置入口 | 最近问答 + 当前 Event Summary + History Tool | 已覆盖   |
| Snapshot/cursor            | 进入会话、刷新、切换     | session.snapshot + 增量订阅                  | 已覆盖   |
| Worker 恢复                | Client 生命周期状态      | restarting/ready + 重取 Snapshot             | 部分覆盖 |
| 双用户隔离                 | 用户切换                 | Main 注入 userId、用户 epoch                 | 部分覆盖 |
| 模型管理                   | 设置—模型配置            | 管理 Query/Command + Credential Store        | 已覆盖   |
| Skill 管理                 | 设置—技能与插件          | 受管目录、启停、skill_load、host_command     | 已覆盖   |
| Runtime 设置               | 设置页                   | runtime revision                             | 待实现   |
| 受控附件                   | 输入区附件按钮           | 文件 token + attachment.import               | 待实现   |

## 4. 环境与 Fixture

- 单元、Contract、Integration 使用临时应用数据目录，禁止读写用户真实 SQLite。
- Runtime 使用 Fake/Scripted LLM 与 Tool，通过正式 EventStore、Projection 和 Driver 执行。
- Electron E2E 启动正式 build，并使用独立 `AGENT_CLIENT_APP_DATA`。
- 真实模型和真实 Skill 只放在 `tests/live`，必须由显式环境变量开启，不进入默认门禁。
- Credential 使用哨兵值，结束后扫描 Query、事件、日志和数据库，确保不回传明文。
- 核心 Electron E2E 至少连续冷启动 3 次，排除启动时序偶发问题。

## 5. M00 质量门禁与阶段 2 基线

| ID         | 优先级/类型     | 场景                              | 预期结果                         | 状态   |
| ---------- | --------------- | --------------------------------- | -------------------------------- | ------ |
| S3-M00-001 | P0 / Static     | TypeScript 类型检查               | 无类型错误                       | 已覆盖 |
| S3-M00-002 | P0 / Static     | ESLint                            | 无 lint error                    | 已覆盖 |
| S3-M00-003 | P0 / Build      | Main/Preload/Worker/Renderer 构建 | 全部成功                         | 已覆盖 |
| S3-M00-004 | P0 / Regression | 全量 Vitest                       | 阶段 1、2、3 测试全部通过        | 已覆盖 |
| S3-M00-005 | P0 / Data       | V1～V3 migration                  | 新库与升级库都能打开             | 已覆盖 |
| S3-M00-006 | P0 / Security   | Renderer 安全边界                 | 无 Node API、任意 IPC 和密钥回传 | 已覆盖 |

## 6. M01 Client Shell、Bridge 与订阅

| ID         | 优先级/类型      | 场景                     | 预期结果                                                | 状态     |
| ---------- | ---------------- | ------------------------ | ------------------------------------------------------- | -------- |
| S3-M01-001 | P0 / E2E         | 冷启动                   | migration、Worker ready、bootstrap 后无白屏             | 已覆盖   |
| S3-M01-002 | P0 / Contract    | 未知 Method/非法 payload | Preload/Main Schema 拒绝                                | 已覆盖   |
| S3-M01-003 | P0 / Integration | Snapshot 后接增量        | `fromSeq=lastSeq+1`，无重放和丢失                       | 已覆盖   |
| S3-M01-004 | P0 / Integration | cursor 断档              | 冻结局部增量并重取 Snapshot                             | 已覆盖   |
| S3-M01-005 | P0 / Reducer     | Event 批次回放           | 增量结果等于从头 Projection                             | 已覆盖   |
| S3-M01-006 | P1 / Resource    | 流式输出 100 个 chunk    | chunk 只更新当前 Projection，不产生 100 次 session.list | 已覆盖   |
| S3-M01-007 | P1 / Resource    | 反复切换会话             | 旧订阅释放，无监听器增长                                | 部分覆盖 |
| S3-M01-008 | P1 / UI          | 空态/loading/error       | 状态可理解且关键操作可达                                | 部分覆盖 |

## 7. M02 输入、Event 归属与记忆

记忆的正式输入由四部分组成：

1. 当前 Turn 的完整消息与 Tool Result；
2. 最近 2 个 Turn 的完整问答，作为跨 Event 的短期记忆保底；
3. 当前 ConversationEvent 的摘要和未被摘要覆盖的 raw tail；
4. 最多 3 个相关 Event 摘要，以及按需调用 `event_search/event_read` 获得的旧历史。

最近问答不能依赖 UI 是否准确判断 Event 边界。摘要覆盖范围和 raw tail 不得重复；当前 Turn 事实不可截断。

| ID         | 优先级/类型      | 场景                             | 预期结果                                           | 状态   |
| ---------- | ---------------- | -------------------------------- | -------------------------------------------------- | ------ |
| S3-M02-001 | P0 / Integration | 新 Session 首次发送              | Runtime 自动创建 Event/Exchange/Turn               | 已覆盖 |
| S3-M02-002 | P0 / Wiring      | 空闲时连续追问                   | Client 发送 `startNewEvent=false`，延续最近 Event  | 已覆盖 |
| S3-M02-003 | P0 / Product     | “记住你叫小爱同学”后问“你叫什么” | 第二次模型请求包含上一轮完整问答，回答不失忆       | 已覆盖 |
| S3-M02-004 | P0 / Context     | 显式创建新 Event                 | 仍携带最近 2 个 Turn 作为短期保底                  | 已覆盖 |
| S3-M02-005 | P0 / Context     | 同 Event 多轮                    | 当前摘要、未覆盖 raw tail、最近 Exchange 顺序正确  | 已覆盖 |
| S3-M02-006 | P0 / Context     | 长 Event 达阈值                  | 压缩成功，至少保留最近 1 个 Exchange 原文          | 已覆盖 |
| S3-M02-007 | P0 / Context     | 摘要版本冲突/无节省              | 不提交无效摘要，不覆盖新事实                       | 已覆盖 |
| S3-M02-008 | P0 / Context     | 当前 Turn 超预算                 | 明确 `context_budget_exceeded`，不截断后请求模型   | 已覆盖 |
| S3-M02-009 | P0 / Tool        | 查询较老事项                     | event_search → event_read，仅当前用户/Session 可见 | 已覆盖 |
| S3-M02-010 | P0 / Isolation   | B 查询 A 的记忆                  | NOT_FOUND/空结果，不泄漏存在性                     | 已覆盖 |

## 8. M03 Queue、Steer、立刻介入与取消

| ID         | 优先级/类型      | 场景                   | 预期结果                                            | 状态     |
| ---------- | ---------------- | ---------------------- | --------------------------------------------------- | -------- |
| S3-M03-001 | P0 / Integration | 运行中普通发送         | 持久进入 next-turn，不改变已发模型请求              | 已覆盖   |
| S3-M03-002 | P0 / UI          | Queue remove/replace   | 同一 InboxItem 正确删除或替换，刷新可恢复           | 已覆盖   |
| S3-M03-003 | P0 / Integration | 直接 Steer             | 绑定当前 Event/Turn，在最近安全 Step 边界进入       | 已覆盖   |
| S3-M03-004 | P0 / Integration | 点击“立刻介入”         | 原 Queue Item 原子 promote 为 next-step，不重复发送 | 已覆盖   |
| S3-M03-005 | P0 / Concurrency | promote 时 Turn 已变化 | 返回 TURN_CHANGED，消息仍留在队列                   | 已覆盖   |
| S3-M03-006 | P0 / Integration | Cancel 当前 Turn       | 终态 cancelled，默认保留 next-turn、清理 next-step  | 已覆盖   |
| S3-M03-007 | P0 / Integration | Cancel 后有排队任务    | 当前结束后新 Turn 正常领取                          | 已覆盖   |
| S3-M03-008 | P0 / Idempotency | 重复 input.submit      | 同 key/同 payload 返回首次结果；不同 payload 冲突   | 已覆盖   |
| S3-M03-009 | P0 / Serial      | 同 Session 多条输入    | 严格串行；不同 Session 可并行                       | 已覆盖   |
| S3-M03-010 | P1 / UI          | busy 操作反馈          | promote/remove/replace 期间禁止重复点击             | 部分覆盖 |

## 9. M04 模型、Tool、Skill 与 Interaction

| ID          | 优先级/类型      | 场景                       | 预期结果                                                                | 状态                |
| ----------- | ---------------- | -------------------------- | ----------------------------------------------------------------------- | ------------------- |
| S3-M04-001  | P0 / Runtime     | 纯文本/流式响应            | chunk 即时展示，final message 最终校准                                  | 已覆盖              |
| S3-M04-001A | P0 / Runtime/UI  | reasoning 与 Markdown      | think 独立流式展示；无 Tool Call 不显示执行区；有调用时安全渲染输入输出 | 已覆盖              |
| S3-M04-002  | P0 / Runtime     | 单/多 Tool 与重试          | 有界并发、顺序稳定、结果完整进入下一 Step                               | 已覆盖              |
| S3-M04-003  | P0 / Runtime     | 无限 Tool 循环             | maxSteps 后确定失败，无开放 Turn                                        | 已覆盖              |
| S3-M04-004  | P0 / Interaction | approval/selection/form    | Schema 校验、持久等待、resolve 后继续                                   | 已覆盖              |
| S3-M04-005  | P0 / Recovery    | Interaction 期间重启       | pending 状态从 Snapshot 恢复                                            | 部分覆盖            |
| S3-M04-006  | P0 / Model       | 保存服务、模型并设默认     | revision 正确，Agent 可立即使用                                         | 已覆盖              |
| S3-M04-007  | P0 / Credential  | replace/unchanged/clear    | 明文不进 SQLite、Query、日志或 DOM                                      | 已覆盖              |
| S3-M04-008  | P0 / Model       | 草稿连接测试与发现         | 不先持久化草稿，错误类型明确                                            | 部分覆盖            |
| S3-M04-009  | P0 / Skill       | 导入标准 Skill             | SKILL.md 必需，scripts/references/assets 可选                           | 已覆盖              |
| S3-M04-010  | P0 / Skill       | Skill 路径安全             | 穿越、链接逃逸、超限被拒绝                                              | 已覆盖              |
| S3-M04-011  | P0 / Skill       | Agent 按需执行             | skill_load 返回 `skill://` 根；host_command 在受管目录执行              | 已覆盖              |
| S3-M04-012  | P0 / Skill       | 启停和双用户               | 只影响当前用户，下一 Step 使用新 revision                               | 已覆盖              |
| S3-M04-013  | P1 / Live        | 12306 Skill + 真实模型     | Agent 自主加载 Skill、执行脚本并形成回答                                | 已覆盖（显式 live） |
| S3-M04-014  | P1 / Skill UI    | 预览、更新、扩权确认、卸载 | 完整产品交互可用                                                        | 待实现              |

## 10. M05 双用户、安全与隐私

| ID         | 优先级/类型      | 场景                              | 预期结果                                      | 状态     |
| ---------- | ---------------- | --------------------------------- | --------------------------------------------- | -------- |
| S3-M05-001 | P0 / E2E         | A 切换 B                          | 会话、模型、Skill 和身份全部切换              | 部分覆盖 |
| S3-M05-002 | P0 / Concurrency | A 的旧响应迟到                    | 用户 epoch 拒绝，不能进入 B 页面              | 部分覆盖 |
| S3-M05-003 | P0 / Runtime     | A 后台执行时切 B                  | 不取消 A；切回按 cursor 恢复                  | 部分覆盖 |
| S3-M05-004 | P0 / Security    | B 使用 A 的 Session/Event/Turn ID | NOT_FOUND，不泄漏 A 数据或存在性              | 已覆盖   |
| S3-M05-005 | P0 / Security    | Renderer 伪造 userId              | Main 忽略/拒绝，只使用可信上下文              | 已覆盖   |
| S3-M05-006 | P0 / Security    | 密钥哨兵扫描                      | 不出现在 Event、SQLite、日志、Snapshot 和 DOM | 已覆盖   |
| S3-M05-007 | P0 / Security    | Skill 宿主命令                    | 只允许固定 executable、受管 cwd 和受限环境    | 已覆盖   |
| S3-M05-008 | P1 / UI          | 切用户时敏感草稿                  | API Key 等未保存输入立即清理                  | 部分覆盖 |

## 11. M06 崩溃、重启与一致性恢复

| ID         | 优先级/类型      | 场景                   | 预期结果                             | 状态     |
| ---------- | ---------------- | ---------------------- | ------------------------------------ | -------- |
| S3-M06-001 | P0 / Runtime     | 开放 Turn 恢复         | 补齐未知副作用并标记 interrupted     | 已覆盖   |
| S3-M06-002 | P0 / Runtime     | replay-safe Tool       | 按 request/call key 去重或安全恢复   | 已覆盖   |
| S3-M06-003 | P0 / Concurrency | lease 被新 Worker 接管 | 旧 Driver 不能再提交结果             | 已覆盖   |
| S3-M06-004 | P0 / Client      | Worker generation 变化 | 丢弃旧响应，重建当前用户订阅         | 部分覆盖 |
| S3-M06-005 | P0 / Client      | Worker ready           | 重取 session.list 和当前 Snapshot    | 部分覆盖 |
| S3-M06-006 | P1 / E2E         | 真实崩溃重启           | UI 显示 restarting，恢复后状态可解释 | 待实现   |

## 12. M07 核心产品 E2E

### 12.1 默认门禁 E2E

1. 冷启动 → bootstrap → Worker ready → 默认用户 A 空态。
2. 打开模型设置 → 打开 Skill 设置 → 返回聊天。
3. 创建会话 → 连续两轮问答 → 第二轮保留上一轮完整上下文。
4. 运行中发送 → Queue → “立刻介入” → 下一 Step 消化 → 正常结束。
5. 流式回答期间切换会话 → 切回 → final 校准且不重复。
6. A 创建独有会话/模型/Skill → 切 B 不可见 → 切回 A 恢复。

### 12.2 显式 Live E2E

1. 通过临时环境变量注入 OpenAI-compatible endpoint、credential 和 model ID。
2. 导入临时解压的标准 Skill，启用后由 Agent 调用 skill_load。
3. Agent 使用 `host_command(cwd='skill://...')` 执行宿主机 Node/Python 脚本。
4. 核对 Tool 轨迹、最终回答、退出状态和用户隔离。
5. 测试结束清理临时 Skill、临时应用目录和环境变量；不得把 credential 写入仓库。

## 13. 视觉与可访问性

| ID         | 优先级/类型     | 场景              | 预期结果                                        | 状态     |
| ---------- | --------------- | ----------------- | ----------------------------------------------- | -------- |
| S3-M07-001 | P1 / Visual     | 1440×900 主界面   | 侧栏、聊天、执行区和输入区比例符合 reference_ui | 部分覆盖 |
| S3-M07-002 | P1 / Visual     | 设置页            | 模型与 Skill 页层级、密度、对齐符合基线         | 部分覆盖 |
| S3-M07-003 | P1 / Responsive | 最小支持宽度      | 关键操作可达，无不可恢复遮挡                    | 待实现   |
| S3-M07-004 | P1 / A11y       | 键盘主流程        | Tab/Enter/Space/Esc 与焦点恢复正确              | 待实现   |
| S3-M07-005 | P1 / A11y       | 200% 缩放与对比度 | 核心内容可操作，达到目标对比度                  | 待实现   |

## 14. 执行命令

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run e2e
```

联合接线专项：

```bash
npx vitest run tests/integration/stage3-client-runtime-wiring.test.ts
```

真实模型/Skill 测试只在显式提供临时环境变量时执行：

```bash
LIVE_MODEL_ENDPOINT=... \
LIVE_MODEL_API_KEY=... \
LIVE_MODEL_ID=... \
LIVE_SKILL_DIRECTORY=... \
npx vitest run tests/live/skill-install.live.test.ts
```

## 15. 本轮联合检查结论

本轮接线检查发现并修复两项阶段 2—3 冲突：

1. Client 原先把所有普通发送都设为 `startNewEvent=true`，导致同一会话的普通追问每次创建新 Event，最近问答未进入下一次模型请求。现改为“空闲追问延续 Event、运行中普通发送排入新事项、steer 继承当前事项”。
2. Client 原先每收到一个流式 Event 都执行 `session.list`，长回答会形成大量重复查询。现仅在 Inbox、Turn 和 Interaction 状态边界刷新会话列表，chunk 只更新当前 Projection。

同时补充 Context 短期记忆保底：最近 2 个 Turn 的完整问答跨 Event 保留；当前 Event 摘要、raw tail、相关 Event 摘要和 History Tool 继续按预算工作。

尚未完成且不得记为通过的阶段 3 设计项：受控附件、Runtime 设置页、Skill 预览/更新/扩权确认/卸载、真实 Worker 崩溃 E2E、完整视觉基线和可访问性门禁。这些属于产品能力缺口，不是阶段 2 Runtime 接线冲突。

本轮执行记录（2026-08-25）：

- TypeScript、ESLint、Prettier 与正式四端构建全部通过；
- 默认 Vitest：165 条通过，4 条显式 Live 用例因未注入外部环境变量而按设计跳过；
- Skill 导入专项覆盖目录型 ZIP、根目录型 ZIP、歧义包拒绝，以及路径穿越、符号链接等非法条目拒绝；
- 阶段 2 Runtime + 阶段 3 接线/管理专项：26 条通过；
- Electron 冷启动与真实 Client 连续追问 E2E 各重复 3 次，共 6 次通过；
- E2E 使用临时应用目录和本地临时模型服务，没有修改用户真实模型、Skill、会话或 Credential。
- 真实 Client E2E 已验证 reasoning 与回答分别实时流出，Markdown 加粗生效，工具输入/输出位于“执行内容”，且执行卡全程只有一个。

## 16. 退出条件

- P0 的“已覆盖”用例全部通过；部分覆盖项有明确剩余层级。
- `typecheck`、`lint`、`format:check`、全量 Vitest、build 全部通过。
- Electron 冷启动核心 E2E 连续执行 3 次无偶发失败。
- 记忆硬用例证明第二次 ModelRequest 中实际存在上一轮 user/assistant 完整问答，而不是只检查最终文案。
- Queue/Steer/Promote/Cancel 的 Command 参数、Event 事实、Projection 和 UI 状态一致。
- secret 与跨用户哨兵不出现在非授权边界。
- 所有“待实现”项保留为后续阶段 3 任务，不以 Mock 或静态页面冒充完成。
