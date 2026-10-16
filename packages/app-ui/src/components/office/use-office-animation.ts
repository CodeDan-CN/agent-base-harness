import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectedDelegation } from '@client-contracts';
import {
  collectOfficeVisits,
  enqueueOfficeVisits,
  OFFICE_SPEAK_MS,
  type OfficeStage,
  type OfficeVisit,
} from './office-choreography';

export function useOfficeAnimation(delegations: readonly ProjectedDelegation[], ready: boolean) {
  const seen = useRef<Map<string, ProjectedDelegation['status']> | null>(null);
  const [queue, setQueue] = useState<OfficeVisit[]>([]);
  const [frame, setFrame] = useState<{ id: string; stage: OfficeStage } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const visit = queue[0] ?? null;
  const visitId = visit?.id;
  const stage = frame && frame.id === visitId ? frame.stage : 'outbound';
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const next = collectOfficeVisits(seen.current, delegations);
    seen.current = next.seen;
    setQueue((current) => {
      const updated = enqueueOfficeVisits(current, next.visits, next.seen);
      return updated.length === current.length &&
        updated.every((item, index) => item.id === current[index]?.id)
        ? current
        : updated;
    });
  }, [delegations, ready]);
  useEffect(() => {
    if (!visitId || stage !== 'speaking') return;
    const timer = window.setTimeout(
      () => setFrame({ id: visitId, stage: 'returning' }),
      OFFICE_SPEAK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [visitId, stage]);
  const onVisitArrive = useCallback(
    (id: string, arrivedStage: OfficeStage) => {
      if (id !== visitId || arrivedStage !== stage) return;
      if (stage === 'outbound') setFrame({ id, stage: 'speaking' });
      if (stage === 'returning') setQueue((current) => current.filter((item) => item.id !== id));
    },
    [visitId, stage],
  );
  const reservedAgentIds = [
    ...new Set(
      queue.flatMap((item) => {
        const delegation = delegations.find((candidate) => candidate.id === item.delegationId);
        return delegation ? [delegation.targetAgentId] : [];
      }),
    ),
  ];
  return { visit, stage, reducedMotion, queued: queue.length, reservedAgentIds, onVisitArrive };
}
