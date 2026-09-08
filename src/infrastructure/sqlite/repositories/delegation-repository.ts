import type { SqliteDatabase } from '../connection';
import type { AgentDelegation, DelegationStatus } from '../../../shared/domain/agent';
import type { LocalUserId } from '../../../shared/domain/user';

interface DelegationRow {
  id: string;
  user_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  parent_tool_call_id: string;
  delegated_session_id: string;
  target_agent_id: string;
  status: DelegationStatus;
  deadline: string;
  result_event_ref: string | null;
  created_at: string;
  updated_at: string;
}

export class DelegationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(value: AgentDelegation): AgentDelegation {
    this.db
      .prepare(
        `INSERT INTO agent_delegations
           (id, user_id, parent_session_id, parent_turn_id, parent_tool_call_id,
            delegated_session_id, target_agent_id, status, deadline, result_event_ref,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.userId,
        value.parentSessionId,
        value.parentTurnId,
        value.parentToolCallId,
        value.delegatedSessionId,
        value.targetAgentId,
        value.status,
        value.deadline,
        value.resultEventRef,
        value.createdAt,
        value.updatedAt,
      );
    return value;
  }

  get(userId: LocalUserId, id: string): AgentDelegation | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_delegations WHERE user_id = ? AND id = ?')
      .get(userId, id) as DelegationRow | undefined;
    return row ? map(row) : undefined;
  }

  getByToolCall(userId: LocalUserId, toolCallId: string): AgentDelegation | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_delegations WHERE user_id = ? AND parent_tool_call_id = ?')
      .get(userId, toolCallId) as DelegationRow | undefined;
    return row ? map(row) : undefined;
  }

  getByDelegatedSession(
    userId: LocalUserId,
    delegatedSessionId: string,
  ): AgentDelegation | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_delegations WHERE user_id = ? AND delegated_session_id = ?')
      .get(userId, delegatedSessionId) as DelegationRow | undefined;
    return row ? map(row) : undefined;
  }

  countActiveForTurn(userId: LocalUserId, sessionId: string, turnId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_delegations
         WHERE user_id = ? AND parent_session_id = ? AND parent_turn_id = ?
           AND status IN ('accepted', 'running', 'awaiting_user')`,
      )
      .get(userId, sessionId, turnId) as { count: number };
    return row.count;
  }

  listNonTerminal(userId: LocalUserId): AgentDelegation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_delegations
           WHERE user_id = ? AND status IN ('accepted', 'running', 'awaiting_user')
           ORDER BY created_at, id`,
        )
        .all(userId) as DelegationRow[]
    ).map(map);
  }

  updateStatus(
    userId: LocalUserId,
    id: string,
    status: DelegationStatus,
    resultEventRef: string | null,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_delegations SET status = ?, result_event_ref = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .run(status, resultEventRef, now, userId, id);
  }
}

function map(row: DelegationRow): AgentDelegation {
  return {
    id: row.id,
    userId: row.user_id,
    parentSessionId: row.parent_session_id,
    parentTurnId: row.parent_turn_id,
    parentToolCallId: row.parent_tool_call_id,
    delegatedSessionId: row.delegated_session_id,
    targetAgentId: row.target_agent_id,
    status: row.status,
    deadline: row.deadline,
    resultEventRef: row.result_event_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
