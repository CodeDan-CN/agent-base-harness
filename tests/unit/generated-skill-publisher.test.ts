import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import { ProcessRunner } from '../../packages/execution/src/process/process-runner';
import { ShellExecutor } from '../../packages/execution/src/process/shell-executor';
import {
  BUILTIN_SKILL_CREATOR_NAME,
  GeneratedSkillPublishError,
  GeneratedSkillPublisher,
} from '../../packages/execution/src/skills/generated-skill-publisher';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE45_MIGRATIONS } from '../../packages/storage/src/schema';
import { registerBuiltinRuntimeTools } from '../../packages/runtime-core/src/builtin-tools';
import { ToolRegistry, type ToolExecutionContext } from '../../packages/runtime-core/src/tools';
import type { Clock, IdProvider } from '../../packages/protocol/src/domain/ports';
import type { LocalUserId } from '../../packages/protocol/src/domain/user';
import { SkillCatalogService } from '../../packages/server-core/src/application/skill-catalog-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GeneratedSkillPublisher', () => {
  it('seeds the built-in creator once and publishes an enabled user-only Skill atomically', () => {
    const fixture = createFixture();
    fixture.publisher.seedBuiltinCreator(['user-a', 'user-b']);

    const creator = fixture.repos.skills.getInstallation('user-a', BUILTIN_SKILL_CREATOR_NAME);
    expect(creator).toMatchObject({ sourceType: 'bundled', enabled: true, status: 'valid' });
    expect(creator?.skillName).toBe(BUILTIN_SKILL_CREATOR_NAME);
    const revision = fixture.repos.users.getRevisions('user-a').skillRevision;
    fixture.publisher.seedBuiltinCreator(['user-a', 'user-b']);
    expect(fixture.repos.users.getRevisions('user-a').skillRevision).toBe(revision);

    const result = fixture.publisher.publish('user-a', {
      name: 'research-gap-explorer',
      description: '用于在受限预算和周期内筛选研究空白并形成可执行 POC。',
      instructions: '# Research Gap Explorer\n\n按证据、资源和可行性依次筛选候选方向。',
    });

    expect(result).toMatchObject({
      skillName: 'research-gap-explorer',
      scope: 'user',
      enabled: true,
    });
    expect(fixture.repos.skills.getInstallation('user-a', result.skillName)).toMatchObject({
      sourceType: 'local',
      enabled: true,
      status: 'valid',
      metadata: { generated: true, generatedBy: BUILTIN_SKILL_CREATOR_NAME },
    });
    expect(fixture.repos.skills.getInstallation('user-b', result.skillName)).toBeUndefined();
    expect(fixture.repos.skills.getInstallation('user-a', result.skillName)?.skillName).toBe(
      result.skillName,
    );
    expect(
      readFileSync(path.join(fixture.skillRoot('user-a'), result.skillName, 'SKILL.md'), 'utf8'),
    ).toContain('name: research-gap-explorer');

    expect(() =>
      fixture.publisher.publish('user-a', {
        name: 'research-gap-explorer',
        description: '重复名称。',
        instructions: '不得覆盖。',
      }),
    ).toThrowError(GeneratedSkillPublishError);

    const catalog = new SkillCatalogService({
      repos: fixture.repos,
      skillRoot: fixture.skillRoot,
      clock: fixture.clock,
    });
    catalog.refresh('user-a');
    expect(fixture.repos.skills.getInstallation('user-a', BUILTIN_SKILL_CREATOR_NAME)?.status).toBe(
      'valid',
    );
  });

  it('exposes skill_publish only after skill-creator is loaded in the current turn', async () => {
    const fixture = createFixture();
    fixture.publisher.seedBuiltinCreator(['user-a']);
    const registry = new ToolRegistry();
    const runner = new ProcessRunner({ allowedRoots: [fixture.root, os.tmpdir()] });
    registerBuiltinRuntimeTools(registry, {
      appDataDir: fixture.root,
      repos: fixture.repos,
      fileSystem: new ScopedFileSystem(fixture.root),
      shell: new ShellExecutor(fixture.root, runner),
      publishSkill: (userId, input) => fixture.publisher.publish(userId, input),
    });
    const context: ToolExecutionContext = {
      userId: 'user-a',
      agentId: 'dylan',
      sessionOrigin: 'direct',
      sessionId: 'session-1',
      eventId: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      permissionPreset: 'full-access',
      signal: new AbortController().signal,
    };

    expect(
      registry
        .definitions(context.userId, context.sessionId, context.turnId)
        .map((tool) => tool.name),
    ).not.toContain('skill_publish');
    await registry.get('skill_load')?.execute({ name: BUILTIN_SKILL_CREATOR_NAME }, context);
    expect(
      registry
        .definitions(context.userId, context.sessionId, context.turnId)
        .map((tool) => tool.name),
    ).toContain('skill_publish');
    expect(
      registry.definitions(context.userId, context.sessionId, 'turn-2').map((tool) => tool.name),
    ).not.toContain('skill_publish');

    const publishTool = registry.get(
      'skill_publish',
      context.userId,
      context.sessionId,
      context.turnId,
    );
    expect(publishTool).toMatchObject({
      approvalPolicy: 'always',
      approvalScope: 'local',
      permissionIdentity: 'skill:publish:user',
    });
    await expect(
      publishTool?.execute(
        {
          name: 'literature-triage',
          description: '用于把研究问题逐层筛选为可验证的候选方向。',
          instructions: '# Literature Triage\n\n先定义约束，再比较证据。',
        },
        { ...context, toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({ skillName: 'literature-triage', enabled: true });
  });
});

function createFixture(): {
  root: string;
  repos: SqliteRepositories;
  clock: Clock;
  skillRoot: (userId: LocalUserId) => string;
  publisher: GeneratedSkillPublisher;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'generated-skill-test-'));
  roots.push(root);
  const db = openDatabase(path.join(root, 'app.db'));
  let tick = 0;
  const clock: Clock = {
    now: () => new Date(`2026-09-03T00:00:${String(tick).padStart(2, '0')}.000Z`),
    nowIso: () => `2026-09-03T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  const ids: IdProvider = { newId: () => `id-${tick++}` };
  runMigrations(db, STAGE45_MIGRATIONS, { clock: () => clock.nowIso() });
  const repos = new SqliteRepositories(db);
  repos.users.seedUsers(clock.nowIso());
  const skillRoot = (userId: LocalUserId) => path.join(root, 'skills', userId);
  const publisher = new GeneratedSkillPublisher({
    appDataDir: root,
    repos,
    clock,
    ids,
    skillRoot,
  });
  return { root, repos, clock, skillRoot, publisher };
}
