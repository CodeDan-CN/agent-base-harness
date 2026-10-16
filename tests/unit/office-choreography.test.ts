import { describe, expect, it } from 'vitest';
import type { ProjectedDelegation } from '@client-contracts';
import {
  collectOfficeVisits,
  enqueueOfficeVisits,
} from '../../packages/app-ui/src/components/office/office-choreography';
import {
  deskPosition,
  officeVisitPath,
} from '../../packages/app-ui/src/components/office/office-layout';

function delegation(id: string, status: ProjectedDelegation['status']): ProjectedDelegation {
  return {
    id,
    status,
    parentTurnId: 'turn',
    parentToolCallId: id,
    delegatedSessionId: `child-${id}`,
    targetAgentId: id,
    callerAgentName: 'Dylan',
    targetAgentName: id,
    resultEventRef: null,
    report: null,
    createdAt: '2026-09-26T01:00:00Z',
    updatedAt: '2026-09-26T01:00:00Z',
  };
}

describe('office choreography follows delegation facts', () => {
  it('restores running and completed history without replaying visits', () => {
    expect(
      collectOfficeVisits(null, [delegation('a', 'running'), delegation('b', 'completed')]).visits,
    ).toEqual([]);
  });
  it('queues parallel assignments and completion reports exactly once', () => {
    const first = collectOfficeVisits(new Map(), [
      delegation('a', 'running'),
      delegation('b', 'accepted'),
    ]);
    expect(first.visits.map((item) => item.id)).toEqual(['a:assign', 'b:assign']);
    const second = collectOfficeVisits(first.seen, [
      delegation('a', 'completed'),
      delegation('b', 'running'),
    ]);
    expect(second.visits.map((item) => item.id)).toEqual(['a:report']);
    const duplicate = collectOfficeVisits(second.seen, [
      delegation('a', 'completed'),
      delegation('b', 'running'),
    ]);
    expect(duplicate.visits).toEqual([]);
    expect(
      enqueueOfficeVisits(first.visits, second.visits, second.seen).map((item) => item.id),
    ).toEqual(['a:assign', 'b:assign', 'a:report']);
  });
  it('preserves assignment before report when completion arrives in one batch', () => {
    const result = collectOfficeVisits(new Map(), [delegation('fast', 'completed')]);
    expect(result.visits.map((item) => item.kind)).toEqual(['assign', 'report']);
  });
  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'removes in-flight and queued animations for %s',
    (status) => {
      const first = collectOfficeVisits(new Map(), [
        delegation('a', 'running'),
        delegation('b', 'running'),
      ]);
      const end = collectOfficeVisits(first.seen, [
        delegation('a', status),
        delegation('b', 'running'),
      ]);
      expect(
        enqueueOfficeVisits(first.visits, end.visits, end.seen).map((item) => item.id),
      ).toEqual(['b:assign']);
      expect(end.visits).toEqual([]);
    },
  );
  it('resuming an interaction does not produce a second assignment', () => {
    const waiting = collectOfficeVisits(new Map([['a', 'running']]), [
      delegation('a', 'awaiting_user'),
    ]);
    expect(collectOfficeVisits(waiting.seen, [delegation('a', 'running')]).visits).toEqual([]);
  });
  it('retains dedupe history during incomplete snapshots', () => {
    const missing = collectOfficeVisits(new Map([['a', 'completed']]), []);
    expect(collectOfficeVisits(missing.seen, [delegation('a', 'completed')]).visits).toEqual([]);
  });
  it('routes along aisles, stops beside the recipient, and returns to the original desk', () => {
    const from = deskPosition(0);
    const to = deskPosition(2);
    expect(officeVisitPath(from, to)).toBe(
      'M 435 590 L 435 636 L 585 636 L 585 403 L 630 403 L 630 357',
    );
    expect(officeVisitPath(from, to, true)).toBe(
      'M 630 357 L 630 403 L 585 403 L 585 636 L 435 636 L 435 590',
    );
    expect(deskPosition(6)).toEqual({ x: 244, y: 980 });
  });
});
