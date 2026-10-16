import { describe, expect, it } from 'vitest';
import {
  advanceOfficeIdle,
  arriveOfficeIdle,
  idleDestinations,
  idlePath,
  mayWander,
} from '../../packages/app-ui/src/components/office/office-idle';

describe('office idle presentation', () => {
  it('only allows available or finished agents to wander', () => {
    for (const status of ['待命', '已完成', '已停止']) expect(mayWander(status)).toBe(true);
    for (const status of [
      '执行中',
      '2 项执行中',
      '协调任务',
      '等待你答复',
      '等待授权',
      '连接中',
      '执行失败',
      '已中断',
      undefined,
    ])
      expect(mayWander(status)).toBe(false);
  });
  it('starts after a quiet period and reserves each destination for one agent', () => {
    const members = ['a', 'b', 'c', 'd'];
    const initial = advanceOfficeIdle({}, members, 0);
    expect(Object.values(initial).every((item) => !item.activity)).toBe(true);
    expect(advanceOfficeIdle(initial, members, 100)).toBe(initial);
    const walking = advanceOfficeIdle(initial, members, 10000);
    const destinations = Object.values(walking).flatMap((item) =>
      item.activity ? [item.activity.kind] : [],
    );
    expect(destinations.sort()).toEqual(['coffee', 'sofa', 'window']);
    expect(walking.d?.activity).toBeNull();
  });
  it('completes a walk, rests, returns, then waits before another activity', () => {
    const initial = advanceOfficeIdle({}, ['a'], 0);
    const walking = advanceOfficeIdle(initial, ['a'], 10000);
    expect(advanceOfficeIdle(walking, ['a'], 30000).a?.activity?.phase).toBe('outbound');
    const resting = arriveOfficeIdle(walking, 'a', walking.a!.activity!, 14000);
    expect(resting.a?.activity?.phase).toBe('resting');
    const returning = advanceOfficeIdle(resting, ['a'], 40000);
    expect(returning.a?.activity?.phase).toBe('returning');
    expect(advanceOfficeIdle(returning, ['a'], 60000).a?.activity?.phase).toBe('returning');
    const home = arriveOfficeIdle(returning, 'a', returning.a!.activity!, 44000);
    expect(home.a?.activity).toBeNull();
    expect(home.a?.cycle).toBe(1);
    expect(home.a?.nextAt).toBeGreaterThan(44000);
    expect(arriveOfficeIdle(returning, 'a', walking.a!.activity!, 44000)).toBe(returning);
  });
  it('immediately releases the pose and occupied destination when work preempts rest', () => {
    const first = advanceOfficeIdle(advanceOfficeIdle({}, ['a', 'b'], 0), ['a', 'b'], 10000);
    const next = advanceOfficeIdle(first, ['b'], 10001);
    expect(next.a).toBeUndefined();
    expect(next.b).toBe(first.b);
    expect(advanceOfficeIdle(next, [], 10002)).toEqual({});
  });
  it('does not resume an old rest after disabling animations or hiding the view', () => {
    const moving = advanceOfficeIdle(advanceOfficeIdle({}, ['a'], 0), ['a'], 10000);
    const cleared = advanceOfficeIdle(moving, [], 11000);
    const resumed = advanceOfficeIdle(cleared, ['a'], 100000);
    expect(resumed.a?.activity).toBeNull();
    expect(resumed.a?.nextAt).toBeGreaterThan(100000);
  });
  it.each(['coffee', 'sofa', 'window'] as const)(
    'routes %s along the side aisle and returns to the desk',
    (kind) => {
      const destination = idleDestinations[kind];
      expect(idlePath(0, kind)).toMatch(/^M 435 590 L 435 636 L 585 636/);
      expect(idlePath(0, kind)).toMatch(new RegExp(`L ${destination.x} ${destination.y}$`));
      expect(idlePath(0, kind, true)).toMatch(new RegExp(`^M ${destination.x} ${destination.y}`));
      expect(idlePath(0, kind, true)).toMatch(/L 435 590$/);
    },
  );
});
