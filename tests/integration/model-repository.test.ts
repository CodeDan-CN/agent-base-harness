import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { openMigratedDb } from '../../packages/test-kit/src/db';
import { BridgeError } from '../../packages/protocol/src/contracts/errors';

const NOW = '2026-01-01T00:00:00.000Z';

function serviceInput(
  id: string,
  userId: string,
  extra: Partial<{ credentialRef: string | null }> = {},
) {
  return {
    id,
    userId,
    name: id,
    providerType: 'openai',
    endpoint: 'https://example.invalid/v1',
    credentialRef: extra.credentialRef ?? null,
    config: { baseUrl: 'https://example.invalid' },
    now: NOW,
  };
}

function modelInput(id: string, userId: string, serviceId: string) {
  return {
    id,
    userId,
    serviceId,
    remoteModelId: id,
    displayName: id,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { vision: false },
    defaultParams: { temperature: 0.7 },
    source: 'manual' as const,
    now: NOW,
  };
}

describe('M08 Model 配置持久化', () => {
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

  it('S1-M08-001 创建模型服务并在事务中递增 model_revision', () => {
    expect(repos.users.getRevisions('user-a').modelRevision).toBe(0);
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    expect(repos.users.getRevisions('user-a').modelRevision).toBe(1);
    expect(repos.users.getRevisions('user-b').modelRevision).toBe(0);
  });

  it('S1-M08-002 服务隔离：B 查 A serviceId 不返回', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    expect(repos.models.getService('user-b', 'srv-a')).toBeUndefined();
    expect(repos.models.getService('user-a', 'srv-a')?.userId).toBe('user-a');
  });

  it('S1-M08-003 模型复合外键：B 模型引用 A service 被拒绝并回滚', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    const before = repos.users.getRevisions('user-b').modelRevision;
    expect(() => repos.models.createModel(modelInput('m1', 'user-b', 'srv-a'))).toThrow(
      BridgeError,
    );
    expect(repos.users.getRevisions('user-b').modelRevision).toBe(before);
    expect(repos.models.listModels('user-b')).toEqual([]);
  });

  it('S1-M08-004 默认模型跨用户：B 设置 A modelId 被拒绝且 revision 不变', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));

    const before = repos.users.getRevisions('user-b').modelRevision;
    expect(() => repos.models.setDefaultModel('user-b', 'm-a', NOW)).toThrow(BridgeError);
    expect(repos.users.getRevisions('user-b').modelRevision).toBe(before);
    expect(repos.models.getDefaultModelId('user-b')).toBeNull();
  });

  it('S1-M08-005 设置默认模型原子性', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    const before = repos.users.getRevisions('user-a').modelRevision;

    repos.models.setDefaultModel('user-a', 'm-a', NOW);
    expect(repos.models.getDefaultModelId('user-a')).toBe('m-a');
    expect(repos.users.getRevisions('user-a').modelRevision).toBe(before + 1);
  });

  it('S1-M08-007 归档含默认模型的服务被阻断', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setDefaultModel('user-a', 'm-a', NOW);

    expect(() => repos.models.archiveService('user-a', 'srv-a', NOW)).toThrow(BridgeError);
    expect(repos.models.getService('user-a', 'srv-a')?.status).toBe('enabled');
  });

  it('S1-M08-006 SQLite 只存 credential_ref，无明文', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a', { credentialRef: 'ref:none' }));
    const row = db
      .prepare(
        "SELECT credential_ref FROM model_services WHERE user_id = 'user-a' AND id = 'srv-a'",
      )
      .get() as { credential_ref: string };
    expect(row.credential_ref).toBe('ref:none');
  });

  it('updateService 更新字段并递增 revision', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    const before = repos.users.getRevisions('user-a').modelRevision;

    repos.models.updateService('user-a', 'srv-a', { endpoint: 'https://new.example/v1' }, NOW);
    expect(repos.models.getService('user-a', 'srv-a')?.endpoint).toBe('https://new.example/v1');
    expect(repos.users.getRevisions('user-a').modelRevision).toBe(before + 1);
  });

  it('setModelStatus 归档非默认模型并递增 revision', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    const before = repos.users.getRevisions('user-a').modelRevision;

    repos.models.setModelStatus('user-a', 'm-a', 'archived', NOW);
    expect(repos.models.getModel('user-a', 'm-a')?.status).toBe('archived');
    expect(repos.users.getRevisions('user-a').modelRevision).toBe(before + 1);
  });

  it('归档默认模型被阻断', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setDefaultModel('user-a', 'm-a', NOW);

    expect(() => repos.models.setModelStatus('user-a', 'm-a', 'archived', NOW)).toThrow(
      BridgeError,
    );
  });

  it('clearDefaultModel 清除默认模型并递增 revision', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setDefaultModel('user-a', 'm-a', NOW);
    expect(repos.models.getDefaultModelId('user-a')).toBe('m-a');

    repos.models.clearDefaultModel('user-a', NOW);
    expect(repos.models.getDefaultModelId('user-a')).toBeNull();
  });

  it('archiveService 级联归档其下模型', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.createModel(modelInput('m-b', 'user-a', 'srv-a'));

    repos.models.archiveService('user-a', 'srv-a', NOW);
    expect(repos.models.getService('user-a', 'srv-a')?.status).toBe('archived');
    expect(repos.models.getModel('user-a', 'm-a')?.status).toBe('archived');
    expect(repos.models.getModel('user-a', 'm-b')?.status).toBe('archived');
  });

  it('归档服务重新启用清空 archived_at', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.archiveService('user-a', 'srv-a', NOW);
    expect(repos.models.getService('user-a', 'srv-a')?.archivedAt).not.toBeNull();

    repos.models.updateService('user-a', 'srv-a', { status: 'enabled' }, NOW);
    const service = repos.models.getService('user-a', 'srv-a');
    expect(service?.status).toBe('enabled');
    expect(service?.archivedAt).toBeNull();
  });

  it('归档模型重新启用清空 archived_at', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setModelStatus('user-a', 'm-a', 'archived', NOW);
    expect(repos.models.getModel('user-a', 'm-a')?.archivedAt).not.toBeNull();

    repos.models.setModelStatus('user-a', 'm-a', 'enabled', NOW);
    const model = repos.models.getModel('user-a', 'm-a');
    expect(model?.status).toBe('enabled');
    expect(model?.archivedAt).toBeNull();
  });

  it('可按服务与远程模型 ID 找回归档记录', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setModelStatus('user-a', 'm-a', 'archived', NOW);

    expect(repos.models.getModelByRemoteId('user-a', 'srv-a', 'm-a')).toMatchObject({
      id: 'm-a',
      status: 'archived',
    });
    expect(repos.models.getModelByRemoteId('user-b', 'srv-a', 'm-a')).toBeUndefined();
  });

  it('setDefaultModel 拒绝 disabled/archived 模型', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.setModelStatus('user-a', 'm-a', 'disabled', NOW);

    expect(() => repos.models.setDefaultModel('user-a', 'm-a', NOW)).toThrow(BridgeError);
    expect(repos.models.getDefaultModelId('user-a')).toBeNull();
  });

  it('setDefaultModel 拒绝服务已归档的模型', () => {
    repos.models.createService(serviceInput('srv-a', 'user-a'));
    repos.models.createModel(modelInput('m-a', 'user-a', 'srv-a'));
    repos.models.archiveService('user-a', 'srv-a', NOW);

    expect(() => repos.models.setDefaultModel('user-a', 'm-a', NOW)).toThrow(BridgeError);
  });
});
