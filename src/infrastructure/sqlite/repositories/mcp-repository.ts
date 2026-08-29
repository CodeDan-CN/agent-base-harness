import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import type {
  McpConnectionStatus,
  McpServer,
  McpServerConfig,
  McpToolCatalogEntry,
} from '../../../shared/domain/mcp';
import type { LocalUserId } from '../../../shared/domain/user';
import { BridgeError } from '../../../shared/contracts/errors';

interface ServerRow {
  id: string;
  user_id: string;
  name: string;
  summary: string;
  transport: McpServer['transport'];
  status: McpServer['status'];
  config_json: string;
  credential_ref: string | null;
  connection_status: McpConnectionStatus;
  generation: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ToolRow {
  user_id: string;
  server_id: string;
  raw_name: string;
  public_name: string;
  description: string;
  input_schema_json: string;
  output_schema_json: string | null;
  schema_digest: string;
  enabled: number;
  review_status: McpToolCatalogEntry['reviewStatus'];
  generation: number;
  discovered_at: string;
  updated_at: string;
}

export class McpRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listServers(userId: LocalUserId): McpServer[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM mcp_servers
           WHERE user_id = ? AND status <> 'archived'
           ORDER BY created_at ASC`,
        )
        .all(userId) as ServerRow[]
    ).map(mapServer);
  }

  getServer(userId: LocalUserId, id: string): McpServer | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?')
      .get(userId, id) as ServerRow | undefined;
    return row ? mapServer(row) : undefined;
  }

  getServerByName(userId: LocalUserId, name: string): McpServer | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND name = ?')
      .get(userId, name) as ServerRow | undefined;
    return row ? mapServer(row) : undefined;
  }

  createServer(input: {
    id: string;
    userId: LocalUserId;
    name: string;
    summary: string;
    transport: McpServer['transport'];
    config: McpServerConfig;
    credentialRef: string | null;
    enabled: boolean;
    now: string;
  }): void {
    try {
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO mcp_servers
             (id, user_id, name, summary, transport, status, config_json, credential_ref,
              connection_status, generation, last_error, created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', 0, NULL, ?, ?, NULL)`,
          )
          .run(
            input.id,
            input.userId,
            input.name,
            input.summary,
            input.transport,
            input.enabled ? 'enabled' : 'disabled',
            JSON.stringify(input.config),
            input.credentialRef,
            input.now,
            input.now,
          );
        this.bumpRevision(input.userId, input.now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  updateServer(
    userId: LocalUserId,
    id: string,
    patch: {
      name: string;
      summary: string;
      transport: McpServer['transport'];
      config: McpServerConfig;
      credentialRef: string | null;
      enabled: boolean;
    },
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE mcp_servers
             SET name = ?, summary = ?, transport = ?, config_json = ?, credential_ref = ?,
                 status = ?, connection_status = 'disconnected', last_error = NULL, updated_at = ?
             WHERE user_id = ? AND id = ? AND status <> 'archived'`,
          )
          .run(
            patch.name,
            patch.summary,
            patch.transport,
            JSON.stringify(patch.config),
            patch.credentialRef,
            patch.enabled ? 'enabled' : 'disabled',
            now,
            userId,
            id,
          );
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'MCP server not found');
        this.bumpRevision(userId, now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  archiveServer(userId: LocalUserId, id: string, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE mcp_servers
             SET status = 'archived', connection_status = 'disconnected',
                 archived_at = ?, updated_at = ?
             WHERE user_id = ? AND id = ? AND status <> 'archived'`,
          )
          .run(now, now, userId, id);
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'MCP server not found');
        this.bumpRevision(userId, now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  setConnectionStatus(
    userId: LocalUserId,
    id: string,
    status: McpConnectionStatus,
    generation: number,
    error: string | null,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE mcp_servers
         SET connection_status = ?, generation = ?, last_error = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .run(status, generation, error, now, userId, id);
  }

  setServerSummary(userId: LocalUserId, id: string, summary: string, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE mcp_servers
             SET summary = ?, updated_at = ?
             WHERE user_id = ? AND id = ? AND status <> 'archived'`,
          )
          .run(summary, now, userId, id);
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'MCP server not found');
        this.bumpRevision(userId, now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  listTools(userId: LocalUserId, serverId?: string): McpToolCatalogEntry[] {
    const rows = serverId
      ? (this.db
          .prepare(
            `SELECT * FROM mcp_tools
             WHERE user_id = ? AND server_id = ?
             ORDER BY public_name ASC`,
          )
          .all(userId, serverId) as ToolRow[])
      : (this.db
          .prepare('SELECT * FROM mcp_tools WHERE user_id = ? ORDER BY public_name ASC')
          .all(userId) as ToolRow[]);
    return rows.map(mapTool);
  }

  replaceDiscoveredTools(
    userId: LocalUserId,
    serverId: string,
    generation: number,
    tools: readonly Omit<
      McpToolCatalogEntry,
      | 'userId'
      | 'serverId'
      | 'enabled'
      | 'reviewStatus'
      | 'generation'
      | 'discoveredAt'
      | 'updatedAt'
    >[],
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const existing = new Map(
          this.listTools(userId, serverId).map((tool) => [tool.rawName, tool] as const),
        );
        const keep = new Set<string>();
        const upsert = this.db.prepare(
          `INSERT INTO mcp_tools
           (user_id, server_id, raw_name, public_name, description, input_schema_json,
            output_schema_json, schema_digest, enabled, review_status, generation,
            discovered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)
           ON CONFLICT(user_id, server_id, raw_name) DO UPDATE SET
             public_name = excluded.public_name,
             description = excluded.description,
             input_schema_json = excluded.input_schema_json,
             output_schema_json = excluded.output_schema_json,
             schema_digest = excluded.schema_digest,
             enabled = CASE
               WHEN mcp_tools.schema_digest = excluded.schema_digest THEN mcp_tools.enabled
               ELSE 0
             END,
             review_status = CASE
               WHEN mcp_tools.schema_digest = excluded.schema_digest THEN mcp_tools.review_status
               ELSE 'changed'
             END,
             generation = excluded.generation,
             discovered_at = excluded.discovered_at,
             updated_at = excluded.updated_at`,
        );
        for (const tool of tools) {
          keep.add(tool.rawName);
          upsert.run(
            userId,
            serverId,
            tool.rawName,
            tool.publicName,
            tool.description,
            JSON.stringify(tool.inputSchema),
            tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
            tool.schemaDigest,
            generation,
            now,
            now,
          );
        }
        for (const rawName of existing.keys()) {
          if (!keep.has(rawName)) {
            this.db
              .prepare('DELETE FROM mcp_tools WHERE user_id = ? AND server_id = ? AND raw_name = ?')
              .run(userId, serverId, rawName);
          }
        }
        this.bumpRevision(userId, now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  setToolEnabled(
    userId: LocalUserId,
    serverId: string,
    rawName: string,
    enabled: boolean,
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE mcp_tools
             SET enabled = ?, review_status = ?, updated_at = ?
             WHERE user_id = ? AND server_id = ? AND raw_name = ?`,
          )
          .run(enabled ? 1 : 0, enabled ? 'approved' : 'pending', now, userId, serverId, rawName);
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'MCP tool not found');
        this.bumpRevision(userId, now);
      });
      txn();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private bumpRevision(userId: LocalUserId, now: string): void {
    this.db
      .prepare(
        `UPDATE user_config_revisions
         SET mcp_revision = mcp_revision + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(now, userId);
  }
}

function mapServer(row: ServerRow): McpServer {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    summary: row.summary,
    transport: row.transport,
    status: row.status,
    config: JSON.parse(row.config_json) as McpServerConfig,
    credentialRef: row.credential_ref,
    connectionStatus: row.connection_status,
    generation: row.generation,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapTool(row: ToolRow): McpToolCatalogEntry {
  return {
    userId: row.user_id,
    serverId: row.server_id,
    rawName: row.raw_name,
    publicName: row.public_name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
    outputSchema: row.output_schema_json
      ? (JSON.parse(row.output_schema_json) as Record<string, unknown>)
      : null,
    schemaDigest: row.schema_digest,
    enabled: row.enabled === 1,
    reviewStatus: row.review_status,
    generation: row.generation,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}
