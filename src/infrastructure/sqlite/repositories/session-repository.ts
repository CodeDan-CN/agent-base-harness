import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import type {
  Session,
  SessionLogEvent,
  AppendCommand,
  AppendResult,
} from '../../../shared/domain/session';
import type { LocalUserId } from '../../../shared/domain/user';
import { DEFAULT_AGENT_ID, type SessionOrigin } from '../../../shared/domain/agent';
import { BridgeError } from '../../../shared/contracts/errors';
import {
  permissionPresetFromStorage,
  permissionPresetToStorage,
  type PermissionPreset,
  type StoredPermissionPreset,
} from '../../../shared/domain/permission';

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  status: 'active' | 'archived';
  permission_preset?: StoredPermissionPreset;
  agent_id?: string | null;
  origin?: SessionOrigin;
  parent_session_id?: string | null;
  next_seq: number;
  version: number;
  created_at: string;
  updated_at: string;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
}

interface EventRow {
  user_id: string;
  session_id: string;
  seq: number;
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  request_id: string | null;
  idempotency_key?: string | null;
  payload_json: string;
}

export class SessionRepository {
  private readonly hasRuntimeColumns: boolean;
  private readonly hasPermissionPresetColumn: boolean;
  private readonly hasUserPermissionPresetColumn: boolean;
  private readonly hasAgentScopeColumns: boolean;

  constructor(private readonly db: SqliteDatabase) {
    const eventColumns = this.db.prepare('PRAGMA table_info(session_events)').all() as Array<{
      name: string;
    }>;
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    const userColumns = this.db.prepare('PRAGMA table_info(local_users)').all() as Array<{
      name: string;
    }>;
    this.hasRuntimeColumns = eventColumns.some((column) => column.name === 'idempotency_key');
    this.hasPermissionPresetColumn = sessionColumns.some(
      (column) => column.name === 'permission_preset',
    );
    this.hasUserPermissionPresetColumn = userColumns.some(
      (column) => column.name === 'session_permission_preset',
    );
    this.hasAgentScopeColumns = sessionColumns.some((column) => column.name === 'agent_id');
  }

  createSession(input: {
    id: string;
    userId: LocalUserId;
    title: string;
    agentId: string;
    origin: SessionOrigin;
    parentSessionId: string | null;
    permissionPreset?: PermissionPreset;
    now: string;
  }): Session {
    const permissionPreset = input.permissionPreset ?? this.getUserPermissionPreset(input.userId);
    const session: Session = {
      id: input.id,
      userId: input.userId,
      title: input.title,
      status: 'active',
      permissionPreset,
      agentId: input.agentId,
      origin: input.origin,
      parentSessionId: input.parentSessionId,
      nextSeq: 1,
      version: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    try {
      if (this.hasPermissionPresetColumn && this.hasAgentScopeColumns) {
        this.db
          .prepare(
            `INSERT INTO sessions
               (id, user_id, title, status, permission_preset, agent_id, origin, parent_session_id,
                next_seq, version, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 1, 0, ?, ?)`,
          )
          .run(
            session.id,
            session.userId,
            session.title,
            permissionPresetToStorage(session.permissionPreset),
            session.agentId,
            session.origin,
            session.parentSessionId,
            session.createdAt,
            session.updatedAt,
          );
      } else if (this.hasPermissionPresetColumn) {
        this.db
          .prepare(
            `INSERT INTO sessions
               (id, user_id, title, status, permission_preset, next_seq, version, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, 1, 0, ?, ?)`,
          )
          .run(
            session.id,
            session.userId,
            session.title,
            permissionPresetToStorage(session.permissionPreset),
            session.createdAt,
            session.updatedAt,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO sessions (id, user_id, title, status, next_seq, version, created_at, updated_at)
             VALUES (?, ?, ?, 'active', 1, 0, ?, ?)`,
          )
          .run(session.id, session.userId, session.title, session.createdAt, session.updatedAt);
      }
    } catch (err) {
      throw mapSqliteError(err);
    }
    return session;
  }

  getSession(userId: LocalUserId, id: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND id = ?')
      .get(userId, id) as SessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  listSessions(userId: LocalUserId): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as SessionRow[];
    return rows.map((r) => this.mapSession(r));
  }

  listByAgent(
    userId: LocalUserId,
    agentId: string,
    origin: SessionOrigin = 'direct',
    limit = 50,
    offset = 0,
  ): Session[] {
    if (!this.hasAgentScopeColumns) {
      return agentId === DEFAULT_AGENT_ID && origin === 'direct'
        ? this.listSessions(userId)
            .filter((session) => session.status === 'active')
            .slice(offset, offset + limit)
        : [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE user_id = ? AND agent_id = ? AND origin = ? AND status = 'active'
         ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(userId, agentId, origin, limit, offset) as SessionRow[];
    return rows.map((row) => this.mapSession(row));
  }

  /**
   * Agent runtime defaults apply to direct sessions owned by that Agent.
   * Delegated sessions intentionally keep their narrower, captured preset.
   */
  setPermissionPresetForAgent(
    userId: LocalUserId,
    agentId: string,
    preset: PermissionPreset,
    now: string,
  ): void {
    if (!this.hasPermissionPresetColumn || !this.hasAgentScopeColumns) return;
    this.db
      .prepare(
        `UPDATE sessions
         SET permission_preset = ?, updated_at = ?
         WHERE user_id = ? AND agent_id = ? AND origin = 'direct'`,
      )
      .run(permissionPresetToStorage(preset), now, userId, agentId);
  }

  append(cmd: AppendCommand): AppendResult {
    const { userId, sessionId, expectedVersion, events } = cmd;

    if (events.length === 0) {
      throw new BridgeError('INVALID_REQUEST', 'No events to append');
    }
    for (const event of events) {
      this.validateEvent(event);
    }

    try {
      const txn = this.db.transaction((): AppendResult => {
        const session = this.db
          .prepare('SELECT * FROM sessions WHERE user_id = ? AND id = ?')
          .get(userId, sessionId) as SessionRow | undefined;
        if (!session) {
          throw new BridgeError('INVALID_REQUEST', 'Session not found');
        }
        if (session.version !== expectedVersion) {
          throw new BridgeError('REVISION_CONFLICT', 'Session version conflict');
        }
        if (
          cmd.leaseOwner &&
          (session.lease_owner !== cmd.leaseOwner ||
            !session.lease_expires_at ||
            session.lease_expires_at <= (events[0]?.occurredAt ?? ''))
        ) {
          throw new BridgeError('SESSION_BUSY', 'Session execution lease was lost');
        }

        let seq = session.next_seq;
        const insert = this.hasRuntimeColumns
          ? this.db.prepare(
              `INSERT INTO session_events
                 (user_id, session_id, seq, event_id, event_type, schema_version, occurred_at,
                  request_id, idempotency_key, payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
          : this.db.prepare(
              `INSERT INTO session_events
                 (user_id, session_id, seq, event_id, event_type, schema_version, occurred_at,
                  request_id, payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
        for (const event of events) {
          const common = [
            userId,
            sessionId,
            seq,
            event.eventId,
            event.eventType,
            event.schemaVersion,
            event.occurredAt,
            event.requestId ?? null,
          ];
          if (this.hasRuntimeColumns) {
            insert.run(...common, event.idempotencyKey ?? null, JSON.stringify(event.payload));
          } else {
            insert.run(...common, JSON.stringify(event.payload));
          }
          seq += 1;
        }
        const newNextSeq = seq;
        const newVersion = session.version + events.length;
        const now = events[events.length - 1]?.occurredAt ?? session.updated_at;
        const permissionPreset = this.permissionPresetFrom(events);
        if (this.hasPermissionPresetColumn && permissionPreset) {
          this.db
            .prepare(
              `UPDATE sessions
               SET next_seq = ?, version = ?, updated_at = ?, permission_preset = ?
               WHERE user_id = ? AND id = ?`,
            )
            .run(
              newNextSeq,
              newVersion,
              now,
              permissionPresetToStorage(permissionPreset),
              userId,
              sessionId,
            );
          if (this.hasUserPermissionPresetColumn) {
            this.db
              .prepare(
                `UPDATE local_users
                 SET session_permission_preset = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(permissionPresetToStorage(permissionPreset), now, userId);
          }
        } else {
          this.db
            .prepare(
              'UPDATE sessions SET next_seq = ?, version = ?, updated_at = ? WHERE user_id = ? AND id = ?',
            )
            .run(newNextSeq, newVersion, now, userId, sessionId);
        }

        return {
          version: newVersion,
          nextSeq: newNextSeq,
          fromSeq: session.next_seq,
          toSeq: newNextSeq - 1,
        };
      });
      return txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  readEventsAfter(userId: LocalUserId, sessionId: string, afterSeq: number): SessionLogEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE user_id = ? AND session_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(userId, sessionId, afterSeq) as EventRow[];
    return rows.map((r) => this.mapEvent(r));
  }

  listEvents(userId: LocalUserId, sessionId: string): SessionLogEvent[] {
    return this.readEventsAfter(userId, sessionId, 0);
  }

  countEvents(userId: LocalUserId, sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM session_events WHERE user_id = ? AND session_id = ?')
      .get(userId, sessionId) as { c: number };
    return row.c;
  }

  findByIdempotencyKey(
    userId: LocalUserId,
    sessionId: string,
    idempotencyKey: string,
  ): SessionLogEvent | undefined {
    if (!this.hasRuntimeColumns) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE user_id = ? AND session_id = ? AND idempotency_key = ?`,
      )
      .get(userId, sessionId, idempotencyKey) as EventRow | undefined;
    return row ? this.mapEvent(row) : undefined;
  }

  renameSession(
    userId: LocalUserId,
    sessionId: string,
    title: string,
    expectedVersion: number,
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE sessions SET title = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND id = ? AND version = ?`,
      )
      .run(title, now, userId, sessionId, expectedVersion);
    if (result.changes !== 1) {
      const exists = this.getSession(userId, sessionId);
      if (exists) throw new BridgeError('REVISION_CONFLICT', 'Session version conflict');
      throw new BridgeError('INVALID_REQUEST', 'Session not found');
    }
  }

  archiveSession(userId: LocalUserId, sessionId: string, now: string): void {
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'archived', lease_owner = NULL, lease_expires_at = NULL,
         updated_at = ? WHERE user_id = ? AND id = ?`,
      )
      .run(now, userId, sessionId);
    if (result.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'Session not found');
  }

  acquireLease(input: {
    userId: LocalUserId;
    sessionId: string;
    owner: string;
    now: string;
    expiresAt: string;
  }): boolean {
    if (!this.hasRuntimeColumns) return false;
    const result = this.db
      .prepare(
        `UPDATE sessions SET lease_owner = ?, lease_expires_at = ?
         WHERE user_id = ? AND id = ? AND status = 'active'
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
      )
      .run(input.owner, input.expiresAt, input.userId, input.sessionId, input.owner, input.now);
    return result.changes === 1;
  }

  renewLease(input: {
    userId: LocalUserId;
    sessionId: string;
    owner: string;
    expiresAt: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE sessions SET lease_expires_at = ?
         WHERE user_id = ? AND id = ? AND lease_owner = ?`,
      )
      .run(input.expiresAt, input.userId, input.sessionId, input.owner);
    return result.changes === 1;
  }

  releaseLease(userId: LocalUserId, sessionId: string, owner: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET lease_owner = NULL, lease_expires_at = NULL
         WHERE user_id = ? AND id = ? AND lease_owner = ?`,
      )
      .run(userId, sessionId, owner);
  }

  clearLeaseForRecovery(userId: LocalUserId, sessionId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET lease_owner = NULL, lease_expires_at = NULL
         WHERE user_id = ? AND id = ?`,
      )
      .run(userId, sessionId);
  }

  private validateEvent(event: AppendCommand['events'][number]): void {
    if (!event.eventId || event.eventId.length === 0) {
      throw new BridgeError('INVALID_REQUEST', 'eventId is required');
    }
    if (!event.eventType || event.eventType.length === 0) {
      throw new BridgeError('INVALID_REQUEST', 'eventType is required');
    }
    if (event.schemaVersion <= 0) {
      throw new BridgeError('INVALID_REQUEST', 'schemaVersion must be positive');
    }
    try {
      JSON.stringify(event.payload);
    } catch {
      throw new BridgeError('INVALID_REQUEST', 'payload is not serializable');
    }
  }

  private permissionPresetFrom(events: AppendCommand['events']): PermissionPreset | undefined {
    let preset: PermissionPreset | undefined;
    for (const event of events) {
      if (event.eventType !== 'permission.preset.changed') continue;
      const payload = event.payload as { to?: unknown } | null;
      const next = payload && typeof payload === 'object' ? payload.to : undefined;
      if (next === 'approval-required' || next === 'guarded' || next === 'full-access') {
        preset = next;
      }
    }
    return preset;
  }

  private getUserPermissionPreset(userId: LocalUserId): PermissionPreset {
    if (!this.hasUserPermissionPresetColumn) return 'guarded';
    const row = this.db
      .prepare('SELECT session_permission_preset FROM local_users WHERE id = ?')
      .get(userId) as { session_permission_preset?: StoredPermissionPreset } | undefined;
    return permissionPresetFromStorage(row?.session_permission_preset);
  }

  private mapSession(row: SessionRow): Session {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      status: row.status,
      permissionPreset: permissionPresetFromStorage(row.permission_preset),
      agentId: row.agent_id ?? DEFAULT_AGENT_ID,
      origin: row.origin ?? 'direct',
      parentSessionId: row.parent_session_id ?? null,
      nextSeq: row.next_seq,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEvent(row: EventRow): SessionLogEvent {
    const event: SessionLogEvent = {
      userId: row.user_id,
      sessionId: row.session_id,
      seq: row.seq,
      eventId: row.event_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      requestId: row.request_id,
      payload: JSON.parse(row.payload_json) as unknown,
    };
    if (row.idempotency_key != null) event.idempotencyKey = row.idempotency_key;
    return event;
  }
}
