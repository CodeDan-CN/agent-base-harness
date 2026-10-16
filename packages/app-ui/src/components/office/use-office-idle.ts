import { useCallback, useEffect, useRef, useState } from 'react';
import {
  advanceOfficeIdle,
  arriveOfficeIdle,
  mayWander,
  type OfficeIdleActivity,
  type OfficeIdleState,
} from './office-idle';
import type { OfficeAgent } from './office-model';

export function useOfficeIdle(
  members: readonly OfficeAgent[],
  statuses: Record<string, string>,
  enabled: boolean,
  reservedIds: readonly string[],
) {
  const [state, setState] = useState<OfficeIdleState>({});
  const [visible, setVisible] = useState(() => !document.hidden);
  const reserved = new Set(reservedIds);
  const eligibleIds =
    enabled && visible
      ? members
          .filter((member) => mayWander(statuses[member.id]) && !reserved.has(member.id))
          .map((member) => member.id)
      : [];
  const eligibleKey = JSON.stringify(eligibleIds);
  const eligibleRef = useRef(eligibleIds);
  eligibleRef.current = eligibleIds;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    const tick = () =>
      setState((previous) => advanceOfficeIdle(previous, eligibleRef.current, Date.now()));
    tick();
    if (!enabled || !visible) return;
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [eligibleKey, enabled, visible]);
  // Exclude preempted actors in this render, before the effect prunes their timer state.
  const arrive = useCallback((id: string, activity: OfficeIdleActivity) => {
    setState((previous) => arriveOfficeIdle(previous, id, activity, Date.now()));
  }, []);
  const activities = Object.fromEntries(
    eligibleIds.flatMap((id) => (state[id]?.activity ? [[id, state[id]!.activity!]] : [])),
  );
  return { activities, arrive };
}
