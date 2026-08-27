# 配置快照与 Runtime 集成设计

## 1. 问题定义

模型与 Skill 是可编辑用户配置，Runtime 的 Step 是确定执行边界。如果直接在模型流或工具执行中读取“最新配置”，一次 Step 可能前后使用不同模型、密钥、Tool Schema 或权限。本设计通过用户级 revision、不可变 Snapshot 和安全边界刷新解决该问题。

## 2. 配置域

```ts
interface ConfigurationRevisions {
  modelRevision: number;
  skillRevision: number;
  runtimeRevision: number;
}
```

- modelRevision：ModelService、Model、默认模型和模型非敏感参数。
- skillRevision：SkillInstallation、配置、授权、secret binding 状态和 Registry 可见性。
- runtimeRevision：maxSteps、上下文预算、工具并行度、超时等用户级 Runtime 参数。

Credential 明文不计入数据库 revision，但 credentialRef 或 secret binding 的替换必须与对应配置 revision 同步提交。

## 3. 两类事实来源

| 类型             | 事实来源                   | 变化方式                    | Runtime 记录                                 |
| ---------------- | -------------------------- | --------------------------- | -------------------------------------------- |
| Session 运行事实 | Session Event Log          | 仅追加                      | 完整 Event                                   |
| 用户配置事实     | Model/Skill/Runtime 配置表 | 带 expectedRevision 的 CRUD | Step 记录 Snapshot ID、revision 和非敏感摘要 |

配置不使用 Session Event Sourcing，因为它跨 Session、需要直接编辑且具有独立生命周期。运行历史不依赖当前配置表解释：每次请求/工具事实保留当时必要的显示元数据和 Snapshot 摘要。

## 4. 配置保存事务

通用伪流程：

```ts
async function mutateConfiguration(scope, domain, expectedRevision, mutation) {
  // 1. 打开短事务并读取 user_config_revisions
  // 2. expectedRevision 不匹配则返回 CONFLICT
  // 3. 校验所有被引用实体属于 scope.userId
  // 4. 写配置表
  // 5. 对应 revision + 1
  // 6. commit
  // 7. 发布 configuration.changed
  // 8. 使对应 userId + domain 缓存失效
}
```

如果配置保存涉及 Credential Store：

1. 在事务外写入新的临时/版本化 secret。
2. 事务内切换 credentialRef 并递增 revision。
3. commit 后清理旧 secret。
4. commit 失败时补偿删除新 secret。
5. 清理失败写诊断和可重试任务，不暴露 secret。

## 5. Step 快照解析

每个 Step 开始时执行：

```text
读取 Session 当前用户
→ 在一致数据库读视图中读取三类 revision
→ 解析默认/Session 指定 Model 和 ModelService
→ 解析已启用 Skill、配置、授权和 Tool 定义
→ 解析 Runtime Settings
→ 生成不可变 ExecutionConfigSnapshot
→ 写 step.started + request.context 的快照摘要
→ 构造模型请求并执行
```

```ts
interface ExecutionConfigSnapshot {
  id: string;
  userId: LocalUserId;
  revisions: ConfigurationRevisions;
  model: ModelConfigSnapshot;
  skills: SkillRegistrySnapshot;
  runtime: RuntimeSettingsSnapshot;
  promptEpoch: string;
  createdAt: Timestamp;
}
```

Snapshot 仅在内存中保存执行所需敏感解析结果。事件只保存 Snapshot ID、revision、模型/工具稳定标识和非敏感参数摘要。

## 6. 生效边界

| 配置变更发生时机  | 当前 Step      | 下一 Step                          | 下一个 Turn     |
| ----------------- | -------------- | ---------------------------------- | --------------- |
| 模型流进行中      | 不变           | 使用新 revision                    | 使用新 revision |
| Tool Call 进行中  | 不变           | 使用新 revision                    | 使用新 revision |
| stopping check 前 | 当前 Step 不变 | 若因 Steer 继续，则使用新 revision | 使用新 revision |
| Session idle      | 不适用         | 不适用                             | 使用新 revision |

例外：安全紧急撤权可以请求 Cancel 当前 Turn，但不能悄悄替换当前 Tool 的权限对象。撤权 Command 的结果需要明确告诉用户“新调用已禁用，当前调用取消已请求/无法撤回”。

## 7. Registry 缓存

缓存键：

```text
ModelRegistry: userId + modelRevision
SkillRegistry: userId + skillRevision + runtime/platform version
RuntimeSettings: userId + runtimeRevision
```

规则：

- 缓存值不可变。
- `configuration.changed` 只失效对应用户和域。
- 旧 Snapshot 被活动 Step 引用时继续存活；引用归零后释放。
- Worker 重启后缓存为空，全部从配置事实表重建。
- 缓存 miss 和 rebuild 不能跨用户合并 Query。

## 8. promptEpoch

promptEpoch 用于标识影响稳定 Prompt 前缀与模型缓存的配置集合。摘要输入至少包含：

- System Prompt 模板版本。
- Model Provider/Model 能力和关键参数版本。
- Skill Registry 中排序后的 Tool name、description 与 Schema digest。
- Runtime Context 策略版本。
- 用户级显式 Agent 指令版本（若 V1 提供）。

不包含：

- API Key/secret 明文。
- 当前时间、requestId、Session ID 等不影响前缀语义的随机值。
- 当前用户消息和动态上下文。

相同语义配置必须生成稳定 promptEpoch；模型或工具 Schema 变化必须生成新 epoch。

## 9. 失败语义

### 9.1 无有效模型

- Input Admission 返回 `CONFIGURATION_INVALID`，不接纳新 Queue。
- 已在 Queue 中、执行前才发现失效的请求保留 Inbox 项并将 Session 标记需要配置，不能跨用户回退。
- UI 提供跳转当前用户模型设置的明确入口。

### 9.2 Skill Registry 构建失败

- 单个 disabled/failed Skill 不进入 Registry。
- 当前声称 enabled 但包损坏、配置无效或 Tool 冲突时，整个相关 Skill fail closed 并记录诊断。
- 内置必需工具失败是否阻止 Runtime ready 由工具级 Contract 决定。

### 9.3 revision 冲突

- Command 返回 `CONFLICT`、currentRevision 和建议重新加载。
- UI 保留用户未提交草稿并显示差异，不自动覆盖。
- 不使用 last-write-wins。

## 10. 用户切换

用户切换只改变当前窗口/应用的活动 User Context：

1. Main 关闭旧用户 UI 订阅。
2. Renderer 清空旧用户管理 Snapshot、Runtime View State 和敏感草稿。
3. Main 更新 activeUserId。
4. Query 新用户 Configuration Snapshot 与 Session 列表。
5. 建立新用户 subscription。

旧用户的后台 Driver 和 Snapshot 继续有效，直到各自 Step/Turn 结束；它们写回旧 userId 的 Session Event，不向当前页面推流。

## 11. 与 Context Projector 的关系

Context Projector 接收已经解析的 ExecutionConfigSnapshot，不自行查询“最新”模型或 Skill 配置。它使用：

- model capabilities/contextWindow/maxOutputTokens 计算预算。
- promptEpoch 和稳定排序 Tool Schema 构造前缀。
- 当前 SkillRegistrySnapshot 的 Tool Definition。
- 当前 RuntimeSettingsSnapshot 的预算与 maxSteps。

如果完整当前 Turn Tool Result 超过快照预算，Turn 以 `context_budget_exceeded` 结束；不能通过切换到更大模型或修改工具集悄悄重试。

## 12. 验收场景

- 模型请求过程中切换默认模型：当前请求不变，下一 Step 使用新模型。
- 工具执行过程中停用 Skill：当前调用按原快照结束/取消，下一 Step 不再包含工具。
- 用户 A 改模型：用户 B 的 Registry cache key 和 promptEpoch 不变化。
- Worker 重启：相同配置 revision 生成语义一致的 Snapshot。
- revision 冲突：旧页面保存失败且不会覆盖新配置。
- Credential 替换失败：旧 Step 和旧配置保持可用，不出现空 ref。
- 无有效默认模型：不创建注定无法执行的新 Inbox Item。
