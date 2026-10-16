import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillCatalogService } from '../../packages/server-core/src/application/skill-catalog-service';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { openMigratedDb } from '../../packages/test-kit/src/db';
import { makeSkillDir, skillFrontmatter } from '../../packages/test-kit/src/skills';
import { FixedClock } from '../../packages/test-kit/src/clock';

const NOW = '2026-01-01T00:00:00.000Z';

describe('M09 Skill 业务闭环（扫描 → 写库 → revision → Catalog）', () => {
  let root: string;
  let db: ReturnType<typeof openMigratedDb>;
  let repos: SqliteRepositories;
  let service: SkillCatalogService;
  let skillRoot: (userId: string) => string;

  beforeEach(() => {
    root = makeTempDir();
    db = openMigratedDb(root);
    repos = new SqliteRepositories(db);
    repos.users.seedUsers(NOW);
    skillRoot = (userId) => path.join(root, 'skills', userId);
    service = new SkillCatalogService({ repos, skillRoot, clock: new FixedClock(NOW) });
    mkdirSync(skillRoot('user-a'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanupDir(root);
  });

  it('扫描合法 Skill 写入安装记录并递增 revision', () => {
    makeSkillDir(skillRoot('user-a'), 'hello', skillFrontmatter('hello', 'Greets'));
    const snapshot = service.refresh('user-a');

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.name).toBe('hello');
    expect(repos.skills.listInstallations('user-a')).toHaveLength(1);
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(1);
  });

  it('内容未变化时重复 refresh 不递增 revision', () => {
    makeSkillDir(skillRoot('user-a'), 'hello', skillFrontmatter('hello'));
    service.refresh('user-a');
    service.refresh('user-a');
    service.refresh('user-a');
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(1);
  });

  it('内容摘要变化后重新写入并递增 revision', () => {
    const dir = makeSkillDir(skillRoot('user-a'), 'hello', skillFrontmatter('hello', 'v1'));
    service.refresh('user-a');
    const first = repos.skills.getInstallation('user-a', 'hello')?.contentDigest;

    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: hello\ndescription: v2\n---\n# changed\n`,
    );
    service.refresh('user-a');
    const second = repos.skills.getInstallation('user-a', 'hello')?.contentDigest;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(2);
  });

  it('用户 Catalog 隔离：A 登记后 B Catalog 为空', () => {
    makeSkillDir(skillRoot('user-a'), 'only-a', skillFrontmatter('only-a'));
    service.refresh('user-a');

    const bCatalog = service.catalog('user-b');
    expect(bCatalog.entries).toEqual([]);
    expect(repos.users.getRevisions('user-b').skillRevision).toBe(0);
  });

  it('invalid skill 计入 invalidCount，不进 valid catalog', () => {
    makeSkillDir(skillRoot('user-a'), 'good', skillFrontmatter('good'));
    makeSkillDir(skillRoot('user-a'), 'bad', 'description: missing name\n');

    const snapshot = service.refresh('user-a');
    expect(snapshot.entries.map((e) => e.name)).toEqual(['good']);
    expect(service.invalidCount('user-a')).toBe(1);
  });

  it('目录删除后安装记录标记为 missing，并递增 revision', () => {
    const dir = makeSkillDir(skillRoot('user-a'), 'gone', skillFrontmatter('gone'));
    service.refresh('user-a');
    expect(repos.skills.getInstallation('user-a', 'gone')?.status).toBe('valid');
    const revisionAfterAdd = repos.users.getRevisions('user-a').skillRevision;

    rmSync(dir, { recursive: true, force: true });
    const snapshot = service.refresh('user-a');
    expect(snapshot.entries).toEqual([]);
    expect(repos.skills.getInstallation('user-a', 'gone')?.status).toBe('missing');
    expect(repos.users.getRevisions('user-a').skillRevision).toBeGreaterThan(revisionAfterAdd);
  });

  it('SKILL.md 变为非法后标记 invalid 并移出 catalog', () => {
    const dir = makeSkillDir(skillRoot('user-a'), 'hello', skillFrontmatter('hello'));
    service.refresh('user-a');
    expect(service.catalog('user-a').entries.map((e) => e.name)).toEqual(['hello']);

    writeFileSync(path.join(dir, 'SKILL.md'), '## no frontmatter\n');
    const snapshot = service.refresh('user-a');
    expect(snapshot.entries).toEqual([]);
    expect(repos.skills.getInstallation('user-a', 'hello')?.status).toBe('invalid');
  });

  it('skill 根不存在时 health 返回 missing', () => {
    cleanupDir(skillRoot('user-a'));
    expect(service.skillRootHealth('user-a').status).toBe('missing');
  });
});
