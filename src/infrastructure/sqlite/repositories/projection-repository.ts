import type { LocalUserId } from '../../../shared/domain/user';
import type { SessionLogEvent } from '../../../shared/domain/session';
import type { SqliteDatabase } from '../connection';
import { projectRuntime } from '../../../client-contracts/projection';
import { estimateTextTokens } from '../../../runtime/context-projector';

export interface ConversationEventView {
  eventId: string;
  title: string;
  status: string;
  summary: string | null;
  summaryVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class ProjectionRepository {
  private readonly hasSessionMemoryTable: boolean;

  constructor(private readonly db: SqliteDatabase) {
    this.hasSessionMemoryTable =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_memory_summaries'",
        )
        .get() !== undefined;
  }

  applyBatch(
    userId: LocalUserId,
    sessionId: string,
    events: readonly SessionLogEvent[],
    now: string,
  ): void {
    if (events.length === 0) return;
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        const payload = record(event.payload);
        const eventId = stringAt(payload, 'eventId');
        switch (event.eventType) {
          case 'conversation.event.created':
            if (eventId) {
              this.db
                .prepare(
                  `INSERT INTO conversation_events
                    (id, user_id, session_id, status, title, summary,
                     summary_through_exchange_seq, summary_tokens, summary_version,
                     exchange_count, created_at, updated_at, completed_at)
                   VALUES (?, ?, ?, 'open', ?, NULL, 0, 0, 0, 0, ?, ?, NULL)`,
                )
                .run(
                  eventId,
                  userId,
                  sessionId,
                  stringAt(payload, 'title') ?? '',
                  event.occurredAt,
                  event.occurredAt,
                );
            }
            break;
          case 'conversation.event.status-changed': {
            const status = stringAt(payload, 'status');
            if (eventId && status) {
              this.db
                .prepare(
                  `UPDATE conversation_events SET status = ?, updated_at = ?,
                   completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END
                   WHERE user_id = ? AND session_id = ? AND id = ?`,
                )
                .run(
                  status,
                  event.occurredAt,
                  status,
                  event.occurredAt,
                  userId,
                  sessionId,
                  eventId,
                );
            }
            break;
          }
          case 'conversation.event.summary-updated':
          case 'compaction.summary-updated': {
            const summary = stringAt(payload, 'summary');
            const coveredThroughSeq = numberAt(payload, 'coveredThroughSeq');
            if (eventId && summary !== undefined && coveredThroughSeq !== undefined) {
              const covered = this.db
                .prepare(
                  `SELECT COUNT(*) AS count FROM conversation_exchanges
                   WHERE user_id = ? AND event_id = ?
                     AND user_visible_through_seq IS NOT NULL
                     AND user_visible_through_seq <= ?`,
                )
                .get(userId, eventId, coveredThroughSeq) as { count: number };
              this.db
                .prepare(
                  `UPDATE conversation_events SET summary = ?, summary_through_exchange_seq = ?,
                   summary_tokens = ?, summary_version = ?, updated_at = ?
                   WHERE user_id = ? AND session_id = ? AND id = ?`,
                )
                .run(
                  summary,
                  covered.count,
                  estimateTextTokens(summary),
                  numberAt(payload, 'summaryVersion') ?? 0,
                  event.occurredAt,
                  userId,
                  sessionId,
                  eventId,
                );
            }
            break;
          }
          case 'conversation.event.related': {
            const relatedEventId = stringAt(payload, 'relatedEventId');
            const relationType = stringAt(payload, 'relationType');
            if (eventId && relatedEventId && relationType) {
              this.db
                .prepare(
                  `INSERT OR IGNORE INTO conversation_event_relations
                    (user_id, source_event_id, target_event_id, relation, created_at)
                   VALUES (?, ?, ?, ?, ?)`,
                )
                .run(userId, eventId, relatedEventId, relationType, event.occurredAt);
            }
            break;
          }
          case 'session.memory.summary-updated': {
            if (!this.hasSessionMemoryTable) break;
            const summary = stringAt(payload, 'summary');
            const coveredThroughSeq = numberAt(payload, 'coveredThroughSeq');
            const summaryVersion = numberAt(payload, 'summaryVersion');
            const summaryTokens = numberAt(payload, 'summaryTokens');
            if (
              summary !== undefined &&
              coveredThroughSeq !== undefined &&
              summaryVersion !== undefined &&
              summaryTokens !== undefined
            ) {
              this.db
                .prepare(
                  `INSERT INTO session_memory_summaries
                    (user_id, session_id, summary, covered_through_session_seq, summary_tokens,
                     summary_version, input_tokens, output_tokens, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id, session_id) DO UPDATE SET
                     summary = excluded.summary,
                     covered_through_session_seq = excluded.covered_through_session_seq,
                     summary_tokens = excluded.summary_tokens,
                     summary_version = excluded.summary_version,
                     input_tokens = excluded.input_tokens,
                     output_tokens = excluded.output_tokens,
                     updated_at = excluded.updated_at`,
                )
                .run(
                  userId,
                  sessionId,
                  summary,
                  coveredThroughSeq,
                  summaryTokens,
                  summaryVersion,
                  numberAt(payload, 'inputTokens') ?? 0,
                  numberAt(payload, 'outputTokens') ?? 0,
                  event.occurredAt,
                );
            }
            break;
          }
          case 'conversation.exchange.started': {
            const exchangeId = stringAt(payload, 'exchangeId');
            const turnId = stringAt(payload, 'turnId');
            if (eventId && exchangeId && turnId) {
              const ordinal = this.db
                .prepare(
                  `SELECT COUNT(*) + 1 AS ordinal FROM conversation_exchanges
                   WHERE user_id = ? AND event_id = ?`,
                )
                .get(userId, eventId) as { ordinal: number };
              this.db
                .prepare(
                  `INSERT INTO conversation_exchanges
                    (id, user_id, event_id, exchange_seq, execution_turn_id, status,
                     user_visible_from_seq, user_visible_through_seq, created_at, completed_at)
                   VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL)`,
                )
                .run(exchangeId, userId, eventId, ordinal.ordinal, turnId, event.occurredAt);
              this.db
                .prepare(
                  `UPDATE conversation_events SET exchange_count = exchange_count + 1,
                   updated_at = ? WHERE user_id = ? AND id = ?`,
                )
                .run(event.occurredAt, userId, eventId);
            }
            break;
          }
          case 'user.message':
          case 'assistant.message': {
            const turnId = stringAt(payload, 'turnId');
            if (turnId) {
              this.db
                .prepare(
                  `UPDATE conversation_exchanges SET
                   user_visible_from_seq = COALESCE(user_visible_from_seq, ?),
                   user_visible_through_seq = ?
                   WHERE user_id = ? AND execution_turn_id = ?`,
                )
                .run(event.seq, event.seq, userId, turnId);
            }
            break;
          }
          case 'conversation.exchange.completed': {
            const exchangeId = stringAt(payload, 'exchangeId');
            const status = stringAt(payload, 'status');
            if (exchangeId && status) {
              const projectedStatus = status === 'cancelled' ? 'failed' : status;
              this.db
                .prepare(
                  `UPDATE conversation_exchanges SET status = ?, completed_at = ?
                   WHERE user_id = ? AND id = ?`,
                )
                .run(projectedStatus, event.occurredAt, userId, exchangeId);
            }
            break;
          }
        }
      }
      this.db
        .prepare(
          `INSERT INTO projection_checkpoints
            (user_id, session_id, projection, through_seq, schema_version, updated_at)
           VALUES (?, ?, 'runtime', ?, 1, ?)
           ON CONFLICT(user_id, session_id, projection) DO UPDATE SET
             through_seq = excluded.through_seq,
             schema_version = excluded.schema_version,
             updated_at = excluded.updated_at`,
        )
        .run(userId, sessionId, events.at(-1)?.seq ?? 0, now);
    });
    transaction();
  }

  rebuild(
    userId: LocalUserId,
    sessionId: string,
    events: readonly SessionLogEvent[],
    now: string,
  ): void {
    const projection = projectRuntime(events);
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM conversation_exchanges WHERE user_id = ? AND event_id IN
           (SELECT id FROM conversation_events WHERE user_id = ? AND session_id = ?)`,
        )
        .run(userId, userId, sessionId);
      this.db
        .prepare(
          `DELETE FROM conversation_event_relations WHERE user_id = ? AND source_event_id IN
           (SELECT id FROM conversation_events WHERE user_id = ? AND session_id = ?)`,
        )
        .run(userId, userId, sessionId);
      this.db
        .prepare('DELETE FROM conversation_events WHERE user_id = ? AND session_id = ?')
        .run(userId, sessionId);
      if (this.hasSessionMemoryTable) {
        this.db
          .prepare('DELETE FROM session_memory_summaries WHERE user_id = ? AND session_id = ?')
          .run(userId, sessionId);
      }

      const insertEvent = this.db.prepare(
        `INSERT INTO conversation_events
          (id, user_id, session_id, status, title, summary, summary_through_exchange_seq,
           summary_tokens, summary_version, exchange_count, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of projection.events.values()) {
        const eventTurns = [...projection.turns.values()].filter(
          (turn) => turn.eventId === event.id,
        );
        const coveredExchangeCount = eventTurns.filter((turn) => {
          const throughSeq = projection.messages
            .filter((message) => message.turnId === turn.id)
            .at(-1)?.seq;
          return throughSeq !== undefined && throughSeq <= event.summaryThroughSeq;
        }).length;
        insertEvent.run(
          event.id,
          userId,
          sessionId,
          event.status,
          event.title,
          event.summary,
          coveredExchangeCount,
          event.summary ? estimateTextTokens(event.summary) : 0,
          event.summaryVersion,
          eventTurns.length,
          event.createdAt,
          event.updatedAt,
          event.status === 'open' || event.status === 'awaiting_user' ? null : event.updatedAt,
        );
      }

      const insertRelation = this.db.prepare(
        `INSERT INTO conversation_event_relations
          (user_id, source_event_id, target_event_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const relation of projection.relations) {
        insertRelation.run(
          userId,
          relation.eventId,
          relation.relatedEventId,
          relation.relationType,
          relation.createdAt,
        );
      }

      const ordinalByEvent = new Map<string, number>();
      const insertExchange = this.db.prepare(
        `INSERT INTO conversation_exchanges
          (id, user_id, event_id, exchange_seq, execution_turn_id, status,
           user_visible_from_seq, user_visible_through_seq, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const turn of projection.turns.values()) {
        const ordinal = (ordinalByEvent.get(turn.eventId) ?? 0) + 1;
        ordinalByEvent.set(turn.eventId, ordinal);
        insertExchange.run(
          turn.exchangeId,
          userId,
          turn.eventId,
          ordinal,
          turn.id,
          turn.status === 'running' ? 'open' : turn.status === 'cancelled' ? 'failed' : turn.status,
          projection.messages.find((message) => message.turnId === turn.id)?.seq ?? null,
          projection.messages.filter((message) => message.turnId === turn.id).at(-1)?.seq ?? null,
          turn.startedAt,
          turn.endedAt,
        );
      }

      if (this.hasSessionMemoryTable && projection.sessionMemorySummary) {
        const summary = projection.sessionMemorySummary;
        this.db
          .prepare(
            `INSERT INTO session_memory_summaries
              (user_id, session_id, summary, covered_through_session_seq, summary_tokens,
               summary_version, input_tokens, output_tokens, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            sessionId,
            summary.summary,
            summary.coveredThroughSeq,
            summary.summaryTokens,
            summary.summaryVersion,
            summary.inputTokens,
            summary.outputTokens,
            summary.updatedAt,
          );
      }

      this.db
        .prepare(
          `INSERT INTO projection_checkpoints
            (user_id, session_id, projection, through_seq, schema_version, updated_at)
           VALUES (?, ?, 'runtime', ?, 1, ?)
           ON CONFLICT(user_id, session_id, projection) DO UPDATE SET
             through_seq = excluded.through_seq,
             schema_version = excluded.schema_version,
             updated_at = excluded.updated_at`,
        )
        .run(userId, sessionId, projection.lastSeq, now);
    });
    transaction();
  }

  listConversationEvents(userId: LocalUserId, sessionId: string): ConversationEventView[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, status, summary, summary_version, created_at, updated_at
         FROM conversation_events WHERE user_id = ? AND session_id = ? ORDER BY updated_at DESC`,
      )
      .all(userId, sessionId) as Array<{
      id: string;
      title: string;
      status: string;
      summary: string | null;
      summary_version: number;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.id,
      title: row.title,
      status: row.status,
      summary: row.summary,
      summaryVersion: row.summary_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === 'string' ? found : undefined;
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}
