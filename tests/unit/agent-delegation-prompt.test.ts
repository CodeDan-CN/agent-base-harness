import { describe, expect, it } from 'vitest';
import { createAgentCallTool } from '../../packages/runtime-core/src/delegation/agent-call-tool';
import { MINIMAL_SYSTEM_PROMPT } from '../../packages/runtime-core/src/model';

describe('agent delegation prompt', () => {
  it('gives peer specialists ownership of their execution method', () => {
    const tool = createAgentCallTool(async () => {
      throw new Error('not executed');
    });
    const properties = tool.parameters.properties as Record<
      string,
      { description?: string }
    >;

    expect(MINIMAL_SYSTEM_PROMPT).toContain('委派是同级专业协作');
    expect(MINIMAL_SYSTEM_PROMPT).toContain('不要用教程式步骤或预设方案指导对方');
    expect(tool.description).toContain('尊重对方的专业判断');
    expect(properties.task?.description).toContain('不要预设方案或逐步指导');
    expect(properties.task?.description).toContain('自主决定执行方式');
  });
});
