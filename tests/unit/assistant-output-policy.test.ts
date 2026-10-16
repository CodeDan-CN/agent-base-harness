import { describe, expect, it } from 'vitest';
import {
  assistantMessagePhase,
  isHistoricalConversationMessage,
  readAssistantPhase,
} from '../../packages/protocol/src/client/assistant-output-policy';
import { applyRuntimeEvent, projectRuntime } from '../../packages/protocol/src/client/projection';
import type { SessionLogEvent } from '../../packages/protocol/src/domain/session';
import { OpenAiStreamNormalizer } from '../../packages/runtime-core/src/provider-normalizers';
import { selectChatMessages } from '../../packages/app-ui/src/chat-layout-policy';
import { groupExecutionPhases } from '../../packages/app-ui/src/execution-process-policy';

const correlation = { requestId: 'r1', stepId: 'step1', turnId: 'turn1', eventId: 'e1' };
function event(seq: number, eventType: string, payload: unknown): SessionLogEvent {
  return {
    seq,
    eventType,
    payload,
    userId: 'user-a',
    sessionId: 's1',
    eventId: `log${seq}`,
    schemaVersion: 1,
    occurredAt: '2026-09-04T00:00:00Z',
    requestId: 'r1',
  };
}

describe('4.6.0 执行说明与回答', () => {
  it('交互续接后的最终回答接管过程入口，不重复展示卡片', () => {
    const progress = { role: 'assistant', turnId: 't1', phase: 'commentary' as const };
    const resumed = { role: 'assistant', turnId: 't2', phase: 'commentary' as const };
    const answer = { role: 'assistant', turnId: 't2', phase: 'final_answer' as const };
    const links = [{ turnId: 't1', continuationTurnId: 't2' }];
    expect(selectChatMessages([progress, resumed], links)).toEqual([resumed]);
    expect(selectChatMessages([progress, resumed, answer], links)).toEqual([answer]);
  });
  it('原生 phase 优先；旧消息按工具事实归类；过程说明不进入历史问答', () => {
    expect(assistantMessagePhase({ toolCalls: [{}] })).toBe('commentary');
    expect(assistantMessagePhase({})).toBe('final_answer');
    expect(assistantMessagePhase({ phase: 'final_answer', toolCalls: [{}] })).toBe('final_answer');
    expect(readAssistantPhase('analysis')).toBeUndefined();
    expect(isHistoricalConversationMessage({ role: 'assistant', phase: 'commentary' })).toBe(false);
    expect(isHistoricalConversationMessage({ role: 'assistant', toolCalls: [{}] })).toBe(false);
    expect(isHistoricalConversationMessage({ role: 'assistant' })).toBe(true);
  });

  it('适配器在同帧正文前发出原生用途，不从内容猜用途', () => {
    const normalizer = new OpenAiStreamNormalizer();
    expect(
      normalizer.push({ choices: [{ delta: { phase: 'commentary', content: '开始检查' } }] }),
    ).toEqual([
      { type: 'message_metadata', phase: 'commentary' },
      { type: 'text_delta', delta: '开始检查' },
    ]);
    expect(normalizer.complete()).toMatchObject({
      response: { phase: 'commentary', content: '开始检查' },
    });
    const legacy = new OpenAiStreamNormalizer();
    legacy.push({ choices: [{ delta: { content: '开始检查' } }] });
    expect(legacy.complete()).not.toHaveProperty('response.phase');
  });

  it.each([true, false])('元数据早到=%s：回放保留首帧位置，完成后归位', (early) => {
    const metadata = (seq: number) =>
      event(seq, 'assistant.message.metadata', { ...correlation, phase: 'commentary' });
    const chunk = (seq: number) =>
      event(seq, 'assistant.chunk', { ...correlation, chunkIndex: 0, content: '开始检查' });
    const events = early ? [metadata(1), chunk(2)] : [chunk(1), metadata(2)];
    const projection = projectRuntime(events);
    expect(projection.streams.get('r1')).toMatchObject({
      content: '开始检查',
      phase: 'commentary',
      finalized: false,
    });
    expect(projection.streams.get('r1')?.displayPhase).toBe(early ? 'commentary' : undefined);
    const completed = event(3, 'assistant.message', {
      messageId: 'm1',
      ...correlation,
      phase: 'commentary',
      phaseSource: 'provider',
      content: '开始检查',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'complete',
    });
    applyRuntimeEvent(projection, completed);
    expect(projectRuntime([...events, completed])).toEqual(projection);
    expect(projection.streams.get('r1')?.finalized).toBe(true);
    expect(projection.messages[0]).toMatchObject({
      requestId: 'r1',
      phase: 'commentary',
      phaseSource: 'provider',
    });
  });

  it('旧日志中 tool.call 晚到后重新归类，不固化默认回答身份', () => {
    const projection = projectRuntime([
      event(1, 'assistant.message', {
        messageId: 'm1',
        ...correlation,
        content: '开始检查',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'tool_calls',
      }),
    ]);
    expect(assistantMessagePhase(projection.messages[0]!)).toBe('final_answer');
    applyRuntimeEvent(
      projection,
      event(2, 'tool.call', {
        ...correlation,
        toolCallId: 'c1',
        toolName: 'Read',
        input: { path: 'README.md' },
        replaySafe: true,
        callIndex: 0,
      }),
    );
    expect(assistantMessagePhase(projection.messages[0]!)).toBe('commentary');
    expect(isHistoricalConversationMessage(projection.messages[0]!)).toBe(false);
  });

  it('关闭推理时仍按步骤显示说明；最终回答只出现在正文一次', () => {
    const progress = { role: 'assistant', turnId: 't1', phase: 'commentary' as const };
    const answer = { role: 'assistant', turnId: 't1', phase: 'final_answer' as const };
    expect(selectChatMessages([progress])).toEqual([progress]);
    expect(selectChatMessages([progress, answer])).toEqual([answer]);
    const phases = groupExecutionPhases({
      steps: [{ id: 's1', stepIndex: 1, status: 'completed' }],
      tools: [],
      reasoning: [],
      commentary: [{ id: 'r1', stepId: 's1', content: '已检查', finalized: true }],
    });
    expect(phases).toHaveLength(1);
    expect(phases[0]?.reasoning).toBeNull();
    expect(phases[0]?.commentary[0]?.content).toBe('已检查');
  });
});
