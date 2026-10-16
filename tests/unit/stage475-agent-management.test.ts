import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import { AgentNavigationService } from '../../packages/server-core/src/application/agent-navigation-service';

const now = '2026-09-07T00:00:00.000Z';
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('4.7.5 agent profiles and session ownership', () => {
  it('keeps profile creation separate from home navigation', () => {
    const repos = fixture();
    expect(repos.agents.getDefault('user-a').id).toBe('dylan');
    expect(repos.agents.listHome('user-a').map((item) => item.agentId)).toEqual(['dylan']);

    const specialist = repos.agents.create({
      id: 'finance',
      userId: 'user-a',
      name: '金融研究员',
      description: '分析市场与公司',
      avatarKey: null,
      instructions: '引用数据并区分事实与判断。',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: 0,
      now,
    });
    expect(specialist.isDefault).toBe(false);
    expect(repos.agents.listHome('user-a').map((item) => item.agentId)).toEqual(['dylan']);

    repos.agents.addHome('user-a', 'finance', 1, now);
    expect(repos.agents.listHome('user-a').map((item) => item.agentId)).toEqual([
      'dylan',
      'finance',
    ]);
  });

  it('stores immutable direct and delegated session ownership', () => {
    const repos = fixture();
    repos.agents.create({
      id: 'finance',
      userId: 'user-a',
      name: '金融研究员',
      description: '',
      avatarKey: null,
      instructions: '',
      defaultModelId: null,
      permissionPreset: 'guarded',
      expectedRevision: 0,
      now,
    });
    repos.sessions.createSession({
      id: 'root',
      userId: 'user-a',
      title: '根会话',
      agentId: 'dylan',
      origin: 'direct',
      parentSessionId: null,
      now,
    });
    repos.sessions.createSession({
      id: 'delegated',
      userId: 'user-a',
      title: '分析任务',
      agentId: 'finance',
      origin: 'delegated',
      parentSessionId: 'root',
      now,
    });
    expect(repos.sessions.listByAgent('user-a', 'dylan', 'direct').map((item) => item.id)).toEqual([
      'root',
    ]);
    expect(
      repos.sessions.listByAgent('user-a', 'finance', 'delegated').map((item) => item.id),
    ).toEqual(['delegated']);
  });

  it('hides archived direct sessions from agent navigation', () => {
    const repos = fixture();
    repos.sessions.createSession({
      id: 'archived-session',
      userId: 'user-a',
      title: '已归档会话',
      agentId: 'dylan',
      origin: 'direct',
      parentSessionId: null,
      now,
    });
    repos.sessions.archiveSession('user-a', 'archived-session', now);

    const snapshot = new AgentNavigationService(repos).snapshot('user-a');

    expect(snapshot.items[0]?.sessions.map((session) => session.id)).toEqual([]);
    expect(repos.sessions.listSessions('user-a').map((session) => session.status)).toEqual([
      'archived',
    ]);
  });

  it('does not undo an explicit removal from the home navigation on restart', () => {
    const repos = fixture();
    const revision = repos.users.getRevisions('user-a').agentRevision;
    repos.agents.removeHome('user-a', 'dylan', revision, now);

    repos.agents.ensureDylan('user-a', 'guarded', now);

    expect(repos.agents.listHome('user-a')).toEqual([]);
    expect(repos.agents.getDefault('user-a').id).toBe('dylan');
  });
});

function fixture(): SqliteRepositories {
  const database = openDatabase(':memory:');
  databases.push(database);
  runMigrations(database, STAGE47_MIGRATIONS, { clock: () => now });
  const repos = new SqliteRepositories(database);
  repos.users.seedUsers(now);
  repos.agents.ensureDylan('user-a', 'guarded', now);
  return repos;
}
