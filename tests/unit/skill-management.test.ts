import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { parseSkillDirectory } from '../../packages/execution/src/skills/parser';
import { commandRequestSchema, runtimeResponseSchema } from '../../packages/protocol/src/contracts/schemas';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';
import { dispatch } from '../../packages/server-core/src/application/dispatcher';

const fixtures: Array<{ app: WorkerApplication; root: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { app, root } of fixtures.splice(0)) {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Skill 描述编辑和永久删除', () => {
  it('经公开命令保存多行描述，刷新及重启后仍保留，正文、分类、资源和启用状态不变', async () => {
    const { app, root, source, managed, original } = fixture();
    app.setSkillEnabled('user-a', 'demo', true, revision(app));
    app.createCapabilityCategory('user-a', 'skill', '测试分类', revision(app));
    const category = app
      .skillManagement('user-a')
      .categories.find((item) => item.name === '测试分类')!;
    app.setSkillCategory('user-a', 'demo', category.id, revision(app));
    const before = app.repos.skills.getInstallation('user-a', 'demo')!;
    const description = '用于 "引号"、路径 C:\\docs、冒号: 和 # 标签\n第二行：按场景选择。';
    const request = commandRequestSchema.parse({
      apiVersion: 2,
      method: 'skill.description.update',
      params: {
        skillName: 'demo',
        description: `  ${description}  `,
        expectedRevision: revision(app),
      },
    });
    const result = await dispatch(app, request.method, request.params, 'user-a');
    expect(runtimeResponseSchema(request.method)!.parse(result)).toEqual({ skillName: 'demo' });
    const after = app.repos.skills.getInstallation('user-a', 'demo')!;
    expect(after).toMatchObject({
      description,
      enabled: true,
      categoryId: category.id,
      metadata: before.metadata,
    });
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(revision(app)).toBe(request.params.expectedRevision + 1);
    expect(readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(original);
    expect(readFileSync(path.join(managed, 'SKILL.md'), 'utf8').split('\r\n---\r\n')[1]).toBe(
      original.split('\r\n---\r\n')[1],
    );
    expect(readFileSync(path.join(managed, 'references', 'notes.txt'), 'utf8')).toBe('keep me');
    expect(
      app.skillManagement('user-a').skills.find((item) => item.name === 'demo')?.description,
    ).toBe(description);
    expect(revision(app)).toBe(request.params.expectedRevision + 1);
    expect(app.repos.skills.getInstallation('user-a', 'demo')).toMatchObject({
      skillName: 'demo',
      description,
    });
    app.close();
    const reopened = createWorkerApplication({
      appDataDir: root,
      generation: 2,
      logger: new MemoryLogger(),
    });
    fixtures.find((item) => item.app === app)!.app = reopened;
    expect(
      reopened.skillManagement('user-a').skills.find((item) => item.name === 'demo'),
    ).toMatchObject({ description, enabled: true });
  });

  it('删除后目录和记录消失，不留备份、原始目录不变，刷新不复活且允许重新导入', async () => {
    const { app, root, source, managed, original } = fixture();
    app.setSkillEnabled('user-a', 'demo', true, revision(app));
    const before = revision(app);
    const request = commandRequestSchema.parse({
      apiVersion: 2,
      method: 'skill.delete',
      params: { skillName: 'demo', expectedRevision: before },
    });
    expect(await dispatch(app, request.method, request.params, 'user-a')).toEqual({
      skillName: 'demo',
    });
    expect(revision(app)).toBe(before + 1);
    expect(app.repos.skills.getInstallation('user-a', 'demo')).toBeUndefined();
    expect(existsSync(managed)).toBe(false);
    expect(readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(original);
    expect(existsSync(path.join(root, 'deleted-skills'))).toBe(false);
    expect(app.skillManagement('user-a').skills.some((item) => item.name === 'demo')).toBe(false);
    expect(app.installSkillDirectory('user-a', source)).toEqual({ skillName: 'demo' });
  });

  it('拒绝空描述、超长描述、NUL、旧版本和外部文件变动，不覆盖已有内容', () => {
    const { app, managed, original } = fixture();
    const update = (description: string, expectedRevision = revision(app)) =>
      app.updateSkillDescription('user-a', { skillName: 'demo', description, expectedRevision });
    for (const description of [' ', 'x'.repeat(4001), 'bad\0value'])
      expect(() => update(description)).toThrow();
    expect(() => update('valid', revision(app) - 1)).toThrow('configuration changed');
    expect(() => app.deleteSkill('user-a', 'demo', revision(app) - 1)).toThrow(
      'configuration changed',
    );
    expect(readFileSync(path.join(managed, 'SKILL.md'), 'utf8')).toBe(original);
    writeFileSync(path.join(managed, 'SKILL.md'), `${original}\r\nexternal change`);
    expect(() => update('valid')).toThrow('Skill file changed');
    expect(readFileSync(path.join(managed, 'SKILL.md'), 'utf8')).toContain('external change');
  });

  it('同名 Skill 按用户隔离，并保护内置 Skill', () => {
    const { app, source } = fixture();
    app.installSkillDirectory('user-b', source);
    const other = app.repos.skills.getInstallation('user-b', 'demo');
    app.updateSkillDescription('user-a', {
      skillName: 'demo',
      description: 'new description',
      expectedRevision: revision(app),
    });
    app.deleteSkill('user-a', 'demo', revision(app));
    expect(app.repos.skills.getInstallation('user-b', 'demo')).toEqual(other);
    expect(() =>
      app.updateSkillDescription('user-a', {
        skillName: 'skill-creator',
        description: 'changed',
        expectedRevision: revision(app),
      }),
    ).toThrow('built-in');
    expect(() => app.deleteSkill('user-a', 'skill-creator', revision(app))).toThrow('built-in');
    expect(app.repos.skills.getInstallation('user-a', 'skill-creator')).toBeDefined();
  });

  it('拒绝越界登记和符号链接，不读写或移动外部文件', () => {
    const { app, source, managed, original } = fixture();
    const installation = app.repos.skills.getInstallation('user-a', 'demo')!;
    app.repos.skills.upsertInstallation({
      ...installation,
      rootPath: source,
      now: new Date().toISOString(),
    });
    expect(() => app.deleteSkill('user-a', 'demo', revision(app))).toThrow('outside');
    app.repos.skills.upsertInstallation({ ...installation, now: new Date().toISOString() });
    rmSync(managed, { recursive: true });
    symlinkSync(source, managed, 'dir');
    expect(() => app.deleteSkill('user-a', 'demo', revision(app))).toThrow(
      'Invalid managed Skill path',
    );
    expect(() =>
      app.updateSkillDescription('user-a', {
        skillName: 'demo',
        description: 'new',
        expectedRevision: revision(app),
      }),
    ).toThrow('Invalid managed Skill path');
    expect(readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(original);
  });

  it('数据库失败时编辑回滚、删除报错且可重试清理记录，不产生假成功', () => {
    const { app, managed, original } = fixture();
    const before = revision(app);
    const updateSpy = vi.spyOn(app.repos.skills, 'upsertInstallation').mockImplementation(() => {
      throw new Error('db unavailable');
    });
    expect(() =>
      app.updateSkillDescription('user-a', {
        skillName: 'demo',
        description: 'new',
        expectedRevision: before,
      }),
    ).toThrow('db unavailable');
    expect(readFileSync(path.join(managed, 'SKILL.md'), 'utf8')).toBe(original);
    updateSpy.mockRestore();
    const deleteSpy = vi.spyOn(app.repos.skills, 'deleteInstallation').mockImplementation(() => {
      throw new Error('db unavailable');
    });
    expect(() => app.deleteSkill('user-a', 'demo', before)).toThrow('db unavailable');
    expect(existsSync(managed)).toBe(false);
    expect(revision(app)).toBe(before);
    expect(app.repos.skills.getInstallation('user-a', 'demo')).toBeDefined();
    deleteSpy.mockRestore();
    app.deleteSkill('user-a', 'demo', before);
    expect(app.repos.skills.getInstallation('user-a', 'demo')).toBeUndefined();
  });

  it('允许清理目录缺失的安装记录，块描述编辑不残留旧续行', () => {
    const { app, managed } = fixture();
    writeFileSync(
      path.join(managed, 'SKILL.md'),
      '---\nname: demo\ndescription: >-\n  old block\n  second line\nauthor: sample\n---\n# Keep body',
    );
    app.skillManagement('user-a');
    app.updateSkillDescription('user-a', {
      skillName: 'demo',
      description: 'new',
      expectedRevision: revision(app),
    });
    expect(parseSkillDirectory(managed)).toMatchObject({ ok: true, skill: { description: 'new' } });
    expect(readFileSync(path.join(managed, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: demo\ndescription: "new"\nauthor: sample\n---\n# Keep body',
    );
    rmSync(managed, { recursive: true });
    app.skillManagement('user-a');
    app.deleteSkill('user-a', 'demo', revision(app));
    expect(app.repos.skills.getInstallation('user-a', 'demo')).toBeUndefined();
  });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skill-management-'));
  const app = createWorkerApplication({
    appDataDir: root,
    generation: 1,
    logger: new MemoryLogger(),
  });
  fixtures.push({ app, root });
  const source = path.join(root, 'source', 'demo');
  mkdirSync(path.join(source, 'references'), { recursive: true });
  const original =
    '---\r\nname: demo\r\ndescription: original\r\nauthor: sample\r\n---\r\n# Demo\r\n\r\nKeep this body exactly.\r\n';
  writeFileSync(path.join(source, 'SKILL.md'), original);
  writeFileSync(path.join(source, 'references', 'notes.txt'), 'keep me');
  app.installSkillDirectory('user-a', source);
  return { app, root, source, managed: path.join(root, 'skills', 'user-a', 'demo'), original };
}

function revision(app: WorkerApplication): number {
  return app.repos.users.getRevisions('user-a').skillRevision;
}
