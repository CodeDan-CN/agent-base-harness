import { describe, expect, it } from 'vitest';
import {
  AnthropicStreamNormalizer,
  OpenAiStreamNormalizer,
} from '../../packages/runtime-core/src/provider-normalizers';

describe('Stage 2 Provider 流式归一化 Contract', () => {
  it('原生 phase 在同帧正文前发出，未知 phase 不参与分类', () => {
    const n = new OpenAiStreamNormalizer();
    expect(n.push({choices: [{delta: {phase: 'commentary', content: '正在读取文件。'}}]})).toEqual([
      {type: 'message_metadata', phase: 'commentary'},
      {type: 'text_delta', delta: '正在读取文件。'},
    ]);
    expect(n.complete()).toMatchObject({response: {phase: 'commentary', content: '正在读取文件。'}});
    const unknown = new OpenAiStreamNormalizer();
    expect(unknown.push({choices: [{delta: {phase: 'analysis', content: '回答'}}]})).toEqual([
      {type: 'text_delta', delta: '回答'},
    ]);
    expect(unknown.complete()).not.toHaveProperty('response.phase');
  });

  it('OpenAI-compatible 将 reasoning_content 和跨 chunk think 标签独立归一化', () => {
    const normalizer = new OpenAiStreamNormalizer();
    const events = [
      ...normalizer.push({
        choices: [{ delta: { reasoning_content: '显式**思考**。' }, finish_reason: null }],
      }),
      ...normalizer.push({
        choices: [{ delta: { content: '<thi' }, finish_reason: null }],
      }),
      ...normalizer.push({
        choices: [{ delta: { content: 'nk>标签思考</think>最终**回答**' }, finish_reason: 'stop' }],
      }),
    ];
    const completed = normalizer.complete();

    expect(
      events.filter((event) => event.type === 'reasoning_delta').map((event) => event.delta),
    ).toEqual(['显式**思考**。', '标签思考']);
    expect(
      events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
    ).toEqual(['最终**回答**']);
    expect(completed).toMatchObject({
      type: 'completed',
      response: {
        content: '最终**回答**',
        reasoning: '显式**思考**。标签思考',
      },
    });
  });

  it('OpenAI-compatible 文本、Tool delta、usage 与 finish reason 归一化', () => {
    const normalizer = new OpenAiStreamNormalizer();
    expect(normalizer.push({ choices: [{ delta: { content: '你' } }] })).toEqual([
      { type: 'text_delta', delta: '你' },
    ]);
    normalizer.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":' } },
            ],
          },
        },
      ],
    });
    normalizer.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"测试"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    expect(normalizer.complete()).toMatchObject({
      type: 'completed',
      response: {
        content: '你',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: '测试' } }],
        usage: { inputTokens: 12, outputTokens: 4 },
        stopReason: 'tool_calls',
      },
    });
  });

  it('Anthropic-compatible 文本、tool_use 与 usage 归一化', () => {
    const normalizer = new AnthropicStreamNormalizer();
    normalizer.push({ type: 'message_start', message: { usage: { input_tokens: 9 } } });
    normalizer.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
    });
    normalizer.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"agent"}' },
    });
    expect(
      normalizer.push({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '处理中' },
      }),
    ).toEqual([{ type: 'text_delta', delta: '处理中' }]);
    normalizer.push({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    });
    expect(normalizer.complete()).toMatchObject({
      type: 'completed',
      response: {
        content: '处理中',
        toolCalls: [{ id: 'tool-1', name: 'search', arguments: { q: 'agent' } }],
        usage: { inputTokens: 9, outputTokens: 5 },
        stopReason: 'tool_calls',
      },
    });
  });
});
