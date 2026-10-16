import { deskPosition, type OfficePoint } from './office-layout';

export type OfficeIdleKind = 'coffee' | 'sofa' | 'window';
export type OfficeIdlePhase = 'outbound' | 'resting' | 'returning';
export interface OfficeIdleActivity {
  kind: OfficeIdleKind;
  phase: OfficeIdlePhase;
  startedAt: number;
}
interface OfficeIdleAgent {
  cycle: number;
  nextAt: number;
  activity: OfficeIdleActivity | null;
}
export type OfficeIdleState = Record<string, OfficeIdleAgent>;
export const IDLE_REST_MS = 11000;
const kinds: OfficeIdleKind[] = ['coffee', 'window', 'sofa'];
export const idleLabels: Record<OfficeIdleKind, string> = {
  coffee: '喝杯咖啡',
  sofa: '沙发小憩',
  window: '看看风景',
};
export const idleDestinations: Record<OfficeIdleKind, OfficePoint> = {
  coffee: { x: 920, y: 467 },
  sofa: { x: 117, y: 537 },
  window: { x: 861, y: 263 },
};

export function mayWander(status: string | undefined): boolean {
  return status === '待命' || status === '已完成' || status === '已停止';
}

function seed(id: string): number {
  return [...id].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
}

// Presentation-only state. Occupancy prevents two characters using the same seat or coffee spot.
// Removing an ineligible agent immediately yields to task/interaction/hand-off rendering.
export function advanceOfficeIdle(
  previous: OfficeIdleState,
  eligibleIds: readonly string[],
  now: number,
): OfficeIdleState {
  const allowed = new Set(eligibleIds);
  const next: OfficeIdleState = {};
  for (const [id, item] of Object.entries(previous)) if (allowed.has(id)) next[id] = item;
  const occupied = new Set(
    Object.values(next).flatMap((item) => (item.activity ? [item.activity.kind] : [])),
  );
  for (const id of eligibleIds) {
    const current = next[id];
    if (!current) {
      next[id] = { cycle: 0, nextAt: now + 4500 + (seed(id) % 4500), activity: null };
      continue;
    }
    const activity = current.activity;
    if (activity) {
      // Travel ends only when the actor arrives, never on a separate wall-clock timer.
      if (
        activity.phase !== 'resting' ||
        now - activity.startedAt < IDLE_REST_MS + (seed(id) % 5000)
      )
        continue;
      next[id] = {
        ...current,
        activity: {
          ...activity,
          phase: 'returning',
          startedAt: now,
        },
      };
    } else if (now >= current.nextAt) {
      const offset = (seed(id) + current.cycle) % kinds.length;
      const kind = [...kinds.slice(offset), ...kinds.slice(0, offset)].find(
        (candidate) => !occupied.has(candidate),
      );
      if (kind) {
        occupied.add(kind);
        next[id] = { ...current, activity: { kind, phase: 'outbound', startedAt: now } };
      }
    }
  }
  return Object.keys(next).length === Object.keys(previous).length &&
    Object.entries(next).every(([id, item]) => previous[id] === item)
    ? previous
    : next;
}

export function arriveOfficeIdle(
  previous: OfficeIdleState,
  id: string,
  activity: OfficeIdleActivity,
  now: number,
): OfficeIdleState {
  const current = previous[id];
  if (
    !current?.activity ||
    current.activity.phase !== activity.phase ||
    current.activity.startedAt !== activity.startedAt ||
    current.activity.kind !== activity.kind ||
    activity.phase === 'resting'
  )
    return previous;
  return {
    ...previous,
    [id]:
      activity.phase === 'returning'
        ? {
            cycle: current.cycle + 1,
            nextAt: now + 10000 + (seed(`${id}:${current.cycle}`) % 10000),
            activity: null,
          }
        : { ...current, activity: { ...activity, phase: 'resting', startedAt: now } },
  };
}

export function idlePath(index: number, kind: OfficeIdleKind, returning = false): string {
  const desk = deskPosition(index);
  const destination = idleDestinations[kind];
  const corridor = 585;
  const points = [
    { x: desk.x, y: desk.y + 66 },
    { x: desk.x, y: desk.y + 112 },
    { x: corridor, y: desk.y + 112 },
    ...(kind === 'sofa'
      ? [
          { x: corridor, y: 412 },
          { x: 290, y: 412 },
          { x: 290, y: 640 },
          { x: destination.x, y: 640 },
        ]
      : [
          { x: corridor, y: 412 },
          { x: 891, y: 412 },
          ...(kind === 'window' ? [{ x: 891, y: 205 }] : []),
        ]),
    destination,
  ];
  if (returning) points.reverse();
  return points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
}
