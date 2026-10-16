import type { AgentProfile, ProjectedDelegation, RuntimeProjection } from '@client-contracts';
import { assistantMessagePhase } from '@client-contracts';
import { executionActivity } from '../../execution-activity';

export type OfficeAgent = Pick<AgentProfile, 'id' | 'name' | 'description'>;

export const delegationLabels: Record<ProjectedDelegation['status'], string> = {
  accepted: '已接纳',
  running: '执行中',
  awaiting_user: '等待你答复',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export function activeDelegation(item: ProjectedDelegation): boolean {
  return ['accepted', 'running', 'awaiting_user'].includes(item.status);
}

export function callerStatus(
  projection: RuntimeProjection | null,
  runtimeReady: boolean,
  activeCount: number,
): string {
  if (!runtimeReady) return '连接中';
  if (!projection) return '待命';
  if ([...projection.interactions.values()].some((item) => item.status === 'pending'))
    return '等待你答复';
  if ([...projection.approvals.values()].some((item) => item.status === 'pending'))
    return '等待授权';
  if (projection.activeTurn) return activeCount ? '协调任务' : '执行中';
  const latest = [...projection.turns.values()].at(-1);
  return latest
    ? {
        running: '执行中',
        completed: '已完成',
        failed: '执行失败',
        cancelled: '已停止',
        interrupted: '已中断',
      }[latest.status]
    : '待命';
}

export function officeMembers(
  caller: OfficeAgent,
  agents: readonly OfficeAgent[],
  delegations: readonly ProjectedDelegation[],
): OfficeAgent[] {
  const members = new Map<string, OfficeAgent>([[caller.id, caller]]);
  for (const agent of agents) if (!members.has(agent.id)) members.set(agent.id, agent);
  for (const item of delegations) {
    if (!members.has(item.targetAgentId))
      members.set(item.targetAgentId, {
        id: item.targetAgentId,
        name: item.targetAgentName ?? '协作伙伴',
        description: '受派智能体',
      });
  }
  return [...members.values()];
}

export function delegationTask(
  projection: RuntimeProjection | null,
  item: ProjectedDelegation,
): string {
  const input = projection?.toolCalls.get(item.parentToolCallId)?.input;
  return input && typeof input === 'object' && 'task' in input && typeof input.task === 'string'
    ? input.task
    : '查看委派执行详情';
}

export function officeActivity(projection: RuntimeProjection | null): string | null {
  if (!projection) return null;
  const pending = [...projection.interactions.values()].find((item) => item.status === 'pending');
  if (pending) return pending.prompt;
  if ([...projection.approvals.values()].some((item) => item.status === 'pending'))
    return '有一项操作需要你授权';
  if (!projection.activeTurn) return null;
  const turn = projection.activeTurn ?? [...projection.turns.values()].at(-1);
  const stream = [...projection.streams.values()]
    .reverse()
    .find(
      (item) =>
        item.turnId === turn?.id &&
        !item.finalized &&
        item.displayPhase === 'commentary' &&
        item.content.trim(),
    );
  if (stream) return stream.content;
  const step = [...projection.steps.values()].reverse().find((item) => item.turnId === turn?.id);
  if (step?.status === 'running') {
    const activity = executionActivity(projection, step);
    if (activity) return activity;
  }
  const message = [...projection.messages]
    .reverse()
    .find(
      (item) =>
        item.turnId === turn?.id &&
        item.role === 'assistant' &&
        assistantMessagePhase(item) === 'commentary' &&
        item.content.trim(),
    );
  return message?.content ?? (projection.activeTurn ? '正在处理任务…' : null);
}
