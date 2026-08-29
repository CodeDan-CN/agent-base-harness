import type { BundledRuntimeSnapshot } from '../../infrastructure/runtime/bundled-runtime-registry';
import type { SqliteRepositories } from '../../infrastructure/sqlite/repositories';

export const BUNDLED_MEMORY_SERVER_ID = 'builtin-memory';
export const BUNDLED_MEMORY_SERVER_NAME = 'memory';
export const BUNDLED_NODE_COMMAND = 'runtime://node';
export const BUNDLED_MEMORY_ENTRYPOINT = 'runtime://mcp/memory';
export const BUNDLED_MEMORY_DATA_FILE = 'runtime://mcp-data/memory.jsonl';

/**
 * 首次提供 Bundled Runtime 时为每个内置用户建立一条可删除的默认配置。
 * 已存在同名配置（包括已归档配置）时不恢复，尊重用户的编辑和删除选择。
 */
export function seedBundledMemoryServers(
  repos: SqliteRepositories,
  runtime: BundledRuntimeSnapshot | undefined,
  now: string,
): void {
  if (!runtime) return;
  for (const user of repos.users.listUsers()) {
    if (
      repos.mcp.getServer(user.id, BUNDLED_MEMORY_SERVER_ID) ||
      repos.mcp.getServerByName(user.id, BUNDLED_MEMORY_SERVER_NAME)
    ) {
      continue;
    }
    repos.mcp.createServer({
      id: BUNDLED_MEMORY_SERVER_ID,
      userId: user.id,
      name: BUNDLED_MEMORY_SERVER_NAME,
      summary: '提供本地知识图谱式长期记忆，可创建实体与关系并按关键词检索历史信息。',
      transport: 'stdio',
      config: {
        command: BUNDLED_NODE_COMMAND,
        args: [BUNDLED_MEMORY_ENTRYPOINT],
        env: { MEMORY_FILE_PATH: BUNDLED_MEMORY_DATA_FILE },
      },
      credentialRef: null,
      enabled: true,
      now,
    });
  }
}
