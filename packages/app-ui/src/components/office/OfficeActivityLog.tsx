import { ArrowUpRight } from 'lucide-react';
import type { ProjectedDelegation } from '@client-contracts';
import { delegationLabels, type OfficeAgent } from './office-model';
import { PixelPerson } from './OfficeAgent';

export function OfficeActivityLog({
  delegations,
  onSelect,
  members,
}: {
  delegations: readonly ProjectedDelegation[];
  onSelect(id: string): void;
  members: OfficeAgent[];
}) {
  const recent = [...delegations]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 2);
  if (!recent.length) return null;
  return (
    <div className="office-activity-log" aria-label="最近的委派动态">
      {recent.map((item) => (
        <button key={item.id} onClick={() => onSelect(item.targetAgentId)}>
          <span className={`office-log-dot ${item.status}`} />
          <svg className="office-log-avatar" viewBox="-28 -64 56 74" aria-hidden="true">
            <PixelPerson index={members.findIndex((member) => member.id === item.targetAgentId)} />
          </svg>
          <span>
            {item.targetAgentName ?? '协作伙伴'} · {delegationLabels[item.status]}
          </span>
          <time dateTime={item.updatedAt}>
            {new Date(item.updatedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <ArrowUpRight size={13} />
        </button>
      ))}
    </div>
  );
}
