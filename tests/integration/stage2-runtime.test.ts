import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createWorkerApplication } from '../../packages/server-core/src/application/application';
import type { WorkerApplication } from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry, type LlmAdapter, type ModelResponse, type ModelStreamEvent } from '../../packages/runtime-core/src/model';
import { ToolExecutionError, ToolRegistry, type RuntimeTool } from '../../packages/runtime-core/src/tools';
import type { RuntimeServiceOptions } from '../../packages/runtime-core/src/runtime-service';
import { estimateTextTokens } from '../../packages/protocol/src/token-estimate';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import {
  FakeLlmAdapter,
  SequenceIdProvider,
  deferred,
  textResponse,
  waitUntil,
} from '../../packages/test-kit/src/runtime';

interface Snapshot {
  inbox: Array<{ id: string; content: string; scope: string }>;
  turns: Array<{ id: string; status: string; stepCount: number }>;
  messages: Array<{
    role: string;
    content: string;
    turnId: string;
    interactionId?: string;
  }>;
  interactions: Array<{
    id: string;
    turnId: string;
    status: string;
    kind: string;
    questions: Array<{
      id: string;
      header?: string;
      question: string;
      options: string[];
    }>;
    value?: unknown;
    continuationTurnId?: string;
  }>;
  activeTurnId: string | null;
  usage: { modelRequests: number; toolCalls: number };
}

describe('Stage 2 单 Agent Runtime', () => {
  let root: string;
  let app: WorkerApplication;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    app?.close();
    cleanupDir(root);
  });

  it('V2 迁移包含租约、幂等键与投影表', () => {
    app = makeApp(new FakeLlmAdapter(() => textResponse('ok')));
    expect(app.schemaVersion).toBeGreaterThanOrEqual(10);
    const sessionColumns = columns('sessions');
    const eventColumns = columns('session_events');
    expect(sessionColumns).toContain('lease_owner');
    expect(sessionColumns).toContain('lease_expires_at');
    expect(eventColumns).toContain('idempotency_key');
    expect(tableNames()).toEqual(
      expect.arrayContaining([
        'conversation_events',
        'conversation_exchanges',
        'conversation_event_relations',
        'projection_checkpoints',
      ]),
    );
  });

  it('完成一次正式 Turn 并生成 Chat、Trajectory 与 Usage 投影', async () => {
    const adapter = new FakeLlmAdapter(() => textResponse('完成了'));
    app = makeApp(adapter);
    createConfiguredSession('s1');
    app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: '执行任务',
      idempotencyKey: 'request-1',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle('user-a', 's1');

    const snapshot = snap('user-a', 's1');
    expect(snapshot.inbox).toEqual([]);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({ status: 'completed', stepCount: 1 });
    expect(snapshot.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', '执行任务'],
      ['assistant', '完成了'],
    ]);
    expect(snapshot.usage).toMatchObject({ modelRequests: 1, toolCalls: 0 });
    expect(app.runtime.conversationEventList('user-a', 's1')).toHaveLength(1);
  });

  it('相同幂等键只接纳一次，不同载荷返回冲突', async () => {
    const gate = deferred<ModelResponse>();
    app = makeApp(new FakeLlmAdapter(() => gate.promise));
    createConfiguredSession('s1');
    const first = app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: '同一请求',
      idempotencyKey: 'same-key',
      startNewEvent: true,
    });
    const duplicate = app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: '同一请求',
      idempotencyKey: 'same-key',
      startNewEvent: true,
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(() =>
      app.runtime.submitInput('user-a', {
        sessionId: 's1',
        content: '不同请求',
        idempotencyKey: 'same-key',
        startNewEvent: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    gate.resolve(textResponse('ok'));
    await app.runtime.waitForIdle();
  });

  it('运行中普通补充保留在 next-turn，当前 Turn 完成后开启新 Turn', async () => {
    const first = deferred<ModelResponse>();
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0 ? first.promise : textResponse('第二轮完成'),
    );
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '第一条', 'k1');
    await waitUntil(() => adapter.requests.length === 1);
    const queued = submit('s1', '排队内容', 'k2');
    expect(snap('user-a', 's1').inbox).toContainEqual(
      expect.objectContaining({ id: queued.inboxItemId, scope: 'next-turn' }),
    );
    first.resolve(textResponse('第一轮完成'));
    await app.runtime.waitForIdle('user-a', 's1');
    expect(snap('user-a', 's1').turns).toHaveLength(2);
    expect(adapter.requests).toHaveLength(2);
  });

  it('立刻介入将同一 InboxItem 原子提升到 next-step，不中断当前请求', async () => {
    const first = deferred<ModelResponse>();
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0 ? first.promise : textResponse('已结合补充完成'),
    );
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '原始问题', 'k1');
    await waitUntil(() => adapter.requests.length === 1);
    const before = snap('user-a', 's1');
    const queued = submit('s1', '立刻补充', 'k2');
    const promoted = app.runtime.promoteInboxItem(
      'user-a',
      's1',
      queued.inboxItemId,
      before.activeTurnId!,
    );
    expect(promoted.scope).toBe('next-step');
    expect(snap('user-a', 's1').inbox).toContainEqual(
      expect.objectContaining({ id: queued.inboxItemId, scope: 'next-step' }),
    );
    first.resolve(textResponse('第一步回答'));
    await app.runtime.waitForIdle('user-a', 's1');

    const after = snap('user-a', 's1');
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]?.stepCount).toBe(2);
    expect(
      after.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['原始问题', '立刻补充']);
    const splice = app.repos.sessions
      .listEvents('user-a', 's1')
      .find(
        (event) =>
          event.eventType === 'agent.inbox.spliced' &&
          (event.payload as { reason?: string }).reason === 'promote',
      );
    expect((splice?.payload as { operations: unknown[] }).operations).toHaveLength(2);
  });

  it('显式 steer 在活动 Turn 中直接进入 next-step；过期 promote 不改变队列', async () => {
    const first = deferred<ModelResponse>();
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0 ? first.promise : textResponse('steer done'),
    );
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', 'initial', 'k1');
    await waitUntil(() => adapter.requests.length === 1);
    const steered = app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: 'steered',
      idempotencyKey: 'k2',
      startNewEvent: true,
      mode: 'steer',
    });
    expect(steered.scope).toBe('next-step');

    const queued = submit('s1', 'queued', 'k3');
    expect(() =>
      app.runtime.promoteInboxItem('user-a', 's1', queued.inboxItemId, 'stale-turn'),
    ).toThrowError(expect.objectContaining({ code: 'TURN_CHANGED' }));
    expect(snap('user-a', 's1').inbox).toContainEqual(
      expect.objectContaining({ id: queued.inboxItemId, scope: 'next-turn' }),
    );
    app.runtime.removeInboxItem('user-a', 's1', queued.inboxItemId);
    first.resolve(textResponse('first'));
    await app.runtime.waitForIdle();
    expect(snap('user-a', 's1').turns).toHaveLength(1);
    expect(snap('user-a', 's1').turns[0]?.stepCount).toBe(2);
  });

  it('取消当前 Turn 后保留 next-turn 队列，并继续处理下一轮', async () => {
    const adapter = new FakeLlmAdapter((_request, signal, index) => {
      if (index > 0) return textResponse('取消后新任务完成');
      return new Promise<ModelResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '长任务', 'k1');
    await waitUntil(() => adapter.requests.length === 1);
    const current = snap('user-a', 's1').activeTurnId!;
    app.runtime.cancelAndQueue('user-a', {
      sessionId: 's1',
      turnId: current,
      content: '新任务',
      idempotencyKey: 'k2',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle('user-a', 's1');
    const turns = snap('user-a', 's1').turns;
    expect(turns.map((turn) => turn.status)).toEqual(['cancelled', 'completed']);
  });

  it('request_user_input 结束当前 Turn，interaction.resolve 在同一 Event 新开 Exchange', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-question',
              name: 'request_user_input',
              arguments: { prompt: '是否继续？', kind: 'confirm' },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      return textResponse('收到确认，已完成');
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '需要确认', 'k1');
    await app.runtime.waitForIdle('user-a', 's1');
    const blocked = snap('user-a', 's1');
    expect(blocked.interactions).toHaveLength(1);
    expect(blocked.interactions[0]?.status).toBe('pending');
    expect(() =>
      app.runtime.resolveInteraction('user-a', {
        sessionId: 's1',
        interactionId: blocked.interactions[0]!.id,
        value: '不是布尔值',
        idempotencyKey: 'invalid-resolution',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    app.runtime.resolveInteraction('user-a', {
      sessionId: 's1',
      interactionId: blocked.interactions[0]!.id,
      value: true,
      idempotencyKey: 'resolve-1',
    });
    await app.runtime.waitForIdle('user-a', 's1');
    const completed = snap('user-a', 's1');
    expect(completed.turns).toHaveLength(2);
    expect(completed.interactions[0]).toMatchObject({
      status: 'resolved',
      continuationTurnId: completed.turns[1]?.id,
    });
    expect(completed.messages.find((message) => message.interactionId)).toMatchObject({
      role: 'user',
      interactionId: completed.interactions[0]?.id,
      turnId: completed.turns[1]?.id,
    });
    expect(app.runtime.conversationEventList('user-a', 's1')).toHaveLength(1);
  });

  it.each([
    { resolution: 'rejected' as const, kind: 'confirm', value: false, feedback: '用户拒绝了本次询问' },
    { resolution: 'cancelled' as const, kind: 'text', value: null, feedback: '用户跳过了本次回答' },
    { resolution: 'cancelled' as const, kind: 'form', value: null, feedback: '用户跳过了本次回答' },
  ])('$kind 交互 $resolution 后反馈给模型并幂等续接同一事项', async ({ resolution, kind, value, feedback }) => {
    const continuation = deferred<ModelResponse>();
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) {
        return {
          content: '',
          toolCalls: [{
            id: 'call-question',
            name: 'request_user_input',
            arguments: {
              prompt: '请补充任务信息',
              kind,
              ...(kind === 'form' ? {
                questions: [{ id: 'format', question: '输出格式？', options: ['简短', '详细'] }],
              } : {}),
            },
          }],
          usage: { inputTokens: 10, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      return continuation.promise;
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '执行任务', 'k1');
    await app.runtime.waitForIdle('user-a', 's1');
    const interactionId = snap('user-a', 's1').interactions[0]!.id;
    const input = { sessionId: 's1', interactionId, value, resolution, idempotencyKey: 'resolve-1' };
    const result = app.runtime.resolveInteraction('user-a', input);
    expect(result.inboxItemId).toEqual(expect.any(String));
    expect(app.runtime.resolveInteraction('user-a', input)).toEqual(result);
    await waitUntil(() => adapter.requests.length === 2);
    expect(app.runtime.conversationEventList('user-a', 's1')).toEqual([
      expect.objectContaining({ status: 'open' }),
    ]);
    expect(adapter.requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining(feedback) }),
    ]));
    continuation.resolve(textResponse('已根据现有信息完成可推进的部分'));
    await app.runtime.waitForIdle('user-a', 's1');
    const completed = snap('user-a', 's1');
    expect(completed.turns.map((turn) => turn.status)).toEqual(['completed', 'completed']);
    expect(completed.interactions[0]).toMatchObject({
      status: 'resolved', resolution, continuationTurnId: completed.turns[1]?.id,
    });
    expect(completed.messages.filter((message) => message.interactionId)).toHaveLength(1);
    expect(app.runtime.conversationEventList('user-a', 's1')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(app.runtime.resolveInteraction('user-a', input)).toEqual(result);
    expect(() => app.runtime.resolveInteraction('user-a', {
      ...input, idempotencyKey: 'resolve-again',
    })).toThrowError(expect.objectContaining({ code: 'INTERACTION_NOT_PENDING' }));
  });

  it('request_user_input 支持多问题推荐选项与自定义回答', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-multi-question',
              name: 'request_user_input',
              arguments: {
                prompt: '请补充 POC 的关键资源信息。',
                questions: [
                  {
                    id: 'model',
                    header: '动物模型',
                    question: '可用的 AD 小鼠模型是？',
                    options: ['5xFAD', 'APP/PS1', 'Trem2-KO'],
                  },
                  {
                    id: 'sample',
                    header: '患者样本',
                    question: '主要样本类型是？',
                    options: ['血浆', 'CSF', 'PBMC'],
                  },
                ],
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      return textResponse('已根据补充信息完成方案');
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '规划 POC', 'multi-question-submit');
    await app.runtime.waitForIdle('user-a', 's1');

    const blocked = snap('user-a', 's1');
    const interaction = blocked.interactions[0]!;
    expect(interaction).toMatchObject({
      status: 'pending',
      kind: 'form',
      questions: [
        { id: 'model', options: ['5xFAD', 'APP/PS1', 'Trem2-KO'] },
        { id: 'sample', options: ['血浆', 'CSF', 'PBMC'] },
      ],
    });
    expect(() =>
      app.runtime.resolveInteraction('user-a', {
        sessionId: 's1',
        interactionId: interaction.id,
        value: { model: '5xFAD' },
        idempotencyKey: 'missing-answer',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));

    const answers = { model: '5xFAD', sample: '脑组织' };
    app.runtime.resolveInteraction('user-a', {
      sessionId: 's1',
      interactionId: interaction.id,
      value: answers,
      idempotencyKey: 'multi-question-answer',
    });
    await app.runtime.waitForIdle('user-a', 's1');

    const completed = snap('user-a', 's1');
    expect(completed.interactions[0]).toMatchObject({ status: 'resolved', value: answers });
    expect(completed.turns).toHaveLength(2);
    expect(completed.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '已根据补充信息完成方案',
    });
  });

  it('完全访问模式把用户问题交回模型自主决策，不创建等待交互', async () => {
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        expect(request.messages[0]?.content).toContain('完全访问：');
        expect(
          request.tools.find((tool) => tool.name === 'request_user_input')?.inputSchema,
        ).toMatchObject({
          properties: { requiresUserProvidedFact: { type: 'boolean' } },
        });
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-autonomous-question',
              name: 'request_user_input',
              arguments: {
                prompt: '请选择实现方向。',
                questions: [
                  {
                    id: 'direction',
                    question: '采用哪种实现？',
                    options: ['低风险方案', '高性能方案'],
                  },
                ],
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      return textResponse('已自主选择低风险方案并完成');
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    app.runtime.setPermissionPreset('user-a', 's1', 'full-access');
    submit('s1', '直接完成任务', 'full-access-autonomous');
    await app.runtime.waitForIdle('user-a', 's1');

    const completed = snap('user-a', 's1');
    expect(
      adapter.requests[1]?.messages.some(
        (message) =>
          message.role === 'tool' && message.content.includes('此项由模型自主决定'),
      ),
    ).toBe(true);
    expect(completed.interactions).toEqual([]);
    expect(completed.turns).toHaveLength(1);
    expect(completed.turns[0]).toMatchObject({ status: 'completed', stepCount: 2 });
    expect(completed.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '已自主选择低风险方案并完成',
    });
  });

  it('完全访问模式仍允许询问不可推断且任务必需的用户事实', async () => {
    const adapter = new FakeLlmAdapter(() => ({
      content: '',
      toolCalls: [
        {
          id: 'call-required-fact',
          name: 'request_user_input',
          arguments: {
            prompt: '缺少继续任务所必需的项目编号。',
            kind: 'text',
            requiresUserProvidedFact: true,
          },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 2 },
      stopReason: 'tool_calls',
    }));
    app = makeApp(adapter);
    createConfiguredSession('s1');
    app.runtime.setPermissionPreset('user-a', 's1', 'full-access');
    submit('s1', '处理指定项目', 'full-access-required-fact');
    await app.runtime.waitForIdle('user-a', 's1');

    const blocked = snap('user-a', 's1');
    expect(blocked.interactions).toHaveLength(1);
    expect(blocked.interactions[0]).toMatchObject({ status: 'pending', kind: 'text' });
  });

  it('同一 Session 严格串行，不同 Session 可以同时进入模型请求', async () => {
    const gates = [deferred<ModelResponse>(), deferred<ModelResponse>(), deferred<ModelResponse>()];
    const adapter = new FakeLlmAdapter((_request, _signal, index) => gates[index]!.promise);
    app = makeApp(adapter);
    createConfiguredSession('s1');
    app.runtime.createSession('user-a', { sessionId: 's2', title: 'S2' });

    submit('s1', 's1-first', 'k1');
    submit('s1', 's1-second', 'k2');
    submit('s2', 's2-first', 'k3');
    await waitUntil(() => adapter.requests.length === 2);
    expect(adapter.requests.map((request) => request.messages.at(-1)?.content).sort()).toEqual([
      's1-first',
      's2-first',
    ]);
    gates[0]!.resolve(textResponse('one'));
    gates[1]!.resolve(textResponse('two'));
    await waitUntil(() => adapter.requests.length === 3);
    expect(adapter.requests[2]?.messages.at(-1)?.content).toBe('s1-second');
    gates[2]!.resolve(textResponse('three'));
    await app.runtime.waitForIdle();
  });

  it('默认最多 4 个 Session 同时执行，第 5 个等待执行槽', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<ModelResponse>());
    const adapter = new FakeLlmAdapter((_request, _signal, index) => gates[index]!.promise);
    app = makeApp(adapter);
    configureModel('user-a');
    for (let index = 1; index <= 5; index += 1) {
      const sessionId = `parallel-${index}`;
      app.runtime.createSession('user-a', { sessionId, title: sessionId });
      submit(sessionId, sessionId, `parallel-key-${index}`);
    }
    await waitUntil(() => adapter.requests.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.requests).toHaveLength(4);
    gates[0]!.resolve(textResponse('released'));
    await waitUntil(() => adapter.requests.length === 5);
    for (const gate of gates.slice(1)) gate.resolve(textResponse('done'));
    await app.runtime.waitForIdle();
  });

  it('工具 retryable_error 最多重试并按原调用顺序提交结果', async () => {
    let attempts = 0;
    const retryTool: RuntimeTool<{ output: string }> = {
      name: 'retry_tool',
      description: 'test',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { output: { type: 'string' } },
          required: ['output'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.output }],
      },
      concurrencySafe: true,
      replaySafe: true,
      async execute() {
        attempts += 1;
        if (attempts < 3) {
          throw new ToolExecutionError('TEMPORARY_FAILURE', 'retryable_error');
        }
        return { output: 'done' };
      },
    };
    const tools = new ToolRegistry();
    tools.register(retryTool);
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? {
            content: '',
            toolCalls: [{ id: 'retry-call', name: 'retry_tool', arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'tool_calls',
          }
        : textResponse('done'),
    );
    app = makeApp(adapter, tools);
    createConfiguredSession('s1');
    submit('s1', 'use tool', 'k1');
    await app.runtime.waitForIdle();
    expect(attempts).toBe(3);
    const result = app.repos.sessions
      .listEvents('user-a', 's1')
      .find((event) => event.eventType === 'tool.result');
    expect(result?.payload).toMatchObject({
      status: 'success',
      output: [{ type: 'text', text: 'done' }],
    });
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [{ id: 'retry-call', name: 'retry_tool', arguments: {} }],
        }),
        expect.objectContaining({ role: 'tool', toolCallId: 'retry-call', content: 'done' }),
      ]),
    );
  });

  it('所有 Session、事件与默认模型都按 userId 隔离', async () => {
    app = makeApp(new FakeLlmAdapter(() => textResponse('ok')));
    configureModel('user-a');
    app.runtime.createSession('user-a', { sessionId: 'secret', title: 'A only' });
    expect(app.runtime.listSessions('user-b')).toEqual([]);
    expect(() => app.runtime.snapshot('user-b', 'secret')).toThrow();
    expect(() =>
      app.runtime.submitInput('user-b', {
        sessionId: 'secret',
        content: 'cross user',
        idempotencyKey: 'bad',
        startNewEvent: true,
      }),
    ).toThrow();
  });

  it('当前 Turn 超出预算时明确失败且不截断后调用模型', async () => {
    const adapter = new FakeLlmAdapter(() => textResponse('should not run'));
    app = makeApp(adapter, undefined, { reservedOutputTokens: 10, safetyTokens: 10 });
    createConfiguredSession('s1', 100, 10);
    submit('s1', '超长'.repeat(500), 'k1');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(0);
    expect(snap('user-a', 's1').turns[0]).toMatchObject({
      status: 'failed',
    });
    expect(
      app.repos.sessions
        .listEvents('user-a', 's1')
        .find((event) => event.eventType === 'turn.ended')?.payload,
    ).toMatchObject({ reason: 'context_budget_exceeded' });
  });

  it('模型请求按实际输出额度预留总上下文空间', async () => {
    const adapter = new FakeLlmAdapter(() => textResponse('ok'));
    app = makeApp(adapter);
    createConfiguredSession('s1', 10_000, 6_000);
    submit('s1', '检查输出预留', 'k1');
    await app.runtime.waitForIdle();

    const requestContext = app.repos.sessions
      .listEvents('user-a', 's1')
      .find((event) => event.eventType === 'model.request.context');
    expect(requestContext?.payload).toMatchObject({ budgetTokens: 3_000 });
    expect(adapter.requests[0]?.maxOutputTokens).toBe(6_000);
  });

  it('流式 delta 立即成为事件，final message 是最终权威事实', async () => {
    const gate = deferred<void>();
    const streaming: LlmAdapter = {
      providerType: 'fake',
      async generate() {
        throw new Error('stream path expected');
      },
      async *stream() {
        yield { type: 'reasoning_delta' as const, delta: '正在**分析**请求' };
        yield { type: 'text_delta' as const, delta: '正在' };
        await gate.promise;
        yield { type: 'text_delta' as const, delta: '完成' };
        yield {
          type: 'completed' as const,
          response: { ...textResponse('正在完成'), reasoning: '正在**分析**请求' },
        };
      },
    };
    app = makeApp(streaming);
    createConfiguredSession('s1');
    submit('s1', 'stream', 'k1');
    await waitUntil(() =>
      app.repos.sessions
        .listEvents('user-a', 's1')
        .some((event) => event.eventType === 'assistant.chunk'),
    );
    const during = snap('user-a', 's1') as Snapshot & {
      streaming: Array<{ content: string; finalized: boolean }>;
    };
    expect(during.streaming[0]).toMatchObject({ content: '正在', finalized: false });
    const reasoningDuring = snap('user-a', 's1') as Snapshot & {
      reasoning: Array<{ content: string; finalized: boolean }>;
    };
    expect(reasoningDuring.reasoning[0]).toMatchObject({
      content: '正在**分析**请求',
      finalized: false,
    });
    gate.resolve();
    await app.runtime.waitForIdle();
    const after = snap('user-a', 's1') as Snapshot & {
      streaming: Array<{ content: string; finalized: boolean }>;
    };
    expect(after.streaming[0]).toMatchObject({ content: '正在完成', finalized: true });
    const reasoningAfter = snap('user-a', 's1') as Snapshot & {
      reasoning: Array<{ content: string; finalized: boolean }>;
    };
    expect(reasoningAfter.reasoning[0]).toMatchObject({
      content: '正在**分析**请求',
      finalized: true,
    });
  });

  it('工具调用后持续开启下一 Step，直到模型给出无工具的最终答复', async () => {
    let call = 0;
    const adapter = new FakeLlmAdapter(() => {
      call += 1;
      if (call === 14) return textResponse('基于已有工具结果完成总结');
      return {
        content: '',
        toolCalls: [{ id: `call-${call}`, name: 'event_search', arguments: { query: 'x' } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls',
      };
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', 'loop', 'k1');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(14);
    expect(adapter.requests.map((request) => request.messages.some((message) => message.content.includes('进度沟通提醒：'))))
      .toEqual([false, true, false, true, false, true, false, true, false, true, false, true, false, true]);
    expect(adapter.requests.every((request) => request.tools.length > 0)).toBe(true);
    expect(snap('user-a', 's1').turns[0]).toMatchObject({
      status: 'completed',
      stepCount: 14,
      endReason: 'complete',
    });
    expect(snap('user-a', 's1').messages.at(-1)?.content).toBe('基于已有工具结果完成总结');
    expect(snap('user-a', 's1').activeTurnId).toBeNull();
  });

  it.each([
    { contextWindow: 8000, maxOutputTokens: 1000, maxOutputCapability: 1000, historyRepeats: 700, mode: 'complete' },
    { contextWindow: 32000, maxOutputTokens: 4096, maxOutputCapability: 32768, historyRepeats: 3200, mode: 'length' },
    { contextWindow: 32000, maxOutputTokens: 4096, maxOutputCapability: 32768, historyRepeats: 3200, mode: 'oversized' },
    { contextWindow: 64000, maxOutputTokens: 8192, maxOutputCapability: 32768, historyRepeats: 6500, mode: 'complete' },
  ])('长 Event 在 $contextWindow 窗口压缩双层 $mode 记忆并继续执行', async ({ contextWindow, maxOutputTokens, maxOutputCapability, historyRepeats, mode }) => {
    let agentCalls = 0;
    const longAnswer = '历史事实'.repeat(historyRepeats);
    const adapter = new FakeLlmAdapter((request) => {
      if (request.purpose === 'compaction') {
        expect(request.maxOutputTokens).toBeLessThanOrEqual(contextWindow * 0.4);
        expect(request.maxOutputTokens).toBeLessThanOrEqual(maxOutputCapability);
        const inputTokens = request.messages.reduce((sum, message) => sum + estimateTextTokens(message.content) + 4, 0);
        expect(inputTokens + request.maxOutputTokens + 500).toBeLessThanOrEqual(contextWindow);
        return {
          ...textResponse('历史摘要：已经完成两轮准备工作。' + (mode === 'oversized' ? '保留的事实。'.repeat(contextWindow) : '')),
          stopReason: mode === 'length' ? 'length' : 'complete',
        };
      }
      agentCalls += 1;
      return textResponse(agentCalls < 3 ? longAnswer : '最终完成');
    });
    app = makeApp(adapter, undefined, { reservedOutputTokens: 500, safetyTokens: 500 });
    createConfiguredSession('s1', contextWindow, maxOutputTokens, maxOutputCapability);
    submit('s1', '第一轮', 'k1');
    await app.runtime.waitForIdle();
    app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: '第二轮',
      idempotencyKey: 'k2',
      startNewEvent: false,
    });
    await app.runtime.waitForIdle();
    app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content: '第三轮',
      idempotencyKey: 'k3',
      startNewEvent: false,
    });
    await app.runtime.waitForIdle();

    expect(adapter.requests.some((request) => request.purpose === 'compaction')).toBe(true);
    expect(app.repos.sessions.listEvents('user-a', 's1').map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['session.memory.summary-updated', 'conversation.event.summary-updated']),
    );
    const summaries = app.repos.sessions.listEvents('user-a', 's1').filter((event) =>
      event.eventType === 'session.memory.summary-updated' || event.eventType === 'conversation.event.summary-updated');
    expect(summaries).toHaveLength(2);
    for (const event of summaries) {
      const payload = event.payload as { summary: string; summaryGeneration: { truncated: boolean; maxOutputTokens: number; stopReason: string } };
      expect(payload.summary.startsWith('历史摘要：已经完成两轮准备工作。')).toBe(true);
      expect(estimateTextTokens(payload.summary)).toBeLessThanOrEqual(payload.summaryGeneration.maxOutputTokens);
      expect(payload.summaryGeneration.truncated).toBe(mode !== 'complete');
      expect(payload.summaryGeneration.stopReason).toBe(mode === 'length' ? 'length' : 'complete');
    }
    expect(snap('user-a', 's1').turns).toHaveLength(3);
    const finalRequest = adapter.requests.filter((request) => request.purpose === 'agent').at(-1)!;
    expect(finalRequest.maxOutputTokens).toBe(maxOutputTokens);
    expect(finalRequest.messages.some((message) => message.content.includes(longAnswer))).toBe(false);
    expect(finalRequest.messages.at(-1)?.content).toBe('第三轮');
    expect(adapter.requests.filter((request) => request.purpose === 'compaction')).toHaveLength(2);
    expect(app.repos.sessions.listEvents('user-a', 's1').some((event) => event.eventType === 'surface.replaced')).toBe(false);
    expect(snap('user-a', 's1').messages.filter((message) => message.content === longAnswer)).toHaveLength(2);
  });

  it.each([
    { contextWindow: 16000, maxOutputTokens: 1000, maxOutputCapability: 1000, summaryStopReason: 'complete' as const },
    { contextWindow: 32000, maxOutputTokens: 4096, maxOutputCapability: 32768, summaryStopReason: 'complete' as const },
    { contextWindow: 32000, maxOutputTokens: 4096, maxOutputCapability: 32768, summaryStopReason: 'length' as const },
  ])('长工具循环在 $contextWindow 窗口处理 $summaryStopReason 检查点，配对与原始结果完整', async ({ contextWindow, maxOutputTokens, maxOutputCapability, summaryStopReason }) => {
    const tools = new ToolRegistry();
    const rawResult = '工具事实'.repeat(2500);
    tools.register({
      name: 'large_result', description: 'large test result',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_args: unknown, value: {text: string}) => [{ type: 'text' as const, text: value.text }] },
      concurrencySafe: true, replaySafe: true,
      async execute() { return { text: rawResult }; },
    });
    let count = 0;
    const adapter = new FakeLlmAdapter((request) => {
      if (request.purpose === 'compaction') {
        expect(request.maxOutputTokens).toBeLessThanOrEqual(contextWindow * 0.4);
        expect(request.maxOutputTokens).toBeLessThanOrEqual(maxOutputCapability);
        if (contextWindow === 32000) expect(request.maxOutputTokens).toBeGreaterThan(4096);
        const inputTokens = request.messages.reduce((sum, message) => sum + estimateTextTokens(message.content) + 4, 0);
        expect(inputTokens + request.maxOutputTokens + (contextWindow === 32000 ? 2048 : 500)).toBeLessThanOrEqual(contextWindow);
        const response = textResponse('检查点：已收集工具事实，继续当前任务。' +
          (maxOutputTokens === 4096 ? '已核验事实。'.repeat(200) : ''));
        return {
          ...response,
          usage: { ...response.usage, outputTokens: summaryStopReason === 'length' ?
            request.maxOutputTokens : maxOutputTokens === 4096 ? 3254 : 100 },
          stopReason: summaryStopReason,
        };
      }
      const calls = request.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
      const results = request.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId);
      expect(results).toEqual(calls);
      count += 1;
      if (count === 7) return textResponse('所有步骤完成');
      return { content: '', toolCalls: [{ id: `large-${count}`, name: 'large_result', arguments: {} }],
        usage: {inputTokens: 10, outputTokens: 10}, stopReason: 'tool_calls' };
    });
    app = makeApp(adapter, tools, { safetyTokens: contextWindow === 32000 ? 2048 : 500, toolOutputTokenLimit: 20000 });
    createConfiguredSession('s1', contextWindow, maxOutputTokens, maxOutputCapability);
    submit('s1', '收集工具事实并完成', 'k1');
    await app.runtime.waitForIdle();
    const events = app.repos.sessions.listEvents('user-a', 's1');
    const replacements = events.filter((event) => event.eventType === 'surface.replaced').map((event) => event.payload as {kind:string});
    expect(replacements.filter((value) => value.kind === 'tool-prune').length).toBeGreaterThan(1);
    expect(events.filter((event) => event.eventType === 'tool.result').every((event) => JSON.stringify(event.payload).includes(rawResult))).toBe(true);
    expect(adapter.requests.some((request) => request.purpose === 'compaction')).toBe(true);
    const checkpoints = replacements.filter((value) => value.kind === 'checkpoint');
    expect(count, JSON.stringify(snap('user-a','s1').turns)).toBe(7);
    expect(snap('user-a', 's1').turns[0]?.status).toBe('completed');
    expect(checkpoints.length).toBeGreaterThan(contextWindow === 16000 ? 1 : 0);
    expect(adapter.requests.filter((request) => request.purpose === 'compaction')).toHaveLength(checkpoints.length);
    expect(adapter.requests.filter((request) => request.purpose === 'agent').at(-1)?.messages[0]?.content).toContain('检查点：已收集工具事实');
    for (const event of events.filter((event) => event.eventType === 'compaction.ended')) {
      expect(event.payload).toMatchObject({
        status: 'completed', summaryGeneration: { stopReason: summaryStopReason, truncated: summaryStopReason === 'length' },
      });
    }
  });

  it('业务摘要一层失败不丢弃另一层的成功结果', async () => {
    let count = 0;
    const adapter = new FakeLlmAdapter((request) => {
      if (request.purpose === 'compaction') {
        if (request.messages[1]?.content.startsWith('当前事件细节')) throw new Error('event summary unavailable');
        return textResponse('已完成准备');
      }
      return textResponse(++count < 3 ? '历史事实'.repeat(700) : '最终完成');
    });
    app = makeApp(adapter, undefined, {safetyTokens:500});
    createConfiguredSession('s1',8000,1000);
    for (let i=0;i<3;i++) {
      app.runtime.submitInput('user-a',{sessionId:'s1',content:`第${i}轮`,idempotencyKey:`k${i}`,startNewEvent:i===0});
      await app.runtime.waitForIdle();
    }
    const types=app.repos.sessions.listEvents('user-a','s1').map((event)=>event.eventType);
    expect(types).toContain('session.memory.summary-updated');
    expect(types).not.toContain('conversation.event.summary-updated');
    expect(snap('user-a','s1').turns.at(-1)?.status).toBe('completed');
  });

  it('恢复开放 Turn 时补齐未知工具副作用并标记 interrupted', async () => {
    app = makeApp(new FakeLlmAdapter(() => textResponse('unused')));
    app.runtime.createSession('user-a', { sessionId: 's1', title: 'recover' });
    const session = app.repos.sessions.getSession('user-a', 's1')!;
    app.repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: session.version,
      events: [
        raw('conversation.event.created', { eventId: 'event-1', title: '恢复' }),
        raw('conversation.exchange.started', {
          exchangeId: 'exchange-1',
          eventId: 'event-1',
          turnId: 'turn-1',
        }),
        raw('turn.started', {
          turnId: 'turn-1',
          eventId: 'event-1',
          exchangeId: 'exchange-1',
        }),
        raw('tool.call', {
          toolCallId: 'danger-1',
          requestId: 'request-1',
          stepId: 'step-1',
          turnId: 'turn-1',
          eventId: 'event-1',
          toolName: 'host_command',
          input: { executable: 'node' },
          replaySafe: false,
          callIndex: 0,
        }),
      ],
    });
    await app.runtime.recover();
    const events = app.repos.sessions.listEvents('user-a', 's1');
    expect(events.find((event) => event.eventType === 'tool.result')?.payload).toMatchObject({
      toolCallId: 'danger-1',
      errorCode: 'UNKNOWN_SIDE_EFFECT',
      recovered: true,
    });
    expect(events.find((event) => event.eventType === 'turn.ended')?.payload).toMatchObject({
      turnId: 'turn-1',
      status: 'interrupted',
    });
  });

  it('lease 被新 owner 接管后旧 Driver 无法提交结果，恢复后标记 interrupted', async () => {
    const gate = deferred<ModelResponse>();
    const adapter = new FakeLlmAdapter(() => gate.promise);
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', 'lease race', 'k1');
    await waitUntil(() => adapter.requests.length === 1);
    app.repos.sessions.releaseLease('user-a', 's1', 'worker-2');
    expect(
      app.repos.sessions.acquireLease({
        userId: 'user-a',
        sessionId: 's1',
        owner: 'new-worker',
        now: '2025-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    ).toBe(true);
    gate.resolve(textResponse('must not commit'));
    await app.runtime.waitForIdle();
    expect(
      app.repos.sessions
        .listEvents('user-a', 's1')
        .some((event) => event.eventType === 'assistant.message'),
    ).toBe(false);
    app.repos.sessions.releaseLease('user-a', 's1', 'new-worker');
    await app.runtime.recover();
    expect(snap('user-a', 's1').turns[0]).toMatchObject({ status: 'interrupted' });
  });

  it('诊断事件页脱敏正文和工具载荷，正式 Turn 读取仍保留完整事实', async () => {
    app = makeApp(new FakeLlmAdapter(() => textResponse('敏感回答')));
    createConfiguredSession('s1');
    submit('s1', '敏感问题', 'k1');
    await app.runtime.waitForIdle();
    const page = app.runtime.eventsPage('user-a', 's1', 0, 100);
    expect(JSON.stringify(page.items)).not.toContain('敏感问题');
    expect(JSON.stringify(page.items)).not.toContain('敏感回答');
    const turnId = snap('user-a', 's1').turns[0]!.id;
    expect(JSON.stringify(app.runtime.executionTurnRead('user-a', 's1', turnId))).toContain(
      '敏感回答',
    );
    const replay = app.runtime.replayEventsPage('user-a', 's1', 0, 100);
    expect(JSON.stringify(replay.items)).toContain('敏感问题');
    expect(JSON.stringify(replay.items)).toContain('敏感回答');
  });

  it('Session create 幂等，rename 使用 expectedVersion，活动 Turn 禁止 archive', async () => {
    const gate = deferred<ModelResponse>();
    app = makeApp(
      new FakeLlmAdapter((_request, signal) => {
        signal.addEventListener('abort', () => gate.reject(new Error('cancelled')), { once: true });
        return gate.promise;
      }),
    );
    configureModel('user-a');
    const created = app.runtime.createSession('user-a', {
      sessionId: 's1',
      title: 'Original',
    }) as { version: number };
    expect(
      app.runtime.createSession('user-a', { sessionId: 's1', title: 'Original' }),
    ).toMatchObject({ id: 's1' });
    expect(() =>
      app.runtime.createSession('user-a', { sessionId: 's1', title: 'Different' }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    app.runtime.renameSession('user-a', 's1', 'Renamed', created.version);
    expect(() => app.runtime.renameSession('user-a', 's1', 'Stale', created.version)).toThrowError(
      expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    );
    submit('s1', 'running', 'k1');
    await waitUntil(() => snap('user-a', 's1').activeTurnId !== null);
    expect(() => app.runtime.archiveSession('user-a', 's1')).toThrowError(
      expect.objectContaining({ code: 'SESSION_BUSY' }),
    );
    app.runtime.cancelTurn('user-a', 's1', snap('user-a', 's1').activeTurnId!);
    await app.runtime.waitForIdle();
    expect(app.runtime.archiveSession('user-a', 's1')).toEqual({ sessionId: 's1' });
  });

  it.each(['early', 'late', 'missing'] as const)('phase %s：逐块输出，晚到元数据不移动正文', async (timing) => {
    const gate = deferred<void>();
    const adapter: LlmAdapter = {
      providerType: 'fake',
      generate: async () => textResponse('unused'),
      async *stream(): AsyncIterable<ModelStreamEvent> {
        if (timing === 'early') yield { type: 'message_metadata', phase: 'commentary' };
        yield { type: 'text_delta', delta: '正在读取文件。' };
        if (timing === 'late') yield { type: 'message_metadata', phase: 'commentary' };
        await gate.promise;
        yield { type: 'completed', response: textResponse('正在读取文件。') };
      },
    };
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '读取文件', 'r1');
    const current = () => app.runtime.snapshot('user-a', 's1') as {
      streaming: Array<{ content: string; phase?: string; displayPhase?: string; finalized: boolean }>;
      messages: Array<{ role: string; phase?: string; phaseSource?: string }>;
    };
    try {
      await waitUntil(() => current().streaming[0]?.content === '正在读取文件。' &&
        (timing !== 'late' || current().streaming[0]?.phase === 'commentary'));
      expect(current().streaming[0]).toMatchObject({finalized: false});
      expect(current().streaming[0]?.displayPhase).toBe(timing === 'early' ? 'commentary' : undefined);
    } finally { gate.resolve(); }
    await app.runtime.waitForIdle();
    expect(current().messages.at(-1)).toMatchObject({
      phase: timing === 'missing' ? 'final_answer' : 'commentary',
      phaseSource: timing === 'missing' ? 'compatibility' : 'provider',
    });
    expect(current().streaming[0]?.finalized).toBe(true);
    expect(snap('user-a', 's1').usage.modelRequests).toBe(1);
  });

  it('原生 commentary 不触发自动重试，也不作为历史答案回填', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) => index === 0
      ? {...textResponse('我会开始读取。'), phase: 'commentary'} : textResponse('直接回答'));
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '第一次', 'r1');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(1);
    expect(snap('user-a', 's1').turns[0]?.status).toBe('completed');
    submit('s1', '第二次', 'r2');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.some((message) => message.content === '我会开始读取。')).toBe(false);
  });

  it.each([undefined, 'commentary'] as const)('工具驱动下一步保持不变，phase=%s', async (phase) => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) => index === 0
      ? {...textResponse('正在搜索历史。'), phase, stopReason: 'tool_calls',
          toolCalls: [{id: 'search1', name: 'event_search', arguments: {query: '第一次'}}]}
      : textResponse('搜索完成。'));
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '第一次', 'r1');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(2);
    expect(snap('user-a', 's1').usage).toMatchObject({modelRequests: 2, toolCalls: 1});
    const messages = app.repos.sessions.listEvents('user-a', 's1').filter((event) => event.eventType === 'assistant.message');
    expect(messages[0]?.payload).toMatchObject({phase: 'commentary', phaseSource: phase ? 'provider' : 'compatibility'});
    expect(messages[1]?.payload).toMatchObject({phase: 'final_answer'});
    expect(adapter.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('取消流式输出保留部分文本并关闭加载状态', async () => {
    const adapter: LlmAdapter = {
      providerType: 'fake',
      generate: async () => textResponse('unused'),
      async *stream(_request, signal): AsyncIterable<ModelStreamEvent> {
        yield {type: 'message_metadata', phase: 'commentary'};
        yield {type: 'text_delta', delta: '已读取一部分'};
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          else signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        });
      },
    };
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '读取', 'r1');
    const current = () => app.runtime.snapshot('user-a', 's1') as {streaming: Array<{content: string; finalized: boolean; interrupted?: boolean}>};
    await waitUntil(() => current().streaming[0]?.content === '已读取一部分');
    app.runtime.cancelTurn('user-a', 's1', snap('user-a', 's1').activeTurnId!);
    await app.runtime.waitForIdle();
    expect(current().streaming[0]).toMatchObject({content: '已读取一部分', finalized: true, interrupted: true});
    expect(snap('user-a', 's1').turns[0]?.status).toBe('cancelled');
    expect(snap('user-a', 's1').messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('连续沉默时在已有请求中临时提醒，正文恢复后重置且不累积历史', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index >= 5) return textResponse('完成');
      return {
        content: index === 2 ? '已确认结果，继续核验。' : '',
        reasoning: '仅有推理不算执行说明',
        toolCalls: [{ id: `progress-${index}`, name: 'event_search', arguments: { query: 'x' } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls',
      };
    });
    app = makeApp(adapter);
    createConfiguredSession('s1');
    submit('s1', '检查信息', 'progress');
    await app.runtime.waitForIdle();
    expect(adapter.requests).toHaveLength(6);
    const reminders = adapter.requests.map((request) => request.messages.filter(
      (message) => message.role === 'system' && message.content.includes('进度沟通提醒：'),
    ).length);
    expect(reminders).toEqual([0, 1, 0, 0, 1, 0]);
    expect(snap('user-a', 's1').messages.some((message) => message.content.startsWith('进度沟通提醒：'))).toBe(false);
    submit('s1', '后续直接回答', 'progress-next');
    await app.runtime.waitForIdle();
    expect(adapter.requests[6]?.messages.some((message) => message.content.includes('进度沟通提醒：'))).toBe(false);
  });

  function makeApp(
    adapter: LlmAdapter,
    tools?: ToolRegistry,
    runtimeOptions?: RuntimeServiceOptions,
  ): WorkerApplication {
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    return createWorkerApplication({
      appDataDir: root,
      generation: 2,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
      runtimeOptions,
    });
  }

  function createConfiguredSession(
    sessionId: string,
    contextWindow = 8192,
    maxOutputTokens = 512,
    maxOutputCapability = maxOutputTokens,
  ): void {
    configureModel('user-a', contextWindow, maxOutputTokens, maxOutputCapability);
    app.runtime.createSession('user-a', { sessionId, title: sessionId });
  }

  function configureModel(
    userId: 'user-a' | 'user-b',
    contextWindow = 8192,
    maxOutputTokens = 512,
    maxOutputCapability = maxOutputTokens,
  ): void {
    if (app.repos.models.getDefaultModelId(userId)) return;
    app.repos.models.createService({
      id: `service-${userId}`,
      userId,
      name: 'Fake',
      providerType: 'fake',
      endpoint: 'https://invalid.local',
      credentialRef: null,
      config: {},
      now: '2025-01-01T00:00:00.000Z',
    });
    app.repos.models.createModel({
      id: `model-${userId}`,
      userId,
      serviceId: `service-${userId}`,
      remoteModelId: 'fake-model',
      displayName: 'Fake Model',
      contextWindow,
      maxOutputTokens,
      maxOutputCapability,
      capabilities: { tools: true },
      defaultParams: {},
      source: 'manual',
      now: '2025-01-01T00:00:00.000Z',
    });
    app.repos.models.setDefaultModel(userId, `model-${userId}`, '2025-01-01T00:00:00.000Z');
  }

  function submit(sessionId: string, content: string, idempotencyKey: string) {
    return app.runtime.submitInput('user-a', {
      sessionId,
      content,
      idempotencyKey,
      startNewEvent: true,
    });
  }

  function snap(userId: 'user-a' | 'user-b', sessionId: string): Snapshot {
    return app.runtime.snapshot(userId, sessionId) as Snapshot;
  }

  function columns(table: string): string[] {
    const db = database();
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  function tableNames(): string[] {
    return (
      database().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  }

  function database() {
    const repo = app.repos.sessions as unknown as { db: Database.Database };
    return repo.db;
  }

  function raw(eventType: string, payload: unknown) {
    return {
      eventId: `raw-${eventType}`,
      eventType,
      schemaVersion: 1,
      occurredAt: '2025-01-01T00:00:00.000Z',
      payload,
    };
  }
});
