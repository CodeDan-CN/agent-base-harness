import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { openMigratedDb } from '../../packages/test-kit/src/db';
import { DEFAULT_USER_ID } from '../../packages/protocol/src/domain/user';

const NOW = '2026-01-01T00:00:00.000Z';

describe('M05 双用户与可信 User Context', () => {
  let root: string;
  let db: ReturnType<typeof openMigratedDb>;
  let repos: SqliteRepositories;

  beforeEach(() => {
    root = makeTempDir();
    db = openMigratedDb(root);
    repos = new SqliteRepositories(db);
    repos.users.seedUsers(NOW);
  });

  afterEach(() => {
    db.close();
    cleanupDir(root);
  });

  it('S1-M05-001 首次 seed 恰好创建 user-a/user-b 及 revision/settings 行', () => {
    const users = repos.users.listUsers();
    expect(users.map((u) => u.id).sort()).toEqual(['user-a', 'user-b']);

    for (const id of ['user-a', 'user-b']) {
      const revision = repos.users.getRevisions(id);
      expect(revision.modelRevision).toBe(0);
      expect(revision.skillRevision).toBe(0);
      expect(revision.runtimeRevision).toBe(0);
    }

    const settingsCount = db.prepare('SELECT COUNT(*) AS c FROM user_model_settings').get() as {
      c: number;
    };
    expect(settingsCount.c).toBe(2);
  });

  it('S1-M05-002 seed 幂等：重复 seed 不产生重复行、固定 ID 不变', () => {
    repos.users.seedUsers(NOW);
    repos.users.seedUsers(NOW);
    repos.users.seedUsers(NOW);

    const count = db.prepare('SELECT COUNT(*) AS c FROM local_users').get() as { c: number };
    expect(count.c).toBe(2);

    const ids = repos.users
      .listUsers()
      .map((u) => u.id)
      .sort();
    expect(ids).toEqual(['user-a', 'user-b']);
  });

  it('S1-M05-003 非法 active_user_id 回退 user-a 并持久化修复', () => {
    db.prepare(
      "INSERT INTO app_settings (key, value_json, revision, updated_at) VALUES ('active_user_id', ?, 0, ?)",
    ).run(JSON.stringify('someone-else'), NOW);

    const repaired = repos.users.repairActiveUserId(NOW);
    expect(repaired).toBe(DEFAULT_USER_ID);
    expect(repos.users.getActiveUserId()).toBe(DEFAULT_USER_ID);

    const raw = db
      .prepare("SELECT value_json FROM app_settings WHERE key = 'active_user_id'")
      .get() as { value_json: string };
    expect(JSON.parse(raw.value_json)).toBe(DEFAULT_USER_ID);
  });

  it('S1-M05-004 Session 跨用户读取被隔离', () => {
    repos.sessions.createSession({ id: 's1', userId: 'user-a', title: 'A session', now: NOW });
    const fromB = repos.sessions.getSession('user-b', 's1');
    expect(fromB).toBeUndefined();

    const fromA = repos.sessions.getSession('user-a', 's1');
    expect(fromA?.userId).toBe('user-a');
  });

  it('S1-M05-010 越权访问不泄漏对方内容（通过 Repository 隔离实现）', () => {
    repos.sessions.createSession({ id: 'secret', userId: 'user-a', title: 'A secret', now: NOW });
    const listB = repos.sessions.listSessions('user-b');
    expect(listB).toEqual([]);
  });
});
