import { describe, expect, it, vi } from 'vitest';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { OpenAiCompatibleAdapter } from '../../packages/execution/src/llm/openai-compatible-adapter';
import type { ModelRequest, ModelStreamEvent } from '../../packages/runtime-core/src/model';

const request: ModelRequest = {
  requestId: 'request-diagnostics',
  purpose: 'agent',
  model: {
    serviceId: 'service',
    modelId: 'model',
    providerType: 'openai-compatible',
    remoteModelId: 'fixture-model',
    endpoint: 'https://fixture.invalid/v1',
    credentialRef: null,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    params: { privateParameter: 'PRIVATE_MODEL_PARAMETER' },
    configRevision: 1,
  },
  messages: [{ role: 'user', content: 'PRIVATE_USER_MESSAGE' }],
  tools: [
    {
      name: 'private_tool',
      description: 'PRIVATE_TOOL_DESCRIPTION',
      inputSchema: { type: 'object' },
    },
  ],
  maxOutputTokens: 4096,
};

function chunk(delta: Record<string, unknown>, finishReason: unknown = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function sse(...frames: unknown[]): string {
  return frames
    .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    .join('');
}

function fixture(body: string | ReadableStream<Uint8Array> | null) {
  const warn = vi.fn();
  const fetch = vi.fn(async () => new Response(body));
  const adapter = new OpenAiCompatibleAdapter({
    credentialStore: new FakeCredentialStore(),
    fetch,
    logger: { warn },
  });
  return { adapter, warn, fetch };
}

async function collect(adapter: OpenAiCompatibleAdapter, events: ModelStreamEvent[] = []) {
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  return events;
}

function completed(events: ModelStreamEvent[]) {
  const event = events.find((item) => item.type === 'completed');
  if (event?.type !== 'completed') throw new Error('expected completed event');
  return event.response;
}

describe('OpenAI-compatible response diagnostics', () => {
  it('normal text stream keeps its response and emits no warning', async () => {
    const { adapter, warn } = fixture(
      sse(
        chunk({ reasoning_content: 'PRIVATE_REASONING' }),
        chunk({ content: 'PRIVATE_ANSWER' }),
        chunk({}, 'stop'),
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 24 } },
        '[DONE]',
      ),
    );
    expect(completed(await collect(adapter))).toMatchObject({
      content: 'PRIVATE_ANSWER',
      reasoning: 'PRIVATE_REASONING',
      usage: { inputTokens: 120, outputTokens: 24 },
      stopReason: 'complete',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['done', 'finish'] as const)('accepts a provider sending only %s', async (ending) => {
    const { adapter, warn } = fixture(
      ending === 'done'
        ? sse(chunk({ content: 'answer' }), '[DONE]')
        : sse(chunk({ content: 'answer' }), chunk({}, 'stop')),
    );
    expect(completed(await collect(adapter)).content).toBe('answer');
    expect(warn).not.toHaveBeenCalled();
  });

  it('records reasoning-only responses with bounded metadata and exact reported usage', async () => {
    const { adapter, warn, fetch } = fixture(
      sse(
        chunk({ reasoning_content: 'PRIVATE_REASONING', content: ' \n\t' }),
        chunk({}, 'stop'),
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
        '[DONE]',
      ),
    );
    expect(completed(await collect(adapter)).toolCalls).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '模型响应异常',
      expect.objectContaining({
        event: 'model_response_anomaly',
        reason: 'empty_response',
        requestId: request.requestId,
        model: 'fixture-model',
        providerType: 'openai-compatible',
        purpose: 'agent',
        stream: true,
        durationMs: expect.any(Number),
        rawFinishReason: 'stop',
        sawDone: true,
        sawFinish: true,
        contentChars: 3,
        contentNonWhitespaceChars: 0,
        reasoningChars: 'PRIVATE_REASONING'.length,
        toolCallCount: 0,
        dataFrameCount: 3,
        usageReported: true,
        usage: { inputTokens: 12, outputTokens: 7 },
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
    expect(JSON.stringify(warn.mock.calls).length).toBeLessThan(1600);
  });

  it('counts <think> reasoning and diagnoses empty non-stream completions', async () => {
    const { adapter, warn } = fixture(
      JSON.stringify({
        choices: [
          { message: { content: '<think>PRIVATE_REASONING</think>  ' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 18 },
      }),
    );
    expect(await adapter.generate(request, new AbortController().signal)).toMatchObject({
      content: '  ',
      reasoning: 'PRIVATE_REASONING',
      stopReason: 'length',
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '模型响应异常',
      expect.objectContaining({
        reason: 'empty_response',
        stream: false,
        rawFinishReason: 'length',
        sawFinish: true,
        sawDone: false,
        reasoningChars: 'PRIVATE_REASONING'.length,
        usage: { inputTokens: 13, outputTokens: 18 },
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it.each([null, '', ' \n'])('rejects EOF without a usable finish signal (%j)', async (finish) => {
    const { adapter, warn } = fixture(sse(chunk({ content: 'PRIVATE_PARTIAL_TEXT' }, finish)));
    const events: ModelStreamEvent[] = [];
    await expect(collect(adapter, events)).rejects.toMatchObject({
      name: 'MODEL_STREAM_INCOMPLETE',
      message: 'MODEL_STREAM_INCOMPLETE',
    });
    expect(events.some((event) => event.type === 'completed')).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '模型响应异常',
      expect.objectContaining({
        reason: 'stream_incomplete',
        sawFinish: false,
        sawDone: false,
        contentChars: 'PRIVATE_PARTIAL_TEXT'.length,
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('does not commit collected tool calls when the stream is truncated', async () => {
    const { adapter, warn } = fixture(
      sse(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call-one',
              function: { name: 'private_tool', arguments: '{"value":"PRIVATE_TOOL_ARGUMENT"}' },
            },
          ],
        }),
      ),
    );
    const events: ModelStreamEvent[] = [];
    await expect(collect(adapter, events)).rejects.toThrow('MODEL_STREAM_INCOMPLETE');
    expect(events.map((event) => event.type)).toEqual(['tool_call_delta']);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ toolCallCount: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private_tool');
  });

  it('recognizes a truncated JSON frame before the finish signal as incomplete', async () => {
    const { adapter, warn } = fixture(
      sse(chunk({ reasoning: 'PRIVATE_REASONING' })) +
        'data: {"choices":[{"delta":{"content":"PRIVATE_PARTIAL',
    );
    const events: ModelStreamEvent[] = [];
    await expect(collect(adapter, events)).rejects.toThrow('MODEL_STREAM_INCOMPLETE');
    expect(events.some((event) => event.type === 'completed')).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'stream_incomplete', sawFinish: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('preserves complete tool-call streams without warning', async () => {
    const { adapter, warn } = fixture(
      sse(
        chunk({
          tool_calls: [
            { index: 0, id: 'call-one', function: { name: 'private_tool', arguments: '{"value":' } },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '"PRIVATE_TOOL_ARGUMENT"}' } }],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ),
    );
    expect(completed(await collect(adapter)).toolCalls).toEqual([
      { id: 'call-one', name: 'private_tool', arguments: { value: 'PRIVATE_TOOL_ARGUMENT' } },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    sse({ error: { message: 'PRIVATE_PROVIDER_ERROR', key: 'PRIVATE_KEY' } }),
    'event: error\ndata: {"message":"PRIVATE_PROVIDER_ERROR","key":"PRIVATE_KEY"}\n\n',
    sse({ type: 'error', message: 'PRIVATE_PROVIDER_ERROR' }),
  ])('rejects error frames even after a finish signal, without logging provider text', async (frame) => {
    const { adapter, warn } = fixture(sse(chunk({ content: 'PRIVATE_ANSWER' }, 'stop')) + frame);
    const events: ModelStreamEvent[] = [];
    await expect(collect(adapter, events)).rejects.toMatchObject({
      name: 'MODEL_PROVIDER_REQUEST_FAILED',
      message: 'MODEL_PROVIDER_REQUEST_FAILED',
    });
    expect(events.some((event) => event.type === 'completed')).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'provider_error', sawFinish: true });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('records transport interruption without copying its exception message', async () => {
    let read = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read++ === 0) {
          controller.enqueue(new TextEncoder().encode(sse(chunk({ reasoning: 'PRIVATE_REASONING' }))));
        } else {
          controller.error(new Error('PRIVATE_TRANSPORT_ERROR'));
        }
      },
    });
    const { adapter, warn } = fixture(body);
    await expect(collect(adapter)).rejects.toThrow('MODEL_STREAM_INCOMPLETE');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'stream_incomplete' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it.each([true, false])('keeps content-filter outcomes distinct from empty/truncated responses (stream=%s)', async (stream) => {
    const { adapter, warn } = fixture(
      stream
        ? sse(chunk({ reasoning_content: 'PRIVATE_REASONING' }, 'content_filter'), '[DONE]')
        : JSON.stringify({
            choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
          }),
    );
    const response = stream
      ? collect(adapter)
      : adapter.generate(request, new AbortController().signal);
    await expect(response).rejects.toMatchObject({
      name: 'MODEL_CONTENT_FILTERED',
      message: 'MODEL_CONTENT_FILTERED',
    });
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      reason: 'content_filtered',
      rawFinishReason: 'content_filter',
      sawFinish: true,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('bounds finish metadata and tolerates a logger failure', async () => {
    const { adapter, warn } = fixture(sse(chunk({ reasoning: 'PRIVATE_REASONING' }, 's'.repeat(10000))));
    warn.mockImplementation(() => {
      throw new Error('diagnostics disk unavailable');
    });
    expect(completed(await collect(adapter)).content).toBe('');
    expect(warn.mock.calls[0]?.[1]?.rawFinishReason).toHaveLength(256);
  });
});
