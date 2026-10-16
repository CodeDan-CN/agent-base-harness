import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import { createCapabilitySearchTool } from '../../packages/runtime-core/src/capability-discovery';
import type { ToolExecutionContext } from '../../packages/runtime-core/src/tools';

const now = '2026-09-07T00:00:00.000Z';
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('4.7.5 unified Agent capability discovery', () => {
  it('finds only authorized peers from direct sessions and never from delegated sessions', async () => {
    const repos = fixture();
    createAgent(repos, 'finance', '金融研究员', '分析公司和市场');
    createAgent(repos, 'writer', '写作助手', '整理文章');
    let revision = repos.users.getRevisions('user-a').agentRevision;
    repos.agents.setDelegateBinding('user-a', 'dylan', 'finance', true, revision, now);
    revision = repos.users.getRevisions('user-a').agentRevision;
    repos.agents.setDelegateBinding('user-a', 'finance', 'writer', true, revision, now);
    repos.sessions.createSession({
      id: 'direct',
      userId: 'user-a',
      title: 'direct',
      agentId: 'dylan',
      origin: 'direct',
      parentSessionId: null,
      now,
    });
    repos.sessions.createSession({
      id: 'delegated',
      userId: 'user-a',
      title: 'delegated',
      agentId: 'finance',
      origin: 'delegated',
      parentSessionId: 'direct',
      now,
    });
    const search = createCapabilitySearchTool(repos);
    const direct = await search.execute({}, context('dylan', 'direct'));
    expect(direct.candidates).toEqual([
      expect.objectContaining({
        kind: 'agent',
        capabilityId: 'finance',
        name: '金融研究员',
        action: 'agent_call',
      }),
    ]);
    expect(direct.totalAvailable).toBe(1);
    expect(JSON.stringify(direct)).not.toContain('instructions');

    const delegated = await search.execute({}, context('finance', 'delegated'));
    expect(delegated).toEqual({ totalAvailable: 0, candidates: [] });
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

function createAgent(
  repos: SqliteRepositories,
  id: string,
  name: string,
  description: string,
): void {
  repos.agents.create({
    id,
    userId: 'user-a',
    name,
    description,
    avatarKey: null,
    instructions: `private:${id}`,
    defaultModelId: null,
    permissionPreset: 'guarded',
    expectedRevision: repos.users.getRevisions('user-a').agentRevision,
    now,
  });
}

function context(agentId: string, sessionId: string): ToolExecutionContext {
  return {
    userId: 'user-a',
    agentId,
    sessionOrigin: sessionId === 'delegated' ? 'delegated' : 'direct',
    sessionId,
    eventId: 'event',
    turnId: 'turn',
    stepId: 'step',
    toolCallId: 'call',
    permissionPreset: 'guarded',
    signal: new AbortController().signal,
  };
}
