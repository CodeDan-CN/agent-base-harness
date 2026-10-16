import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import {
  LlmAdapterRegistry,
  type LlmAdapter,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../../packages/runtime-core/src/model';
import { ToolRegistry, type RuntimeTool } from '../../packages/runtime-core/src/tools';
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
  activeTurnId: string | null;
  turns: Array<{ id: string; status: string; stepCount: number; endReason: string }>;
  messages: Array<{ role: string; content: string }>;
  streaming: Array<{ content: string; finalized: boolean; interrupted?: boolean }>;
  reasoning: Array<{ content: string; finalized: boolean; interrupted?: boolean }>;
  usage: { modelRequests: number; inputTokens: number; outputTokens: number; toolCalls: number };
}

describe('模型空输出的有限恢复', () => {
  let root: string;
  let app: WorkerApplication;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    app?.close();
    cleanupDir(root);
  });

  it('正常正文只请求一次', async () => {
    const adapter = new FakeLlmAdapter(() => textResponse('正常回答'));
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(snapshot().turns).toEqual([
      expect.objectContaining({ status: 'completed', stepCount: 1 }),
    ]);
    expect(diagnostics()).toEqual([]);
  });

  it('只有工具调用的响应正常执行工具，不消耗空输出恢复请求', async () => {
    const tool = countingTool();
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0 ? toolResponse() : textResponse('工具已完成'),
    );
    start(adapter, tool.registry);
    await run();

    expect(adapter.requests).toHaveLength(2);
    expect(tool.calls()).toBe(1);
    expect(snapshot().usage).toMatchObject({ modelRequests: 2, toolCalls: 1 });
    expect(diagnostics()).toEqual([]);
  });

  it('只有推理时恢复一次，保留用量并记录关联字段，日志不泄漏正文和推理', async () => {
    const reasoning = 'private-reasoning-sentinel';
    const answer = 'private-answer-sentinel';
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? emptyResponse(reasoning)
        : { ...textResponse(answer), usage: { inputTokens: 13, outputTokens: 7 } },
    );
    start(adapter);
    await run('private-user-sentinel');

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.requestId).not.toBe(adapter.requests[0]?.requestId);
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages);
    expect(snapshot().turns).toEqual([
      expect.objectContaining({ status: 'completed', stepCount: 2 }),
    ]);
    expect(snapshot().usage).toMatchObject({
      modelRequests: 2,
      inputTokens: 24,
      outputTokens: 12,
      toolCalls: 0,
    });
    expect(snapshot().messages.at(-1)).toMatchObject({ role: 'assistant', content: answer });

    const requests = payloads('model.request.context');
    expect(new Set(requests.map((request) => request.stepId)).size).toBe(2);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        level: 'warn',
        reason: 'empty_model_response',
        requestId: adapter.requests[0]?.requestId,
        stepId: requests[0]?.stepId,
        turnId: snapshot().turns[0]?.id,
        model: 'fake-model',
        reasoningChars: reasoning.length,
        contentChars: 0,
        toolCallCount: 0,
        stopReason: 'complete',
        inputTokens: 11,
        outputTokens: 5,
        willRetry: true,
        recoveryUsed: false,
      }),
      expect.objectContaining({
        level: 'info',
        recoveredFromRequestId: adapter.requests[0]?.requestId,
        requestId: adapter.requests[1]?.requestId,
      }),
    ]);
    const logs = JSON.stringify((app.logger as MemoryLogger).entries);
    for (const sentinel of [reasoning, answer, 'private-user-sentinel']) {
      expect(logs).not.toContain(sentinel);
    }
  });

  it('工具后空回复的恢复保留结果与原推理配对，不重复执行已完成的副作用', async () => {
    const tool = countingTool();
    const adapter = new FakeLlmAdapter((_request, _signal, index) => {
      if (index === 0) return toolResponse();
      if (index === 1) return emptyResponse('empty-attempt-reasoning');
      return textResponse('基于已完成的工具结果回答');
    });
    start(adapter, tool.registry);
    await run();

    expect(adapter.requests).toHaveLength(3);
    expect(tool.calls()).toBe(1);
    expect(payloads('tool.call')).toHaveLength(1);
    expect(payloads('tool.result')).toHaveLength(1);
    const retryContext = adapter.requests[2]!.messages;
    const toolAssistantIndex = retryContext.findIndex((message) => message.toolCalls?.length);
    expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(retryContext[toolAssistantIndex]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoningContent: 'tool-attempt-reasoning',
      toolCalls: [{ id: 'effect-call', name: 'record_effect', arguments: {} }],
    });
    expect(retryContext[toolAssistantIndex + 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'effect-call',
      content: 'effect-once',
    });
    expect(retryContext.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(retryContext)).not.toContain('empty-attempt-reasoning');
    expect(snapshot().usage).toMatchObject({ modelRequests: 3, toolCalls: 1 });
    expect(snapshot().turns[0]).toMatchObject({ status: 'completed', stepCount: 3 });
  });

  it('连续空回复两次即失败，同一 Turn 不继续无限重试', async () => {
    const adapter = new FakeLlmAdapter(() => emptyResponse());
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(2);
    expect(snapshot().activeTurnId).toBeNull();
    expect(snapshot().turns[0]).toMatchObject({
      status: 'failed',
      stepCount: 2,
      endReason: 'empty_model_response',
    });
    expect(snapshot().usage).toMatchObject({ modelRequests: 2, inputTokens: 22, outputTokens: 10 });
    expect(diagnostics().map((entry) => entry.willRetry)).toEqual([true, false]);
    expect(diagnostics().map((entry) => entry.recoveryUsed)).toEqual([false, true]);
  });

  it('未显示正文的流提前结束可恢复，不把未完成的工具参数当成可执行调用', async () => {
    const tool = countingTool();
    const adapter = streamingAdapter(async function* (_request, _signal, index) {
      if (index === 0) {
        yield { type: 'reasoning_delta', delta: 'private-incomplete-reasoning' };
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'partial-call',
          name: 'record_effect',
          argumentsDelta: '{',
        };
        return;
      }
      yield { type: 'completed', response: textResponse('恢复后的答复') };
    });
    start(adapter, tool.registry);
    await run();

    expect(adapter.requests).toHaveLength(2);
    expect(tool.calls()).toBe(0);
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages);
    expect(snapshot().turns[0]).toMatchObject({ status: 'completed', stepCount: 2 });
    expect(diagnostics()[0]).toMatchObject({
      reason: 'model_stream_incomplete',
      streamedTextChars: 0,
      streamedReasoningChars: 'private-incomplete-reasoning'.length,
      willRetry: true,
    });
    expect(JSON.stringify(diagnostics())).not.toContain('private-incomplete-reasoning');
  });

  it('流中断与完整空回复共用一次恢复额度', async () => {
    const adapter = streamingAdapter(async function* (_request, _signal, index) {
      if (index === 0) return;
      yield { type: 'completed', response: emptyResponse() };
    });
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(2);
    expect(snapshot().turns[0]).toMatchObject({
      status: 'failed',
      endReason: 'empty_model_response',
    });
    expect(diagnostics().map((entry) => entry.willRetry)).toEqual([true, false]);
  });

  it('恢复请求等待期间，已失败步骤的推理流立即结束加载', async () => {
    const gate = deferred<void>();
    const adapter = streamingAdapter(async function* (_request, _signal, index) {
      if (index === 0) {
        yield { type: 'reasoning_delta', delta: '第一步的部分推理' };
        return;
      }
      await gate.promise;
      yield { type: 'completed', response: textResponse('恢复完成') };
    });
    start(adapter);
    submit();
    try {
      await waitUntil(() => adapter.requests.length === 2);
      expect(snapshot().activeTurnId).not.toBeNull();
      expect(snapshot().reasoning[0]).toMatchObject({
        content: '第一步的部分推理',
        finalized: true,
      });
    } finally {
      gate.resolve();
      await app.runtime.waitForIdle();
    }
    expect(snapshot().turns[0]?.status).toBe('completed');
  });

  it('已经显示部分正文后流中断时不重试，保留部分正文', async () => {
    const adapter = streamingAdapter(async function* () {
      yield { type: 'text_delta', delta: '已经显示的正文' };
    });
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(snapshot().turns[0]).toMatchObject({
      status: 'failed',
      endReason: 'model_stream_incomplete',
    });
    expect(snapshot().streaming[0]).toMatchObject({
      content: '已经显示的正文',
      finalized: true,
      interrupted: true,
    });
    expect(diagnostics()[0]).toMatchObject({ willRetry: false });
  });

  it('即使最终响应为空，已显示正文的请求也不会自动重复', async () => {
    const adapter = streamingAdapter(async function* () {
      yield { type: 'text_delta', delta: '已经显示过' };
      yield { type: 'completed', response: emptyResponse() };
    });
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(snapshot().turns[0]?.status).toBe('failed');
    expect(diagnostics()[0]).toMatchObject({ willRetry: false });
  });

  it('非流式响应有后备正文块时，空 content 不触发重复请求', async () => {
    const adapter = new FakeLlmAdapter(() => ({
      ...emptyResponse(),
      chunks: ['已显示的后备正文'],
    }));
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(payloads('assistant.chunk')).toEqual([
      expect.objectContaining({ content: '已显示的后备正文' }),
    ]);
    expect(diagnostics()[0]).toMatchObject({ willRetry: false });
  });

  it('输出额度耗尽时不增加空回复重试', async () => {
    const adapter = new FakeLlmAdapter(() => ({ ...emptyResponse(), stopReason: 'length' }));
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(snapshot().turns[0]?.status).toBe('failed');
    expect(diagnostics()[0]).toMatchObject({ stopReason: 'length', willRetry: false });
  });

  it('鉴权失败等其它错误不触发空回复恢复', async () => {
    const adapter = new FakeLlmAdapter(() => {
      throw Object.assign(new Error('credentials rejected'), { name: 'MODEL_AUTH_ERROR' });
    });
    start(adapter);
    await run();

    expect(adapter.requests).toHaveLength(1);
    expect(snapshot().turns[0]).toMatchObject({ status: 'failed', endReason: 'model_auth_error' });
    expect(diagnostics()).toEqual([]);
  });

  it('恢复请求仍可取消，取消后不产生第三次请求', async () => {
    let recoverySignal: AbortSignal | undefined;
    const adapter = new FakeLlmAdapter((_request, signal, index) => {
      if (index === 0) return emptyResponse();
      recoverySignal = signal;
      return new Promise<ModelResponse>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    start(adapter);
    submit();
    try {
      await waitUntil(() => adapter.requests.length === 2);
    } finally {
      const activeTurnId = snapshot().activeTurnId;
      if (activeTurnId) app.runtime.cancelTurn('user-a', 's1', activeTurnId);
    }
    await app.runtime.waitForIdle();

    expect(recoverySignal?.aborted).toBe(true);
    expect(adapter.requests).toHaveLength(2);
    expect(snapshot().turns[0]).toMatchObject({ status: 'cancelled', endReason: 'user_cancelled' });
    expect(diagnostics().filter((entry) => entry.level === 'info')).toHaveLength(0);
  });

  it('诊断日志写入失败不影响空回复恢复和最终回答', async () => {
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0 ? emptyResponse() : textResponse('日志不可用时仍完成'),
    );
    start(adapter);
    const originalWarn = app.logger.warn.bind(app.logger);
    const originalInfo = app.logger.info.bind(app.logger);
    let diagnosticFailures = 0;
    vi.spyOn(app.logger, 'warn').mockImplementation((message, fields) => {
      if (fields?.reason === 'empty_model_response') {
        diagnosticFailures += 1;
        throw new Error('test log write failure');
      }
      originalWarn(message, fields);
    });
    vi.spyOn(app.logger, 'info').mockImplementation((message, fields) => {
      if (fields?.recoveredFromRequestId) {
        diagnosticFailures += 1;
        throw new Error('test log write failure');
      }
      originalInfo(message, fields);
    });
    await run();

    expect(diagnosticFailures).toBe(2);
    expect(adapter.requests).toHaveLength(2);
    expect(snapshot().turns[0]?.status).toBe('completed');
    expect(snapshot().messages.at(-1)?.content).toBe('日志不可用时仍完成');
  });

  function start(adapter: LlmAdapter, tools?: ToolRegistry): void {
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 2,
      logger: new CapturingLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
    });
    const now = '2025-01-01T00:00:00.000Z';
    app.repos.models.createService({
      id: 'service-a',
      userId: 'user-a',
      name: 'Fake',
      providerType: 'fake',
      endpoint: 'https://invalid.local',
      credentialRef: null,
      config: {},
      now,
    });
    app.repos.models.createModel({
      id: 'model-a',
      userId: 'user-a',
      serviceId: 'service-a',
      remoteModelId: 'fake-model',
      displayName: 'Fake Model',
      contextWindow: 8192,
      maxOutputTokens: 512,
      maxOutputCapability: 512,
      capabilities: { tools: true },
      defaultParams: {},
      source: 'manual',
      now,
    });
    app.repos.models.setDefaultModel('user-a', 'model-a', now);
    app.runtime.createSession('user-a', { sessionId: 's1', title: 'Recovery' });
  }

  function submit(content = '完成任务'): void {
    app.runtime.submitInput('user-a', {
      sessionId: 's1',
      content,
      idempotencyKey: 'input-1',
      startNewEvent: true,
    });
  }

  async function run(content?: string): Promise<void> {
    submit(content);
    await app.runtime.waitForIdle('user-a', 's1');
  }

  function snapshot(): Snapshot {
    return app.runtime.snapshot('user-a', 's1') as Snapshot;
  }

  function payloads(type: string): Array<Record<string, unknown>> {
    return app.repos.sessions
      .listEvents('user-a', 's1')
      .filter((event) => event.eventType === type)
      .map((event) => event.payload as Record<string, unknown>);
  }

  function diagnostics(): Record<string, unknown>[] {
    return (app.logger as MemoryLogger).entries.filter(
      (entry) =>
        entry.reason === 'empty_model_response' || entry.reason === 'model_stream_incomplete',
    );
  }
});

// Runtime and application create child loggers; keep every test entry in one collector.
class CapturingLogger extends MemoryLogger {
  override child(): this {
    return this;
  }
}

function emptyResponse(reasoning = 'reasoning-only'): ModelResponse {
  return {
    content: '',
    reasoning,
    toolCalls: [],
    usage: { inputTokens: 11, outputTokens: 5 },
    stopReason: 'complete',
  };
}

function toolResponse(): ModelResponse {
  return {
    content: '',
    reasoning: 'tool-attempt-reasoning',
    toolCalls: [{ id: 'effect-call', name: 'record_effect', arguments: {} }],
    usage: { inputTokens: 3, outputTokens: 2 },
    stopReason: 'tool_calls',
  };
}

function countingTool(): { registry: ToolRegistry; calls: () => number } {
  let calls = 0;
  const tool: RuntimeTool<{ output: string }> = {
    name: 'record_effect',
    description: 'Records a side effect once',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { output: { type: 'string' } },
        required: ['output'],
        additionalProperties: false,
      },
      render: (_input, value) => [{ type: 'text', text: value.output }],
    },
    concurrencySafe: false,
    replaySafe: false,
    async execute() {
      calls += 1;
      return { output: 'effect-once' };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  return { registry, calls: () => calls };
}

function streamingAdapter(
  handler: (
    request: ModelRequest,
    signal: AbortSignal,
    index: number,
  ) => AsyncIterable<ModelStreamEvent>,
): LlmAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    providerType: 'fake',
    requests,
    generate: async () => {
      throw new Error('stream path expected');
    },
    async *stream(request, signal) {
      requests.push(request);
      yield* handler(request, signal, requests.length - 1);
    },
  };
}
