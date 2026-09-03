import type { BundledRuntimeSnapshot } from '../../infrastructure/runtime/bundled-runtime-registry';
import type { SqliteRepositories } from '../../infrastructure/sqlite/repositories';

export const BUNDLED_MEMORY_SERVER_ID = 'builtin-memory';
export const BUNDLED_MEMORY_SERVER_NAME = 'memory';
export const BUNDLED_NODE_COMMAND = 'runtime://node';
export const BUNDLED_MEMORY_ENTRYPOINT = 'runtime://mcp/memory';
export const BUNDLED_MEMORY_DATA_FILE = 'runtime://mcp-data/memory.jsonl';
export const BUNDLED_MEMORY_SERVER_SUMMARY =
  '提供本地知识图谱式长期记忆，用于记住、跨会话保存和召回用户明确要求保留的偏好、事实、约束与工作流程。';

/**
 * 首次提供 Bundled Runtime 时为每个内置用户建立一条可删除的默认配置。
 * 旧的内置配置仅在简介为空时回填；同名、已编辑或已归档配置不覆盖。
 */
export function seedBundledMemoryServers(
  repos: SqliteRepositories,
  runtime: BundledRuntimeSnapshot | undefined,
  now: string,
): void {
  if (!runtime) return;
  for (const user of repos.users.listUsers()) {
    const bundled = repos.mcp.getServer(user.id, BUNDLED_MEMORY_SERVER_ID);
    if (bundled) {
      if (bundled.status !== 'archived' && bundled.summary.trim().length === 0) {
        repos.mcp.setServerSummary(
          user.id,
          BUNDLED_MEMORY_SERVER_ID,
          BUNDLED_MEMORY_SERVER_SUMMARY,
          now,
        );
      }
      continue;
    }
    if (repos.mcp.getServerByName(user.id, BUNDLED_MEMORY_SERVER_NAME)) {
      continue;
    }
    repos.mcp.createServer({
      id: BUNDLED_MEMORY_SERVER_ID,
      userId: user.id,
      name: BUNDLED_MEMORY_SERVER_NAME,
      summary: BUNDLED_MEMORY_SERVER_SUMMARY,
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
