# 阶段 2：单 Agent Runtime V1 测试用例

- 文档状态：待评审
- 所属阶段：阶段 2（单 Agent Runtime V1 完整实现）
- 更新日期：2026-08-19
- 对应设计：`docs/阶段方案/阶段2-单AgentRuntime-V1开发架构设计.md`
- 回归基线：`docs/阶段方案/阶段1-Client基础运行平台测试用例.md`

## 1. 测试目的

证明单 Agent Runtime V1 在无产品 UI 的 Headless Harness 中具备最终执行语义、确定持久化、上下文预算、工具调度、用户隔离和崩溃恢复能力，并证明阶段 3 可以直接消费其正式 Contract。

测试不得使用独立简化 Driver、内存队列或专用 Mock Repository 绕过生产 EventStore。Fake LLM、Tool、Clock 和 Credential 只替代外部不确定性，不改变业务路径。

## 2. 测试分级

### 2.1 优先级

| 优先级 | 定义                                                             |
| ------ | ---------------------------------------------------------------- |
| P0     | 核心不变量、数据完整性、跨用户隔离、取消与恢复；失败阻断阶段验收 |
| P1     | 主要错误、边界、并发和兼容路径；失败原则上阻断                   |
| P2     | 诊断、性能基线和低概率组合；需记录并评估                         |

### 2.2 测试类型

| 类型            | 主要对象                                                 |
| --------------- | -------------------------------------------------------- |
| Schema/Contract | Event、Command/Query、Provider、ToolResult、Interaction  |
| Unit            | Inbox、状态机、Projector、Scheduler、Reducer、预算算法   |
| Repository      | V2 migration、lease、EventStore、Projection 加速表       |
| Integration     | Worker、SQLite、Fake Provider、ProcessRunner、Credential |
| Concurrency     | Session/Tool 并行、lease、取消、顺序 commit              |
| Property        | seq、不变量、回放等价、随机状态操作序列                  |
| Crash           | 指定持久化边界强制终止 Worker                            |
| Headless E2E    | 通过正式 Runtime Application Contract 的完整场景         |

## 3. 测试环境与 Fixture

- 每例使用临时应用数据目录、独立 SQLite 和 Fake Credential namespace。
- 内置用户固定为 `user-a`、`user-b`。
- Fake Clock 和 ID Generator 默认确定性；并发用例可使用受控 barrier。
- Scripted LLM 支持文本 chunk、多个 Tool Call、usage、截断、断流、超时和取消。
- Scripted Tool 支持并行 barrier、独占、超时、needs_input、不可重放副作用和大结果。
- 所有 E2E 同时保存事件序列、实时 Projection 和重放 Projection。

固定 Fixture：

| Fixture                            | 场景                           |
| ---------------------------------- | ------------------------------ |
| `text-completed-v1`                | 纯文本一次调用完成             |
| `single-tool-two-step-v1`          | 单工具两 Step                  |
| `parallel-tools-ordered-commit-v1` | 多工具乱序完成、顺序提交       |
| `queue-after-turn-v1`              | 当前 Turn 后处理 Queue         |
| `steer-at-safe-boundary-v1`        | 工具后注入 Steer               |
| `promote-queue-to-next-step-v1`    | 已排队消息立刻介入当前 Turn    |
| `cancel-keep-queue-v1`             | 取消清 next-step、留 next-turn |
| `interaction-form-v1`              | 结构化表单等待与提交           |
| `model-max-output-v1`              | 模型输出截断                   |
| `context-budget-exceeded-v1`       | 完整结果导致预算失败           |
| `worker-interrupted-v1`            | 开放 Turn 修复                 |
| `compaction-version-conflict-v1`   | 摘要版本冲突                   |

## 4. 进入与退出条件

### 4.1 进入条件

- 阶段 1 全量测试通过。
- 阶段 2 Event、Command、Query、ToolResult 和 Provider Schema 已评审。
- V2 migration 可在阶段 1 数据库副本上执行。
- Harness 可从同一 Runtime 组合根替换 Clock/ID/Provider/Tool。

### 4.2 退出条件

- 全部 P0、P1 自动化通过；P2 无未评估失败。
- 关键属性至少运行 1,000 组随机序列或达到约定时间预算。
- 崩溃矩阵全部产生确定恢复结果。
- 实时与回放 Projection 对所有固定 Fixture 完全一致。
- 阶段 1 回归、构建、类型、Lint 和格式门禁通过。

## 5. M01 Contract 与状态机用例

| ID         | 优先级/类型   | 场景               | 关键步骤                  | 预期结果                             |
| ---------- | ------------- | ------------------ | ------------------------- | ------------------------------------ |
| S2-M01-001 | P0 / Contract | 事件 Schema 全目录 | 校验每类合法/非法 payload | 合法通过，未知危险字段和非法枚举拒绝 |
| S2-M01-002 | P0 / Unit     | Turn 合法转换      | 生成所有合法路径          | 状态与结束原因确定                   |
| S2-M01-003 | P0 / Unit     | 非法重复结束       | 对已结束 Turn 再结束      | 拒绝且不追加事件                     |
| S2-M01-004 | P0 / Unit     | Step 单模型请求    | 尝试同 Step 创建第二请求  | 不变量阻止                           |
| S2-M01-005 | P1 / Contract | 未知事件版本       | 回放 schemaVersion=99     | Projection 停止并报告兼容错误        |
| S2-M01-006 | P1 / Contract | Upcaster           | 回放受支持旧 payload      | 只在读取边界转换，不改历史行         |
| S2-M01-007 | P0 / Data     | 原子 batch         | 在 batch 中点注入失败     | 全部回滚、seq 不跳号                 |

## 6. M02 Input Admission 与 Inbox 用例

| ID         | 优先级/类型      | 场景                | 关键步骤                                 | 预期结果                                           |
| ---------- | ---------------- | ------------------- | ---------------------------------------- | -------------------------------------------------- |
| S2-M02-001 | P0 / Integration | 先持久后唤醒        | 在 commit 前观察 Driver                  | Driver 不运行；commit 后才唤醒                     |
| S2-M02-002 | P0 / Integration | Queue 接纳          | 活动 Turn 中 submit queue                | 写 next-turn，不进入当前 Step                      |
| S2-M02-003 | P0 / Integration | Steer 接纳          | 活动 Turn 中 submit steer                | 写 next-step，在安全边界领取                       |
| S2-M02-004 | P1 / Unit        | 空闲 Steer          | 空闲时 submit steer                      | 按规则转换 next-turn并记录语义                     |
| S2-M02-005 | P0 / Data        | 幂等重复            | 相同 key/相同请求两次                    | 返回首次接纳，仅一个 InboxItem                     |
| S2-M02-006 | P0 / Data        | 幂等冲突            | 相同 key/不同消息                        | `IDEMPOTENCY_CONFLICT`，原项不变                   |
| S2-M02-007 | P0 / Property    | splice 回放         | 随机 insert/remove/replace/promote/claim | 回放结果等于参考模型                               |
| S2-M02-008 | P0 / Property    | Inbox 互斥          | 随机操作序列                             | 同一 item 不同时属于两个 target                    |
| S2-M02-009 | P1 / Integration | remove/replace 竞态 | 与 claim 同时执行                        | 只有一个版本成功，无丢失更新                       |
| S2-M02-010 | P0 / Security    | 伪造 userId         | payload 加另一 userId                    | Schema/Main 拒绝，目标用户无事件                   |
| S2-M02-011 | P1 / Contract    | 无有效模型          | 当前用户无默认模型提交                   | `CONFIGURATION_INVALID`，不接纳 Queue              |
| S2-M02-012 | P0 / Integration | 立刻介入            | 对 pending next-turn 调用 promote        | 同一 item 原子移至 next-step，ID 不变              |
| S2-M02-013 | P0 / Integration | 工具期间介入        | 工具未结束时 promote                     | 不取消工具；结果提交后的下一 Step 可见             |
| S2-M02-014 | P0 / Integration | 最终流期间介入      | 文本流结束前 promote                     | stopping check 阻止结束并开启新 Step               |
| S2-M02-015 | P0 / Concurrency | promote/claim 竞态  | Turn 结束领取与 promote 同时发生         | 只允许一个事务成功，item 不丢不重复                |
| S2-M02-016 | P0 / Contract    | expectedTurnId 过期 | UI 所见 Turn 已结束                      | 返回 TURN_CHANGED，item 保持 next-turn             |
| S2-M02-017 | P1 / Data        | 提升事项归属        | 原 Queue 指定新 Event 后 promote         | 清除新事项意图并绑定当前 Event/Exchange            |
| S2-M02-018 | P0 / Property    | 提升投影原子性      | 订阅 promote splice                      | 观察者只看到提升前或提升后，不看到双 target/半移动 |
| S2-M02-019 | P0 / Crash       | 提升提交边界崩溃    | append 前后分别强退 Worker               | item 要么仍在 next-turn，要么完整位于 next-step    |

## 7. M03 Driver、Turn 与 Step 用例

| ID         | 优先级/类型      | 场景              | 关键步骤                 | 预期结果                         |
| ---------- | ---------------- | ----------------- | ------------------------ | -------------------------------- |
| S2-M03-001 | P0 / E2E         | 纯文本            | 一次文本回复完成         | 仅一次模型调用，Turn completed   |
| S2-M03-002 | P0 / E2E         | 单工具            | 模型调用工具后回答       | 两 Step，一个 ToolResult         |
| S2-M03-003 | P0 / E2E         | 多工具            | 一响应含 3 个调用        | 工具收敛后仅一个后续 Step        |
| S2-M03-004 | P0 / Concurrency | 同 Session 双唤醒 | 同时 wake 两次           | 仅一个有效 Driver/开放 Turn      |
| S2-M03-005 | P0 / Concurrency | 不同 Session      | 两模型 barrier           | 两 Session 确实并行              |
| S2-M03-006 | P0 / Data        | lease 丢失        | 执行中替换 owner         | 旧 Driver 后续 append 被拒绝     |
| S2-M03-007 | P1 / Integration | lease 续租        | 长模型调用超过初始 lease | 定时续租，合法完成               |
| S2-M03-008 | P0 / E2E         | max steps         | 模型持续请求工具         | 第 12 Step 后 `max_steps`        |
| S2-M03-009 | P1 / E2E         | 模型空响应        | Provider 完成但无内容    | 明确错误/完成规则，不留开放 Turn |
| S2-M03-010 | P0 / Property    | 单开放 Turn       | 随机 Queue/Steer/Cancel  | 任意时刻最多一个开放 Turn        |

## 8. M04 Provider 与配置快照用例

| ID         | 优先级/类型      | 场景                  | 关键步骤                     | 预期结果                                 |
| ---------- | ---------------- | --------------------- | ---------------------------- | ---------------------------------------- |
| S2-M04-001 | P0 / Contract    | 文本多字节流          | 拆分 Unicode chunk           | 完整组装且顺序正确                       |
| S2-M04-002 | P0 / Contract    | Tool Call 增量        | 参数跨多个 chunk             | 合法完整 args，畸形时稳定错误            |
| S2-M04-003 | P0 / Contract    | 多 Tool Call          | 交错增量                     | callIndex 与 Provider 顺序稳定           |
| S2-M04-004 | P0 / Contract    | usage 字段            | cache/reasoning 有无组合     | 精确保存，不重复求和                     |
| S2-M04-005 | P0 / E2E         | max output            | finish reason 截断           | Turn=`max_output_tokens`，不显示正常完成 |
| S2-M04-006 | P0 / Integration | 流中取消              | 发 chunk 后 cancel           | 网络中止、事件闭合、无迟到写入           |
| S2-M04-007 | P1 / Contract    | auth/rate/5xx/timeout | Fake Server 返回各错误       | 映射稳定错误且响应脱敏                   |
| S2-M04-008 | P0 / Integration | Step 快照不可变       | 模型流中修改 revision        | 当前 Step 原快照，下一 Step 新快照       |
| S2-M04-009 | P0 / Security    | Credential 隔离       | A/B 同 serviceId 不同 secret | 每个请求只用所属用户 secret              |
| S2-M04-010 | P1 / Data        | prompt epoch          | 相同/不同配置计算            | 稳定输入相同，影响 Prompt 的变化必改变   |

## 9. M05 Context Projector 用例

| ID         | 优先级/类型   | 场景               | 关键步骤                       | 预期结果                                |
| ---------- | ------------- | ------------------ | ------------------------------ | --------------------------------------- |
| S2-M05-001 | P0 / Unit     | Surface 顺序       | 构造多 Step/工具事件           | role、call/result 配对和顺序正确        |
| S2-M05-002 | P0 / Unit     | 当前 Turn 完整     | ToolResult 接近预算            | 不裁剪、不改写、不拆对                  |
| S2-M05-003 | P0 / Unit     | 候选降级           | 总预算超限                     | 先删除最低分相关 Event                  |
| S2-M05-004 | P0 / E2E      | 无法容纳结果       | 单结果超过硬预算               | `context_budget_exceeded`，不发畸形请求 |
| S2-M05-005 | P0 / Property | Summary/raw 不重叠 | 随机覆盖位置                   | 无重复、无缺失、至少保留 recent floor   |
| S2-M05-006 | P1 / Unit     | 稳定前缀           | 相同 epoch 多请求              | System + Tool Schema 字节一致           |
| S2-M05-007 | P0 / Security | 相关历史隔离       | A/B 相似内容                   | A Context 不包含 B 候选                 |
| S2-M05-008 | P1 / Unit     | Event 解析优先级   | 组合 eventId/awaiting/startNew | 严格按设计顺序决定                      |
| S2-M05-009 | P1 / Unit     | 当前消息去重       | Event raw 与 Turn 同含消息     | 模型输入只出现一次                      |
| S2-M05-010 | P1 / Contract | Context Breakdown  | 固定 token fixture             | 分项合计、预留和预算可解释              |

## 10. M06 Skill、Tool 与 Interaction 用例

| ID         | 优先级/类型      | 场景                    | 关键步骤                 | 预期结果                               |
| ---------- | ---------------- | ----------------------- | ------------------------ | -------------------------------------- |
| S2-M06-001 | P0 / Integration | 统一能力概览             | 调用 `capability_search` | 同时返回全部可用 Skill/MCP 名称和完整 description，标记同级且无正文/完整 Schema，不受查询词或数量限制 |
| S2-M06-002 | P0 / Integration | 按需加载                | 选择 Skill 后读 SKILL.md | 正文按需进入当前用户上下文             |
| S2-M06-003 | P0 / Security    | Skill 越界资源          | 引用 `../`/外部链接      | 拒绝且不读取外部内容                   |
| S2-M06-004 | P0 / Security    | Skill 用户隔离          | A 启用、B 未安装         | B Catalog/loader 不可见                |
| S2-M06-005 | P0 / Contract    | Tool input/output       | 非法 args/result         | 执行前/后确定拒绝并规范化错误          |
| S2-M06-006 | P0 / Concurrency | parallel-safe 重叠      | A/B barrier              | 同时运行                               |
| S2-M06-007 | P0 / Concurrency | exclusive 屏障          | A并行、B独占、C并行      | A 完成后 B，B 完成后 C                 |
| S2-M06-008 | P0 / Concurrency | 乱序完成                | C/A/B 完成               | Result 按 A/B/C commit                 |
| S2-M06-009 | P0 / E2E         | 统一结果状态            | 五种 ToolResult          | Event/Surface/Trajectory 状态一致      |
| S2-M06-010 | P0 / Integration | timeout/cancel          | 长工具超时或取消         | Abort 贯穿、确定收敛                   |
| S2-M06-011 | P0 / E2E         | needs_input             | 工具请求 form            | Interaction 持久且 Event awaiting_user |
| S2-M06-012 | P0 / Contract    | resolution Schema       | 提交非法/合法 value      | 非法拒绝，合法持久并继续               |
| S2-M06-013 | P0 / Security    | 普通消息伪造 resolution | 输入同名字段             | 不能解除 Interaction                   |
| S2-M06-014 | P1 / Integration | 宿主解释器缺失          | 执行 Skill Python 脚本   | 明确 Tool error，不自动安装            |
| S2-M06-015 | P0 / Property    | Call/Result 一一对应    | 随机工具批次             | 已闭合 Step 每 Call 恰一 Result        |

## 11. M07 History 与 Compaction 用例

| ID         | 优先级/类型      | 场景         | 关键步骤                   | 预期结果                           |
| ---------- | ---------------- | ------------ | -------------------------- | ---------------------------------- |
| S2-M07-001 | P0 / Contract    | event_search | 多 Event 检索              | 候选有界、排序确定、不含当前 Event |
| S2-M07-002 | P0 / Contract    | event_read   | 指定 Exchange 范围         | 只返回用户可见问答                 |
| S2-M07-003 | P0 / Contract    | turn_read    | 读取含大 ToolResult Turn   | 完整返回原结果                     |
| S2-M07-004 | P0 / Security    | 跨用户 ID    | B 读 A event/turn          | NOT_FOUND 且无存在性泄漏           |
| S2-M07-005 | P1 / Unit        | 未达阈值     | Exchange 完成              | 不调用摘要模型                     |
| S2-M07-006 | P0 / E2E         | 压缩成功     | 超过 75% 阈值              | Summary 提交、覆盖位置正确         |
| S2-M07-007 | P0 / Concurrency | version 冲突 | 摘要期间新增 Exchange      | 候选 discarded，不覆盖新事实       |
| S2-M07-008 | P1 / E2E         | 摘要失败     | Provider 错误/非法 Schema  | 原 Summary/raw 保持不变            |
| S2-M07-009 | P0 / Integration | 同步兜底     | 请求前仍超预算             | 同步压缩或明确预算失败             |
| S2-M07-010 | P0 / Security    | 摘要敏感范围 | 事件含隐藏 Prompt/工具轨迹 | 摘要输入只含用户可见问答           |

## 12. M08 Projection 与订阅用例

| ID         | 优先级/类型      | 场景                 | 关键步骤                | 预期结果                           |
| ---------- | ---------------- | -------------------- | ----------------------- | ---------------------------------- |
| S2-M08-001 | P0 / Property    | 实时/回放等价        | 所有固定 Fixture        | 四类 Projection 完全一致           |
| S2-M08-002 | P0 / Integration | chunk/final          | 流式后 final            | 临时组装最终被权威 message 确认    |
| S2-M08-003 | P0 / Contract    | Snapshot cursor      | snapshot 后追加事件     | 增量从 throughSeq+1 开始           |
| S2-M08-004 | P0 / Contract    | 重复 seq             | 重放同增量              | 幂等忽略                           |
| S2-M08-005 | P0 / Contract    | cursor 断档          | 跳过一个 seq            | 标记失效并要求重取 Snapshot        |
| S2-M08-006 | P0 / Security    | 用户/Session 不匹配  | 注入错误增量            | Reducer 拒绝并重同步               |
| S2-M08-007 | P1 / Integration | checkpoint 重建      | 删除加速表后重建        | Query 结果一致                     |
| S2-M08-008 | P1 / Integration | interrupted 展示事实 | 回放崩溃 Fixture        | 已有可见内容保留且状态明确         |
| S2-M08-009 | P0 / Data        | Usage 精确性         | 多 Step/cache/reasoning | step/turn/session/event 聚合不重计 |

## 13. M09 Cancel 与恢复用例

| ID         | 优先级/类型      | 场景                     | 关键步骤                 | 预期结果                            |
| ---------- | ---------------- | ------------------------ | ------------------------ | ----------------------------------- |
| S2-M09-001 | P0 / E2E         | Cancel 模型流            | 流中停止                 | Abort、Turn cancelled、队列规则正确 |
| S2-M09-002 | P0 / E2E         | Cancel 工具批次          | 部分工具运行时停止       | 未启动 cancelled，已启动确定收敛    |
| S2-M09-003 | P0 / E2E         | cancel-and-queue         | 停止当前任务并排入新消息 | 取消与队首接纳无竞态                |
| S2-M09-004 | P0 / Crash       | 接纳 commit 前/后        | 两点终止 Worker          | 前者无输入，后者恢复且不重复        |
| S2-M09-005 | P0 / Crash       | claim 后 user.message 前 | 强退                     | 输入不静默丢失，产生确定修复        |
| S2-M09-006 | P0 / Crash       | 模型 chunk 中            | 强退                     | 开放 Turn/Exchange interrupted      |
| S2-M09-007 | P0 / Crash       | Tool Call 后执行前       | 非 replay-safe           | unknown_side_effect，不自动运行     |
| S2-M09-008 | P0 / Crash       | Tool 完成 Result 前      | 非 replay-safe           | unknown_side_effect，不重复副作用   |
| S2-M09-009 | P1 / Crash       | replay-safe + 幂等       | Result 前终止            | 按策略安全重试且仅一个语义结果      |
| S2-M09-010 | P0 / Crash       | 多工具部分完成           | 强退                     | 每个调用均有确定恢复结果            |
| S2-M09-011 | P1 / Crash       | Interaction 等待         | 强退并重启               | pending 状态可恢复/确定续接         |
| S2-M09-012 | P0 / Crash       | 摘要 commit 前           | 强退                     | 原摘要有效，无半提交                |
| S2-M09-013 | P0 / Integration | 新 generation            | 旧 Worker 迟到 append    | lease/version 拒绝                  |

## 14. 双用户负向测试矩阵

对 Session、InboxItem、ConversationEvent、Exchange、Turn、Interaction、ModelSnapshot、SkillSnapshot、History Tool 和订阅执行：A 创建 → B 使用相同 ID Query → B 尝试 Command → B 尝试建立关联/读取历史 → B 订阅 A Session。所有路径均不得返回 A 数据；Repository 直接路径与 Bridge 路径结果一致。

额外验证：

- A 运行中切换活动用户到 B，不取消 A Turn，但 A 增量不能进入 B 订阅。
- A/B 同名 Skill 和 Model 分别解析各自 revision 与 Credential。
- 配置缓存键必须包含 userId；A 失效不影响 B prompt epoch。
- SQLite 复合外键拒绝跨用户 Event/Exchange/Relation。

## 15. 性能与资源基线

| ID         | 场景           | 数据量                   | 通过标准                                   |
| ---------- | -------------- | ------------------------ | ------------------------------------------ |
| S2-NFR-001 | Event 回放     | 单 Session 10,000 events | 不丢事件；耗时与内存记录基线，无非线性异常 |
| S2-NFR-002 | 多 Session     | 20 Session、并行上限 4   | 同 Session 串行、全局有界、无饥饿          |
| S2-NFR-003 | 大 Tool Result | 接近允许上限             | 单份完整存储，预算不足明确失败             |
| S2-NFR-004 | 长 Event       | 100 Exchanges            | 压缩后上下文有界，原事件可读               |
| S2-NFR-005 | 取消延迟       | 模型/进程/网络 Fixture   | 在约定 timeout 内进入终态                  |
| S2-NFR-006 | Worker 重启    | 20 开放/排队 Session     | 全部修复完成后才 ready，无跨用户污染       |

阶段 2 只建立可重复基线，正式发布水位由阶段 5 根据目标设备和发布范围确认。

## 16. Headless E2E 清单

1. 纯文本单次调用完成。
2. 单工具两 Step 完成。
3. 三工具并行/独占混排并按序提交。
4. Queue 在当前 Turn 后执行。
5. Steer 在工具后进入下一 Step。
6. 已排队消息通过“立刻介入”进入当前 Turn 的下一 Step，且不取消当前模型/工具。
7. Cancel 保留 next-turn、清理 next-step。
8. cancel-and-queue 在明确停止当前任务后将新输入置于队首。
9. Interaction 表单提交、拒绝和取消。
10. 模型截断、断流、超时和配置失效。
11. 大结果分页与不可容纳时预算失败。
12. Event continuation、相关历史和显式深读。
13. 长 Event 压缩、摘要失败和 version race。
14. Worker 崩溃、开放 Turn 修复和不确定副作用。
15. 双用户后台 Session 并行与活动用户切换。

## 17. 阶段测试报告要求

- 环境、commit、migration version、Node/Electron/SQLite 版本。
- P0/P1/P2 通过、失败、跳过统计及失败证据。
- 固定 Fixture 的事件序列摘要和实时/回放 Projection 对比。
- 属性测试 seed、运行次数和最小失败样本。
- 崩溃注入点、修复事件和副作用判定。
- 并发、回放、取消和恢复性能基线。
- 双用户负向矩阵和 secret 哨兵扫描结果。
- 阶段 1 回归、构建、类型、Lint、格式结果。
