import { randomUUID } from 'node:crypto';
import { BridgeError } from '../shared/contracts/errors';
import type {
  LifecycleEvent,
  SessionEventBatch,
  SessionSubscriptionEvent,
} from '../shared/contracts/ipc';
import {
  MAX_REQUEST_BYTES,
  commandRequestSchema,
  queryParamsSchema,
  queryRequestSchema,
  runtimeResponseSchema,
} from '../shared/contracts/schemas';
import { bootstrapResultSchema } from '../shared/contracts/bootstrap';
import { healthSnapshotSchema } from '../shared/contracts/health';
import { isBuiltinUser } from '../shared/domain/user';
import type { Logger } from '../infrastructure/logging/logger';

export interface RequestDispatcher {
  request(input: {
    requestId: string;
    userId: string;
    windowId: string;
    method: string;
    params?: unknown;
  }): Promise<unknown>;
  retry(): Promise<void>;
}

export interface BridgeControllerDeps {
  dispatcher: RequestDispatcher;
  logger: Logger;
  isAuthorizedSender: (senderId: string) => boolean;
  sendLifecycle: (event: LifecycleEvent) => void;
  sendSessionEvents?: (senderId: string, event: SessionSubscriptionEvent) => void;
  generateRequestId?: () => string;
}

export class BridgeController {
  private readonly dispatcher: RequestDispatcher;
  private readonly logger: Logger;
  private readonly isAuthorizedSender: (senderId: string) => boolean;
  private readonly sendLifecycle: (event: LifecycleEvent) => void;
  private readonly generateRequestId: () => string;
  private readonly sendSessionEvents: (senderId: string, event: SessionSubscriptionEvent) => void;
  private readonly subscribers = new Set<string>();
  private readonly sessionSubscribers = new Map<string, { sessionId: string; cursor: number }>();
  private activeUserId = 'user-a';
  private userEpoch = 0;

  constructor(deps: BridgeControllerDeps) {
    this.dispatcher = deps.dispatcher;
    this.logger = deps.logger;
    this.isAuthorizedSender = deps.isAuthorizedSender;
    this.sendLifecycle = deps.sendLifecycle;
    this.generateRequestId = deps.generateRequestId ?? randomUUID;
    this.sendSessionEvents = deps.sendSessionEvents ?? (() => undefined);
  }

  syncActiveUser(userId: string): void {
    this.activeUserId = userId;
  }

  getActiveUserId(): string {
    return this.activeUserId;
  }

  getSubscribedSessionId(senderId: string): string | undefined {
    return this.sessionSubscribers.get(senderId)?.sessionId;
  }

  hasSubscriber(senderId: string): boolean {
    return this.subscribers.has(senderId);
  }

  async handleQuery(senderId: string, payload: unknown): Promise<unknown> {
    this.authorize(senderId);
    const parsed = queryRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid request');
    }
    this.assertSize(payload);
    const paramsSchema = queryParamsSchema(parsed.data.method);
    const params = paramsSchema ? paramsSchema.safeParse(parsed.data.params) : undefined;
    if (params && !params.success) throw new BridgeError('INVALID_REQUEST', 'Invalid params');
    const requestId = this.generateRequestId();
    const epoch = this.userEpoch;
    const result = await this.dispatcher.request({
      requestId,
      userId: this.activeUserId,
      windowId: senderId,
      method: parsed.data.method,
      params: params?.data ?? parsed.data.params,
    });
    if (epoch !== this.userEpoch) {
      throw new BridgeError('RUNTIME_RESTARTED', 'User context changed');
    }
    this.logger.info('query', { requestId, userId: this.activeUserId, method: parsed.data.method });
    return this.validateResponse(parsed.data.method, result);
  }

  async handleCommand(senderId: string, payload: unknown): Promise<unknown> {
    this.authorize(senderId);
    const parsed = commandRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid request');
    }
    this.assertSize(payload);

    if (parsed.data.method === 'runtime.retry') {
      await this.dispatcher.retry();
      const requestId = this.generateRequestId();
      const result = await this.dispatcher.request({
        requestId,
        userId: this.activeUserId,
        windowId: senderId,
        method: 'app.bootstrap',
      });
      const bootstrap = this.validateResponse('app.bootstrap', result);
      if (
        typeof bootstrap === 'object' &&
        bootstrap !== null &&
        'activeUser' in bootstrap &&
        typeof bootstrap.activeUser === 'object' &&
        bootstrap.activeUser !== null &&
        'id' in bootstrap.activeUser &&
        typeof bootstrap.activeUser.id === 'string'
      ) {
        this.activeUserId = bootstrap.activeUser.id;
      }
      this.logger.info('runtime-retried', { requestId, userId: this.activeUserId });
      return bootstrap;
    }

    if (parsed.data.method === 'user.switch') {
      const target = parsed.data.params.userId;
      if (!isBuiltinUser(target)) {
        throw new BridgeError('USER_NOT_FOUND', 'User not found');
      }
      const requestId = this.generateRequestId();
      const result = await this.dispatcher.request({
        requestId,
        userId: this.activeUserId,
        windowId: senderId,
        method: 'user.switch',
        params: { userId: target },
      });
      this.activeUserId = target;
      this.userEpoch += 1;
      if (this.subscribers.size > 0) {
        this.sendLifecycle({ type: 'user-changed', userId: target });
      }
      this.subscribers.clear();
      this.sessionSubscribers.clear();
      this.logger.info('user-switched', { requestId, userId: target });
      return this.validateResponse('app.bootstrap', result);
    }

    const requestId = this.generateRequestId();
    const epoch = this.userEpoch;
    const result = await this.dispatcher.request({
      requestId,
      userId: this.activeUserId,
      windowId: senderId,
      method: parsed.data.method,
      params: parsed.data.params,
    });
    if (epoch !== this.userEpoch)
      throw new BridgeError('RUNTIME_RESTARTED', 'User context changed');
    this.logger.info('command', {
      requestId,
      userId: this.activeUserId,
      method: parsed.data.method,
    });
    return this.validateResponse(parsed.data.method, result);
  }

  handleSubscribe(
    senderId: string,
    subscription?: { kind: 'session'; sessionId: string; afterSeq: number },
  ): void {
    if (!this.isAuthorizedSender(senderId)) {
      this.logger.warn('unauthorized subscribe rejected', { senderId });
      return;
    }
    if (subscription) {
      this.sessionSubscribers.set(senderId, {
        sessionId: subscription.sessionId,
        cursor: subscription.afterSeq,
      });
    } else {
      this.subscribers.add(senderId);
    }
  }

  handleUnsubscribe(senderId: string, kind?: 'session'): void {
    if (kind === 'session') this.sessionSubscribers.delete(senderId);
    else this.subscribers.delete(senderId);
  }

  handleLifecycle(event: LifecycleEvent): void {
    if (this.subscribers.size === 0) return;
    if (event.type === 'runtime' || event.type === 'user-changed') {
      this.sendLifecycle(event);
    }
  }

  handleSessionEvents(batch: SessionEventBatch): void {
    if (batch.userId !== this.activeUserId) return;
    for (const [senderId, subscription] of this.sessionSubscribers) {
      if (subscription.sessionId !== batch.sessionId || batch.toSeq <= subscription.cursor)
        continue;
      const events = batch.events.filter((event) => event.seq > subscription.cursor);
      const first = events[0];
      if (!first) continue;
      const expectedSeq = subscription.cursor + 1;
      if (first.seq !== expectedSeq) {
        this.sendSessionEvents(senderId, {
          type: 'resync-required',
          sessionId: batch.sessionId,
          expectedSeq,
          receivedSeq: first.seq,
        });
        this.sessionSubscribers.delete(senderId);
        continue;
      }
      const toSeq = events.at(-1)?.seq ?? subscription.cursor;
      this.sendSessionEvents(senderId, {
        type: 'events',
        sessionId: batch.sessionId,
        fromSeq: first.seq,
        toSeq,
        events,
      });
      subscription.cursor = toSeq;
    }
  }

  private authorize(senderId: string): void {
    if (!this.isAuthorizedSender(senderId)) {
      throw new BridgeError('UNAUTHORIZED_SENDER', 'Unauthorized sender');
    }
  }

  private assertSize(payload: unknown): void {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {
      throw new BridgeError('INVALID_REQUEST', 'Invalid payload');
    }
    if (size > MAX_REQUEST_BYTES) {
      throw new BridgeError('INVALID_REQUEST', 'Payload too large');
    }
  }

  private validateResponse(method: string, result: unknown): unknown {
    if (method !== 'app.bootstrap' && method !== 'system.health' && method !== 'user.switch') {
      const runtimeSchema = runtimeResponseSchema(method);
      if (!runtimeSchema) return result;
      const parsed = runtimeSchema.safeParse(result);
      if (!parsed.success) {
        throw new BridgeError('INTERNAL_ERROR', 'Invalid response from runtime');
      }
      return result;
    }
    const schema = method === 'system.health' ? healthSnapshotSchema : bootstrapResultSchema;
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new BridgeError('INTERNAL_ERROR', 'Invalid response from runtime');
    }
    return result;
  }
}
