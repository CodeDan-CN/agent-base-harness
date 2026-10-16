import { Check, Circle, Hand, X } from 'lucide-react';
import type { ProjectedDelegation, RuntimeProjection } from '@client-contracts';
import { delegationLabels } from './office-model';

export function OfficeTaskTimeline({
  projection,
  task,
}: {
  projection: RuntimeProjection;
  task?: ProjectedDelegation;
}) {
  const latestTurn = [...projection.turns.values()].at(-1);
  const steps = [...projection.steps.values()]
    .filter((step) => step.turnId === latestTurn?.id)
    .slice(-2);
  const rows = [
    ...(task
      ? [{ id: 'accepted', text: '已接收委派', time: task.createdAt, status: 'completed' }]
      : []),
    ...steps.map((step) => ({
      id: step.id,
      text: `步骤 ${step.stepIndex} · ${{ running: '正在执行', completed: '已完成', failed: '执行失败', cancelled: '已停止' }[step.status]}`,
      time: step.endedAt ?? step.startedAt,
      status: step.status,
    })),
    ...(task
      ? [
          {
            id: 'status',
            text: delegationLabels[task.status],
            time: task.updatedAt,
            status: task.status,
          },
        ]
      : []),
  ];
  if (!rows.length) return null;
  return (
    <ol className="office-task-timeline">
      {rows.map((row) => (
        <li key={row.id} className={row.status}>
          <span className="office-timeline-marker">
            {row.status === 'completed' ? (
              <Check size={12} />
            ) : row.status === 'awaiting_user' ? (
              <Hand size={12} />
            ) : row.status === 'failed' ? (
              <X size={12} />
            ) : (
              <Circle size={8} />
            )}
          </span>
          <span>{row.text}</span>
          <time dateTime={row.time}>
            {new Date(row.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </li>
      ))}
    </ol>
  );
}
