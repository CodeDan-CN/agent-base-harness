import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import { ToolRegistry } from '../../packages/runtime-core/src/tools';
import { ElicitationBridge } from '../../packages/runtime-core/src/mcp/elicitation';
import { projectRuntime } from '../../packages/protocol/src/client/projection';
import { makeTempDir, cleanupDir } from '../../packages/test-kit/src/temp';
import { FakeLlmAdapter, textResponse, waitUntil } from '../../packages/test-kit/src/runtime';

describe('真实 SDK → Runtime 确认 → 原工具恢复', () => {
  let app: WorkerApplication;
  let root: string;
  let client: Client;
  let server: Server;
  let writes = 0;
  let adapter: FakeLlmAdapter;
  const projection = () => projectRuntime(app.repos.sessions.listEvents('user-a', 'test'));
  const pending = () => [...projection().interactions.values()].find((x) => x.status === 'pending');
  afterEach(async () => {
    app?.close();
    await client?.close();
    await server?.close();
    cleanupDir(root);
  });
  async function setup(timeout = 5000) {
    writes = 0;
    root = makeTempDir('mcp-confirmation-');
    client = new Client(
      { name: 'test', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    );
    server = new Server({ name: 'TEST_ONLY', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const result = await server.elicitInput({
        message: 'TEST_ONLY: amount=100, draft=abc',
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', default: true } },
          required: ['confirm'],
        },
      });
      if (result.action === 'accept' && result.content?.confirm === true) writes++;
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    const bridge = new ElicitationBridge();
    bridge.attach(client, 'TEST_ONLY');
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(left), server.connect(right)]);
    const tools = new ToolRegistry();
    tools.register({
      name: 'confirm_test',
      description: 'Test isolated confirmation',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, context) {
        const result = await bridge.run(client, context, () =>
          client.callTool({ name: 'commit', arguments: {} }, undefined, { timeout }),
        );
        return { status: 'success', content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    });
    adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? {
            ...textResponse(''),
            toolCalls: [{ id: 'commit-1', name: 'confirm_test', arguments: {} }],
            stopReason: 'tool_calls',
          }
        : textResponse('done'),
    );
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      llmAdapters: adapters,
      tools,
    });
    const now = new Date().toISOString();
    app.repos.models.createService({
      id: 'fake-service',
      userId: 'user-a',
      name: 'Fake',
      providerType: 'fake',
      endpoint: 'https://invalid.local',
      credentialRef: null,
      config: {},
      now,
    });
    app.repos.models.createModel({
      id: 'fake-model',
      userId: 'user-a',
      serviceId: 'fake-service',
      remoteModelId: 'fake-model',
      displayName: 'Fake',
      contextWindow: 32000,
      maxOutputTokens: 512,
      capabilities: { tools: true },
      defaultParams: {},
      source: 'manual',
      now,
    });
    app.repos.models.setDefaultModel('user-a', 'fake-model', now);
    app.runtime.createSession('user-a', { sessionId: 'test', title: 'TEST_ONLY' });
    app.runtime.submitInput('user-a', {
      sessionId: 'test',
      content: 'TEST_ONLY confirmation',
      idempotencyKey: 'input-1',
      startNewEvent: true,
    });
    await waitUntil(() => Boolean(pending()));
  }
  it('等待显式确认；同一 Turn 返回，不新增模型解释授权或重复写入', async () => {
    await setup();
    expect(writes).toBe(0);
    expect(adapter.requests).toHaveLength(1);
    const interaction = pending()!;
    expect(interaction.prompt).toContain('draft=abc');
    const input = {
      sessionId: 'test',
      interactionId: interaction.id,
      value: true,
      resolution: 'submitted' as const,
      idempotencyKey: 'confirm-1',
    };
    expect(app.runtime.resolveInteraction('user-a', input).inboxItemId).toBeNull();
    expect(app.runtime.resolveInteraction('user-a', input).inboxItemId).toBeNull();
    await app.runtime.waitForIdle();
    expect(writes).toBe(1);
    expect(adapter.requests).toHaveLength(2);
    expect(projection().turns.size).toBe(1);
    expect(projection().inbox).toHaveLength(0);
  });
  it.each(['rejected', 'cancelled'] as const)('%s 不写入，保持原 Turn 完成', async (resolution) => {
    await setup();
    app.runtime.resolveInteraction('user-a', {
      sessionId: 'test',
      interactionId: pending()!.id,
      value: false,
      resolution,
      idempotencyKey: resolution,
    });
    await app.runtime.waitForIdle();
    expect(writes).toBe(0);
    expect(adapter.requests).toHaveLength(2);
    expect(pending()).toBeUndefined();
  });
  it('越权用户、错误会话、非布尔值不能解锁', async () => {
    await setup();
    const input = {
      sessionId: 'test',
      interactionId: pending()!.id,
      value: true,
      idempotencyKey: 'bad',
    };
    expect(() => app.runtime.resolveInteraction('user-b', input)).toThrow();
    expect(() =>
      app.runtime.resolveInteraction('user-a', { ...input, sessionId: 'other' }),
    ).toThrow();
    expect(() => app.runtime.resolveInteraction('user-a', { ...input, value: 'true' })).toThrow();
    expect(writes).toBe(0);
    expect(pending()).toBeDefined();
  });
  it('SDK 超时关闭确认，迟到点击不能写入', async () => {
    await setup(200);
    const id = pending()!.id;
    await app.runtime.waitForIdle();
    expect(writes).toBe(0);
    expect(pending()).toBeUndefined();
    expect(() =>
      app.runtime.resolveInteraction('user-a', {
        sessionId: 'test',
        interactionId: id,
        value: true,
        idempotencyKey: 'late',
      }),
    ).toThrow();
  });
  it('停止 Turn 取消正在等待的协议确认', async () => {
    await setup();
    const id = pending()!.id;
    app.runtime.cancelTurn('user-a', 'test', projection().activeTurn!.id);
    await app.runtime.waitForIdle();
    expect(writes).toBe(0);
    expect(projection().interactions.get(id)?.resolution).toBe('cancelled');
  });
  it('重启恢复令持久化的旧确认失效，不重放副作用', async () => {
    root = makeTempDir('mcp-recovery-');
    app = createWorkerApplication({ appDataDir: root, generation: 1, logger: new MemoryLogger() });
    app.runtime.createSession('user-a', { sessionId: 'test', title: 'recovery' });
    const entries = [
      ['conversation.event.created', { eventId: 'ev', title: 'recover' }],
      ['conversation.exchange.started', { exchangeId: 'ex', eventId: 'ev', turnId: 't' }],
      ['turn.started', { turnId: 't', eventId: 'ev', exchangeId: 'ex' }],
      [
        'tool.call',
        {
          toolCallId: 'c',
          requestId: 'r',
          stepId: 's',
          turnId: 't',
          eventId: 'ev',
          toolName: 'commit',
          input: {},
          replaySafe: false,
          callIndex: 0,
        },
      ],
      [
        'interaction.requested',
        {
          interactionId: 'i',
          toolCallId: 'c',
          eventId: 'ev',
          turnId: 't',
          prompt: 'TEST_ONLY',
          kind: 'approval',
          options: [],
          schema: { type: 'boolean', 'x-harness-source': 'mcp' },
        },
      ],
    ] as const;
    app.repos.sessions.append({
      userId: 'user-a',
      sessionId: 'test',
      expectedVersion: app.repos.sessions.getSession('user-a', 'test')!.version,
      events: entries.map(([eventType, payload], index) => ({
        eventId: `raw-${index}`,
        eventType,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        payload,
      })),
    });
    app.runtime.recover();
    expect(projection().interactions.get('i')?.resolution).toBe('cancelled');
    expect(projection().toolCalls.get('c')?.errorCode).toBe('UNKNOWN_SIDE_EFFECT');
    expect(() =>
      app.runtime.resolveInteraction('user-a', {
        sessionId: 'test',
        interactionId: 'i',
        value: true,
        idempotencyKey: 'old',
      }),
    ).toThrow();
  });
});
