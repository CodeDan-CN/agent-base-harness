import { describe, expect, it } from 'vitest';
import {
  groupExecutionPhases,
  shouldAutoExpandExecutionProcess,
} from '../../packages/app-ui/src/execution-process-policy';

function step(id: string, stepIndex: number, status = 'completed') {
  return { id, stepIndex, status };
}

function tool(id: string, stepId: string, callIndex = 0) {
  return { id, stepId, callIndex };
}

function reasoning(stepId: string, content: string) {
  return { stepId, content };
}

describe('执行过程按 Step 分段', () => {
  it('运行中自动展开，模型回答结束后自动折叠', () => {
    expect(shouldAutoExpandExecutionProcess('running')).toBe(true);
    expect(shouldAutoExpandExecutionProcess('completed')).toBe(false);
    expect(shouldAutoExpandExecutionProcess('failed')).toBe(false);
    expect(shouldAutoExpandExecutionProcess('cancelled')).toBe(false);
  });

  it('没有 reasoning 也按步骤保留工具归属', () => {
    const phases = groupExecutionPhases({
      steps: [step('step-10', 10), step('step-11', 11), step('step-12', 12)],
      tools: [tool('tool-10', 'step-10'), tool('tool-11', 'step-11'), tool('tool-12', 'step-12')],
      reasoning: [reasoning('step-10', '先分三段写入。')],
    });

    expect(phases).toHaveLength(3);
    expect(phases.map((phase) => phase.steps[0]?.id)).toEqual(['step-10', 'step-11', 'step-12']);
    expect(phases.map((phase) => phase.tools[0]?.id)).toEqual(['tool-10', 'tool-11', 'tool-12']);
    expect(phases[0]?.reasoning?.content).toBe('先分三段写入。');
  });

  it('同一步里的并行工具按 callIndex 一起展示', () => {
    const phases = groupExecutionPhases({
      steps: [step('step-1', 1)],
      tools: [tool('tool-b', 'step-1', 1), tool('tool-a', 'step-1', 0)],
      reasoning: [reasoning('step-1', '并行查询两个来源。')],
    });

    expect(phases[0]?.tools.map((item) => item.id)).toEqual(['tool-a', 'tool-b']);
  });

  it('模型返回新的 reasoning 时开启新阶段', () => {
    const phases = groupExecutionPhases({
      steps: [step('step-1', 1), step('step-2', 2), step('step-3', 3)],
      tools: [tool('tool-1', 'step-1'), tool('tool-2', 'step-2'), tool('tool-3', 'step-3')],
      reasoning: [reasoning('step-1', '第一阶段'), reasoning('step-3', '第二阶段')],
    });

    expect(phases).toHaveLength(3);
    expect(phases[0]?.tools.map((item) => item.id)).toEqual(['tool-1']);
    expect(phases[2]?.tools.map((item) => item.id)).toEqual(['tool-3']);
  });

  it('首个工具没有 reasoning 时只展示执行阶段，不制造思考内容', () => {
    const phases = groupExecutionPhases({
      steps: [step('step-1', 1)],
      tools: [tool('tool-1', 'step-1')],
      reasoning: [],
    });

    expect(phases).toHaveLength(1);
    expect(phases[0]?.reasoning).toBeNull();
    expect(phases[0]?.tools.map((item) => item.id)).toEqual(['tool-1']);
  });

  it('已完成且没有 reasoning 或工具的步骤不留下空执行框', () => {
    const phases = groupExecutionPhases({
      steps: [step('step-1', 1)],
      tools: [],
      reasoning: [],
    });

    expect(phases).toHaveLength(0);
  });
});
