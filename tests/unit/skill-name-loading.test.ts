import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import Ajv from 'ajv';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { createBuiltinTools } from '../../packages/runtime-core/src/builtin-tools';
import { createCapabilitySearchTool } from '../../packages/runtime-core/src/capability-discovery';
import { ScopedFileSystem } from '../../packages/execution/src/filesystem/scoped-file-system';
import { ShellExecutor } from '../../packages/execution/src/process/shell-executor';
import { ProcessRunner } from '../../packages/execution/src/process/process-runner';
import type {
  AgentExecutionConfigSnapshot,
  ToolExecutionContext,
} from '../../packages/runtime-core/src/tools';

const now = '2026-10-16T00:00:00.000Z';
const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skill-name-load-'));
  roots.push(root);
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db, STAGE47_MIGRATIONS, { clock: () => now });
  const repos = new SqliteRepositories(db);
  repos.users.seedUsers(now);
  for (const userId of ['user-a', 'user-b']) {
    repos.agents.ensureDylan(userId, 'guarded', now);
    repos.sessions.createSession({
      id: `session-${userId}`,
      userId,
      title: 'Skills',
      agentId: 'dylan',
      origin: 'direct',
      parentSessionId: null,
      now,
    });
  }
  const tool = createBuiltinTools({
    repos,
    appDataDir: root,
    fileSystem: new ScopedFileSystem(root),
    shell: new ShellExecutor(root, new ProcessRunner({ allowedRoots: [root] })),
  }).find((entry) => entry.name === 'skill_load')!;
  function install(userId: string, name: string, bound = true) {
    const skillRoot = path.join(root, 'source', userId, name);
    mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      `# ${name}\nPrivate instructions for ${userId}`,
    );
    writeFileSync(path.join(skillRoot, 'scripts/report.py'), `print('${userId}')`);
    repos.skills.upsertInstallation({
      id: `${userId}:${name}`,
      userId,
      skillName: name,
      description: name,
      sourceType: 'local',
      sourceRef: skillRoot,
      rootPath: skillRoot,
      metadata: {},
      contentDigest: 'fixture',
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
      now,
    });
    if (bound)
      repos.agents.setSkillBinding(
        userId,
        'dylan',
        `${userId}:${name}`,
        true,
        repos.users.getRevisions(userId).agentRevision,
        now,
      );
  }
  return { root, repos, tool, install };
}
function context(userId = 'user-a'): ToolExecutionContext {
  return {
    userId,
    agentId: 'dylan',
    sessionOrigin: 'direct',
    sessionId: `session-${userId}`,
    eventId: 'event',
    turnId: 'turn',
    stepId: 'step',
    toolCallId: 'call',
    permissionPreset: 'guarded',
    signal: new AbortController().signal,
  };
}

it('loads the exact name returned by discovery and exposes real skill resources without installation IDs', async () => {
  const f = fixture();
  f.install('user-a', 'weekly-report-summary');
  const search = createCapabilitySearchTool(f.repos);
  const discovered = await search.execute({}, context());
  expect(discovered.candidates).toEqual([
    {
      kind: 'skill',
      name: 'weekly-report-summary',
      description: 'weekly-report-summary',
      action: 'skill_load',
    },
  ]);
  const validate = new Ajv({ strict: false }).compile(search.output!.schema);
  expect(validate(discovered)).toBe(true);
  expect(
    validate({
      ...discovered,
      candidates: [{ ...discovered.candidates[0], capabilityId: 'user-a:weekly-report-summary' }],
    }),
  ).toBe(false);
  const loaded = (await f.tool.execute({ name: discovered.candidates[0]!.name }, context())) as {
    content: string;
    resourceBase: { path: string };
  };
  expect(loaded.content).toContain('Private instructions for user-a');
  expect(readFileSync(path.join(loaded.resourceBase.path, 'scripts/report.py'), 'utf8')).toContain(
    'user-a',
  );
  expect(f.tool.parameters).toMatchObject({
    required: ['name'],
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  });
  expect(JSON.stringify(f.tool.parameters)).not.toContain('capabilityId');
});

it('rejects removed ID arguments and does not interpret IDs as names', async () => {
  const f = fixture();
  f.install('user-a', 'weekly-report-summary');
  for (const args of [
    {},
    { skillName: 'weekly-report-summary' },
    { capabilityId: 'weekly-report-summary' },
    { capabilityId: 'user-a:weekly-report-summary' },
    { name: 'weekly-report-summary', capabilityId: 'anything' },
  ]) {
    await expect(f.tool.execute(args, context())).rejects.toThrow();
  }
  await expect(f.tool.execute({ name: 'user-a:weekly-report-summary' }, context())).rejects.toThrow(
    'SKILL_NOT_AVAILABLE',
  );
});

it('keeps same-name skills isolated by user and rejects unbound skills', async () => {
  const f = fixture();
  f.install('user-a', 'shared-name');
  f.install('user-b', 'shared-name');
  f.install('user-b', 'only-b');
  f.install('user-a', 'unbound', false);
  for (const userId of ['user-a', 'user-b']) {
    const loaded = (await f.tool.execute({ name: 'shared-name' }, context(userId))) as {
      content: string;
    };
    expect(loaded.content).toContain(`Private instructions for ${userId}`);
  }
  await expect(f.tool.execute({ name: 'only-b' }, context())).rejects.toThrow(
    'SKILL_NOT_AVAILABLE',
  );
  await expect(f.tool.execute({ name: 'unbound' }, context())).rejects.toThrow(
    'SKILL_NOT_AVAILABLE',
  );
});

it('continues to authorize names against the frozen step skill IDs', async () => {
  const f = fixture();
  f.install('user-a', 'bound');
  const frozen = { skillIds: [] } as unknown as AgentExecutionConfigSnapshot;
  await expect(
    f.tool.execute({ name: 'bound' }, { ...context(), executionConfig: frozen }),
  ).rejects.toThrow('SKILL_NOT_AVAILABLE');
});
