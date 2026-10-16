import { describe, expect, it } from 'vitest';
import {
  officeWalkFrame,
  officeWalkSegments,
} from '../../packages/app-ui/src/components/office/office-walk';
import {
  deskPosition,
  officeVisitPath,
} from '../../packages/app-ui/src/components/office/office-layout';
import { idlePath } from '../../packages/app-ui/src/components/office/office-idle';
import {
  continueOfficeRoute,
  officePathPoints,
  officePointAt,
  pointDistance,
} from '../../packages/app-ui/src/components/office/office-movement';

describe('office walking follows paced movement', () => {
  it('turns at distance-weighted corners instead of splitting time evenly', () => {
    const route = officeWalkSegments('M 0 0 L 0 10 L 90 10 L 90 0');
    expect(officeWalkFrame(route, 99, 1100).facing).toBe('down');
    expect(officeWalkFrame(route, 100, 1100).facing).toBe('right');
    expect(officeWalkFrame(route, 999, 1100).facing).toBe('right');
    expect(officeWalkFrame(route, 1000, 1100).facing).toBe('up');
  });

  it('ignores repeated points and stops animating on arrival', () => {
    const route = officeWalkSegments('M 0 0 L 0 0 L 10 0 L 10 0');
    expect(route).toEqual([{ end: 10, facing: 'right' }]);
    expect(officeWalkFrame(route, 1000, 1000)).toEqual({
      facing: 'right',
      frame: 0,
      moving: false,
    });
    expect(officeWalkFrame([], 0, 1000).moving).toBe(false);
    expect(officeWalkFrame(route, 0, 0).moving).toBe(false);
  });

  it('alternates four walk poses and wraps without restarting at a corner', () => {
    const route = officeWalkSegments('M 0 0 L 100 0');
    expect([0, 120, 240, 360, 480].map((time) => officeWalkFrame(route, time, 1000).frame)).toEqual(
      [0, 1, 2, 3, 0],
    );
  });

  it('reverses every facing for both delegation and idle return routes', () => {
    const opposite = { down: 'up', up: 'down', left: 'right', right: 'left' };
    const pairs = [
      [
        officeVisitPath(deskPosition(0), deskPosition(2)),
        officeVisitPath(deskPosition(0), deskPosition(2), true),
      ],
      ...(['coffee', 'sofa', 'window'] as const).map((kind) => [
        idlePath(0, kind),
        idlePath(0, kind, true),
      ]),
    ];
    for (const [outbound, returning] of pairs) {
      const outward = officeWalkSegments(outbound!);
      const inward = officeWalkSegments(returning!);
      expect(inward.map((segment) => segment.facing)).toEqual(
        outward.map((segment) => opposite[segment.facing]).reverse(),
      );
      expect(inward.at(-1)?.end).toBeCloseTo(outward.at(-1)!.end);
    }
  });
});

describe('continuous office movement', () => {
  it('interpolates corners and clamps to the endpoint without restarting at the origin', () => {
    const points = officePathPoints('M 10 20 L 10 20 L 10 50 L 70 50');
    expect(officePointAt(points, 15)).toEqual({ x: 10, y: 35 });
    expect(officePointAt(points, 40)).toEqual({ x: 20, y: 50 });
    expect(officePointAt(points, 1000)).toEqual({ x: 70, y: 50 });
  });

  it.each(['coffee', 'sofa', 'window'] as const)(
    'returns from any point on the %s route without teleporting or cutting across furniture',
    (kind) => {
      const previous = officePathPoints(idlePath(0, kind));
      const total = previous
        .slice(1)
        .reduce((sum, point, index) => sum + pointDistance(previous[index]!, point), 0);
      for (const fraction of [0.1, 0.4, 0.8, 1]) {
        const current = officePointAt(previous, total * fraction);
        const returning = continueOfficeRoute(current, previous, [previous[0]!]);
        expect(returning[0]).toEqual(current);
        expect(returning.at(-1)).toEqual(previous[0]);
        const returnLength = returning
          .slice(1)
          .reduce((sum, point, index) => sum + pointDistance(returning[index]!, point), 0);
        expect(returnLength).toBeCloseTo(total * fraction);
      }
    },
  );

  it('joins a delegation route from the current aisle rather than snapping to the desk', () => {
    const previous = officePathPoints(idlePath(0, 'coffee'));
    const requested = officePathPoints(officeVisitPath(deskPosition(0), deskPosition(2)));
    const current = { x: 585, y: 450 };
    const result = continueOfficeRoute(current, previous, requested);
    expect(result[0]).toEqual(current);
    expect(result.at(-1)).toEqual(requested.at(-1));
    expect(result).not.toContainEqual(previous[0]);
    expect(continueOfficeRoute(requested.at(-1)!, requested, [requested.at(-1)!])).toEqual([
      requested.at(-1),
    ]);
  });
});
