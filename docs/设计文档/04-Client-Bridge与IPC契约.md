# Client Bridge 与 IPC 契约

## 1. 目标

- Renderer 只访问固定、强类型 Client API。
- Preload 不暴露原始 `ipcRenderer`、文件系统、进程或任意 channel。
- Main 注入可信活动 `userId`，Renderer 不能给普通业务请求指定用户作用域。
- Main 与 Runtime Worker 复用同一份 Schema，对输入和输出双向校验。
- 刷新、Worker 重启和窗口重建不改变契约。

## 2. 对 Renderer 暴露的唯一入口

```ts
interface AgentClientApi {
  command<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
  ): Promise<ApiResult<CommandOutput<TName>>>;

  query<TName extends QueryName>(
    name: TName,
    input: QueryInput<TName>,
  ): Promise<ApiResult<QueryOutput<TName>>>;

  subscribe(input: SubscribeInput, listener: (event: ClientProjectionEvent) => void): Unsubscribe;

  selectLocalFile(
    purpose: 'attachment' | 'skill-package',
  ): Promise<ApiResult<SelectedFileToken | null>>;
}
```

`SelectedFileToken` 是 Main 内存中有过期时间和用途限制的一次性引用，不包含可供 Renderer 重放的任意绝对路径。

## 3. 请求与响应 Envelope

```ts
interface CommandEnvelope<T> {
  requestId: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  payload: T;
}

type ApiResult<T> =
  { ok: true; requestId: string; value: T } | { ok: false; requestId: string; error: ApiError };

interface ApiError {
  code: StableErrorCode;
  message: string;
  details?: JsonValue;
  retryable: boolean;
}
```

Main 转发给 Worker 时追加内部字段：

```ts
interface TrustedRequestContext {
  userId: LocalUserId;
  windowId: string;
  senderOrigin: string;
  requestId: string;
}
```

内部 Context 不与 Renderer payload 合并，防止用户字段覆盖可信字段。

## 4. Command 目录

### 4.1 应用与用户

| Command               | 输入要点                  | 持久结果                                        |
| --------------------- | ------------------------- | ----------------------------------------------- |
| `user.switch`         | 目标内置 userId           | Main 更新活动用户；返回新用户应用 Snapshot 起点 |
| `user.profile.update` | displayName、avatar token | 更新当前用户资料 revision                       |

`user.switch` 是唯一允许 Renderer 提供目标 userId 的业务命令；Main 必须校验它属于初始化时注册的两个用户。

### 4.2 Session 与输入

| Command                 | 输入要点                                              | 持久结果                                        |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `session.create`        | title?                                                | `session.created`                               |
| `session.rename`        | sessionId、title、expectedVersion                     | Session metadata 更新                           |
| `session.archive`       | sessionId                                             | Session status 更新                             |
| `session.delete`        | sessionId、confirmation                               | Session tombstone                               |
| `input.submit`          | sessionId、message、mode、eventId?、startNewEvent?    | `agent.inbox.spliced`                           |
| `inbox.remove`          | sessionId、inboxItemId                                | removal splice                                  |
| `inbox.replace`         | sessionId、inboxItemId、message                       | replacement splice                              |
| `inbox.promote`         | sessionId、inboxItemId、expectedTurnId                | 同一 Queue Item 从 next-turn 原子移至 next-step |
| `turn.cancel`           | sessionId、turnId、keepNextTurn、keepNextStep、reason | cancel requested/终止事实                       |
| `turn.cancel-and-queue` | sessionId、turnId、新 message                         | 明确停止当前任务后再接纳 next-turn 的组合事务   |
| `interaction.resolve`   | sessionId、interactionId、resolution、value?          | `interaction.resolved`                          |

`input.submit` 必须带 idempotencyKey。Command 成功表示输入已持久接纳，不表示 Turn 已完成。

`inbox.promote` 是参考 UI“立刻介入”的正式语义：不取消模型或工具，只在最近安全 Step 边界把已排队消息注入当前 Turn。`expectedTurnId` 防止 UI 基于过期视图把消息介入另一个 Turn；不匹配时原 Queue Item 保持不变。

### 4.3 模型管理

| Command                 | 输入要点                                                                                  | 结果                              |
| ----------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| `model-service.save`    | serviceId?、name、providerType、endpoint、providerEndpoint?、enabled、credentialMutation? | 新 model revision 与服务 Snapshot |
| `model-service.test`    | service draft、一次性 credential input/ref                                                | 结构化测试结果，不必保存配置      |
| `model-service.archive` | serviceId、expectedRevision                                                               | 归档或引用冲突                    |
| `model.discover`        | serviceId、draft override?                                                                | 远端模型差异预览，不直接写库      |
| `model.discovery.apply` | serviceId、discoveryToken、选择项                                                         | 写入模型并递增 revision           |
| `model.save`            | modelId?、serviceId、remoteModelId、能力与参数                                            | 新 model revision                 |
| `model.archive`         | modelId                                                                                   | 归档或引用冲突                    |
| `model.default.set`     | modelId                                                                                   | 用户默认模型与 revision           |

`credentialMutation` 只能表达 `unchanged`、`replace(value)` 或 `clear`。Query 永远不返回保存的 value。

### 4.4 Skill 管理

| Command                 | 输入要点                                             | 结果                                                     |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `skill.install.inspect` | SelectedFileToken                                    | installToken、Manifest、权限、文件清单、冲突和兼容性预览 |
| `skill.install.commit`  | installToken、确认的权限                             | installationId、初始状态、新 skill revision              |
| `skill.settings.save`   | installationId、普通配置、secret mutations、权限授予 | 新状态与 revision                                        |
| `skill.enable`          | installationId、expectedRevision                     | enabled 或明确阻断原因                                   |
| `skill.disable`         | installationId、expectedRevision                     | disabled 与 Registry revision                            |
| `skill.upgrade.inspect` | installationId、SelectedFileToken                    | 版本和权限差异预览                                       |
| `skill.upgrade.commit`  | upgradeToken、确认                                   | 新 package 绑定和 revision                               |
| `skill.export`          | installationId、目标目录 token                       | 受控导出结果                                             |
| `skill.uninstall`       | installationId、confirmation                         | uninstalling/removed 与 revision                         |

inspect token 绑定 `userId + windowId + file digest + purpose`，短时有效且只能 commit 一次。commit 必须重新验证暂存内容没有变化。

### 4.5 Runtime 与附件配置

| Command                 | 输入要点                      | 结果                  |
| ----------------------- | ----------------------------- | --------------------- |
| `runtime-settings.save` | 并行度、预算、maxSteps 等     | runtime revision      |
| `attachment.import`     | sessionId?、SelectedFileToken | attachmentId 与元数据 |
| `attachment.delete`     | attachmentId                  | tombstone             |

## 5. Query 目录

| Query                       | 输入                         | 输出                                                            |
| --------------------------- | ---------------------------- | --------------------------------------------------------------- |
| `app.bootstrap`             | 无                           | 当前用户、两个用户目录、应用状态和各 Snapshot revision          |
| `session.list`              | cursor?、search?、status?    | 当前用户 Session 页                                             |
| `session.snapshot`          | sessionId                    | Chat/Trajectory/Inbox/Usage + throughSeq                        |
| `session.events.page`       | sessionId、afterSeq、limit   | 诊断用脱敏事件页                                                |
| `conversation-event.list`   | sessionId、cursor?           | Event 摘要与状态                                                |
| `conversation-event.read`   | sessionId、eventId、range?   | 用户可见原始问答                                                |
| `execution-turn.list`       | sessionId、cursor?           | Turn 索引                                                       |
| `execution-turn.read`       | sessionId、turnId            | 完整内部执行证据                                                |
| `model-management.snapshot` | 无                           | 当前用户服务、模型、默认模型、credential status、model revision |
| `skill-management.snapshot` | search?、enabledOnly?        | 当前用户安装列表和 skill revision                               |
| `skill.detail`              | installationId               | Manifest、受控文件树、工具、权限、配置 Schema、授权状态         |
| `skill.file.preview`        | installationId、relativePath | 受控文本/元数据预览                                             |
| `runtime-settings.snapshot` | 无                           | 当前用户普通 Runtime 设置与 revision                            |
| `diagnostics.summary`       | 时间范围                     | 当前用户脱敏诊断摘要                                            |

所有 ID Query 都在 Main 注入的当前 userId 下解析。跨用户 ID 对 Renderer 默认返回 `NOT_FOUND`，详细越权事实只进入安全日志。

## 6. Subscription

```ts
type SubscribeInput =
  | { kind: 'session'; sessionId: string; afterSeq: number }
  | { kind: 'configuration'; revisions: ConfigurationRevisions }
  | { kind: 'application'; afterCursor: number };
```

事件类型：

```ts
type ClientProjectionEvent =
  | SessionProjectionEvent
  | ConfigurationChangedEvent
  | SkillInstallProgressEvent
  | RuntimeLifecycleEvent;
```

规则：

- Session 增量携带 `userId + sessionId + seq`。
- Configuration 增量携带 `userId + domain + revision`。
- Worker generation 改变时发布 `runtime.restarted`，Renderer 对活动 Snapshot 执行重同步。
- unsubscribe 必须真正释放 Main 与 Worker 的转发订阅。
- 用户切换时 Main 主动关闭旧用户全部窗口订阅，不能依赖 React 组件稍后清理。

## 7. Schema 与兼容

- CommandName、QueryName 使用封闭 union，不接受任意字符串 channel。
- 每个输入和输出有独立 JSON Schema，并从同一源生成/校验 TypeScript 类型或通过 Contract Test 保持一致。
- Schema 默认拒绝未知危险字段；纯显示查询可按兼容策略容忍未知输出字段。
- `apiVersion` 第一版为 1；破坏性变更需要并行兼容窗口或明确升级门槛。
- Provider 原始错误不能直接透传给 Renderer，应映射稳定错误码并脱敏 details。

## 8. IPC 安全校验

Main 每次请求执行：

1. 校验 sender WebContents 与允许 origin。
2. 校验窗口仍绑定当前应用实例。
3. 校验 name 在白名单 union。
4. 校验 payload Schema 和大小上限。
5. 读取 Main 当前活动 userId 并构造 TrustedRequestContext。
6. 对文件 token 校验用途、窗口、用户、过期时间和单次消费状态。
7. 转发 Worker 并校验 Worker 响应 Schema。
8. 对日志和错误做敏感信息清理。

Preload 不提供：

- `ipcRenderer.send/on/invoke` 原始引用。
- 任意 channel 订阅。
- 任意文件路径读写。
- shell、child_process、环境变量或 Credential Store 访问。
- 可执行字符串或动态模块加载接口。

## 9. 幂等与并发

- 输入接纳、Skill commit 和可能重复提交的配置保存带 idempotencyKey。
- 配置写入带 expectedRevision；冲突返回最新 revision 和可重新加载提示，不做 last-write-wins。
- `requestId` 用于链路追踪，不代替业务幂等键。
- 用户双击保存时，相同 idempotencyKey 返回第一次结果。
- 连接测试和模型发现是只读外部调用，可以取消但不写配置；apply 使用独立 token 防止过期发现结果覆盖新配置。

## 10. Bridge Contract 验收

- Renderer 无法构造任意 IPC channel、userId、绝对路径或 Credential ref。
- 两个窗口/用户切换竞态不会把旧用户响应交给新用户页面。
- 所有 Command/Query 错误都符合 ApiError Schema。
- Snapshot + 增量能在刷新和 Worker 重启后恢复。
- 文件 token 过期、跨窗口、跨用户、重复消费和用途错误全部被拒绝。
- 密钥保存后 Query 和诊断输出不包含明文。
