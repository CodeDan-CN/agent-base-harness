import { describe, expect, it } from 'vitest';

import { normalizeTurnResponse } from '../../scripts/agent-travel-benchmark.mjs';

const guard = {
  containsSecret: () => false,
  redact: <T>(value: T): T => value,
};

describe('Agent Base Harness travel benchmark normalization', () => {
  it('maps skill_load to the shared Skill evidence shape and preserves bash evidence', () => {
    const events = [
      {
        sessionId: 'session-1',
        seq: 1,
        eventType: 'tool.call',
        occurredAt: '2026-09-02T00:00:00.100Z',
        __receivedAtMs: 100,
        payload: {
          turnId: 'turn-1',
          stepId: 'step-1',
          toolCallId: 'tool-1',
          toolName: 'skill_load',
          input: { skillName: '12306' },
        },
      },
      {
        sessionId: 'session-1',
        seq: 2,
        eventType: 'tool.call',
        occurredAt: '2026-09-02T00:00:00.200Z',
        __receivedAtMs: 200,
        payload: {
          turnId: 'turn-1',
          stepId: 'step-1',
          toolCallId: 'tool-2',
          toolName: 'bash',
          input: { command: 'node query.mjs 上海虹桥 杭州东 --json --seat ze' },
        },
      },
      {
        sessionId: 'session-1',
        seq: 3,
        eventType: 'assistant.message',
        occurredAt: '2026-09-02T00:00:00.300Z',
        __receivedAtMs: 300,
        payload: {
          turnId: 'turn-1',
          stepId: 'step-1',
          requestId: 'request-1',
          content: '推荐 G123。',
        },
      },
    ];
    const response = normalizeTurnResponse(
      events,
      {
        items: [
          {
            requestId: 'request-1',
            stepId: 'step-1',
            startedAt: '1970-01-01T00:00:00.000Z',
            firstTokenAt: '1970-01-01T00:00:00.100Z',
            completedAt: '1970-01-01T00:00:00.300Z',
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            ttftMs: 100,
            tps: 100,
            stopReason: 'complete',
          },
        ],
      },
      0,
      300,
      guard,
      false,
    );

    expect(response.tool_calls).toEqual([
      expect.objectContaining({ toolName: 'Skill', input: { skill: '12306' } }),
      expect.objectContaining({ toolName: 'bash' }),
    ]);
    expect(response.model_metrics).toEqual(
      expect.objectContaining({
        model_call_count: 1,
        total_input_tokens: 100,
        total_output_tokens: 20,
      }),
    );
    expect(response.final_text).toBe('推荐 G123。');
  });
});
