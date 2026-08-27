# Session 事件与 Projection 契约

## 1. 边界

Session Event Log 记录 Agent 运行事实，包括输入接纳、Turn/Step、模型、工具、Interaction 和压缩。模型与 Skill 的 CRUD 配置不属于 Session，不写入 `session_events`；它们使用用户配置 revision 和 `configuration.changed` Client 增量。

## 2. 事件 Envelope

逻辑事件：

```ts
interface SessionLogEvent<TType extends SessionEventType, TPayload> {
  id: EventId;
  sessionId: SessionId;
  seq: number;
  type: TType;
  schemaVersion: 1;
  time: Timestamp;
  requestId?: RequestId;
  payload: TPayload;
}
```

物理 EventStore 行额外保存 `user_id`。`userId` 不重复写入 payload，但所有 append/read/subscribe/replay API 必须显式携带可信 User Context。

规则：

- `seq` 在 `(userId, sessionId)` 内从 1 连续递增。
- `id` 在同一用户内唯一。
- `time` 由 Runtime Clock 生成，不能信任 Renderer 时间。
- `schemaVersion` 表示单个事件 payload 版本，不等于数据库 migration 版本。
- 未识别事件版本时停止对应 Projection 并报告兼容性错误，不能忽略后继续推进 checkpoint。

## 3. V1 事件目录

### 3.1 Session 与 Inbox

```ts
type SessionCreatedPayload = {
  title: string;
  createdBy: 'user' | 'system';
};

type InboxSpliceReason =
  'queue' | 'steer' | 'inject' | 'promote' | 'claim' | 'remove' | 'cancel_cleanup' | 'replace';

type InboxSpliceOperation = {
  target: 'next-turn' | 'next-step';
  insertAt: number;
  deleteCount: number;
  inserted: InboxItem[];
  removedIds: InboxItemId[];
};

type AgentInboxSplicedPayload = {
  reason: InboxSpliceReason;
  operations: InboxSpliceOperation[];
  claimedByTurnId?: ExecutionTurnId;
  promotedToTurnId?: ExecutionTurnId;
};
```

不变量：

- 接纳输入的 Command 必须先提交 `agent.inbox.spliced` 才返回成功。
- claim 使用同一 splice 语义移除待处理项，并记录 `claimedByTurnId`。
- `operations` 按数组顺序在一个事件中原子应用；Projection 不得发布 operation 中间状态。
- “立刻介入”使用 `reason='promote'`：第一项 operation 从 `next-turn` 删除，第二项将同一 InboxItem ID 插入 `next-step`，并记录 `promotedToTurnId`。
- 每项 `insertAt`、`deleteCount` 和 removedIds 必须与前一 operation 执行后的 Inbox 状态一致，否则 Projection 报损坏。

### 3.2 ConversationEvent 与 Exchange

```ts
type ConversationEventCreatedPayload = {
  conversationEventId: ConversationEventId;
  title?: string;
};

type ConversationEventStatusChangedPayload = {
  conversationEventId: ConversationEventId;
  from: 'open' | 'awaiting_user' | 'completed' | 'failed';
  to: 'open' | 'awaiting_user' | 'completed' | 'failed';
  reason?: string;
};

type ConversationEventSummaryUpdatedPayload = {
  conversationEventId: ConversationEventId;
  summary: string;
  summaryThroughExchangeSeq: number;
  summaryTokens: number;
  summaryVersion: number;
  sourceThroughSessionSeq: number;
};

type ConversationEventRelatedPayload = {
  sourceEventId: ConversationEventId;
  targetEventId: ConversationEventId;
  relation: 'explicit' | 'continuation';
};

type ConversationExchangeStartedPayload = {
  conversationEventId: ConversationEventId;
  exchangeId: ConversationExchangeId;
  exchangeSeq: number;
  executionTurnId: ExecutionTurnId;
};

type ConversationExchangeCompletedPayload = {
  conversationEventId: ConversationEventId;
  exchangeId: ConversationExchangeId;
  status: 'completed' | 'interrupted' | 'failed';
  userVisibleFromSeq: number;
  userVisibleThroughSeq: number;
};
```

Summary 不包含密钥、隐藏系统提示词或历史工具轨迹。覆盖位置必须指向已完成 Exchange，且不能越过仍需保留的 recent raw floor。

### 3.3 Turn 与 Step

```ts
type TurnStartedPayload = {
  turnId: ExecutionTurnId;
  exchangeId: ConversationExchangeId;
  claimedInboxItemIds: InboxItemId[];
};

type TurnEndedPayload = {
  turnId: ExecutionTurnId;
  reason: TurnEndReason;
  error?: StableError;
  completedStepCount: number;
  durationMs: number;
};

type StepStartedPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  stepIndex: number;
  modelConfigSnapshotId: string;
  skillRegistrySnapshotId: string;
  modelRevision: number;
  skillRevision: number;
  promptEpoch: string;
};

type StepEndedPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  status: 'completed' | 'cancelled' | 'error';
  finishReason?: string;
  durationMs: number;
};
```

`StepStartedPayload` 只记录快照 ID、revision 和非敏感摘要。endpoint、API Key 和 Skill secret 不进入事件。

### 3.4 模型请求与消息

```ts
type RequestContextPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  modelRequestId: ModelRequestId;
  modelServiceId: ModelServiceId;
  modelId: ModelId;
  modelConfigVersion: number;
  promptEpoch: string;
  skillRegistrySnapshotId: string;
  toolNames: string[];
  contextBreakdown: {
    systemTokens: number;
    toolSchemaTokens: number;
    summaryTokens: number;
    eventTokens: number;
    currentTurnTokens: number;
    reservedOutputTokens: number;
  };
};

type UserMessagePayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  messageId: MessageId;
  sourceInboxItemId?: InboxItemId;
  role: 'user';
  content: UserContentPart[];
};

type AssistantChunkPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  modelRequestId: ModelRequestId;
  chunkIndex: number;
  textDelta?: string;
  providerDeltaType: string;
};

type AssistantMessagePayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  modelRequestId: ModelRequestId;
  messageId: MessageId;
  text: string;
  finishReason: string;
  usage: ProviderUsage;
};
```

模型响应被截断时仍记录 AssistantMessage，但 TurnEndReason 必须保留 `max_output_tokens`，UI 不能显示为正常完成。

### 3.5 Tool Call 与 Tool Result

```ts
type ToolCallPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  callIndex: number;
  toolName: string;
  skillInstallationId?: SkillInstallationId;
  input: JsonValue;
  concurrencyMode: 'parallel' | 'exclusive';
  replaySafe: boolean;
  idempotencyKey?: string;
};

type ToolResultStatus = 'success' | 'needs_input' | 'retryable_error' | 'fatal_error' | 'cancelled';

type ToolResultPayload = {
  turnId: ExecutionTurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  callIndex: number;
  status: ToolResultStatus;
  content: JsonValue;
  missing?: string[];
  error?: StableError;
  concludesTurn?: boolean;
  durationMs: number;
  resultCertainty: 'certain' | 'unknown_side_effect';
};
```

不变量：

- Tool Result 的 `content` 是工具规范化后的完整结果。
- Event Log、Trajectory 和当前 Turn Surface 引用同一份结果语义，不存在给模型的裁剪副本。
- 并行工具可以乱序完成，但事件按 `callIndex` 顺序 commit。
- 有 Tool Call 而无 Tool Result 的非 replay-safe 副作用在恢复时写入明确的不确定结果，不自动重放。

### 3.6 Interaction

```ts
type InteractionRequestedPayload = {
  interactionId: InteractionId;
  turnId: ExecutionTurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  kind: 'approval' | 'selection' | 'form';
  schema: JsonSchema;
  title: string;
  description?: string;
};

type InteractionResolvedPayload = {
  interactionId: InteractionId;
  resolution: 'submitted' | 'rejected' | 'cancelled';
  value?: JsonValue;
  resolvedAt: Timestamp;
};
```

Interaction value 必须再次通过服务端 Schema 校验。普通聊天输入不能伪造 interaction resolution。

### 3.7 Compaction

```ts
type CompactionStartedPayload = {
  compactionId: string;
  scope: 'conversation_event' | 'session';
  sourceFromSeq: number;
  sourceThroughSeq: number;
  expectedSummaryVersion: number;
};

type CompactionSummaryPayload = {
  compactionId: string;
  candidateSummary: string;
  inputTokens: number;
  outputTokens: number;
};

type CompactionEndedPayload = {
  compactionId: string;
  result: 'committed' | 'discarded' | 'failed';
  reason?: string;
};
```

候选摘要只有在 Schema 合法、节省 token 且 version 未冲突时才通过 `conversation-event.summary-updated` 生效。

## 4. Event Batch 原子边界

以下事实必须以单个 batch 提交：

- `turn.started`、Inbox claim、`conversation-exchange.started`。
- 同一 Tool Call 批次按模型顺序提交的全部 `tool.result`。
- `assistant.message`、`step.ended` 以及由该响应直接确定的状态事实。
- `turn.ended` 与 `conversation-exchange.completed`。
- Summary 生效相关的 `compaction.ended(committed)` 与 `conversation-event.summary-updated`。

流式 `assistant.chunk` 可以逐个 batch 追加，但完整消息必须由 `assistant.message` 确认；独立思考内容使用 `assistant.reasoning.chunk` 实时追加，并由 `assistant.reasoning` 校准最终内容。Projection 重建时不能只依赖 chunk 猜测最终正文、思考内容、finish reason 或 usage。Provider 的 `reasoning_content`、`reasoning` 和正文内 `<think>` 标签必须先归一化，思考内容不得混入最终回答。

## 5. Runtime Projection

### 5.1 ChatProjection

输出：

- 用户可见消息。
- ConversationEvent/Exchange 分组。
- 助手流式与最终状态。
- Tool 卡片的用户可见状态。
- Turn 结束原因。

规则：

- 用户消息来自已接纳进 Step 的 `user.message`，不是 Renderer 乐观永久插入。
- chunk 只更新临时 assembled view；`assistant.message` 是最终组装事实。
- interrupted/failed Exchange 必须保留已有用户可见内容并显示明确状态。

### 5.2 TrajectoryProjection

输出 Turn、Step、ModelRequest、Tool Call/Result、Interaction、耗时和错误。它可以显示模型/Skill 快照 ID 与 revision，但不得显示密钥或完整隐藏 Prompt。

### 5.3 InboxProjection

按事件顺序原子回放每个 splice 的全部 operations，输出 `next-turn` 和 `next-step`。UI 默认把用户可操作的 `next-turn` 显示为等待队列；`reason='promote'` 后同一 Item 转为当前 Turn 的“将在下一步介入”，不能同时出现在两个 target，也不能生成重复消息。内部 inject 可以进入诊断视图，不直接暴露敏感内容。

### 5.4 UsageProjection

provider usage 为权威计量；Context Breakdown 是组成估算。cache read、cache write、reasoning token 和普通 input/output 分字段保存，不能重复相加。

## 6. Snapshot 与增量 cursor

Session Snapshot：

```ts
interface SessionSnapshot {
  userId: LocalUserId;
  sessionId: SessionId;
  throughSeq: number;
  chat: ChatProjection;
  trajectory: TrajectoryProjection;
  inbox: InboxProjection;
  usage: UsageProjection;
}
```

订阅规则：

1. Renderer 先 Query Snapshot。
2. 以 `throughSeq` 作为订阅起点。
3. 只接收 `seq = previous + 1` 的同用户同 Session 增量。
4. 重复 seq 幂等忽略；出现间隙、用户不匹配或无法识别版本时丢弃局部状态并重新 Query Snapshot。
5. 切换用户先销毁旧订阅，再清空旧 Runtime View State，然后加载新用户 Snapshot。

## 7. Configuration Snapshot 与增量

配置增量不使用 Session seq：

```ts
interface ConfigurationChangedEvent {
  userId: LocalUserId;
  domain: 'model' | 'skill' | 'runtime';
  revision: number;
  changedIds: string[];
}
```

Renderer 只把它作为失效通知或增量提示。检测 revision 不是当前 revision + 1 时，重新查询完整 ModelManagementSnapshot 或 SkillManagementSnapshot。

## 8. 版本兼容

- V1 事件只使用 `schemaVersion: 1`。
- 新增可选字段可以保持版本，但消费者必须保留未知字段容忍策略。
- 删除、重命名字段或改变语义必须升级 payload 版本并提供 Upcaster。
- Upcaster 只在读取边界产生新内存形状，不改写历史事件。
- Projection schemaVersion 与 event schemaVersion 分开管理。

## 9. Contract Fixture

阶段 1 必须为以下场景建立固定事件流 Fixture：

- 纯文本一次模型调用完成。
- 单 Tool Call 两 Step 完成。
- 三个并行工具乱序完成、顺序 commit。
- Queue 在当前 Turn 后开启新 Turn。
- Steer 在工具后进入下一 Step。
- Queue Item 在工具期间从 next-turn 原子提升到 next-step，且不取消工具。
- Cancel 保留 next-turn、清理 next-step。
- Interaction 请求、提交和拒绝。
- 模型截断、context budget 超限和 max_steps。
- Worker 崩溃、开放 Turn interrupted、副作用结果不确定。
- Event Compaction 成功、失败和 version 冲突。

每个 Fixture 同时验证 Chat、Trajectory、Inbox 和 Usage 的实时消费结果等于全量回放结果。
