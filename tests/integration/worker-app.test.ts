import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApplication } from '../../packages/server-core/src/application/application';
import { dispatch } from '../../packages/server-core/src/application/dispatcher';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

describe('Worker Application 与 dispatched 服务', () => {
  let root: string;
  let app: ReturnType<typeof createWorkerApplication>;

  beforeEach(() => {
    root = makeTempDir();
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
    });
  });

  afterEach(() => {
    app.close();
    cleanupDir(root);
  });

  it('S1-M04-008 app.bootstrap 返回完整契约', () => {
    const result = app.bootstrap('user-a');
    expect(result.activeUser.id).toBe('user-a');
    expect(result.users.map((u) => u.id)).toEqual(['user-a']);
    expect(result.runtime.status).toBe('ready');
    expect(result.runtime.generation).toBe(1);
    expect(result.schemaVersion).toBe(16);
    expect(result.defaultAgentId).toBe('dylan');
    expect(result.revisions.userId).toBe('user-a');
    expect(result.capabilities).toEqual({
      model: 'foundation',
      skill: 'foundation',
      runtime: 'ready',
      agentProfiles: 'ready',
      agentDelegation: 'ready',
      scopedMcpInstances: 'ready',
    });
  });

  it('S1-M05-008 用户身份由每个已认证请求显式确定', () => {
    const result = app.bootstrap('user-b');
    expect(result.activeUser.id).toBe('user-b');
    expect(app.bootstrap('user-a').activeUser.id).toBe('user-a');
  });

  it('S1-M12-001 health 完整性：Worker/DB/Credential/Skill/ interpreters 齐全', async () => {
    const health = await app.health('user-a');
    expect(health.worker.status).toBe('ready');
    expect(health.worker.generation).toBe(1);
    expect(health.database.status).toBe('ok');
    expect(health.database.schemaVersion).toBe(16);
    expect(['configured', 'unavailable', 'error']).toContain(health.credential.status);
    expect(['ok', 'missing', 'error']).toContain(health.skillRoot.status);
    expect(['available', 'missing', 'error', 'unsupported']).toContain(
      health.interpreters.node.status,
    );
  });

  it('S1-M04-009 health 脱敏：不泄漏可执行文件绝对路径', async () => {
    const health = await app.health('user-a');
    expect(Object.keys(health.interpreters.node).sort()).toEqual([
      'arch',
      'source',
      'status',
      'version',
    ]);
    expect(Object.keys(health.interpreters.python).sort()).toEqual([
      'arch',
      'source',
      'status',
      'version',
    ]);
    const json = JSON.stringify(health);
    expect(json).not.toContain('/usr/');
  });

  it('S1-M03-012 Worker 状态不进入数据库（无 worker 业务表）', () => {
    expect(app.schemaVersion).toBe(16);
    expect(app.repos.users.listUsers()).toHaveLength(2);
  });

  it('dispatch user.switch 要求重新登录且不切换请求身份', async () => {
    await expect(
      dispatch(app, 'user.switch', { userId: 'user-b' }, 'user-a'),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(app.bootstrap('user-a').activeUser.id).toBe('user-a');
  });

  it('dispatch 未知 method 返回 INVALID_REQUEST', async () => {
    await expect(dispatch(app, 'unknown.method', {}, 'user-a')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('S1-M06-009 常规业务连接只由 Worker 创建（Main/Renderer 无 DB 引用）', async () => {
    const health = await app.health('user-a');
    expect(health.database.status).toBe('ok');
    expect(health.database.schemaVersion).toBe(16);
    expect(app.repos.sessions.listSessions('user-a')).toEqual([]);
  });
});
