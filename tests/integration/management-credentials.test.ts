import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  credentialRefOf,
  type CredentialStore,
} from '../../packages/execution/src/credential/credential-store';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { MacKeychainCredentialStore } from '../../packages/execution/src/credential/mac-keychain-store';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import {
  modelManagementSnapshotSchema,
  mcpManagementSnapshotSchema,
} from '../../packages/protocol/src/contracts/management';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { dispatch } from '../../packages/server-core/src/application/dispatcher';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';

const fixtures: Array<{ app: WorkerApplication; root: string }> = [];
const now = '2026-09-14T00:00:00.000Z';
const savedScope = { userId: 'user-a', purpose: 'model-service', entityId: 'saved' };
const danglingRef = credentialRefOf({ ...savedScope, entityId: 'dangling' });

afterEach(() => {
  for (const { app, root } of fixtures.splice(0)) {
    app.close();
    cleanupDir(root);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(store: CredentialStore) {
  const root = makeTempDir('management-credentials-');
  const app = createWorkerApplication({
    appDataDir: root,
    generation: 1,
    logger: new MemoryLogger(),
    credentialStore: store,
    refreshCatalogOnStart: false,
  });
  fixtures.push({ app, root });
  for (const [id, credentialRef] of [
    ['saved', credentialRefOf(savedScope)],
    ['dangling', danglingRef],
    ['absent', null],
    ['empty', ''],
  ] as const) {
    app.repos.models.createService({
      id,
      userId: 'user-a',
      name: id,
      providerType: 'openai-compatible',
      endpoint: 'https://example.invalid/v1',
      credentialRef,
      config: {},
      now,
    });
    app.repos.mcp.createServer({
      id,
      userId: 'user-a',
      name: id,
      summary: '',
      transport: 'streamable-http',
      config: { url: 'https://example.invalid/mcp', local: false },
      credentialRef,
      enabled: id === 'saved',
      now,
    });
  }
  app.repos.models.updateService('user-a', 'dangling', { status: 'disabled' }, now);
  app.repos.mcp.setConnectionStatus('user-a', 'saved', 'error', 1, 'Connection failed', now);
  app.repos.mcp.setConnectionStatus('user-a', 'absent', 'connected', 1, null, now);
  return app;
}

function spyOnStore(store: CredentialStore) {
  return (['set', 'get', 'getByRef', 'delete', 'status', 'available'] as const).map((method) =>
    vi.spyOn(store, method),
  );
}

const expectedStatuses = {
  saved: 'configured',
  dangling: 'configured',
  absent: 'missing',
  empty: 'missing',
};

describe('管理快照的凭据状态只反映已保存引用', () => {
  for (const unavailable of [false, true]) {
    it(`模型快照对凭据库零访问（unavailable=${unavailable}）`, async () => {
      const store = new FakeCredentialStore();
      await store.set(savedScope, 'test-only-secret');
      const app = fixture(store);
      store.setUnavailable(unavailable);
      const spies = spyOnStore(store);

      const snapshot = modelManagementSnapshotSchema.parse(
        await dispatch(app, 'model-management.snapshot', {}, 'user-a'),
      );

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(Object.fromEntries(snapshot.services.map((s) => [s.id, s.credentialStatus]))).toEqual(
        expectedStatuses,
      );
      expect(JSON.stringify(snapshot)).not.toContain('test-only-secret');
      expect(JSON.stringify(snapshot)).not.toContain(credentialRefOf(savedScope));
    });

    it(`MCP 快照对凭据库零访问且连接状态独立（unavailable=${unavailable}）`, async () => {
      const store = new FakeCredentialStore();
      await store.set(savedScope, 'test-only-secret');
      const app = fixture(store);
      store.setUnavailable(unavailable);
      const spies = spyOnStore(store);

      const snapshot = mcpManagementSnapshotSchema.parse(
        await dispatch(app, 'mcp-management.snapshot', {}, 'user-a'),
      );

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(Object.fromEntries(snapshot.servers.map((s) => [s.id, s.credentialStatus]))).toEqual(
        expectedStatuses,
      );
      expect(snapshot.servers.find((s) => s.id === 'saved')).toMatchObject({
        credentialStatus: 'configured',
        connectionStatus: 'error',
        lastError: 'Connection failed',
      });
      expect(snapshot.servers.find((s) => s.id === 'absent')).toMatchObject({
        credentialStatus: 'missing',
        connectionStatus: 'connected',
      });
      expect(JSON.stringify(snapshot)).not.toContain('test-only-secret');
      expect(JSON.stringify(snapshot)).not.toContain(credentialRefOf(savedScope));
    });
  }

  it('使用 macOS 凭据适配器查询两个快照时不启动 security', async () => {
    const exec = vi.fn(async () => ({ stdout: 'test-only-secret', stderr: '' }));
    const store = new MacKeychainCredentialStore({ exec });
    const app = fixture(store);
    const spies = spyOnStore(store);

    await dispatch(app, 'model-management.snapshot', {}, 'user-a');
    await dispatch(app, 'mcp-management.snapshot', {}, 'user-a');

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('模型连接测试仍读取已保存密钥，并返回独立的认证失败结果', async () => {
    const store = new FakeCredentialStore();
    await store.set(savedScope, 'test-only-secret');
    const app = fixture(store);
    const read = vi.spyOn(store, 'getByRef');
    const fetch = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);

    expect(
      await app.testModelService('user-a', {
        id: 'saved',
        name: 'saved',
        providerType: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        enabled: true,
        config: {},
        credential: { action: 'unchanged' },
      }),
    ).toEqual({ status: 'auth' });
    expect(read).toHaveBeenCalledExactlyOnceWith(credentialRefOf(savedScope));
    expect(fetch).toHaveBeenCalledWith(
      'https://example.invalid/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer test-only-secret' } }),
    );
    read.mockClear();
    expect(
      (await app.modelManagement('user-a')).services.find((service) => service.id === 'saved')
        ?.credentialStatus,
    ).toBe('configured');
    expect(read).not.toHaveBeenCalled();
  });

  it('MCP 连接测试仍尝试读取密钥，凭据库故障在测试阶段暴露', async () => {
    const store = new FakeCredentialStore();
    const app = fixture(store);
    store.setUnavailable(true);
    const read = vi.spyOn(store, 'getByRef');

    const result = await app.testMcpServer('user-a', {
      id: 'saved',
      name: 'saved',
      summary: '',
      categoryId: 'uncategorized',
      transport: 'streamable-http',
      config: { url: 'http://127.0.0.1:1/mcp', local: true },
      enabled: true,
      credential: { action: 'unchanged' },
    });

    expect(result.status).not.toBe('success');
    expect(read).toHaveBeenCalledWith(credentialRefOf(savedScope));
    read.mockClear();
    expect(
      (await app.mcpManagement('user-a')).servers.find((server) => server.id === 'saved')
        ?.credentialStatus,
    ).toBe('configured');
    expect(read).not.toHaveBeenCalled();
  });
});
