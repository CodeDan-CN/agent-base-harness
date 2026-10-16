import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import { createCapabilitySearchTool } from '../../packages/runtime-core/src/capability-discovery';
import type { ToolExecutionContext } from '../../packages/runtime-core/src/tools';

const now = '2026-09-08T00:00:00.000Z';
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('capability_search 动态能力目录', () => {
  it('使用空参数返回三类授权能力的轻量目录', async () => {
    const repos = fixture();
    addAgent(repos, 'charlie', '投资顾问（Charlie）', '获取股票、基金和持仓信息。');
    addAgent(repos, 'writer', '写作助手', '整理文章。');
    bindDelegate(repos, 'charlie');
    addSkill(repos, 'news-brief', '汇总市场新闻。');
    bindSkill(repos, 'user-a:news-brief');
    addMcp(repos, 'market-data', '查询公开市场数据。');
    bindMcp(repos, 'market-data');

    const search = createCapabilitySearchTool(repos);
    expect(search.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    const result = await search.execute({}, context);
    expect(result).toEqual({
      totalAvailable: 3,
      candidates: [
        {
          kind: 'agent',
          capabilityId: 'charlie',
          name: '投资顾问（Charlie）',
          description: '获取股票、基金和持仓信息。',
          action: 'agent_call',
        },
        {
          kind: 'mcp',
          name: 'market-data',
          description: '查询公开市场数据。',
          action: 'mcp_load',
          scope: 'user',
        },
        {
          kind: 'skill',
          name: 'news-brief',
          description: '汇总市场新闻。',
          action: 'skill_load',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private:|inputSchema|rootPath|写作助手/);
  });

  it('无授权候选时返回空目录', async () => {
    const repos = fixture();
    const search = createCapabilitySearchTool(repos);
    await expect(search.execute({}, context)).resolves.toEqual({
      totalAvailable: 0,
      candidates: [],
    });
  });

  it('完整返回超过五项的目录，不按相关性或旧 limit 截断', async () => {
    const repos = fixture();
    for (let index = 0; index < 8; index += 1) {
      addSkill(repos, `skill-${index}`, `能力 ${index}`);
      bindSkill(repos, `user-a:skill-${index}`);
    }
    const result = await createCapabilitySearchTool(repos).execute({}, context);
    expect(result.totalAvailable).toBe(8);
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(
      Array.from({ length: 8 }, (_, index) => `skill-${index}`),
    );
  });

  it.each([{ userRequest: '寻找能力' }, { limit: 5 }, { kinds: ['skill'] }])(
    '拒绝已移除的查询参数 %j',
    async (input) => {
      await expect(createCapabilitySearchTool(fixture()).execute(input, context)).rejects.toThrow();
    },
  );

  it('过滤未绑定、Agent 绑定禁用、无效和不兼容的 Skill 与未审核或禁用的 MCP', async () => {
    const repos = fixture();
    for (const name of ['valid', 'unbound', 'disabled', 'invalid', 'incompatible']) {
      addSkill(repos, name, name, {
        enabled: name !== 'disabled',
        status: name === 'invalid' ? 'invalid' : 'valid',
        compatibilityStatus: name === 'incompatible' ? 'incompatible' : 'compatible',
      });
      if (name !== 'unbound') {
        repos.agents.setSkillBinding(
          'user-a',
          'dylan',
          `user-a:${name}`,
          name !== 'disabled',
          repos.users.getRevisions('user-a').agentRevision,
          now,
        );
      }
    }
    for (const name of ['approved', 'unbound', 'disabled', 'unapproved']) {
      addMcp(repos, name, name, name !== 'disabled', name !== 'unapproved');
      if (name !== 'unbound') bindMcp(repos, name);
    }

    const result = await createCapabilitySearchTool(repos).execute({}, context);
    expect(result.candidates.map((candidate) => candidate.capabilityId ?? candidate.name)).toEqual([
      'approved',
      'valid',
    ]);
    expect(result.totalAvailable).toBe(2);
  });

  it('拒绝不同智能体或不存在会话的目录读取', async () => {
    const repos = fixture();
    addSkill(repos, 'bound', '已授权能力');
    bindSkill(repos, 'user-a:bound');
    const search = createCapabilitySearchTool(repos);
    await expect(search.execute({}, { ...context, agentId: 'other' })).resolves.toEqual({
      totalAvailable: 0,
      candidates: [],
    });
    await expect(search.execute({}, { ...context, sessionId: 'missing' })).resolves.toEqual({
      totalAvailable: 0,
      candidates: [],
    });
  });
});

function fixture(): SqliteRepositories {
  const database = openDatabase(':memory:');
  databases.push(database);
  runMigrations(database, STAGE47_MIGRATIONS, { clock: () => now });
  const repos = new SqliteRepositories(database);
  repos.users.seedUsers(now);
  repos.agents.ensureDylan('user-a', 'guarded', now);
  repos.sessions.createSession({
    id: 'session',
    userId: 'user-a',
    title: 'direct',
    agentId: 'dylan',
    origin: 'direct',
    parentSessionId: null,
    now,
  });
  return repos;
}

function addAgent(repos: SqliteRepositories, id: string, name: string, description: string): void {
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

function bindDelegate(repos: SqliteRepositories, agentId: string): void {
  repos.agents.setDelegateBinding(
    'user-a',
    'dylan',
    agentId,
    true,
    repos.users.getRevisions('user-a').agentRevision,
    now,
  );
}

function addSkill(
  repos: SqliteRepositories,
  name: string,
  description: string,
  options: Partial<
    Pick<
      Parameters<SqliteRepositories['skills']['upsertInstallation']>[0],
      'enabled' | 'status' | 'compatibilityStatus'
    >
  > = {},
): void {
  repos.skills.upsertInstallation({
    id: `user-a:${name}`,
    userId: 'user-a',
    skillName: name,
    description,
    sourceType: 'local',
    sourceRef: null,
    rootPath: `/not-read-during-discovery/${name}`,
    metadata: {},
    contentDigest: 'digest',
    enabled: true,
    status: 'valid',
    compatibilityStatus: 'compatible',
    ...options,
    now,
  });
}

function bindSkill(repos: SqliteRepositories, skillId: string): void {
  repos.agents.setSkillBinding(
    'user-a',
    'dylan',
    skillId,
    true,
    repos.users.getRevisions('user-a').agentRevision,
    now,
  );
}

function addMcp(
  repos: SqliteRepositories,
  id: string,
  summary: string,
  enabled = true,
  approved = true,
): void {
  repos.mcp.createServer({
    id,
    userId: 'user-a',
    name: id,
    summary,
    enabled,
    transport: 'streamable-http',
    config: { url: 'https://invalid.local/mcp', local: false },
    credentialRef: null,
    now,
  });
  repos.mcp.replaceDiscoveredTools(
    'user-a',
    id,
    1,
    [
      {
        rawName: 'search',
        publicName: `mcp__${id}__search`,
        description: summary,
        inputSchema: { type: 'object' },
        outputSchema: null,
        schemaDigest: 'digest',
      },
    ],
    now,
  );
  if (approved) repos.mcp.setToolEnabled('user-a', id, 'search', true, now);
}

function bindMcp(repos: SqliteRepositories, serverId: string): void {
  repos.agents.setMcpBinding(
    'user-a',
    'dylan',
    serverId,
    'user',
    true,
    repos.users.getRevisions('user-a').agentRevision,
    now,
  );
}

const context: ToolExecutionContext = {
  userId: 'user-a',
  agentId: 'dylan',
  sessionOrigin: 'direct',
  sessionId: 'session',
  eventId: 'event',
  turnId: 'turn',
  stepId: 'step',
  toolCallId: 'call',
  permissionPreset: 'guarded',
  signal: new AbortController().signal,
};
