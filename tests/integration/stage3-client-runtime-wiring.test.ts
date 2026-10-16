import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import {
  deriveInputSubmissionPolicy,
  shouldRefreshSessionList,
} from '../../packages/app-ui/src/runtime-wiring-policy';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { FakeLlmAdapter, SequenceIdProvider, textResponse } from '../../packages/test-kit/src/runtime';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

describe('Stage 3 Client 与 Stage 2 Runtime 联合接线', () => {
  let root: string;
  let app: WorkerApplication;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    app?.close();
    cleanupDir(root);
  });

  it('空闲连续发送延续同一事项，并把最近完整问答送入下一次模型请求', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      textResponse(index === 0 ? '好的，我记住了，我叫小爱同学。' : '我叫小爱同学。'),
    );
    app = makeApp(adapter);
    configureModel();
    app.runtime.createSession('user-a', { sessionId: 'memory-session', title: '记忆测试' });

    await submitAsClient('你记住你叫小爱同学', false, 'memory-1');
    await submitAsClient('你叫什么', false, 'memory-2');

    expect(app.runtime.conversationEventList('user-a', 'memory-session')).toHaveLength(1);
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '你记住你叫小爱同学' }),
        expect.objectContaining({ role: 'assistant', content: '好的，我记住了，我叫小爱同学。' }),
        expect.objectContaining({ role: 'user', content: '你叫什么' }),
      ]),
    );
  });

  it('显式新事项仍保留最近两轮问答作为跨 Event 短期记忆保底', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      textResponse(index === 0 ? '已记住称呼。' : '仍然记得。'),
    );
    app = makeApp(adapter);
    configureModel();
    app.runtime.createSession('user-a', { sessionId: 'memory-session', title: '跨事项测试' });

    await submitAsClient('以后叫我小爱同学', false, 'event-1');
    app.runtime.submitInput('user-a', {
      sessionId: 'memory-session',
      content: '现在开始另一个事项，但你还记得我的称呼吗',
      idempotencyKey: 'event-2',
      startNewEvent: true,
      mode: 'queue',
    });
    await app.runtime.waitForIdle('user-a', 'memory-session');

    expect(app.runtime.conversationEventList('user-a', 'memory-session')).toHaveLength(2);
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '以后叫我小爱同学' }),
        expect.objectContaining({ role: 'assistant', content: '已记住称呼。' }),
      ]),
    );
  });

  it('输入策略区分空闲追问、运行中排队和下一步介入', () => {
    expect(deriveInputSubmissionPolicy('queue', false)).toEqual({
      mode: 'queue',
      startNewEvent: false,
    });
    expect(deriveInputSubmissionPolicy('queue', true)).toEqual({
      mode: 'queue',
      startNewEvent: true,
    });
    expect(deriveInputSubmissionPolicy('steer', true)).toEqual({
      mode: 'steer',
      startNewEvent: false,
    });
  });

  it('流式 chunk 不触发会话列表重查，状态边界事件才刷新', () => {
    const event = (eventType: 'assistant.chunk' | 'turn.ended') => ({
      userId: 'user-a',
      sessionId: 's1',
      seq: 1,
      eventId: 'log-1',
      eventType,
      schemaVersion: 1,
      occurredAt: '2025-01-01T00:00:00.000Z',
      requestId: null,
      payload: {},
    });
    expect(shouldRefreshSessionList([event('assistant.chunk')])).toBe(false);
    expect(shouldRefreshSessionList([event('turn.ended')])).toBe(true);
  });

  async function submitAsClient(
    content: string,
    hasActiveTurn: boolean,
    key: string,
  ): Promise<void> {
    app.runtime.submitInput('user-a', {
      sessionId: 'memory-session',
      content,
      idempotencyKey: key,
      ...deriveInputSubmissionPolicy('queue', hasActiveTurn),
    });
    await app.runtime.waitForIdle('user-a', 'memory-session');
  }

  function makeApp(adapter: FakeLlmAdapter): WorkerApplication {
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    return createWorkerApplication({
      appDataDir: root,
      generation: 3,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
    });
  }

  function configureModel(): void {
    app.repos.models.createService({
      id: 'service-a',
      userId: 'user-a',
      name: 'Fake',
      providerType: 'fake',
      endpoint: 'https://invalid.local',
      credentialRef: null,
      config: {},
      now: '2025-01-01T00:00:00.000Z',
    });
    app.repos.models.createModel({
      id: 'model-a',
      userId: 'user-a',
      serviceId: 'service-a',
      remoteModelId: 'fake-model',
      displayName: 'Fake Model',
      contextWindow: 8192,
      maxOutputTokens: 512,
      capabilities: { tools: true },
      defaultParams: {},
      source: 'manual',
      now: '2025-01-01T00:00:00.000Z',
    });
    app.repos.models.setDefaultModel('user-a', 'model-a', '2025-01-01T00:00:00.000Z');
  }
});
