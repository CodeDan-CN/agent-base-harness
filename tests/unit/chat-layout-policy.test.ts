import { describe, expect, it } from 'vitest';
import {
  interactionExecutionTurnIds,
  isExecutionProcessAssistant,
  selectChatMessages,
  shouldRenderExecutionForMessage,
  shouldRenderStandaloneExecution,
} from '../../packages/app-ui/src/chat-layout-policy';

describe('聊天执行过程归属', () => {
  it('把用户回答前后的 Turn 合并为同一执行过程', () => {
    const interactions = [
      { turnId: 'turn-1', continuationTurnId: 'turn-2' },
      { turnId: 'turn-2', continuationTurnId: 'turn-3' },
    ];

    expect(interactionExecutionTurnIds(interactions, 'turn-1')).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    expect(interactionExecutionTurnIds(interactions, 'turn-3')).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
  });

  it('新 Turn 流式回答时仍保留历史回答的执行过程', () => {
    expect(
      shouldRenderExecutionForMessage({
        messageTurnId: 'turn-1',
        streamingTurnId: 'turn-2',
      }),
    ).toBe(true);
  });

  it('当前流式 Turn 由流式消息承载执行过程，避免重复', () => {
    expect(
      shouldRenderExecutionForMessage({
        messageTurnId: 'turn-2',
        streamingTurnId: 'turn-2',
      }),
    ).toBe(false);
  });

  it('流式结束后回答继续展示自己 Turn 的执行过程', () => {
    expect(
      shouldRenderExecutionForMessage({
        messageTurnId: 'turn-2',
        streamingTurnId: null,
      }),
    ).toBe(true);
  });

  it('工具调用前的过程性文本只进入执行轨迹', () => {
    expect(isExecutionProcessAssistant({ role: 'assistant', toolCallCount: 1 })).toBe(true);
    expect(isExecutionProcessAssistant({ role: 'assistant', toolCallCount: 0 })).toBe(false);
    expect(isExecutionProcessAssistant({ role: 'user', toolCallCount: 1 })).toBe(false);
  });

  it('过程说明保留执行卡片，最终回答到达后只保留最终回答', () => {
    const progress = { role: 'assistant', turnId: 't1', phase: 'commentary' as const };
    const answer = { role: 'assistant', turnId: 't1', phase: 'final_answer' as const };
    expect(selectChatMessages([progress])).toEqual([progress]);
    expect(selectChatMessages([progress, answer])).toEqual([answer]);
    expect(isExecutionProcessAssistant({role: 'assistant', toolCallCount: 0, phase: 'commentary'})).toBe(true);
  });

  it('失败 Turn 没有最终回答时仍独立展示执行过程', () => {
    expect(
      shouldRenderStandaloneExecution({
        executionTurnId: 'turn-failed',
        hasRunningStream: false,
        executionTurnHasAssistant: false,
      }),
    ).toBe(true);
  });
});
