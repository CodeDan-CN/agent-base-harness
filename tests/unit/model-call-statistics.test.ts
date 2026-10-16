import { describe, expect, it } from 'vitest';
import type { Session, SessionLogEvent } from '../../packages/protocol/src/domain/session';
import { buildModelCallStatistics } from '../../packages/server-core/src/application/model-call-statistics';

describe('模型调用统计投影', () => {
  it('从历史流式事件计算 TTFT、TPS 与 Token，并支持会话和模型过滤', () => {
    const session = makeSession('session-a', '纳指分析');
    const events = [
      event(1, 'step.started', '2026-08-27T01:00:00.000Z', {
        stepId: 'step-1',
        stepIndex: 1,
      }),
      event(2, 'model.request.context', '2026-08-27T01:00:00.000Z', {
        requestId: 'request-1',
        stepId: 'step-1',
        estimatedInputTokens: 80,
        model: {
          modelId: 'model-config-1',
          remoteModelId: 'qwen36-27b',
          contextWindow: 262_144,
          thinkingMode: 'enabled',
          reasoningEffort: 'high',
        },
      }),
      event(3, 'assistant.reasoning.chunk', '2026-08-27T01:00:00.500Z', {
        requestId: 'request-1',
      }),
      event(4, 'assistant.message', '2026-08-27T01:00:02.500Z', {
        requestId: 'request-1',
        stepId: 'step-1',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'complete',
      }),
      event(5, 'step.ended', '2026-08-27T01:00:02.500Z', {
        stepId: 'step-1',
        status: 'completed',
      }),
    ];

    const snapshot = buildModelCallStatistics([{ session, events }], {
      sessionId: 'session-a',
      modelKeyword: 'QWEN36',
    });

    expect(snapshot.summary).toEqual({
      callCount: 1,
      averageTtftMs: 500,
      averageTps: 25,
      totalTokens: 150,
    });
    expect(snapshot.items[0]).toMatchObject({
      requestId: 'request-1',
      sessionTitle: '纳指分析',
      modelId: 'qwen36-27b',
      ttftMs: 500,
      tps: 25,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      firstTokenObserved: true,
    });
  });

  it('优先使用新事件中的精确耗时并对失败调用保留日志', () => {
    const session = makeSession('session-a', '测试会话');
    const events = [
      event(1, 'model.request.context', '2026-08-27T01:00:00.000Z', {
        requestId: 'request-complete',
        stepId: 'step-complete',
        model: { remoteModelId: 'deepseek-v4-flash-0731' },
      }),
      event(2, 'assistant.message', '2026-08-27T01:00:10.000Z', {
        requestId: 'request-complete',
        stepId: 'step-complete',
        inputTokens: 10,
        outputTokens: 20,
        stopReason: 'complete',
        requestStartedAt: '2026-08-27T01:00:00.000Z',
        firstTokenAt: '2026-08-27T01:00:00.123Z',
        completedAt: '2026-08-27T01:00:01.123Z',
        ttftMs: 123,
        durationMs: 1123,
        generationDurationMs: 1000,
        firstTokenObserved: true,
      }),
      event(3, 'model.request.context', '2026-08-27T02:00:00.000Z', {
        requestId: 'request-failed',
        stepId: 'step-failed',
        model: { remoteModelId: 'deepseek-v4-flash-0731' },
      }),
      event(4, 'step.ended', '2026-08-27T02:00:03.000Z', {
        stepId: 'step-failed',
        status: 'failed',
      }),
    ];

    const snapshot = buildModelCallStatistics([{ session, events }], {});

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find((item) => item.requestId === 'request-complete')).toMatchObject({
      ttftMs: 123,
      tps: 20,
      durationMs: 1123,
      status: 'completed',
    });
    expect(snapshot.items.find((item) => item.requestId === 'request-failed')).toMatchObject({
      ttftMs: null,
      tps: null,
      durationMs: 3000,
      status: 'failed',
    });
  });
});

function makeSession(id: string, title: string): Session {
  return {
    id,
    userId: 'user-a',
    title,
    status: 'active',
    nextSeq: 1,
    version: 0,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function event(
  seq: number,
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): SessionLogEvent {
  return {
    userId: 'user-a',
    sessionId: 'session-a',
    seq,
    eventId: `event-${seq}`,
    eventType,
    schemaVersion: 1,
    occurredAt,
    requestId: null,
    payload,
  };
}
