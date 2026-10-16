import { useLayoutEffect, useRef, useState } from 'react';
import type { OfficePoint } from './office-layout';
import { officeWalkFrame, officeWalkSegments, type OfficeWalkFrame } from './office-walk';
import {
  continueOfficeRoute,
  officePathPoints,
  officePointAt,
  OFFICE_WALK_SPEED,
} from './office-movement';

export function useOfficeMovement({
  point,
  path,
  motionKey,
  reducedMotion,
  onArrive,
  onMovingChange,
}: {
  point: OfficePoint;
  path?: string;
  motionKey: string;
  reducedMotion: boolean;
  onArrive(): void;
  onMovingChange(moving: boolean): void;
}) {
  const element = useRef<SVGGElement>(null);
  const position = useRef(point);
  const previousRoute = useRef<OfficePoint[]>([point]);
  const callbacks = useRef({ onArrive, onMovingChange });
  callbacks.current = { onArrive, onMovingChange };
  const [walk, setWalk] = useState<OfficeWalkFrame>({ facing: 'down', frame: 0, moving: false });

  useLayoutEffect(() => {
    const requested = path ? officePathPoints(path) : [{ x: point.x, y: point.y }];
    const target = requested.at(-1)!;
    const points = continueOfficeRoute(position.current, previousRoute.current, requested);
    // Retain the route while resting, so a new task can follow it back to an aisle.
    if (points.length > 1) previousRoute.current = points;
    const route = points.map((p, index) => `${index ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    const segments = officeWalkSegments(route);
    const total = segments.at(-1)?.end ?? 0;
    const duration = (total / OFFICE_WALK_SPEED) * 1000;
    let elapsed = 0;
    let last: number | null = null;
    let request = 0;
    let finished = false;
    const publish = (next: OfficeWalkFrame) => {
      setWalk((current) =>
        current.facing === next.facing &&
        current.frame === next.frame &&
        current.moving === next.moving
          ? current
          : next,
      );
    };
    const place = (next: OfficePoint) => {
      position.current = next;
      element.current?.setAttribute('transform', `translate(${next.x} ${next.y})`);
    };
    const finish = () => {
      finished = true;
      place(target);
      publish(officeWalkFrame(segments, duration, duration));
      callbacks.current.onMovingChange(false);
      callbacks.current.onArrive();
    };
    place(position.current);
    if (reducedMotion || !total) {
      finish();
      return;
    }
    callbacks.current.onMovingChange(true);
    publish(officeWalkFrame(segments, 0, duration));
    const tick = (now: number) => {
      // A suspended tab or long render must never catch up by jumping across the room.
      if (last !== null) elapsed += Math.min(32, Math.max(0, now - last));
      last = now;
      if (elapsed >= duration) {
        finish();
        return;
      }
      place(officePointAt(points, (elapsed / 1000) * OFFICE_WALK_SPEED));
      publish(officeWalkFrame(segments, elapsed, duration));
      request = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(request);
      last = null;
      if (!document.hidden && !finished) request = requestAnimationFrame(tick);
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(request);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, point.x, point.y, motionKey, reducedMotion]);

  return { element, walk };
}
