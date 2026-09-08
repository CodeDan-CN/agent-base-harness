import { z } from 'zod';
import { textContent, type RuntimeTool, type ToolExecutionContext } from '../tools';

export interface AgentCallResult {
  delegationId: string;
  delegatedSessionId: string;
  targetAgentId: string;
  status: 'completed' | 'failed' | 'awaiting_user';
  report: string;
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
      '把一个有界任务委派给 capability_search 返回的已授权智能体。仅 direct 会话可用；受派智能体返回独立报告，不自动获得当前会话历史。',
    parameters: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string', minLength: 1, maxLength: 128 },
        task: { type: 'string', minLength: 1, maxLength: 65536 },
        allowSharedMemory: { type: 'boolean', default: false },
      },
      required: ['targetAgentId', 'task'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => textContent(value) },
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
      };
    },
  };
}
