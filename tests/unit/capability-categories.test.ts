import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE45_MIGRATIONS } from '../../packages/storage/src/schema';
import { UNCATEGORIZED_CATEGORY_ID } from '../../packages/protocol/src/domain/capability-category';

describe('能力分类', () => {
  it('Skill 与 MCP 使用互不影响的分类命名空间', () => {
    const { db, repos } = fixture();
    repos.categories.create('user-a', 'skill', 'research', '医学研究', now(1));
    repos.categories.create('user-a', 'mcp', 'research', '医学研究', now(1));
    repos.skills.upsertInstallation({
      id: 'clinical-search',
      userId: 'user-a',
      skillName: 'clinical-search',
      description: '检索临床研究资料',
      sourceType: 'local',
      sourceRef: null,
      rootPath: '/tmp/clinical-search',
      metadata: {},
      contentDigest: 'digest',
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
      now: now(2),
    });
    repos.categories.setSkillCategory('user-a', 'clinical-search', 'research', now(3));
    repos.mcp.createServer({
      id: 'papers',
      userId: 'user-a',
      name: 'papers',
      summary: '查询医学论文',
      categoryId: 'research',
      transport: 'streamable-http',
      config: { url: 'https://example.com/mcp', local: false },
      credentialRef: null,
      enabled: true,
      now: now(4),
    });

    repos.categories.rename('user-a', 'skill', 'research', '循证医学', now(5));
    expect(repos.categories.get('user-a', 'skill', 'research')?.name).toBe('循证医学');
    expect(repos.categories.get('user-a', 'mcp', 'research')?.name).toBe('医学研究');
    expect(repos.skills.getInstallation('user-a', 'clinical-search')?.categoryId).toBe(
      'research',
    );
    expect(repos.mcp.getServer('user-a', 'papers')?.categoryId).toBe('research');

    repos.categories.delete('user-a', 'skill', 'research', now(6));
    expect(repos.skills.getInstallation('user-a', 'clinical-search')?.categoryId).toBe(
      UNCATEGORIZED_CATEGORY_ID,
    );
    expect(repos.mcp.getServer('user-a', 'papers')?.categoryId).toBe('research');
    expect(() =>
      repos.categories.delete('user-a', 'skill', UNCATEGORIZED_CATEGORY_ID, now(7)),
    ).toThrow('System category cannot be changed');
    repos.categories.delete('user-a', 'mcp', 'research', now(8));
    expect(repos.mcp.getServer('user-a', 'papers')?.categoryId).toBe(
      UNCATEGORIZED_CATEGORY_ID,
    );
    db.close();
  });
});

function fixture() {
  const db = openDatabase(':memory:');
  runMigrations(db, STAGE45_MIGRATIONS, { clock: () => now(0) });
  const repos = new SqliteRepositories(db);
  repos.users.seedUsers(now(0));
  repos.categories.ensureDefaults('user-a', 'skill', now(0));
  repos.categories.ensureDefaults('user-a', 'mcp', now(0));
  return { db, repos };
}

function now(offset: number): string {
  return `2026-09-03T00:00:${String(offset).padStart(2, '0')}.000Z`;
}
