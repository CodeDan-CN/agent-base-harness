import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, projectRuntime } from '../../packages/protocol/src/client/projection';
import { RUNTIME_EVENT_SCHEMA_VERSION } from '../../packages/protocol/src/client/runtime';
import type { SessionLogEvent } from '../../packages/protocol/src/domain/session';
import { executionActivity } from '../../packages/app-ui/src/execution-activity';

function event(seq: number, eventType: string, payload: unknown): SessionLogEvent {
  return {
    userId: 'user-a',
    sessionId: 'session-1',
    seq,
    eventId: `log-${seq}`,
    eventType,
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: `2026-09-08T00:00:0${seq}.000Z`,
    requestId: 'request-1',
    payload,
  };
}

const correlation = {
  toolCallId: 'tool-call-1',
  toolName: 'mcp__research_gap_cloud__run_topic_evidence_mapper',
  stepId: 'step-1',
  turnId: 'turn-1',
  eventId: 'conversation-event-1',
};

describe('MCP 工具进度展示', () => {
  it('将最新进度投影到运行中工具和步骤文案', () => {
    const projection = projectRuntime([
      event(1, 'tool.call', {
        ...correlation,
        requestId: 'request-1',
        input: { question: 'TREM2' },
        replaySafe: false,
        presentation: { kind: 'generic', title: '主题证据地图' },
        callIndex: 0,
      }),
      event(2, 'tool.progress', {
        ...correlation,
        progress: 4,
        message: '步骤 4/6：Tavily 公开证据检索完成，共 3 个去重来源',
      }),
    ]);

    expect(projection.toolCalls.get(correlation.toolCallId)?.progress).toMatchObject({
      current: 4,
      message: '步骤 4/6：Tavily 公开证据检索完成，共 3 个去重来源',
    });
    expect(
      executionActivity(projection, {
        id: correlation.stepId,
        turnId: correlation.turnId,
        eventId: correlation.eventId,
        stepIndex: 1,
        status: 'running',
        startedAt: '2026-09-08T00:00:00.000Z',
        endedAt: null,
        requestContext: null,
      }),
    ).toBe(
      '正在执行：主题证据地图 · 步骤 4/6：Tavily 公开证据检索完成，共 3 个去重来源',
    );
  });

  it('工具完成后清除运行中进度', () => {
    const projection = projectRuntime([
      event(1, 'tool.call', {
        ...correlation,
        requestId: 'request-1',
        input: {},
        replaySafe: false,
        presentation: null,
        callIndex: 0,
      }),
      event(2, 'tool.progress', {
        ...correlation,
        progress: 1,
        message: '正在执行',
      }),
    ]);

    applyRuntimeEvent(
      projection,
      event(3, 'tool.result', {
        ...correlation,
        status: 'success',
        output: [{ type: 'text', text: '已完成' }],
        errorCode: null,
        meta: null,
        presentation: null,
        executionFacts: null,
        callIndex: 0,
      }),
    );

    expect(projection.toolCalls.get(correlation.toolCallId)?.progress).toBeUndefined();
  });
});
