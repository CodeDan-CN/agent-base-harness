import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import type {
  AgentBindings,
  AgentHomeItem,
  AgentMcpBinding,
  AgentProfile,
} from '../../../shared/domain/agent';
import { DEFAULT_AGENT_ID, DEFAULT_AGENT_NAME } from '../../../shared/domain/agent';
import type { LocalUserId } from '../../../shared/domain/user';
import { BridgeError } from '../../../shared/contracts/errors';
import {
  permissionPresetFromStorage,
  permissionPresetToStorage,
  type PermissionPreset,
  type StoredPermissionPreset,
} from '../../../shared/domain/permission';

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  avatar_key: string | null;
  instructions: string;
  default_model_id: string | null;
  permission_preset: StoredPermissionPreset;
  status: 'active' | 'archived';
  is_default: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface HomeRow {
  user_id: string;
  agent_id: string;
  sort_order: number;
  created_at: string;
}

export interface CreateAgentInput {
  id: string;
  userId: LocalUserId;
  name: string;
  description: string;
  avatarKey: string | null;
  instructions: string;
  defaultModelId: string | null;
  permissionPreset: PermissionPreset;
  expectedRevision: number;
  now: string;
}

export interface UpdateAgentInput extends Omit<CreateAgentInput, 'id' | 'userId'> {
  userId: LocalUserId;
  agentId: string;
  expectedProfileRevision: number;
}

export class AgentRepository {
  readonly hasSchema: boolean;

  constructor(private readonly db: SqliteDatabase) {
    this.hasSchema = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profiles'")
        .get(),
    );
  }

  ensureDylan(userId: LocalUserId, permissionPreset: PermissionPreset, now: string): AgentProfile {
    try {
      this.db.transaction(() => {
        const hasDefault = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM agent_profiles WHERE user_id = ? AND status = 'active' AND is_default = 1",
            )
            .get(userId),
        );
        const inserted = this.db
          .prepare(
            `INSERT INTO agent_profiles
               (id, user_id, name, description, avatar_key, instructions, default_model_id,
                permission_preset, status, is_default, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, '', NULL, ?, 'active', ?, 0, ?, ?)
             ON CONFLICT(user_id, id) DO NOTHING`,
          )
          .run(
            DEFAULT_AGENT_ID,
            userId,
            DEFAULT_AGENT_NAME,
            '默认通用智能体',
            permissionPresetToStorage(permissionPreset),
            hasDefault ? 0 : 1,
            now,
            now,
          );
        if (inserted.changes > 0) {
          this.db
            .prepare(
              `INSERT INTO agent_home_items (user_id, agent_id, sort_order, created_at)
               VALUES (?, ?, COALESCE((
                 SELECT MAX(h.sort_order) FROM agent_home_items h WHERE h.user_id = ?
               ), -1) + 1, ?)`,
            )
            .run(userId, DEFAULT_AGENT_ID, userId, now);
        }
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
    return this.require(userId, DEFAULT_AGENT_ID);
  }

  create(input: CreateAgentInput): AgentProfile {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(input.userId, input.expectedRevision);
        this.db
          .prepare(
            `INSERT INTO agent_profiles
               (id, user_id, name, description, avatar_key, instructions, default_model_id,
                permission_preset, status, is_default, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?)`,
          )
          .run(
            input.id,
            input.userId,
            input.name,
            input.description,
            input.avatarKey,
            input.instructions,
            input.defaultModelId,
            permissionPresetToStorage(input.permissionPreset),
            input.now,
            input.now,
          );
        this.bumpGlobalRevision(input.userId, input.now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
    return this.require(input.userId, input.id);
  }

  update(input: UpdateAgentInput): AgentProfile {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(input.userId, input.expectedRevision);
        const changed = this.db
          .prepare(
            `UPDATE agent_profiles
             SET name = ?, description = ?, avatar_key = ?, instructions = ?, default_model_id = ?,
                 permission_preset = ?, revision = revision + 1, updated_at = ?
             WHERE user_id = ? AND id = ? AND status = 'active' AND revision = ?`,
          )
          .run(
            input.name,
            input.description,
            input.avatarKey,
            input.instructions,
            input.defaultModelId,
            permissionPresetToStorage(input.permissionPreset),
            input.now,
            input.userId,
            input.agentId,
            input.expectedProfileRevision,
          );
        if (changed.changes !== 1) {
          const existing = this.get(input.userId, input.agentId);
          if (!existing || existing.status !== 'active') {
            throw new BridgeError('AGENT_NOT_FOUND', 'Agent not found');
          }
          throw new BridgeError('REVISION_CONFLICT', 'Agent revision conflict');
        }
        this.bumpGlobalRevision(input.userId, input.now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
    return this.require(input.userId, input.agentId);
  }

  archive(userId: LocalUserId, agentId: string, expectedRevision: number, now: string): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        const current = this.require(userId, agentId);
        if (current.status !== 'active')
          throw new BridgeError('AGENT_NOT_FOUND', 'Agent not found');
        if (current.isDefault) {
          throw new BridgeError('DEFAULT_AGENT_REQUIRED', 'Select another default agent first');
        }
        const active = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_profiles WHERE user_id = ? AND status = 'active'",
          )
          .get(userId) as { count: number };
        if (active.count <= 1) throw new BridgeError('LAST_ACTIVE_AGENT', 'Last active agent');
        this.db
          .prepare(
            `UPDATE agent_profiles
             SET status = 'archived', revision = revision + 1, updated_at = ?
             WHERE user_id = ? AND id = ?`,
          )
          .run(now, userId, agentId);
        this.db
          .prepare('DELETE FROM agent_home_items WHERE user_id = ? AND agent_id = ?')
          .run(userId, agentId);
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  setDefault(userId: LocalUserId, agentId: string, expectedRevision: number, now: string): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        const target = this.require(userId, agentId);
        if (target.status !== 'active') throw new BridgeError('AGENT_NOT_FOUND', 'Agent not found');
        this.db.prepare('UPDATE agent_profiles SET is_default = 0 WHERE user_id = ?').run(userId);
        this.db
          .prepare(
            `UPDATE agent_profiles
             SET is_default = 1, revision = revision + 1, updated_at = ?
             WHERE user_id = ? AND id = ?`,
          )
          .run(now, userId, agentId);
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  get(userId: LocalUserId, agentId: string): AgentProfile | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_profiles WHERE user_id = ? AND id = ?')
      .get(userId, agentId) as AgentRow | undefined;
    return row ? mapAgent(row) : undefined;
  }

  requireActive(userId: LocalUserId, agentId: string): AgentProfile {
    const agent = this.get(userId, agentId);
    if (!agent || agent.status !== 'active')
      throw new BridgeError('AGENT_NOT_FOUND', 'Agent not found');
    return agent;
  }

  getDefault(userId: LocalUserId): AgentProfile {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_profiles WHERE user_id = ? AND status = 'active' AND is_default = 1",
      )
      .get(userId) as AgentRow | undefined;
    if (!row) throw new BridgeError('DEFAULT_AGENT_REQUIRED', 'Default agent missing');
    return mapAgent(row);
  }

  list(userId: LocalUserId, includeArchived = false): AgentProfile[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_profiles
         WHERE user_id = ? ${includeArchived ? '' : "AND status = 'active'"}
         ORDER BY status ASC, name COLLATE NOCASE ASC, id ASC`,
      )
      .all(userId) as AgentRow[];
    return rows.map(mapAgent);
  }

  listHome(userId: LocalUserId): AgentHomeItem[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_home_items WHERE user_id = ? ORDER BY sort_order ASC')
        .all(userId) as HomeRow[]
    ).map((row) => ({
      userId: row.user_id,
      agentId: row.agent_id,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    }));
  }

  addHome(userId: LocalUserId, agentId: string, expectedRevision: number, now: string): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        this.requireActive(userId, agentId);
        const existing = this.db
          .prepare('SELECT 1 FROM agent_home_items WHERE user_id = ? AND agent_id = ?')
          .get(userId, agentId);
        if (existing) throw new BridgeError('AGENT_ALREADY_IN_HOME', 'Agent already in home');
        const row = this.db
          .prepare(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM agent_home_items WHERE user_id = ?',
          )
          .get(userId) as { next: number };
        this.db
          .prepare(
            'INSERT INTO agent_home_items (user_id, agent_id, sort_order, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(userId, agentId, row.next, now);
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  removeHome(userId: LocalUserId, agentId: string, expectedRevision: number, now: string): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        const changed = this.db
          .prepare('DELETE FROM agent_home_items WHERE user_id = ? AND agent_id = ?')
          .run(userId, agentId);
        if (changed.changes !== 1) throw new BridgeError('AGENT_NOT_IN_HOME', 'Agent not in home');
        this.compactHomeOrder(userId);
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  reorderHome(
    userId: LocalUserId,
    agentIds: readonly string[],
    expectedRevision: number,
    now: string,
  ): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        const current = this.listHome(userId)
          .map((item) => item.agentId)
          .sort();
        const requested = [...agentIds].sort();
        if (
          current.length !== requested.length ||
          current.some((agentId, index) => agentId !== requested[index])
        ) {
          throw new BridgeError('INVALID_REQUEST', 'Home order must contain every visible agent');
        }
        const offset = agentIds.length + 1;
        this.db
          .prepare('UPDATE agent_home_items SET sort_order = sort_order + ? WHERE user_id = ?')
          .run(offset, userId);
        const update = this.db.prepare(
          'UPDATE agent_home_items SET sort_order = ? WHERE user_id = ? AND agent_id = ?',
        );
        agentIds.forEach((agentId, index) => update.run(index, userId, agentId));
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  setSkillBinding(
    userId: LocalUserId,
    agentId: string,
    skillId: string,
    enabled: boolean,
    expectedRevision: number,
    now: string,
  ): void {
    this.mutateBinding(userId, agentId, expectedRevision, now, () => {
      this.db
        .prepare(
          `INSERT INTO agent_skill_bindings
             (user_id, agent_id, skill_id, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, agent_id, skill_id) DO UPDATE SET
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(userId, agentId, skillId, enabled ? 1 : 0, now, now);
    });
  }

  setMcpBinding(
    userId: LocalUserId,
    agentId: string,
    serverId: string,
    accessScope: 'user' | 'agent',
    enabled: boolean,
    expectedRevision: number,
    now: string,
  ): void {
    this.mutateBinding(userId, agentId, expectedRevision, now, () => {
      this.db
        .prepare(
          `INSERT INTO agent_mcp_bindings
             (user_id, agent_id, server_id, access_scope, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, agent_id, server_id, access_scope) DO UPDATE SET
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(userId, agentId, serverId, accessScope, enabled ? 1 : 0, now, now);
    });
  }

  setDelegateBinding(
    userId: LocalUserId,
    callerAgentId: string,
    calleeAgentId: string,
    enabled: boolean,
    expectedRevision: number,
    now: string,
  ): void {
    if (callerAgentId === calleeAgentId) {
      throw new BridgeError('DELEGATION_NOT_ALLOWED', 'Agent cannot call itself');
    }
    this.mutateBinding(userId, callerAgentId, expectedRevision, now, () => {
      this.requireActive(userId, calleeAgentId);
      this.db
        .prepare(
          `INSERT INTO agent_delegate_bindings
             (user_id, caller_agent_id, callee_agent_id, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, caller_agent_id, callee_agent_id) DO UPDATE SET
             enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(userId, callerAgentId, calleeAgentId, enabled ? 1 : 0, now, now);
    });
  }

  listBindings(userId: LocalUserId, agentId: string): AgentBindings {
    this.require(userId, agentId);
    const skillIds = (
      this.db
        .prepare(
          'SELECT skill_id FROM agent_skill_bindings WHERE user_id = ? AND agent_id = ? AND enabled = 1 ORDER BY skill_id',
        )
        .all(userId, agentId) as Array<{ skill_id: string }>
    ).map((row) => row.skill_id);
    const mcp = (
      this.db
        .prepare(
          `SELECT agent_id, server_id, access_scope, enabled FROM agent_mcp_bindings
           WHERE user_id = ? AND agent_id = ? AND enabled = 1
           ORDER BY server_id, access_scope`,
        )
        .all(userId, agentId) as Array<{
        agent_id: string;
        server_id: string;
        access_scope: 'user' | 'agent';
        enabled: number;
      }>
    ).map<AgentMcpBinding>((row) => ({
      agentId: row.agent_id,
      serverId: row.server_id,
      accessScope: row.access_scope,
      enabled: row.enabled === 1,
    }));
    const delegateAgentIds = (
      this.db
        .prepare(
          `SELECT callee_agent_id FROM agent_delegate_bindings
           WHERE user_id = ? AND caller_agent_id = ? AND enabled = 1
           ORDER BY callee_agent_id`,
        )
        .all(userId, agentId) as Array<{ callee_agent_id: string }>
    ).map((row) => row.callee_agent_id);
    return { skillIds, mcp, delegateAgentIds };
  }

  canDelegate(userId: LocalUserId, callerAgentId: string, calleeAgentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM agent_delegate_bindings b
           JOIN agent_profiles p ON p.user_id = b.user_id AND p.id = b.callee_agent_id
           WHERE b.user_id = ? AND b.caller_agent_id = ? AND b.callee_agent_id = ?
             AND b.enabled = 1 AND p.status = 'active'`,
        )
        .get(userId, callerAgentId, calleeAgentId),
    );
  }

  ensureMcpBinding(
    userId: LocalUserId,
    agentId: string,
    serverId: string,
    accessScope: 'user' | 'agent',
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `INSERT INTO agent_mcp_bindings
           (user_id, agent_id, server_id, access_scope, enabled, created_at, updated_at)
         SELECT ?, ?, ?, ?, 1, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_profiles WHERE user_id = ? AND id = ? AND status = 'active'
         ) AND EXISTS (
           SELECT 1 FROM mcp_servers WHERE user_id = ? AND id = ? AND status <> 'archived'
         )
         ON CONFLICT(user_id, agent_id, server_id, access_scope) DO NOTHING`,
      )
      .run(userId, agentId, serverId, accessScope, now, now, userId, agentId, userId, serverId);
    if (result.changes > 0) this.bumpGlobalRevision(userId, now);
  }

  ensureSkillBinding(userId: LocalUserId, agentId: string, skillId: string, now: string): void {
    const result = this.db
      .prepare(
        `INSERT INTO agent_skill_bindings
           (user_id, agent_id, skill_id, enabled, created_at, updated_at)
         SELECT ?, ?, ?, 1, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_profiles WHERE user_id = ? AND id = ? AND status = 'active'
         ) AND EXISTS (
           SELECT 1 FROM skill_installations WHERE user_id = ? AND id = ? AND status <> 'deleted'
         )
         ON CONFLICT(user_id, agent_id, skill_id) DO NOTHING`,
      )
      .run(userId, agentId, skillId, now, now, userId, agentId, userId, skillId);
    if (result.changes > 0) this.bumpGlobalRevision(userId, now);
  }

  private mutateBinding(
    userId: LocalUserId,
    agentId: string,
    expectedRevision: number,
    now: string,
    mutate: () => void,
  ): void {
    try {
      this.db.transaction(() => {
        this.assertGlobalRevision(userId, expectedRevision);
        this.requireActive(userId, agentId);
        mutate();
        this.bumpGlobalRevision(userId, now);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private require(userId: LocalUserId, agentId: string): AgentProfile {
    const agent = this.get(userId, agentId);
    if (!agent) throw new BridgeError('AGENT_NOT_FOUND', 'Agent not found');
    return agent;
  }

  private assertGlobalRevision(userId: LocalUserId, expectedRevision: number): void {
    const row = this.db
      .prepare('SELECT agent_revision FROM user_config_revisions WHERE user_id = ?')
      .get(userId) as { agent_revision: number } | undefined;
    if (!row || row.agent_revision !== expectedRevision) {
      throw new BridgeError('REVISION_CONFLICT', 'Agent configuration revision conflict');
    }
  }

  private bumpGlobalRevision(userId: LocalUserId, now: string): void {
    this.db
      .prepare(
        `UPDATE user_config_revisions
         SET agent_revision = agent_revision + 1, updated_at = ? WHERE user_id = ?`,
      )
      .run(now, userId);
  }

  private compactHomeOrder(userId: LocalUserId): void {
    const rows = this.listHome(userId);
    const offset = rows.length + 1;
    this.db
      .prepare('UPDATE agent_home_items SET sort_order = sort_order + ? WHERE user_id = ?')
      .run(offset, userId);
    const update = this.db.prepare(
      'UPDATE agent_home_items SET sort_order = ? WHERE user_id = ? AND agent_id = ?',
    );
    rows.forEach((row, index) => update.run(index, userId, row.agentId));
  }
}

function mapAgent(row: AgentRow): AgentProfile {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    avatarKey: row.avatar_key,
    instructions: row.instructions,
    defaultModelId: row.default_model_id,
    permissionPreset: permissionPresetFromStorage(row.permission_preset),
    status: row.status,
    isDefault: row.is_default === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
