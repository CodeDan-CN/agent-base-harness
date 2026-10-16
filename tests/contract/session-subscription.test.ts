import { describe, expect, it } from 'vitest';
import { BridgeController } from '../../packages/server-core/src/legacy/bridge-controller';
import type { SessionLogEvent } from '../../packages/protocol/src/domain/session';
import type { SessionSubscriptionEvent } from '../../packages/protocol/src/contracts/ipc';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';

describe('Stage 2 Session Subscription cursor', () => {
  it('只发送连续增量并推进 cursor', () => {
    const received: SessionSubscriptionEvent[] = [];
    const controller = createController(received);
    controller.handleSubscribe('window-1', { kind: 'session', sessionId: 's1', afterSeq: 1 });
    controller.handleSessionEvents({
      userId: 'user-a',
      sessionId: 's1',
      fromSeq: 2,
      toSeq: 3,
      events: [event(2), event(3)],
    });
    controller.handleSessionEvents({
      userId: 'user-a',
      sessionId: 's1',
      fromSeq: 3,
      toSeq: 4,
      events: [event(3), event(4)],
    });
    expect(received).toMatchObject([
      { type: 'events', fromSeq: 2, toSeq: 3 },
      { type: 'events', fromSeq: 4, toSeq: 4 },
    ]);
  });

  it('发现断档时要求重取 Snapshot，且不转发其他用户事件', () => {
    const received: SessionSubscriptionEvent[] = [];
    const controller = createController(received);
    controller.handleSubscribe('window-1', { kind: 'session', sessionId: 's1', afterSeq: 2 });
    controller.handleSessionEvents({
      userId: 'user-b',
      sessionId: 's1',
      fromSeq: 3,
      toSeq: 3,
      events: [event(3, 'user-b')],
    });
    controller.handleSessionEvents({
      userId: 'user-a',
      sessionId: 's1',
      fromSeq: 5,
      toSeq: 5,
      events: [event(5)],
    });
    expect(received).toEqual([
      { type: 'resync-required', sessionId: 's1', expectedSeq: 3, receivedSeq: 5 },
    ]);
  });
});

function createController(received: SessionSubscriptionEvent[]): BridgeController {
  return new BridgeController({
    dispatcher: { request: async () => ({}), retry: async () => undefined },
    logger: new MemoryLogger(),
    isAuthorizedSender: () => true,
    sendLifecycle: () => undefined,
    sendSessionEvents: (_senderId, value) => received.push(value),
    generateRequestId: () => 'request-1',
  });
}

function event(seq: number, userId = 'user-a'): SessionLogEvent {
  return {
    userId,
    sessionId: 's1',
    seq,
    eventId: `event-${seq}`,
    eventType: 'test.event',
    schemaVersion: 1,
    occurredAt: '2025-01-01T00:00:00.000Z',
    requestId: null,
    payload: {},
  };
}
