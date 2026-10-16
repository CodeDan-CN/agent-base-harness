import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { openMigratedDb } from '../../packages/test-kit/src/db';
import { BridgeError } from '../../packages/protocol/src/contracts/errors';
import type { AppendEventInput } from '../../packages/protocol/src/domain/session';

const NOW = '2026-01-01T00:00:00.000Z';

function evt(eventId: string, payload: unknown = { value: 1 }): AppendEventInput {
  return {
    eventId,
    eventType: 'test',
    schemaVersion: 1,
    occurredAt: NOW,
    requestId: null,
    payload,
  };
}

describe('M07 Session 与 EventStore', () => {
  let root: string;
  let db: ReturnType<typeof openMigratedDb>;
  let repos: SqliteRepositories;

  beforeEach(() => {
    root = makeTempDir();
    db = openMigratedDb(root);
    repos = new SqliteRepositories(db);
    repos.users.seedUsers(NOW);
    repos.sessions.createSession({ id: 's1', userId: 'user-a', title: 'test', now: NOW });
  });

  afterEach(() => {
    db.close();
    cleanupDir(root);
  });

  it('S1-M07-001 创建 Session', () => {
    const session = repos.sessions.getSession('user-a', 's1');
    expect(session).toBeTruthy();
    expect(session?.userId).toBe('user-a');
    expect(session?.nextSeq).toBe(1);
    expect(session?.version).toBe(0);
  });

  it('S1-M07-002 单事件追加：seq=1、version=1、next_seq=2', () => {
    const result = repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1')],
    });
    expect(result.version).toBe(1);
    expect(result.nextSeq).toBe(2);
    expect(result.fromSeq).toBe(1);
    expect(result.toSeq).toBe(1);

    const events = repos.sessions.listEvents('user-a', 's1');
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.eventId).toBe('e1');
  });

  it('S1-M07-003 批量追加：seq 连续且同事务提交', () => {
    const result = repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1'), evt('e2'), evt('e3')],
    });
    expect(result.version).toBe(3);
    expect(result.nextSeq).toBe(4);
    const seqs = repos.sessions.listEvents('user-a', 's1').map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('S1-M07-004 版本冲突：过期 expectedVersion 返回 REVISION_CONFLICT', () => {
    repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1')],
    });

    expect(() =>
      repos.sessions.append({
        userId: 'user-a',
        sessionId: 's1',
        expectedVersion: 0,
        events: [evt('e2')],
      }),
    ).toThrowError(new BridgeError('REVISION_CONFLICT', 'Session version conflict'));

    expect(repos.sessions.countEvents('user-a', 's1')).toBe(1);
  });

  it('S1-M07-005 批次中途失败：整批与 Session version 全部回滚', () => {
    expect(() =>
      repos.sessions.append({
        userId: 'user-a',
        sessionId: 's1',
        expectedVersion: 0,
        events: [evt('dup'), evt('dup')],
      }),
    ).toThrow();

    expect(repos.sessions.countEvents('user-a', 's1')).toBe(0);
    const session = repos.sessions.getSession('user-a', 's1');
    expect(session?.version).toBe(0);
    expect(session?.nextSeq).toBe(1);
  });

  it('S1-M07-007 跨用户 append 被拒绝', () => {
    expect(() =>
      repos.sessions.append({
        userId: 'user-b',
        sessionId: 's1',
        expectedVersion: 0,
        events: [evt('e1')],
      }),
    ).toThrow();
    expect(repos.sessions.countEvents('user-a', 's1')).toBe(0);
  });

  it('S1-M07-008 afterSeq 分页回放', () => {
    repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1'), evt('e2'), evt('e3')],
    });
    const after = repos.sessions.readEventsAfter('user-a', 's1', 1);
    expect(after.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('S1-M07-009 eventId 唯一约束拒绝且不破坏历史', () => {
    repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1')],
    });
    expect(() =>
      repos.sessions.append({
        userId: 'user-a',
        sessionId: 's1',
        expectedVersion: 1,
        events: [evt('e1')],
      }),
    ).toThrow();
    const events = repos.sessions.listEvents('user-a', 's1');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe('e1');
  });

  it('S1-M07-010 Session 列表隔离', () => {
    repos.sessions.createSession({ id: 'b1', userId: 'user-b', title: 'B session', now: NOW });
    const listA = repos.sessions.listSessions('user-a');
    const listB = repos.sessions.listSessions('user-b');
    expect(listA.map((s) => s.id)).toEqual(['s1']);
    expect(listB.map((s) => s.id)).toEqual(['b1']);
  });

  it('S1-M07-011 非法 payload 在 SQL 前被拒绝', () => {
    expect(() =>
      repos.sessions.append({
        userId: 'user-a',
        sessionId: 's1',
        expectedVersion: 0,
        events: [evt('e1', { bad: BigInt(1) })],
      }),
    ).toThrowError(new BridgeError('INVALID_REQUEST', 'payload is not serializable'));
    expect(repos.sessions.countEvents('user-a', 's1')).toBe(0);
  });

  it('S1-M07-012 历史不可修改（无更新方法）', () => {
    repos.sessions.append({
      userId: 'user-a',
      sessionId: 's1',
      expectedVersion: 0,
      events: [evt('e1')],
    });
    expect('updateEvent' in repos.sessions).toBe(false);
    expect('deleteEvent' in repos.sessions).toBe(false);
  });
});
