import { describe, expect, it } from 'vitest';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { credentialRefOf } from '../../packages/execution/src/credential/credential-store';
import { OpenAiCompatibleAdapter } from '../../packages/execution/src/llm/openai-compatible-adapter';
import type { ModelRequest } from '../../packages/runtime-core/src/model';

const scope = { userId: 'user-a', purpose: 'model-service', entityId: 'service-a' };

describe('OpenAI-compatible HTTP Adapter', () => {
  it('非流式请求使用 Bearer 凭据并归一化文本、工具和 usage', async () => {
    const store = new FakeCredentialStore();
    await store.set(scope, 'sk-test-only');
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const adapter = new OpenAiCompatibleAdapter({
      credentialStore: store,
      fetch: async (input, init) => {
        capturedUrl = input.toString();
        capturedInit = init;
        return Response.json({
          choices: [
            {
              message: {
                content: '',
                reasoning_content: '需要调用查询工具。',
                phase: 'commentary',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"测试"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });
      },
    });

    const response = await adapter.generate(request(), new AbortController().signal);

    expect(capturedUrl).toBe('https://provider.example/v1/chat/completions');
    expect(capturedInit?.headers).toMatchObject({ authorization: 'Bearer sk-test-only' });
    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({
      model: 'remote-model',
      stream: false,
      max_tokens: 512,
      enable_thinking: true,
      reasoning_effort: 'low',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    });
    expect(response).toEqual({
      content: '',
      reasoning: '需要调用查询工具。',
      phase: 'commentary',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: '测试' } }],
      usage: { inputTokens: 12, outputTokens: 4 },
      stopReason: 'tool_calls',
    });
  });

  it('流式请求解析 SSE 文本、Tool delta、finish reason 与末尾 usage', async () => {
    const store = new FakeCredentialStore();
    await store.set(scope, 'sk-test-only');
    const sse = [
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"测试\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const adapter = new OpenAiCompatibleAdapter({
      credentialStore: store,
      fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    });

    const events = [];
    for await (const event of adapter.stream!(request(), new AbortController().signal)) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'text_delta', delta: '你好' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      response: {
        content: '你好',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: '测试' } }],
        usage: { inputTokens: 13, outputTokens: 5 },
        stopReason: 'tool_calls',
      },
    });
  });

  it('拒绝无效凭据引用，且不会向 Provider 发请求', async () => {
    const store = new FakeCredentialStore();
    let called = false;
    const adapter = new OpenAiCompatibleAdapter({
      credentialStore: store,
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    const invalid = request();
    invalid.model.credentialRef = 'foreign-app:user-a:service-a';

    await expect(adapter.generate(invalid, new AbortController().signal)).rejects.toMatchObject({
      name: 'MODEL_CREDENTIAL_MISSING',
    });
    expect(called).toBe(false);
  });

  it('识别 Provider 上下文窗口溢出，供 Runtime 触发单次压缩恢复', async () => {
    const store = new FakeCredentialStore();
    await store.set(scope, 'sk-test-only');
    const adapter = new OpenAiCompatibleAdapter({
      credentialStore: store,
      fetch: async () =>
        new Response('{"error":{"message":"maximum context length exceeded"}}', {
          status: 400,
        }),
    });

    await expect(adapter.generate(request(), new AbortController().signal)).rejects.toMatchObject({
      name: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
    });
  });
});

function request(): ModelRequest {
  return {
    requestId: 'request-1',
    purpose: 'agent',
    model: {
      serviceId: 'service-a',
      modelId: 'model-a',
      providerType: 'openai-compatible',
      remoteModelId: 'remote-model',
      endpoint: 'https://provider.example/v1',
      credentialRef: credentialRefOf(scope),
      contextWindow: 8192,
      maxOutputTokens: 512,
      params: { temperature: 0.2, enable_thinking: true, reasoning_effort: 'low' },
      configRevision: 1,
    },
    messages: [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old-call', name: 'lookup', arguments: { q: 'old' } }],
      },
      { role: 'tool', toolCallId: 'old-call', content: '{"result":"old"}' },
      { role: 'user', content: '测试' },
    ],
    tools: [
      {
        name: 'lookup',
        description: '查询测试值',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
    maxOutputTokens: 512,
  };
}
