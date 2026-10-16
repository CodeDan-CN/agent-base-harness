import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSkillRoot } from '../../packages/execution/src/skills/parser';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { cleanupDir, makeTempDir, writeFile } from '../../packages/test-kit/src/temp';
import { makeSkillDir, skillFrontmatter } from '../../packages/test-kit/src/skills';
import { openMigratedDb } from '../../packages/test-kit/src/db';

const NOW = '2026-01-01T00:00:00.000Z';

describe('M09 Skill 目录与配置', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(root);
  });

  it('S1-M09-001 合法标准 Skill 可解析 name/description/resource base', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(skillsRoot, 'hello', skillFrontmatter('hello', 'Greets the user'));

    const result = scanSkillRoot(skillsRoot);
    expect(result.invalid).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe('hello');
    expect(result.skills[0]?.description).toBe('Greets the user');
    expect(result.skills[0]?.contentDigest).toBeTruthy();
  });

  it('S1-M09-002 带 scripts/references/assets 辅助目录可发现资源', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(skillsRoot, 'with-assets', skillFrontmatter('with-assets'), {
      scripts: true,
      references: true,
      assets: true,
    });
    const result = scanSkillRoot(skillsRoot);
    const skill = result.skills[0];
    expect(skill?.hasScripts).toBe(true);
    expect(skill?.hasReferences).toBe(true);
    expect(skill?.hasAssets).toBe(true);
  });

  it('S1-M09-003 扫描阶段零执行：脚本不会运行', () => {
    const skillsRoot = path.join(root, 'skills');
    const sentinel = path.join(root, 'sentinel.txt');
    const dir = makeSkillDir(skillsRoot, 'evil', skillFrontmatter('evil'), { scripts: true });
    writeFile(
      path.join(dir, 'scripts', 'attack.js'),
      `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'pwn')`,
    );

    scanSkillRoot(skillsRoot);
    expect(exists(sentinel)).toBe(false);
  });

  it('S1-M09-004 缺失 SKILL.md 不入 catalog', () => {
    const skillsRoot = path.join(root, 'skills');
    mkdirSync(path.join(skillsRoot, 'plain'), { recursive: true });
    const result = scanSkillRoot(skillsRoot);
    expect(result.skills).toEqual([]);
    expect(result.invalid.some((i) => i.error === 'missing_skill_md')).toBe(true);
  });

  it('S1-M09-005 缺少 name/description 标记 invalid', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(skillsRoot, 'noname', 'description: no name\n');
    makeSkillDir(skillsRoot, 'nodesc', 'name: nodesc\n');
    const result = scanSkillRoot(skillsRoot);
    expect(result.skills).toEqual([]);
    expect(result.invalid.map((i) => i.error).sort()).toEqual([
      'missing_description',
      'missing_name',
    ]);
  });

  it('S1-M09-006 目录名与 frontmatter name 不一致标记 invalid', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(skillsRoot, 'dir-a', skillFrontmatter('dir-b'));
    const result = scanSkillRoot(skillsRoot);
    expect(result.skills).toEqual([]);
    expect(result.invalid.some((i) => i.error === 'name_mismatch')).toBe(true);
  });

  it('S1-M09-007 越界链接引用外部路径被拒绝', () => {
    const skillsRoot = path.join(root, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const outside = path.join(root, 'outside');
    const insideLink = path.join(skillsRoot, 'escape');
    mkdirSync(path.join(outside, 'sub'), { recursive: true });
    writeFile(path.join(outside, 'sub', 'SKILL.md'), `---\nname: escape\ndescription: d\n---\n`);
    symlinkSync(path.join(outside, 'sub'), insideLink);

    const result = scanSkillRoot(skillsRoot);
    expect(result.skills).toEqual([]);
    expect(result.invalid.some((i) => i.error === 'path_escape')).toBe(true);
  });

  it('S1-M09-012 无 skill.json 仅 SKILL.md 也能 valid', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(skillsRoot, 'nojson', skillFrontmatter('nojson'));
    const result = scanSkillRoot(skillsRoot);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe('nojson');
  });

  it('S1-M09-010 metadata 兼容：未知与扩展字段保留', () => {
    const skillsRoot = path.join(root, 'skills');
    makeSkillDir(
      skillsRoot,
      'meta',
      'name: meta\ndescription: d\ncompatibility: safe\nunknown_field: keepme\n',
    );
    const result = scanSkillRoot(skillsRoot);
    const skill = result.skills[0];
    expect(skill?.metadata).toMatchObject({ compatibility: 'safe', unknown_field: 'keepme' });
  });

  it('S1-M09-011 修改 SKILL.md 后 content_digest 变化', () => {
    const skillsRoot = path.join(root, 'skills');
    const dir = makeSkillDir(skillsRoot, 'dyn', skillFrontmatter('dyn', 'v1'));
    const first = scanSkillRoot(skillsRoot).skills[0]?.contentDigest;

    writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: dyn\ndescription: v2\n---\n# changed\n`);
    const second = scanSkillRoot(skillsRoot).skills[0]?.contentDigest;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe('M09 Skill 安装记录 Repository', () => {
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

  function install(userId: string, skillName: string, enabled = true) {
    repos.skills.upsertInstallation({
      id: `${userId}-${skillName}`,
      userId,
      skillName,
      description: 'd',
      sourceType: 'local',
      sourceRef: null,
      rootPath: `/skills/${skillName}`,
      metadata: {},
      contentDigest: 'digest-1',
      enabled,
      status: 'valid',
      compatibilityStatus: 'compatible',
      now: NOW,
    });
  }

  it('S1-M09-008 用户 Catalog 隔离：A 登记，B Catalog 不可见', () => {
    install('user-a', 'only-a');
    expect(repos.skills.listInstallations('user-a')).toHaveLength(1);
    expect(repos.skills.listInstallations('user-b')).toEqual([]);
  });

  it('S1-M09-009 每次有效配置变更递增 skill_revision', () => {
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(0);
    install('user-a', 's1');
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(1);
    install('user-a', 's1', false);
    expect(repos.users.getRevisions('user-a').skillRevision).toBe(2);
    expect(repos.users.getRevisions('user-b').skillRevision).toBe(0);
  });

  it('S1-M09-014 source_type 非法枚举被约束拒绝', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO skill_installations
             (id, user_id, skill_name, description, source_type, root_path, metadata_json, content_digest,
              enabled, status, compatibility_status, created_at, updated_at)
           VALUES ('x', 'user-a', 'bad', 'd', 'INVALID', '/', '{}', 'd', 0, 'invalid', 'unknown', 't', 't')`,
        )
        .run(),
    ).toThrow();
  });
});

function exists(filePath: string): boolean {
  return existsSync(filePath);
}
