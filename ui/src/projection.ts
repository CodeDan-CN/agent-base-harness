import { applyRuntimeEvent, cloneRuntimeProjection } from '@client-contracts';
import type { RuntimeProjection, SessionLogEvent } from '@client-contracts';
import type { SessionSnapshotPayload } from './types';

export function hydrateProjection(snapshot: SessionSnapshotPayload): RuntimeProjection {
  const turns = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
  return {
    lastSeq: snapshot.throughSeq,
    inbox: snapshot.inbox,
    events: new Map(snapshot.conversationEvents.map((event) => [event.id, event])),
    turns,
    messages: snapshot.messages,
    interactions: new Map(
      snapshot.interactions.map((interaction) => [interaction.id, interaction]),
    ),
    steps: new Map(snapshot.trajectory.steps.map((step) => [step.id, step])),
    toolCalls: new Map(snapshot.trajectory.toolCalls.map((call) => [call.id, call])),
    streams: new Map(snapshot.streaming.map((stream) => [stream.requestId, stream])),
    reasoning: new Map((snapshot.reasoning ?? []).map((stream) => [stream.requestId, stream])),
    relations: snapshot.relations,
    usage: snapshot.usage,
    sessionMemorySummary: snapshot.sessionMemorySummary ?? null,
    surfaceReplacements: snapshot.surfaceReplacements ?? [],
    activeTurn: snapshot.activeTurnId ? (turns.get(snapshot.activeTurnId) ?? null) : null,
  };
}

export function applyEventBatch(
  projection: RuntimeProjection,
  events: readonly SessionLogEvent[],
): RuntimeProjection {
  const next = cloneRuntimeProjection(projection);
  for (const event of events) applyRuntimeEvent(next, event);
  return next;
}
