import { describe, expect, it } from 'vitest';
import { projectRuntime, type RuntimeProjection, type ProjectedStep } from '../../packages/protocol/src/client/projection';
import { needsProgressReminder, PROGRESS_REMINDER } from '../../packages/runtime-core/src/progress-communication';
import { ContextProjector } from '../../packages/runtime-core/src/context-projector';
import { executionActivity } from '../../packages/app-ui/src/execution-activity';

const start = '2026-09-05T00:00:00.000Z';
function addStep(p: RuntimeProjection, n: number, content = ''): ProjectedStep {
  const step: ProjectedStep = { id: `s${n}`, turnId: 't', eventId: 'e', stepIndex: n,
    status: 'completed', startedAt: start, endedAt: start, requestContext: null };
  p.steps.set(step.id, step);
  p.messages.push({ seq: n * 2, role: 'assistant', content, turnId: 't', eventId: 'e', stepId: step.id });
  p.toolCalls.set(`c${n}`, { id: `c${n}`, stepId: step.id, turnId: 't', eventId: 'e', name: 'read', callIndex: 0, input: {}, status: 'success' });
  return step;
}
function projection(): RuntimeProjection {
  const p = projectRuntime([]);
  p.turns.set('t', {id: 't', eventId: 'e', exchangeId: 'x', status: 'running', stepCount: 0,
    cancelRequested: false, startedAt: start, endedAt: null, endReason: null});
  return p;
}

describe('progress communication', () => {
  it('提醒按轮计算，排除推理、其他 Turn，并在正文后重置', () => {
    const p = projection();
    expect(needsProgressReminder(p, 't', start)).toBe(false);
    addStep(p, 1);
    p.reasoning.set('r', {requestId:'r', stepId:'s1', turnId:'t', content:'有推理', chunkCount:1, finalized:true});
    expect(needsProgressReminder(p, 't', start)).toBe(true);
    expect(needsProgressReminder(p, 'other', start)).toBe(false);
    addStep(p, 2, '已核对表头，接下来检查缺失行。');
    expect(needsProgressReminder(p, 't', start)).toBe(false);
    addStep(p, 3);
    expect(needsProgressReminder(p, 't', start)).toBe(true);
  });

  it('提醒被忽略后间隔两轮再提醒，避免每个请求重复催促', () => {
    const p = projection();
    const first = addStep(p, 1);
    first.requestContext = requestContext(true);
    expect(needsProgressReminder(p, 't', start)).toBe(false);
    addStep(p, 2);
    expect(needsProgressReminder(p, 't', start)).toBe(true);
  });

  it('等待超过 60 秒才在下一次请求提醒；时间倒退不触发', () => {
    const p = projection();
    addStep(p, 1, '先读取表格。');
    expect(needsProgressReminder(p, 't', '2026-09-05T00:00:59Z')).toBe(false);
    expect(needsProgressReminder(p, 't', '2026-09-05T00:01:00Z')).toBe(true);
    expect(needsProgressReminder(p, 't', '2026-09-04T00:00:00Z')).toBe(false);
  });

  it('提醒合并进唯一的开头 system 消息，重复投影不累积，预算紧张时省略', () => {
    const projector = new ContextProjector();
    const current = projection();
    current.messages.push({
      seq: 1,
      role: 'user',
      content: '继续执行',
      turnId: 't',
      eventId: 'e',
    });
    const input = { projection: current, turnId:'t', eventId:'e', contextWindow:10000,
      reservedOutputTokens:0, safetyTokens:0, tools:[], skills:[] };
    const base = projector.project(input);
    const reminded = projector.project({...input, progressReminder:true});
    expect(reminded.messages[0]).toMatchObject({role:'system'});
    expect(reminded.messages[0]?.content).toContain(PROGRESS_REMINDER);
    expect(reminded.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(reminded.messages.at(-1)).toEqual({role:'user', content:'继续执行'});
    expect(reminded.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens);
    expect(reminded.estimatedInputTokens).toBe(Object.values(reminded.tokenBreakdown).reduce((a,b)=>a+b,0));
    expect(projector.project({...input, progressReminder:true})).toEqual(reminded);
    expect(input.projection.messages).toHaveLength(1);
    const tight = projector.project({...input, contextWindow:base.estimatedInputTokens, progressReminder:true});
    expect(tight.progressReminder).toBe(false);
    expect(tight.messages).toEqual(base.messages);
  });

  it('运行状态只陈述已知工具结果；停止后不再声称等待工具', () => {
    const p = projection();
    const step = addStep(p, 1);
    expect(executionActivity(p, step)).toBe('已完成 1 项工具调用');
    step.status = 'running';
    p.toolCalls.get('c1')!.status = 'running';
    p.toolCalls.get('c1')!.presentation = { title: '读取报表' };
    expect(executionActivity(p, step)).toBe('正在执行：读取报表');
    step.status = 'cancelled';
    expect(executionActivity(p, step)).toBe('本步骤已停止');
    step.status = 'completed';
    p.toolCalls.get('c1')!.status = 'execution_error';
    expect(executionActivity(p, step)).toContain('0/1 项成功');
    p.toolCalls.clear();
    expect(executionActivity(p, step)).toBeNull();
    step.status = 'running';
    p.reasoning.set('reasoning', {
      requestId: 'r',
      stepId: step.id,
      turnId: 't',
      content: '内部推理',
      chunkCount: 1,
      finalized: false,
    });
    expect(executionActivity(p, step)).toBeNull();
  });
});

function requestContext(progressReminder: boolean): NonNullable<ProjectedStep['requestContext']> {
  return {
    requestId: 'r', progressReminder, modelId: 'm', configRevision: 1, promptEpoch: 1,
    estimatedInputTokens: 1, budgetTokens: 10, tokenBreakdown: null, includedEventIds: ['e'],
    skillRevision: 0, runtimeRevision: 0, mcpRevision: 0,
  };
}
