import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry, type LlmAdapter } from '../../packages/runtime-core/src/model';
import { ToolRegistry } from '../../packages/runtime-core/src/tools';
import type { RuntimeServiceOptions } from '../../packages/runtime-core/src/runtime-service';
import { estimateTextTokens } from '../../packages/protocol/src/token-estimate';
import { projectRuntime } from '../../packages/protocol/src/client/projection';
import { materializeSurface } from '../../packages/runtime-core/src/surface-compactor';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import {
  FakeLlmAdapter,
  SequenceIdProvider,
  textResponse,
} from '../../packages/test-kit/src/runtime';

interface Snapshot {
  turns: Array<{ id: string; status: string }>;
}

describe('工具结果入模限额与 Runtime 集成', () => {
  let root: string;
  let app: WorkerApplication;
  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    app?.close();
    cleanupDir(root);
  });

  it('低于压力阈值也限制每条工具结果，保留原文并可从事件重建模型视图', async () => {
    const tools = new ToolRegistry();
    const rawResults = {
      huge_json: JSON.stringify({
        rows: Array.from({ length: 20000 }, (_, id) => ({ id, text: '原始数据😀' })),
      }),
      mcp_fixture_query: '查询结果'.repeat(4000),
      small_result: '无需裁剪',
    };
    const executions: string[] = [];
    for (const [name, text] of Object.entries(rawResults)) {
      tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'string' },
          render: (_args, value: string) => [
            { type: 'text', text: '包装标题\n' },
            { type: 'text', text: value },
            { type: 'resource', uri: 'result://details', text: '\n包装尾部' },
          ],
        },
        concurrencySafe: true,
        async execute() {
          executions.push(name);
          return text;
        },
      });
    }
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? {
            content: '',
            toolCalls: Object.keys(rawResults).map((name) => ({ id: name, name, arguments: {} })),
            usage: { inputTokens: 10, outputTokens: 10 },
            stopReason: 'tool_calls',
          }
        : textResponse('完成'),
    );
    app = makeApp(adapter, tools, {
      toolOutputTokenLimit: 256,
      toolOutputTokenLimits: { mcp_fixture_query: 512 },
    });
    createConfiguredSession('s1', 2_000_000, 1000);
    submit('s1', '查询数据', 'limit-1');
    await app.runtime.waitForIdle();
    expect(snap('user-a', 's1').turns[0]?.status).toBe('completed');
    expect(adapter.requests.map((request) => request.purpose)).toEqual(['agent', 'agent']);
    expect(executions.sort()).toEqual(Object.keys(rawResults).sort());
    const outputs = adapter.requests[1]!.messages.filter((message) => message.role === 'tool');
    expect(outputs.map((message) => message.toolCallId)).toEqual(Object.keys(rawResults));
    expect(outputs[2]?.content).toBe('包装标题\n\n无需裁剪\n\n包装尾部');
    for (const output of outputs) {
      expect(estimateTextTokens(output.content) + 4).toBeLessThanOrEqual(
        output.toolCallId === 'mcp_fixture_query' ? 512 : 256,
      );
    }
    const events = app.repos.sessions.listEvents('user-a', 's1');
    const replayed = projectRuntime(events);
    for (const [name, original] of Object.entries(rawResults)) {
      const call = replayed.toolCalls.get(name)!;
      expect(call.output).toEqual([
        { type: 'text', text: '包装标题\n' },
        { type: 'text', text: original },
        { type: 'resource', uri: 'result://details', text: '\n包装尾部' },
      ]);
      if (name !== 'small_result') {
        expect(outputs.find((message) => message.toolCallId === name)?.content).toContain(
          `tool.result seq=${call.resultSeq}`,
        );
      }
    }
    expect(
      replayed.surfaceReplacements.map((replacement) => [
        replacement.kind,
        replacement.toolOutputTokenLimit,
      ]),
    ).toEqual([
      ['tool-output-limit', 256],
      ['tool-output-limit', 512],
    ]);
    expect(
      materializeSurface(replayed)
        .filter((message) => message.role === 'tool')
        .map((message) => message.content),
    ).toEqual(outputs.map((message) => message.content));
    expect(
      replayed.messages.find((message) => message.toolCallId === 'huge_json')?.content,
    ).toContain(rawResults.huge_json);
  });

  it('入模限额与检查点压缩共同工作，超限恢复只重试模型请求', async () => {
    const tools = new ToolRegistry();
    let executions = 0;
    tools.register({
      name: 'bounded_read',
      description: '读取数据',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value: string) => [{ type: 'text', text: value }],
      },
      concurrencySafe: true,
      async execute() {
        executions++;
        return '完整证据'.repeat(5000);
      },
    });
    let requests = 0;
    let overflowed = false;
    const adapter = new FakeLlmAdapter((request) => {
      if (request.purpose === 'compaction') return textResponse('检查点：读取完成，继续核对。');
      const calls = request.messages
        .flatMap((message) => message.toolCalls ?? [])
        .map((call) => call.id);
      const results = request.messages.filter((message) => message.role === 'tool');
      expect(results.map((message) => message.toolCallId)).toEqual(calls);
      expect(results.every((message) => estimateTextTokens(message.content) + 4 <= 256)).toBe(true);
      if (executions === 2 && !overflowed) {
        overflowed = true;
        const error = new Error('provider context overflow');
        error.name = 'MODEL_CONTEXT_WINDOW_EXCEEDED';
        throw error;
      }
      if (++requests === 9) return textResponse('完成');
      return {
        content: '',
        toolCalls: [{ id: `bounded-${requests}`, name: 'bounded_read', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 10 },
        stopReason: 'tool_calls',
      };
    });
    app = makeApp(adapter, tools, { toolOutputTokenLimit: 256, safetyTokens: 100 });
    createConfiguredSession('s1', 4000, 500);
    submit('s1', '读取并核对', 'bounded-loop');
    await app.runtime.waitForIdle();
    expect(snap('user-a', 's1').turns[0]?.status).toBe('completed');
    expect(overflowed).toBe(true);
    expect(executions).toBe(8);
    const events = app.repos.sessions.listEvents('user-a', 's1');
    const replayed = projectRuntime(events);
    expect(
      replayed.surfaceReplacements.filter(
        (replacement) => replacement.kind === 'tool-output-limit',
      ),
    ).toHaveLength(8);
    expect(
      replayed.surfaceReplacements.some((replacement) => replacement.kind === 'checkpoint'),
    ).toBe(true);
    expect(adapter.requests.filter((request) => request.purpose === 'agent')).toHaveLength(10);
  });

  it('单条结果均已限额但合计仍超预算时，最终检查拒绝发送请求', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'batch_read',
      description: '读取一份数据',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value: string) => [{ type: 'text', text: value }],
      },
      concurrencySafe: true,
      async execute() {
        return '原始内容'.repeat(1000);
      },
    });
    const adapter = new FakeLlmAdapter(() => ({
      content: '',
      toolCalls: Array.from({ length: 16 }, (_, index) => ({
        id: `batch-${index}`,
        name: 'batch_read',
        arguments: {},
      })),
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'tool_calls',
    }));
    app = makeApp(adapter, tools, { toolOutputTokenLimit: 256, safetyTokens: 100 });
    createConfiguredSession('s1', 4000, 500);
    submit('s1', '读取全部数据', 'batch-limit');
    await app.runtime.waitForIdle();
    const events = app.repos.sessions.listEvents('user-a', 's1');
    expect(projectRuntime(events).surfaceReplacements).toHaveLength(16);
    expect(events.filter((event) => event.eventType === 'tool.result')).toHaveLength(16);
    expect(events.find((event) => event.eventType === 'turn.ended')?.payload).toMatchObject({
      reason: 'context_budget_exceeded',
    });
    expect(adapter.requests).toHaveLength(1);
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
  ): void {
    configureModel('user-a', contextWindow, maxOutputTokens);
    app.runtime.createSession('user-a', { sessionId, title: sessionId });
  }

  function configureModel(
    userId: 'user-a' | 'user-b',
    contextWindow = 8192,
    maxOutputTokens = 512,
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
});
