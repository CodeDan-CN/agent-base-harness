import { z } from 'zod';
import { textContent, type RuntimeTool, type ToolExecutionContext } from '../tools';

export interface AgentCallResult {
  delegationId: string;
  delegatedSessionId: string;
  targetAgentId: string;
  status: 'completed' | 'failed' | 'awaiting_user';
  report: string;
  locations: Array<{ path: string }>;
}

export function createAgentCallTool(
  delegate: (
    context: ToolExecutionContext,
    input: { targetAgentId: string; task: string; allowSharedMemory: boolean },
  ) => Promise<AgentCallResult>,
): RuntimeTool<AgentCallResult> {
  const input = z
    .object({
      targetAgentId: z.string().min(1).max(128),
      task: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1024),
      allowSharedMemory: z.boolean().default(false),
    })
    .strict();
  return {
    name: 'agent_call',
    description:
      '向 capability_search 返回的已授权同级智能体请求帮忙。双方没有主次；仅 direct 会话可用，对方返回独立报告且不自动获得当前会话历史。',
    parameters: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string', minLength: 1, maxLength: 128 },
        task: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
          description:
            '向同级智能体提出的帮忙请求：只转述用户需求和必要上下文，不规定对方的产出形式或执行方式。',
        },
        allowSharedMemory: { type: 'boolean', default: false },
      },
      required: ['targetAgentId', 'task'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render(_args, value) {
        const { locations, ...report } = value;
        return textContent({
          ...report,
          files: locations.map((location) => basename(location.path)),
        });
      },
      presentationMeta(_args, value) {
        return { locations: value.locations };
      },
    },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 10 * 60_000,
    execute(raw, context) {
      return delegate(context, input.parse(raw));
    },
    presentCall(raw) {
      const parsed = input.safeParse(raw);
      return {
        kind: 'generic',
        title: '调用智能体',
        detail: parsed.success ? parsed.data.targetAgentId : undefined,
      };
    },
    presentResult(_raw, result) {
      return {
        kind: 'generic',
        title: '智能体报告',
        status: result.status === 'success' ? 'success' : 'error',
        locations: result.status === 'success' ? locationsOf(result.meta) : [],
      };
    },
  };
}

function locationsOf(value: unknown): Array<{ path: string }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const locations = (value as { locations?: unknown }).locations;
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((location) => {
    if (typeof location !== 'object' || location === null || Array.isArray(location)) return [];
    const path = (location as { path?: unknown }).path;
    return typeof path === 'string' && path ? [{ path }] : [];
  });
}

function basename(value: string): string {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return index < 0 ? value : value.slice(index + 1);
}
