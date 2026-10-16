import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteCredentialStore } from '../../packages/execution/src/credential/sqlite-credential-store';
import { credentialRefOf } from '../../packages/execution/src/credential/credential-store';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { MacKeychainCredentialStore } from '../../packages/execution/src/credential/mac-keychain-store';
import { LinuxEncryptedCredentialStore } from '../../packages/execution/src/credential/linux-encrypted-store';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { migrateLegacyCredentials } from '../../packages/server-core/src/migrate-legacy-credentials';
import { DataDirectoryLock } from '../../packages/server-core/src/lifecycle';
import { servicePaths } from '../../packages/server-core/src/paths';
import { ServiceHost } from '../../packages/server-core/src/service-host';
import { AgentClient } from '../../packages/client-sdk/src/agent-client';
import { makeTempDir, cleanupDir } from '../../packages/test-kit/src/temp';

const roots: string[] = [];
const apps = new Set<WorkerApplication>();
const hosts: ServiceHost[] = [];
const scope = { userId: 'user-a', purpose: 'model-service', entityId: 'service' };
const now = '2026-09-14T00:00:00.000Z';

function root() {
  const directory = makeTempDir('sqlite-credentials-');
  roots.push(directory);
  return directory;
}
function application(appDataDir: string, useSystemCredential?: boolean) {
  const app = createWorkerApplication({
    appDataDir,
    generation: 1,
    logger: new MemoryLogger(),
    useSystemCredential,
    refreshCatalogOnStart: false,
  });
  apps.add(app);
  return app;
}
function close(app: WorkerApplication) {
  app.close();
  apps.delete(app);
}
function seedModel(repos: SqliteRepositories, id = scope.entityId, userId = scope.userId) {
  repos.models.createService({
    id,
    userId,
    name: id,
    providerType: 'openai-compatible',
    endpoint: 'https://example.invalid/v1',
    config: {},
    now,
    credentialRef: credentialRefOf({ userId, purpose: 'model-service', entityId: id }),
  });
}
function forbidLegacyStores() {
  return [MacKeychainCredentialStore.prototype, LinuxEncryptedCredentialStore.prototype].flatMap(
    (prototype) =>
      (['set', 'get', 'getByRef', 'delete', 'status', 'available'] as const).map((method) =>
        vi.spyOn(prototype, method).mockImplementation(async () => {
          throw new Error('Unexpected legacy credential access');
        }),
      ),
  );
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const app of apps) app.close();
  apps.clear();
  for (const directory of roots.splice(0)) cleanupDir(directory);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SQLite credentials', () => {
  it.each([undefined, true, false])(
    'persists model keys and tests connections without legacy stores (option %s)',
    async (legacy) => {
      const spies = forbidLegacyStores();
      const directory = root();
      vi.stubEnv('AGENT_HARNESS_CREDENTIAL_KEY_FILE', '/nonexistent/legacy-master.key');
      const first = application(directory, legacy);
      const saved = await first.saveModelService('user-a', {
        name: 'Saved model',
        providerType: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        enabled: true,
        config: {},
        credential: { action: 'replace', value: 'test-only-api-key' },
        expectedRevision: first.repos.users.getRevisions('user-a').modelRevision,
      });
      const ref = first.repos.models.getService('user-a', saved.id)!.credentialRef!;
      expect(first.credentialStore).toBeInstanceOf(SqliteCredentialStore);
      close(first);
      const second = application(directory, legacy);
      expect(await second.credentialStore.getByRef(ref)).toBe('test-only-api-key');
      const fetch = vi.fn(async () => Response.json({ data: [] }));
      vi.stubGlobal('fetch', fetch);
      expect(
        await second.testModelService('user-a', {
          id: saved.id,
          name: 'Saved model',
          providerType: 'openai-compatible',
          endpoint: 'https://example.invalid/v1',
          enabled: true,
          config: {},
          credential: { action: 'unchanged' },
        }),
      ).toEqual({ status: 'success' });
      expect(fetch).toHaveBeenCalledWith(
        'https://example.invalid/v1/models',
        expect.objectContaining({ headers: { authorization: 'Bearer test-only-api-key' } }),
      );
      expect(existsSync(path.join(directory, 'credentials'))).toBe(false);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const snapshot = await second.modelManagement('user-a');
      expect(JSON.stringify(snapshot)).not.toContain('test-only-api-key');
    },
  );

  it('isolates scopes, replaces and clears credentials, and never falls back on missing values', async () => {
    const spies = forbidLegacyStores();
    const app = application(root());
    const store = app.credentialStore;
    expect(await store.status(scope)).toBe('missing');
    await store.set(scope, 'first');
    expect(await store.status(scope)).toBe('configured');
    expect(await store.get({ ...scope, userId: 'user-b' })).toBeNull();
    expect(await store.get({ ...scope, purpose: 'mcp-server' })).toBeNull();
    expect(await store.getByRef('../../outside')).toBeNull();
    await store.set(scope, 'replacement');
    expect(await store.get(scope)).toBe('replacement');
    await store.delete(scope);
    expect(await store.get(scope)).toBeNull();
    expect(await store.status(scope)).toBe('missing');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('ServiceHost persists keys via the public gateway without platform-specific storage', async () => {
    const spies = forbidLegacyStores();
    const dataDir = root();
    const host = new ServiceHost({
      dataDir,
      useSystemCredential: true,
      skipRecovery: true,
      logger: new MemoryLogger(),
    });
    hosts.push(host);
    const client = new AgentClient({
      baseUrl: (await host.start()).baseUrl,
      clientKind: 'cli',
      user: { id: 'sqlite-store-user', loginName: 'sqlite-store-user', displayName: 'Test' },
    });
    const snapshot = await client.query<{ revision: number }>('model-management.snapshot');
    const saved = await client.command<{ id: string }>('model-service.save', {
      name: 'Test',
      providerType: 'openai-compatible',
      endpoint: 'https://example.invalid/v1',
      enabled: true,
      config: {},
      credential: { action: 'replace', value: 'host-test-secret' },
      expectedRevision: snapshot.revision,
    });
    await host.stop();
    const app = application(dataDir);
    expect(
      await app.credentialStore.get({
        userId: 'sqlite-store-user',
        purpose: 'model-service',
        entityId: saved.id,
      }),
    ).toBe('host-test-secret');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('explicit offline credential migration', () => {
  it('upgrades a pre-SQLite-credential database without changing saved references', async () => {
    const directory = root();
    // Create the directory structure, then replace only this isolated test database's schema.
    const app = application(directory);
    close(app);
    const db = openDatabase(path.join(directory, 'database', 'app.db'));
    db.exec('DROP TABLE credential_secrets; DELETE FROM schema_migrations WHERE version = 16');
    runMigrations(
      db,
      STAGE47_MIGRATIONS.filter((migration) => migration.version < 16),
      { clock: () => now },
    );
    seedModel(new SqliteRepositories(db));
    db.close();
    const source = new FakeCredentialStore();
    await source.set(scope, 'old-key');
    expect(await migrateLegacyCredentials(directory, 'keychain', source)).toEqual({
      migrated: 1,
      skipped: 0,
      missing: 0,
      failed: 0,
    });
    const restarted = application(directory);
    expect(await restarted.credentialStore.get(scope)).toBe('old-key');
    expect(restarted.repos.models.getService('user-a', 'service')?.credentialRef).toBe(
      credentialRefOf(scope),
    );
  });

  it('migrates model/MCP and archived entries, preserves local values, and is repeatable', async () => {
    const directory = root();
    const app = application(directory);
    seedModel(app.repos);
    seedModel(app.repos, 'archived');
    seedModel(app.repos, 'local');
    app.repos.models.archiveService('user-a', 'archived', now);
    const mcpScope = { userId: 'user-a', purpose: 'mcp-server', entityId: 'mcp' };
    app.repos.mcp.createServer({
      id: 'mcp',
      userId: 'user-a',
      name: 'mcp',
      summary: '',
      transport: 'streamable-http',
      config: { url: 'http://127.0.0.1:1/mcp', local: true },
      credentialRef: credentialRefOf(mcpScope),
      enabled: false,
      now,
    });
    const localScope = { ...scope, entityId: 'local' };
    await app.credentialStore.set(localScope, 'local-value');
    close(app);
    const source = new FakeCredentialStore();
    await source.set(scope, 'model-value');
    await source.set({ ...scope, entityId: 'archived' }, 'archived-value');
    await source.set(mcpScope, 'mcp-value');
    await source.set(localScope, 'old-value');
    const read = vi.spyOn(source, 'getByRef');
    const remove = vi.spyOn(source, 'delete');
    expect(await migrateLegacyCredentials(directory, 'keychain', source)).toEqual({
      migrated: 3,
      skipped: 1,
      missing: 0,
      failed: 0,
    });
    expect(read).toHaveBeenCalledTimes(3);
    const restarted = application(directory);
    expect(await restarted.credentialStore.get(scope)).toBe('model-value');
    expect(await restarted.credentialStore.get(mcpScope)).toBe('mcp-value');
    expect(await restarted.credentialStore.get(localScope)).toBe('local-value');
    close(restarted);
    read.mockClear();
    expect(await migrateLegacyCredentials(directory, 'keychain', source)).toEqual({
      migrated: 0,
      skipped: 4,
      missing: 0,
      failed: 0,
    });
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('imports the existing Linux encrypted file format and keeps source files intact', async () => {
    const directory = root();
    const app = application(directory);
    seedModel(app.repos);
    close(app);
    const source = new LinuxEncryptedCredentialStore({
      directory: path.join(directory, 'credentials'),
    });
    await source.set(scope, 'encrypted-source-value');
    expect(await migrateLegacyCredentials(directory, 'files')).toEqual({
      migrated: 1,
      skipped: 0,
      missing: 0,
      failed: 0,
    });
    expect(await application(directory).credentialStore.get(scope)).toBe('encrypted-source-value');
    expect(await source.get(scope)).toBe('encrypted-source-value');
  });

  it('reports missing/failed credentials without secrets, releases the lock, and supports retry', async () => {
    const directory = root();
    const app = application(directory);
    seedModel(app.repos);
    seedModel(app.repos, 'missing');
    close(app);
    const source = {
      getByRef: vi.fn(async (ref: string) => {
        if (ref === credentialRefOf(scope)) throw new Error('sensitive-source-error');
        return null;
      }),
    };
    expect(await migrateLegacyCredentials(directory, 'keychain', source)).toEqual({
      migrated: 0,
      skipped: 0,
      missing: 1,
      failed: 1,
    });
    const retry = new FakeCredentialStore();
    await retry.set(scope, 'recovered');
    expect(await migrateLegacyCredentials(directory, 'keychain', retry)).toEqual({
      migrated: 1,
      skipped: 0,
      missing: 1,
      failed: 0,
    });
  });

  it('refuses migration while a Runtime owns the directory', async () => {
    const directory = root();
    const app = application(directory);
    seedModel(app.repos);
    close(app);
    const lock = new DataDirectoryLock(servicePaths(directory));
    lock.acquire();
    const source = { getByRef: vi.fn(async () => 'unused') };
    try {
      await expect(migrateLegacyCredentials(directory, 'keychain', source)).rejects.toThrow(
        'already owns',
      );
      expect(source.getByRef).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });
});
