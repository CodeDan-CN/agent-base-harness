import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry, type ModelResponse } from '../../packages/runtime-core/src/model';
import { ToolRegistry, type RuntimeTool } from '../../packages/runtime-core/src/tools';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { FakeLlmAdapter, SequenceIdProvider, textResponse, waitUntil } from '../../packages/test-kit/src/runtime';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

describe('4.7.5 direct agent delegation', () => {
  let root = '';
  let app: WorkerApplication | undefined;

  afterEach(() => {
    app?.close();
    if (root) cleanupDir(root);
  });

  it('runs a delegated agent with its own profile and no nested agent_call', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        expect(request.tools.map((tool) => tool.name)).toContain('agent_call');
        return toolResponse('search-finance', 'capability_search', {});
      }
      if (index === 1) {
        expect(request.tools.map((tool) => tool.name)).toContain('agent_call');
        expect(request.model.modelId).toBe('fake-model');
        const discovery = request.messages.find(
          (message) => message.role === 'tool' && message.content.includes('"candidates"'),
        );
        expect(discovery?.content).toContain(targetAgentId);
        expect(discovery?.content).toContain('金融研究员');
        expect(discovery?.content).not.toContain('你是金融研究员');
        return toolResponse('call-finance', 'agent_call', {
          targetAgentId,
          task: '分析这家公司',
          allowSharedMemory: false,
        });
      }
      if (index === 2) {
        expect(request.tools.map((tool) => tool.name)).not.toContain('agent_call');
        expect(request.messages[0]?.content).toContain('你是金融研究员');
        return textResponse('金融智能体报告');
      }
      expect(request.messages.some((message) => message.content.includes('金融智能体报告'))).toBe(
        true,
      );
      return textResponse('Dylan 汇总完成');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);

    let revision = app.agentManagement.snapshot('user-a').revision;
    const profile = app.agentManagement.create('user-a', {
      name: '金融研究员',
      description: '公司研究',
      avatarKey: null,
      instructions: '你是金融研究员',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: revision,
    });
    targetAgentId = profile.id;
    revision = app.agentManagement.snapshot('user-a').revision;
    app.agentManagement.toggleDelegate('user-a', 'dylan', profile.id, true, revision);

    app.runtime.createSession('user-a', {
      sessionId: 'root-session',
      agentId: 'dylan',
      title: '根会话',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'root-session',
      content: '请分析并汇总',
      idempotencyKey: 'root-input',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();

    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests.every((request) => request.purpose === 'agent')).toBe(true);
    const parentSnapshot = app.runtime.snapshot('user-a', 'root-session') as {
      turns: Array<{ status: string }>;
    };
    expect(parentSnapshot.turns.at(-1)?.status).toBe('completed');
    expect(
      adapter.requests[1]?.messages.some(
        (message) => message.role === 'tool' && message.content.includes(targetAgentId),
      ),
    ).toBe(true);
    const delegation = app.repos.delegations.getByToolCall('user-a', 'call-finance');
    expect(delegation).toMatchObject({
      parentSessionId: 'root-session',
      targetAgentId: profile.id,
      status: 'completed',
    });
    expect(app.repos.sessions.getSession('user-a', delegation!.delegatedSessionId)).toMatchObject({
      agentId: profile.id,
      origin: 'delegated',
      parentSessionId: 'root-session',
    });
  });

  it('keeps delegated provider failure terminal and never promotes commentary to a report', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        return toolResponse('failed-call', 'agent_call', {
          targetAgentId,
          task: '查询市场数据',
          allowSharedMemory: false,
        });
      }
      if (index === 1) {
        expect(request.tools.map((tool) => tool.name)).not.toContain('agent_call');
        return {
          ...toolResponse('child-list', 'turn_list', {}),
          content: '我先查找可用的行情数据能力。',
          chunks: ['我先查找可用的行情数据能力。'],
          phase: 'commentary',
        };
      }
      if (index === 2) {
        const error = new Error('provider rejected request');
        error.name = 'MODEL_PROVIDER_REQUEST_FAILED';
        throw error;
      }
      expect(
        request.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.content.includes('受派智能体执行失败：model_provider_request_failed'),
        ),
      ).toBe(true);
      return textResponse('父智能体已识别受派失败');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const target = app.agentManagement.create('user-a', {
      name: '市场研究员',
      description: '',
      avatarKey: null,
      instructions: '查询市场数据并返回最终报告',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = target.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      target.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'failed-root',
      agentId: 'dylan',
      title: 'failed-root',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'failed-root',
      content: '查询并汇总',
      idempotencyKey: 'failed-input',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();

    const delegation = app.repos.delegations.getByToolCall('user-a', 'failed-call');
    expect(delegation).toMatchObject({ status: 'failed', resultEventRef: null });
    const parentEvents = app.repos.sessions.listEvents('user-a', 'failed-root');
    expect(
      parentEvents
        .filter((event) => event.eventType === 'agent.delegation.status-changed')
        .map((event) => (event.payload as { status?: string }).status),
    ).toEqual(['running', 'failed']);
    expect(
      parentEvents.find(
        (event) =>
          event.eventType === 'tool.result' &&
          (event.payload as { toolName?: string }).toolName === 'agent_call',
      )?.payload,
    ).toMatchObject({
      status: 'fatal_error',
      errorCode: 'DELEGATED_AGENT_FAILED',
    });
    const childSnapshot = app.runtime.snapshot('user-a', delegation!.delegatedSessionId) as {
      turns: Array<{ status: string; endReason: string | null }>;
      messages: Array<{ phase?: string; content: string }>;
    };
    expect(childSnapshot.turns.at(-1)).toMatchObject({
      status: 'failed',
      endReason: 'model_provider_request_failed',
    });
    const childAssistantMessages = childSnapshot.messages.filter((message) => 'phase' in message);
    expect(childAssistantMessages).toEqual([
      expect.objectContaining({
        phase: 'commentary',
        content: '我先查找可用的行情数据能力。',
      }),
    ]);
  });

  it('requires a final_answer before a completed child turn becomes a delegation report', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        return toolResponse('commentary-call', 'agent_call', {
          targetAgentId,
          task: '生成完整报告',
          allowSharedMemory: false,
        });
      }
      if (index === 1) {
        return {
          ...textResponse('我正在准备报告。'),
          phase: 'commentary',
        };
      }
      expect(
        request.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.content.includes('受派智能体执行失败：missing_final_answer'),
        ),
      ).toBe(true);
      return textResponse('父智能体已识别报告缺失');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const target = app.agentManagement.create('user-a', {
      name: '报告员',
      description: '',
      avatarKey: null,
      instructions: '必须返回最终报告',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = target.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      target.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'commentary-root',
      agentId: 'dylan',
      title: 'commentary-root',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'commentary-root',
      content: '生成报告',
      idempotencyKey: 'commentary-input',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();

    const delegation = app.repos.delegations.getByToolCall('user-a', 'commentary-call');
    expect(delegation).toMatchObject({ status: 'failed', resultEventRef: null });
    const toolResult = app.repos.sessions
      .listEvents('user-a', 'commentary-root')
      .find(
        (event) =>
          event.eventType === 'tool.result' &&
          (event.payload as { toolName?: string }).toolName === 'agent_call',
      );
    expect(toolResult?.payload).toMatchObject({
      status: 'fatal_error',
      errorCode: 'DELEGATED_AGENT_NO_FINAL_REPORT',
    });
  });

  it('propagates parent cancellation only to the delegated child', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    const adapter = new FakeLlmAdapter((request, signal, index) => {
      if (index === 0) {
        return toolResponse('cancel-call', 'agent_call', {
          targetAgentId,
          task: '等待取消',
          allowSharedMemory: false,
        });
      }
      return new Promise<ModelResponse>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('cancelled'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const created = app.agentManagement.create('user-a', {
      name: '慢速智能体',
      description: '',
      avatarKey: null,
      instructions: '',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = created.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      created.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'cancel-root',
      agentId: 'dylan',
      title: 'cancel-root',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'cancel-root',
      content: '开始',
      idempotencyKey: 'cancel-input',
      startNewEvent: true,
    });
    await waitUntil(() => adapter.requests.length === 2);
    const snapshot = app.runtime.snapshot('user-a', 'cancel-root') as {
      activeTurnId: string | null;
    };
    expect(snapshot.activeTurnId).not.toBeNull();
    app.runtime.cancelTurn('user-a', 'cancel-root', snapshot.activeTurnId!);
    await app.runtime.waitForIdle();

    expect(app.repos.delegations.getByToolCall('user-a', 'cancel-call')?.status).toBe('cancelled');
  });

  it('mirrors delegated questions to the parent and keeps agent_call waiting for the answer', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        return toolResponse('question-call', 'agent_call', {
          targetAgentId,
          task: '先向用户确认范围再完成',
          allowSharedMemory: false,
        });
      }
      if (index === 1) {
        expect(request.tools.map((tool) => tool.name)).not.toContain('agent_call');
        return toolResponse('child-question', 'request_user_input', {
          prompt: '是否覆盖海外市场？',
          kind: 'confirm',
          requiresUserProvidedFact: true,
        });
      }
      if (index === 2) {
        expect(request.messages.some((message) => message.content.includes('true'))).toBe(true);
        return textResponse('已覆盖海外市场并完成分析');
      }
      expect(
        request.messages.some((message) => message.content.includes('已覆盖海外市场并完成分析')),
      ).toBe(true);
      return textResponse('父智能体已汇总');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const target = app.agentManagement.create('user-a', {
      name: '市场研究员',
      description: '',
      avatarKey: null,
      instructions: '完成市场研究',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = target.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      target.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'question-root',
      agentId: 'dylan',
      title: 'question-root',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'question-root',
      content: '开始研究',
      idempotencyKey: 'question-input',
      startNewEvent: true,
    });

    await waitUntil(() => {
      const snapshot = app!.runtime.snapshot('user-a', 'question-root') as {
        interactions: Array<{ status: string }>;
      };
      return snapshot.interactions.some((interaction) => interaction.status === 'pending');
    });
    const waiting = app.runtime.snapshot('user-a', 'question-root') as {
      activeTurnId: string | null;
      interactions: Array<{ id: string; prompt: string; status: string }>;
    };
    expect(waiting.activeTurnId).not.toBeNull();
    expect(waiting.interactions[0]).toMatchObject({
      status: 'pending',
      prompt: '来自「市场研究员」：是否覆盖海外市场？',
    });
    expect(app.repos.delegations.getByToolCall('user-a', 'question-call')?.status).toBe(
      'awaiting_user',
    );

    app.runtime.resolveInteraction('user-a', {
      sessionId: 'question-root',
      interactionId: waiting.interactions[0]!.id,
      value: true,
      idempotencyKey: 'delegated-question-answer',
    });
    await app.runtime.waitForIdle();

    expect(adapter.requests).toHaveLength(4);
    expect(app.repos.delegations.getByToolCall('user-a', 'question-call')?.status).toBe(
      'completed',
    );
    const completed = app.runtime.snapshot('user-a', 'question-root') as {
      activeTurnId: string | null;
      interactions: Array<{ status: string; value?: unknown }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(completed.activeTurnId).toBeNull();
    expect(completed.interactions[0]).toMatchObject({ status: 'resolved', value: true });
    expect(completed.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '父智能体已汇总',
    });
  });

  it('mirrors delegated approvals to the parent and routes the decision back to the child', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    let executed = false;
    const externalTool: RuntimeTool<{ accepted: boolean }> = {
      name: 'delegated_external_write',
      description: 'writes an external value',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { accepted: { type: 'boolean' } },
          required: ['accepted'],
          additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'accepted' }],
      },
      concurrencySafe: false,
      replaySafe: false,
      exclusive: true,
      approvalPolicy: 'always',
      approvalScope: 'external',
      permissionIdentity: 'external:delegated-test:v1',
      async execute() {
        executed = true;
        return { accepted: true };
      },
    };
    const tools = new ToolRegistry();
    tools.register(externalTool);
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) {
        return toolResponse('approval-call', 'agent_call', {
          targetAgentId,
          task: '执行一次需审批的外部写入',
          allowSharedMemory: false,
        });
      }
      if (index === 1) return toolResponse('child-write', externalTool.name, {});
      if (index === 2) return textResponse('子智能体写入完成');
      return textResponse('父智能体确认完成');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const target = app.agentManagement.create('user-a', {
      name: '执行专员',
      description: '',
      avatarKey: null,
      instructions: '',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = target.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      target.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'approval-root',
      agentId: 'dylan',
      title: 'approval-root',
    });
    app.runtime.submitInput('user-a', {
      sessionId: 'approval-root',
      content: '执行',
      idempotencyKey: 'approval-input',
      startNewEvent: true,
    });

    await waitUntil(() => {
      const snapshot = app!.runtime.snapshot('user-a', 'approval-root') as {
        approvals: Array<{ status: string }>;
      };
      return snapshot.approvals.some((approval) => approval.status === 'pending');
    });
    const waiting = app.runtime.snapshot('user-a', 'approval-root') as {
      activeTurnId: string | null;
      approvals: Array<{ id: string; toolName: string; status: string }>;
    };
    expect(executed).toBe(false);
    expect(waiting.activeTurnId).not.toBeNull();
    expect(waiting.approvals[0]).toMatchObject({
      status: 'pending',
      toolName: '执行专员 · delegated_external_write',
    });

    app.runtime.resolveApproval('user-a', {
      sessionId: 'approval-root',
      approvalId: waiting.approvals[0]!.id,
      resolution: 'allowed-once',
      idempotencyKey: 'delegated-approval-answer',
    });
    await app.runtime.waitForIdle();

    expect(executed).toBe(true);
    expect(app.repos.delegations.getByToolCall('user-a', 'approval-call')?.status).toBe(
      'completed',
    );
    const completed = app.runtime.snapshot('user-a', 'approval-root') as {
      approvals: Array<{ status: string; resolution?: string }>;
    };
    expect(completed.approvals[0]).toMatchObject({
      status: 'resolved',
      resolution: 'allowed-once',
    });
  });

  it('freezes the caller Step permission for delegated execution', async () => {
    root = makeTempDir();
    let targetAgentId = '';
    let executed = false;
    const externalTool: RuntimeTool<{ accepted: boolean }> = {
      name: 'delegated_external_read',
      description: 'reads an external value',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { accepted: { type: 'boolean' } },
          required: ['accepted'],
          additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'accepted' }],
      },
      concurrencySafe: false,
      replaySafe: false,
      approvalPolicy: 'always',
      approvalScope: 'external',
      permissionIdentity: 'external:delegated-read:v1',
      async execute() {
        executed = true;
        return { accepted: true };
      },
    };
    const tools = new ToolRegistry();
    tools.register(externalTool);
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) {
        return toolResponse('inherited-permission-call', 'agent_call', {
          targetAgentId,
          task: '读取外部数据',
          allowSharedMemory: false,
        });
      }
      if (index === 1) return toolResponse('child-read', externalTool.name, {});
      if (index === 2) return textResponse('子智能体读取完成');
      return textResponse('父智能体确认完成');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
      runtimeOptions: { maxParallelSessions: 1 },
    });
    configureModel(app);
    const target = app.agentManagement.create('user-a', {
      name: '受限执行专员',
      description: '',
      avatarKey: null,
      instructions: '',
      defaultModelId: null,
      permissionPreset: 'approval-required',
      expectedRevision: app.agentManagement.snapshot('user-a').revision,
    });
    targetAgentId = target.id;
    app.agentManagement.toggleDelegate(
      'user-a',
      'dylan',
      target.id,
      true,
      app.agentManagement.snapshot('user-a').revision,
    );
    app.runtime.createSession('user-a', {
      sessionId: 'inherited-permission-root',
      agentId: 'dylan',
      title: 'inherited-permission-root',
    });
    app.runtime.setPermissionPreset('user-a', 'inherited-permission-root', 'full-access');
    app.runtime.submitInput('user-a', {
      sessionId: 'inherited-permission-root',
      content: '执行',
      idempotencyKey: 'inherited-permission-input',
      startNewEvent: true,
    });
    await app.runtime.waitForIdle();

    expect(executed).toBe(true);
    const parentSnapshot = app.runtime.snapshot('user-a', 'inherited-permission-root') as {
      approvals: Array<{ status: string }>;
    };
    expect(parentSnapshot.approvals).toEqual([]);
    const delegation = app.repos.delegations.getByToolCall('user-a', 'inherited-permission-call');
    expect(delegation?.status).toBe('completed');
    expect(
      app.repos.sessions.getSession('user-a', delegation!.delegatedSessionId)?.permissionPreset,
    ).toBe('full-access');
  });
});

function toolResponse(id: string, name: string, args: unknown): ModelResponse {
  return {
    content: '',
    chunks: [],
    toolCalls: [{ id, name, arguments: args }],
    usage: { inputTokens: 10, outputTokens: 4 },
    stopReason: 'tool_calls',
  };
}

function configureModel(app: WorkerApplication): void {
  app.repos.models.createService({
    id: 'fake-service',
    userId: 'user-a',
    name: 'Fake',
    providerType: 'fake',
    endpoint: 'https://invalid.local',
    credentialRef: null,
    config: {},
    now: '2026-09-07T00:00:00.000Z',
  });
  app.repos.models.createModel({
    id: 'fake-model',
    userId: 'user-a',
    serviceId: 'fake-service',
    remoteModelId: 'fake-model',
    displayName: 'Fake Model',
    contextWindow: 8192,
    maxOutputTokens: 512,
    capabilities: { tools: true },
    defaultParams: {},
    source: 'manual',
    now: '2026-09-07T00:00:00.000Z',
  });
  app.repos.models.setDefaultModel('user-a', 'fake-model', '2026-09-07T00:00:00.000Z');
}
