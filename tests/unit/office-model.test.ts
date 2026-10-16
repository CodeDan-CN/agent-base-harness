import { describe, expect, it } from 'vitest';
import { projectRuntime } from '@client-contracts';
import {
  callerStatus,
  officeActivity,
  officeMembers,
} from '../../packages/app-ui/src/components/office/office-model';

describe('office display reflects public execution facts', () => {
  it('shows a failed caller instead of falsely displaying idle', () => {
    const projection = projectRuntime([]);
    projection.turns.set('t', {
      id: 't',
      eventId: 'e',
      exchangeId: 'x',
      status: 'failed',
      stepCount: 1,
      cancelRequested: false,
      startedAt: '',
      endedAt: '',
      endReason: 'model_credential_missing',
    });
    expect(callerStatus(projection, true, 0)).toBe('执行失败');
    expect(callerStatus(projection, false, 0)).toBe('连接中');
  });
  it('deduplicates the current agent and authorized colleagues', () => {
    const caller = { id: 'dylan', name: 'Dylan', description: '' };
    const expert = { id: 'expert', name: 'Expert', description: '' };
    expect(officeMembers(caller, [expert, caller, expert], []).map((item) => item.id)).toEqual([
      'dylan',
      'expert',
    ]);
  });
  it('does not show old commentary as ongoing work after completion', () => {
    const projection = projectRuntime([]);
    projection.messages.push({
      role: 'assistant',
      phase: 'commentary',
      content: '正在检索资料',
      turnId: 't',
      eventId: 'e',
      seq: 1,
    });
    expect(officeActivity(projection)).toBeNull();
  });
  it('gives pending questions priority over progress and preserves their exact text', () => {
    const projection = projectRuntime([]);
    projection.interactions.set('q', {
      id: 'q',
      eventId: 'e',
      turnId: 't',
      status: 'pending',
      prompt: '预算是否包含交通？',
      kind: 'confirm',
      options: [],
      questions: [],
      schema: null,
    });
    expect(officeActivity(projection)).toBe('预算是否包含交通？');
  });
  it('uses commentary while never exposing reasoning as a speech bubble', () => {
    const projection = projectRuntime([]);
    projection.activeTurn = {
      id: 't',
      eventId: 'e',
      exchangeId: 'x',
      status: 'running',
      stepCount: 1,
      cancelRequested: false,
      startedAt: '',
      endedAt: null,
      endReason: null,
    };
    projection.reasoning.set('r', {
      requestId: 'r',
      stepId: 's',
      turnId: 't',
      content: 'private reasoning',
      chunkCount: 1,
      finalized: false,
    });
    expect(officeActivity(projection)).toBe('正在处理任务…');
    projection.streams.set('public', {
      requestId: 'public',
      turnId: 't',
      displayPhase: 'commentary',
      content: '我正在核对预算。',
      chunkCount: 1,
      finalized: false,
    });
    expect(officeActivity(projection)).toBe('我正在核对预算。');
  });
});
