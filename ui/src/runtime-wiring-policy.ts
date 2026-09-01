import type { SessionLogEvent } from '@client-contracts';

export type InputSubmissionMode = 'queue' | 'steer';

/**
 * Renderer 只决定用户当下的交互意图，ConversationEvent 的最终归属仍由 Runtime 负责。
 * 空闲追问默认延续最近事项；运行中显式排队代表下一事项；steer 永远继承当前事项。
 */
export function deriveInputSubmissionPolicy(
  mode: InputSubmissionMode,
  hasActiveTurn: boolean,
): { mode: InputSubmissionMode; startNewEvent: boolean } {
  return {
    mode,
    startNewEvent: mode === 'queue' && hasActiveTurn,
  };
}

const SESSION_LIST_REFRESH_EVENTS = new Set<SessionLogEvent['eventType']>([
  'agent.inbox.spliced',
  'turn.started',
  'turn.ended',
  'interaction.requested',
  'interaction.resolved',
  'approval.requested',
  'approval.resolved',
  'permission.preset.changed',
]);

/** 流式 chunk 和 Step 细节只更新当前 Projection，不应逐条重查 session.list。 */
export function shouldRefreshSessionList(events: readonly SessionLogEvent[]): boolean {
  return events.some((event) => SESSION_LIST_REFRESH_EVENTS.has(event.eventType));
}
