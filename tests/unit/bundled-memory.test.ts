import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE45_MIGRATIONS } from '../../packages/storage/src/schema';
import type { BundledRuntimeSnapshot } from '../../packages/execution/src/runtime/bundled-runtime-registry';
import {
  BUNDLED_MEMORY_DATA_FILE,
  BUNDLED_MEMORY_ENTRYPOINT,
  BUNDLED_NODE_COMMAND,
  BUNDLED_MEMORY_SERVER_SUMMARY,
  seedBundledMemoryServers,
} from '../../packages/runtime-core/src/mcp/bundled-memory';

const runtime = {
  platform: 'darwin',
  arch: 'arm64',
  rootDir: '/runtime',
  binDir: '/runtime/bin',
  node: { version: '24.20.0', executable: '/runtime/node/bin/node' },
  python: { version: '3.13.15', executable: '/runtime/python/bin/python3' },
  mcp: {
    memory: {
      package: '@modelcontextprotocol/server-memory',
      version: '2026.7.4',
      entrypoint: '/runtime/mcp/server-memory/index.mjs',
    },
  },
} satisfies BundledRuntimeSnapshot;

describe('Bundled Memory MCP 默认配置', () => {
  it('为两个用户各 seed 一条可移植、相互隔离的配置', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, STAGE45_MIGRATIONS, { clock: () => '2026-08-27T00:00:00.000Z' });
    const repos = new SqliteRepositories(db);
    repos.users.seedUsers('2026-08-27T00:00:00.000Z');

    seedBundledMemoryServers(repos, runtime, '2026-08-27T00:00:00.000Z');
    seedBundledMemoryServers(repos, runtime, '2026-08-27T00:00:01.000Z');

    for (const userId of ['user-a', 'user-b'] as const) {
      const servers = repos.mcp.listServers(userId);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        id: 'builtin-memory',
        name: 'memory',
        categoryId: 'memory',
        summary: BUNDLED_MEMORY_SERVER_SUMMARY,
        transport: 'stdio',
        status: 'enabled',
        config: {
          command: BUNDLED_NODE_COMMAND,
          args: [BUNDLED_MEMORY_ENTRYPOINT],
          env: { MEMORY_FILE_PATH: BUNDLED_MEMORY_DATA_FILE },
        },
      });
    }
    db.close();
  });

  it('回填内置服务的旧空简介，不覆盖用户自定义简介', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, STAGE45_MIGRATIONS, { clock: () => '2026-08-27T00:00:00.000Z' });
    const repos = new SqliteRepositories(db);
    repos.users.seedUsers('2026-08-27T00:00:00.000Z');

    for (const [userId, summary] of [
      ['user-a', ''],
      ['user-b', '用户自定义的记忆简介'],
    ] as const) {
      repos.mcp.createServer({
        id: 'builtin-memory',
        userId,
        name: 'memory',
        summary,
        transport: 'stdio',
        config: {
          command: BUNDLED_NODE_COMMAND,
          args: [BUNDLED_MEMORY_ENTRYPOINT],
          env: { MEMORY_FILE_PATH: BUNDLED_MEMORY_DATA_FILE },
        },
        credentialRef: null,
        enabled: true,
        now: '2026-08-27T00:00:00.000Z',
      });
    }

    seedBundledMemoryServers(repos, runtime, '2026-08-27T00:00:01.000Z');

    expect(repos.mcp.getServer('user-a', 'builtin-memory')?.summary).toBe(
      BUNDLED_MEMORY_SERVER_SUMMARY,
    );
    expect(repos.mcp.getServer('user-b', 'builtin-memory')?.summary).toBe(
      '用户自定义的记忆简介',
    );
    db.close();
  });

  it('归档后不自动恢复，尊重用户删除选择', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, STAGE45_MIGRATIONS, { clock: () => '2026-08-27T00:00:00.000Z' });
    const repos = new SqliteRepositories(db);
    repos.users.seedUsers('2026-08-27T00:00:00.000Z');
    seedBundledMemoryServers(repos, runtime, '2026-08-27T00:00:00.000Z');
    repos.mcp.archiveServer('user-a', 'builtin-memory', '2026-08-27T00:00:01.000Z');

    seedBundledMemoryServers(repos, runtime, '2026-08-27T00:00:02.000Z');

    expect(repos.mcp.listServers('user-a')).toEqual([]);
    expect(repos.mcp.listServers('user-b')).toHaveLength(1);
    db.close();
  });
});
