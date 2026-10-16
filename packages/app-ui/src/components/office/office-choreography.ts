import type { ProjectedDelegation } from '@client-contracts';
import { activeDelegation } from './office-model';

export type OfficeVisit = { id: string; delegationId: string; kind: 'assign' | 'report' };
export type OfficeStage = 'outbound' | 'speaking' | 'returning';
export const OFFICE_SPEAK_MS = 2600;

// A snapshot establishes a baseline. Only subsequent facts produce visits, so reloading
// a conversation never replays its history. A batch may contain both acceptance and completion.
export function collectOfficeVisits(
  previous: ReadonlyMap<string, ProjectedDelegation['status']> | null,
  delegations: readonly ProjectedDelegation[],
): { seen: Map<string, ProjectedDelegation['status']>; visits: OfficeVisit[] } {
  const seen = new Map(previous ?? []);
  const visits: OfficeVisit[] = [];
  for (const item of delegations) {
    const before = seen.get(item.id);
    seen.set(item.id, item.status);
    if (!previous) continue;
    if (!before && (activeDelegation(item) || item.status === 'completed')) {
      visits.push({ id: `${item.id}:assign`, delegationId: item.id, kind: 'assign' });
    }
    if (item.status === 'completed' && before !== 'completed') {
      visits.push({ id: `${item.id}:report`, delegationId: item.id, kind: 'report' });
    }
  }
  return { seen, visits };
}

export function enqueueOfficeVisits(
  queue: readonly OfficeVisit[],
  incoming: readonly OfficeVisit[],
  seen: ReadonlyMap<string, ProjectedDelegation['status']>,
): OfficeVisit[] {
  return [...new Map([...queue, ...incoming].map((visit) => [visit.id, visit])).values()].filter(
    (visit) => {
      const status = seen.get(visit.delegationId);
      return status !== undefined && !['failed', 'cancelled', 'interrupted'].includes(status);
    },
  );
}
