import { describe, expect, it } from 'vitest';
import {
  FULL_ACCESS_AUTONOMY_PROMPT,
  estimateTextTokens,
} from '../../packages/runtime-core/src/context-projector';
import type { ModelToolDefinition } from '../../packages/runtime-core/src/model';
import { modelToolsForPermission } from '../../packages/runtime-core/src/permission-tool-policy';

const baselineTool: ModelToolDefinition = {
  name: 'request_user_input',
  description: '缺少必要信息时暂停当前任务并请用户补充。',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    additionalProperties: false,
  },
};

const runtimeTool: ModelToolDefinition = {
  ...baselineTool,
  inputSchema: {
    ...baselineTool.inputSchema,
    properties: {
      ...(baselineTool.inputSchema.properties as Record<string, unknown>),
      requiresUserProvidedFact: {
        type: 'boolean',
        default: false,
        description: '内部运行时校验说明，不应发送给常规模型。',
      },
    },
  },
};

describe('permission-specific model tool policy', () => {
  it.each(['approval-required', 'guarded'] as const)(
    '%s keeps the original request_user_input prompt footprint',
    (permissionPreset) => {
      expect(modelToolsForPermission([runtimeTool], permissionPreset)).toEqual([baselineTool]);
    },
  );

  it('keeps full-access prompt overhead at about 100 estimated tokens or less', () => {
    const fullAccessTools = modelToolsForPermission([runtimeTool], 'full-access');
    expect(fullAccessTools[0]?.inputSchema).toMatchObject({
      properties: { requiresUserProvidedFact: { type: 'boolean' } },
    });

    const systemDelta = estimateTextTokens(`\n\n${FULL_ACCESS_AUTONOMY_PROMPT}`);
    const toolDelta =
      estimateTextTokens(JSON.stringify(fullAccessTools)) -
      estimateTextTokens(JSON.stringify([baselineTool]));
    expect(systemDelta + toolDelta).toBeLessThanOrEqual(100);
  });
});
