import { createHash } from 'node:crypto';
import {
  assistantMessagePhase,
  isHistoricalConversationMessage,
  type AssistantMessagePhase,
} from '../client-contracts/assistant-output-policy';
import type { Logger } from '../infrastructure/logging/logger';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { BridgeError } from '../shared/contracts/errors';
import type { AppendEventInput, SessionLogEvent } from '../shared/domain/session';
import type { LocalUserId } from '../shared/domain/user';
import type { ApprovalResolution, PermissionPreset } from '../shared/domain/permission';
import type { SessionEventBatch } from '../shared/contracts/ipc';
import type { Clock, IdProvider } from '../shared/domain/ports';
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  inboxSplicedPayloadSchema,
  type InboxItem,
  type RuntimeEventType,
  validateAndUpcastRuntimeEvent,
} from '../client-contracts/runtime';
import { ContextBudgetError, ContextProjector } from './context-projector';
import { estimateTextTokens } from './context-projector';
import type {
  LlmAdapter,
  LlmAdapterRegistry,
  ModelResponse,
  ModelSnapshot,
  ModelToolDefinition,
} from './model';
import { SYSTEM_PROMPT_REVISION, validateModelResponse } from './model';
import { needsProgressReminder } from './progress-communication';
import {
  applyRuntimeEvent,
  cloneRuntimeProjection,
  projectRuntime,
  type RuntimeProjection,
} from '../client-contracts/projection';
import type { RuntimeTool, ScheduledToolCall, ToolExecutionContext, ToolRegistry } from './tools';
import { ToolScheduler } from './tools';
import { pruneToolResultText, selectCheckpointMessages } from './surface-compactor';
import { modelToolsForPermission } from './permission-tool-policy';

export interface RuntimeServiceOptions {
  leaseDurationMs?: number;
  reservedOutputTokens?: number;
  safetyTokens?: number;
  toolParallelism?: number;
  maxParallelSessions?: number;
  memoryCompactionTriggerRatio?: number;
  surfaceCompactionTriggerRatio?: number;
  compactionRetries?: number;
}

export interface RuntimeServiceDeps {
  appDataDir: string;
  repos: SqliteRepositories;
  clock: Clock;
  ids: IdProvider;
  logger: Logger;
  workerId: string;
  llmAdapters: LlmAdapterRegistry;
  tools: ToolRegistry;
  resolveModel(userId: LocalUserId): ModelSnapshot;
  options?: RuntimeServiceOptions;
  onEventsAppended?: (batch: SessionEventBatch) => void;
}

interface DriverIdentity {
  userId: LocalUserId;
  sessionId: string;
}

interface ActiveExecution extends DriverIdentity {
  turnId: string;
  controller: AbortController;
}

interface PendingApproval {
  userId: LocalUserId;
  sessionId: string;
  toolIdentity: string;
  resolve(resolution: ApprovalResolution): void;
}

export class RuntimeService {
  private readonly repos: SqliteRepositories;
  private readonly clock: Clock;
  private readonly ids: IdProvider;
  private readonly logger: Logger;
  private readonly workerId: string;
  private readonly llmAdapters: LlmAdapterRegistry;
  private readonly tools: ToolRegistry;
  private readonly scheduler: ToolScheduler;
  private readonly contextProjector: ContextProjector;
  private readonly resolveModel: RuntimeServiceDeps['resolveModel'];
  private readonly onEventsAppended: (batch: SessionEventBatch) => void;
  private readonly leaseDurationMs: number;
  private readonly reservedOutputTokens: number;
  private readonly safetyTokens: number;
  private readonly maxParallelSessions: number;
  private readonly memoryCompactionTriggerRatio: number;
  private readonly surfaceCompactionTriggerRatio: number;
  private readonly compactionRetries: number;
  private activeSessionCount = 0;
  private readonly sessionWaiters: Array<() => void> = [];
  private readonly running = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly projectionCache = new Map<string, RuntimeProjection>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private closed = false;

  constructor(deps: RuntimeServiceDeps) {
    this.contextProjector = new ContextProjector(deps.appDataDir);
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.logger = deps.logger.child({ component: 'runtime' });
    this.workerId = deps.workerId;
    this.llmAdapters = deps.llmAdapters;
    this.tools = deps.tools;
    this.resolveModel = deps.resolveModel;
    this.onEventsAppended = deps.onEventsAppended ?? (() => undefined);
    this.leaseDurationMs = deps.options?.leaseDurationMs ?? 30_000;
    this.reservedOutputTokens = deps.options?.reservedOutputTokens ?? 4096;
    this.safetyTokens = deps.options?.safetyTokens ?? 2048;
    this.maxParallelSessions = deps.options?.maxParallelSessions ?? 4;
    this.memoryCompactionTriggerRatio = deps.options?.memoryCompactionTriggerRatio ?? 0.8;
    this.surfaceCompactionTriggerRatio = deps.options?.surfaceCompactionTriggerRatio ?? 0.8;
    this.compactionRetries = deps.options?.compactionRetries ?? 1;
    this.scheduler = new ToolScheduler(
      deps.tools,
      deps.options?.toolParallelism ?? 4,
      (call, tool, context) => this.authorizeToolCall(call, tool, context),
    );
  }

  createSession(userId: LocalUserId, input: { sessionId?: string; title: string }): unknown {
    this.assertOpen();
    const sessionId = input.sessionId ?? this.ids.newId();
    const existing = this.repos.sessions.getSession(userId, sessionId);
    if (existing) {
      if (existing.title !== input.title) {
        throw new BridgeError('IDEMPOTENCY_CONFLICT', 'Session id was used with another title');
      }
      return existing;
    }
    const now = this.clock.nowIso();
    const session = this.repos.sessions.createSession({
      id: sessionId,
      userId,
      title: input.title,
      now,
    });
    this.append(userId, sessionId, [
      this.event('session.created', { sessionId, title: input.title }),
    ]);
    return this.repos.sessions.getSession(userId, sessionId) ?? session;
  }

  renameSession(
    userId: LocalUserId,
    sessionId: string,
    title: string,
    expectedVersion: number,
  ): { sessionId: string } {
    this.requireSession(userId, sessionId);
    this.repos.sessions.renameSession(
      userId,
      sessionId,
      title,
      expectedVersion,
      this.clock.nowIso(),
    );
    return { sessionId };
  }

  archiveSession(userId: LocalUserId, sessionId: string): { sessionId: string } {
    this.requireSession(userId, sessionId);
    if (this.load(userId, sessionId).activeTurn) {
      throw new BridgeError('SESSION_BUSY', 'Cancel the active turn before archiving');
    }
    this.repos.sessions.archiveSession(userId, sessionId, this.clock.nowIso());
    return { sessionId };
  }

  setPermissionPreset(
    userId: LocalUserId,
    sessionId: string,
    preset: PermissionPreset,
  ): { sessionId: string; permissionPreset: PermissionPreset } {
    this.requireActiveSession(userId, sessionId);
    const session = this.requireSession(userId, sessionId);
    if (this.load(userId, sessionId).activeTurn) {
      throw new BridgeError('SESSION_BUSY', 'Stop the active turn before changing permissions');
    }
    if (session.permissionPreset === preset) {
      return { sessionId, permissionPreset: preset };
    }
    this.append(userId, sessionId, [
      this.event('permission.preset.changed', {
        from: session.permissionPreset,
        to: preset,
      }),
    ]);
    return { sessionId, permissionPreset: preset };
  }

  resolveApproval(
    userId: LocalUserId,
    input: {
      sessionId: string;
      approvalId: string;
      resolution: ApprovalResolution;
      idempotencyKey: string;
    },
  ): { approvalId: string; resolution: ApprovalResolution } {
    const existing = this.repos.sessions.findByIdempotencyKey(
      userId,
      input.sessionId,
      input.idempotencyKey,
    );
    if (existing) {
      const payload = asRecord(existing.payload);
      if (
        stringAt(payload, 'approvalId') !== input.approvalId ||
        stringAt(payload, 'resolution') !== input.resolution
      ) {
        throw new BridgeError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused');
      }
      return { approvalId: input.approvalId, resolution: input.resolution };
    }
    const projection = this.load(userId, input.sessionId);
    const approval = projection.approvals.get(input.approvalId);
    const pending = this.pendingApprovals.get(input.approvalId);
    if (
      !approval ||
      approval.status !== 'pending' ||
      !pending ||
      pending.userId !== userId ||
      pending.sessionId !== input.sessionId
    ) {
      throw new BridgeError('INTERACTION_NOT_PENDING', 'Approval is not pending');
    }
    this.renewLease({ userId, sessionId: input.sessionId });
    const events: AppendEventInput[] = [
      this.event(
        'approval.resolved',
        {
          approvalId: input.approvalId,
          toolIdentity: approval.toolIdentity,
          resolution: input.resolution,
        },
        null,
        input.idempotencyKey,
      ),
    ];
    if (input.resolution === 'session-granted') {
      events.push(
        this.event('permission.grant.created', {
          approvalId: input.approvalId,
          toolIdentity: approval.toolIdentity,
          scope: 'session',
        }),
      );
    }
    this.append(userId, input.sessionId, events);
    this.pendingApprovals.delete(input.approvalId);
    pending.resolve(input.resolution);
    return { approvalId: input.approvalId, resolution: input.resolution };
  }

  submitInput(
    userId: LocalUserId,
    input: {
      sessionId: string;
      content: string;
      idempotencyKey: string;
      startNewEvent: boolean;
      mode?: 'queue' | 'steer';
      eventId?: string;
    },
  ): { inboxItemId: string; duplicate: boolean; scope: 'next-turn' | 'next-step' } {
    this.requireActiveSession(userId, input.sessionId);
    const duplicate = this.repos.sessions.findByIdempotencyKey(
      userId,
      input.sessionId,
      input.idempotencyKey,
    );
    if (duplicate) return this.duplicateInputResult(duplicate, input.content);
    const model = this.resolveModel(userId);
    if (!this.llmAdapters.get(model.providerType)) {
      throw new BridgeError('MODEL_ADAPTER_UNAVAILABLE', 'Model adapter is unavailable');
    }

    const projection = this.load(userId, input.sessionId);
    if (input.startNewEvent && input.eventId) {
      throw new BridgeError('INVALID_REQUEST', 'A new event cannot reuse an eventId');
    }
    if (input.eventId && !projection.events.has(input.eventId)) {
      throw new BridgeError('INVALID_REQUEST', 'Conversation event not found');
    }
    const isSteer = input.mode === 'steer' && projection.activeTurn !== null;
    const item: InboxItem = {
      id: this.ids.newId(),
      content: input.content,
      scope: isSteer ? 'next-step' : 'next-turn',
      eventId: isSteer ? (projection.activeTurn?.eventId ?? null) : (input.eventId ?? null),
      startNewEvent: isSteer ? false : input.startNewEvent,
      createdAt: this.clock.nowIso(),
    };
    const event = this.event(
      'agent.inbox.spliced',
      { reason: 'submit', operations: [{ op: 'insert', item }] },
      null,
      input.idempotencyKey,
    );
    try {
      this.append(userId, input.sessionId, [event]);
    } catch (error) {
      const raced = this.repos.sessions.findByIdempotencyKey(
        userId,
        input.sessionId,
        input.idempotencyKey,
      );
      if (raced) return this.duplicateInputResult(raced, input.content);
      throw error;
    }
    this.wake(userId, input.sessionId);
    return { inboxItemId: item.id, duplicate: false, scope: item.scope };
  }

  removeInboxItem(
    userId: LocalUserId,
    sessionId: string,
    inboxItemId: string,
  ): { inboxItemId: string } {
    const projection = this.load(userId, sessionId);
    if (!projection.inbox.some((item) => item.id === inboxItemId)) {
      throw new BridgeError('INBOX_ITEM_NOT_FOUND', 'Inbox item not found');
    }
    this.append(userId, sessionId, [
      this.event('agent.inbox.spliced', {
        reason: 'remove',
        operations: [{ op: 'remove', itemId: inboxItemId }],
      }),
    ]);
    return { inboxItemId };
  }

  replaceInboxItem(
    userId: LocalUserId,
    sessionId: string,
    inboxItemId: string,
    content: string,
  ): { inboxItemId: string } {
    const projection = this.load(userId, sessionId);
    if (!projection.inbox.some((item) => item.id === inboxItemId)) {
      throw new BridgeError('INBOX_ITEM_NOT_FOUND', 'Inbox item not found');
    }
    this.append(userId, sessionId, [
      this.event('agent.inbox.spliced', {
        reason: 'replace',
        operations: [{ op: 'replace', itemId: inboxItemId, content }],
      }),
    ]);
    return { inboxItemId };
  }

  promoteInboxItem(
    userId: LocalUserId,
    sessionId: string,
    inboxItemId: string,
    expectedTurnId: string,
  ): { inboxItemId: string; turnId: string; scope: 'next-step' } {
    const projection = this.load(userId, sessionId);
    if (projection.activeTurn?.id !== expectedTurnId) {
      throw new BridgeError('TURN_CHANGED', 'Active turn changed');
    }
    const item = projection.inbox.find((candidate) => candidate.id === inboxItemId);
    if (!item || item.scope !== 'next-turn') {
      throw new BridgeError('INBOX_ITEM_NOT_PROMOTABLE', 'Inbox item is not promotable');
    }
    const promoted: InboxItem = {
      ...item,
      scope: 'next-step',
      eventId: projection.activeTurn.eventId,
      startNewEvent: false,
    };
    this.append(userId, sessionId, [
      this.event('agent.inbox.spliced', {
        reason: 'promote',
        turnId: expectedTurnId,
        operations: [
          { op: 'remove', itemId: item.id },
          { op: 'insert', item: promoted },
        ],
      }),
    ]);
    return { inboxItemId, turnId: expectedTurnId, scope: 'next-step' };
  }

  cancelTurn(
    userId: LocalUserId,
    sessionId: string,
    turnId: string,
    options: { keepNextTurn: boolean; keepNextStep: boolean; reason: string } = {
      keepNextTurn: true,
      keepNextStep: false,
      reason: 'user_cancelled',
    },
  ): { turnId: string; status: 'cancelling' } {
    const projection = this.load(userId, sessionId);
    if (projection.activeTurn?.id !== turnId)
      throw new BridgeError('TURN_CHANGED', 'Active turn changed');
    const events: AppendEventInput[] = [];
    const cleanup = cancelNextStepOperations(projection, options.keepNextStep);
    if (cleanup.length > 0) {
      events.push(
        this.event('agent.inbox.spliced', {
          reason: 'cancel-cleanup',
          turnId,
          operations: cleanup,
        }),
      );
    }
    if (!options.keepNextTurn) {
      const queued = projection.inbox
        .filter((item) => item.scope === 'next-turn')
        .map((item) => ({ op: 'remove' as const, itemId: item.id }));
      if (queued.length > 0) {
        events.push(
          this.event('agent.inbox.spliced', {
            reason: 'cancel-cleanup',
            turnId,
            operations: queued,
          }),
        );
      }
    }
    events.push(this.event('turn.cancel.requested', { turnId, reason: options.reason }));
    this.append(userId, sessionId, events);
    this.active.get(keyOf(userId, sessionId))?.controller.abort();
    return { turnId, status: 'cancelling' };
  }

  cancelAndQueue(
    userId: LocalUserId,
    input: {
      sessionId: string;
      turnId: string;
      content: string;
      idempotencyKey: string;
      startNewEvent: boolean;
    },
  ): { turnId: string; inboxItemId: string } {
    const existing = this.repos.sessions.findByIdempotencyKey(
      userId,
      input.sessionId,
      input.idempotencyKey,
    );
    if (existing) {
      const parsed = inboxSplicedPayloadSchema.safeParse(existing.payload);
      if (!parsed.success) {
        throw new BridgeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used by another request',
        );
      }
      const inserted = parsed.data.operations.find((operation) => operation.op === 'insert');
      if (!inserted || inserted.op !== 'insert' || inserted.item.content !== input.content) {
        throw new BridgeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used by another request',
        );
      }
      if (parsed.data.turnId !== input.turnId) {
        throw new BridgeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used by another request',
        );
      }
      return { turnId: parsed.data.turnId, inboxItemId: inserted.item.id };
    }
    const projection = this.load(userId, input.sessionId);
    if (projection.activeTurn?.id !== input.turnId) {
      throw new BridgeError('TURN_CHANGED', 'Active turn changed');
    }
    const item: InboxItem = {
      id: this.ids.newId(),
      content: input.content,
      scope: 'next-turn',
      eventId: null,
      startNewEvent: input.startNewEvent,
      createdAt: this.clock.nowIso(),
    };
    const cleanup = cancelNextStepOperations(projection, false);
    this.append(userId, input.sessionId, [
      this.event(
        'agent.inbox.spliced',
        {
          reason: 'submit',
          turnId: input.turnId,
          operations: [...cleanup, { op: 'insert', item }],
        },
        null,
        input.idempotencyKey,
      ),
      this.event('turn.cancel.requested', { turnId: input.turnId, reason: 'cancel_and_queue' }),
    ]);
    this.active.get(keyOf(userId, input.sessionId))?.controller.abort();
    return { turnId: input.turnId, inboxItemId: item.id };
  }

  resolveInteraction(
    userId: LocalUserId,
    input: {
      sessionId: string;
      interactionId: string;
      value?: unknown;
      resolution?: 'submitted' | 'cancelled' | 'rejected';
      idempotencyKey: string;
    },
  ): { interactionId: string; inboxItemId: string | null } {
    const existing = this.repos.sessions.findByIdempotencyKey(
      userId,
      input.sessionId,
      input.idempotencyKey,
    );
    if (existing) {
      const payload = asRecord(existing.payload);
      if (
        stringAt(payload, 'interactionId') !== input.interactionId ||
        stringAt(payload, 'resolution') !== (input.resolution ?? 'submitted') ||
        safeJson(payload?.value) !== safeJson(input.value)
      ) {
        throw new BridgeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used by another request',
        );
      }
      return {
        interactionId: stringAt(payload, 'interactionId') ?? input.interactionId,
        inboxItemId: stringAt(payload, 'inboxItemId') ?? null,
      };
    }
    const projection = this.load(userId, input.sessionId);
    const interaction = projection.interactions.get(input.interactionId);
    if (!interaction || interaction.status !== 'pending') {
      throw new BridgeError('INTERACTION_NOT_PENDING', 'Interaction is not pending');
    }
    const resolution = input.resolution ?? 'submitted';
    if (resolution === 'submitted' && !validInteractionValue(interaction, input.value)) {
      throw new BridgeError('INVALID_REQUEST', 'Interaction value does not match the request');
    }
    if (resolution === 'submitted') {
      const model = this.resolveModel(userId);
      if (!this.llmAdapters.get(model.providerType)) {
        throw new BridgeError('MODEL_ADAPTER_UNAVAILABLE', 'Model adapter is unavailable');
      }
    }
    const inboxItemId = resolution === 'submitted' ? this.ids.newId() : null;
    const resolutionEvents: AppendEventInput[] = [
      this.event(
        'interaction.resolved',
        {
          interactionId: input.interactionId,
          eventId: interaction.eventId,
          value: input.value,
          resolution,
          inboxItemId,
        },
        null,
        input.idempotencyKey,
      ),
    ];
    if (resolution !== 'submitted' || !inboxItemId) {
      resolutionEvents.push(
        this.event('conversation.event.status-changed', {
          eventId: interaction.eventId,
          status: resolution === 'cancelled' ? 'completed' : 'failed',
        }),
      );
      this.append(userId, input.sessionId, resolutionEvents);
      return { interactionId: input.interactionId, inboxItemId: null };
    }
    const item: InboxItem = {
      id: inboxItemId,
      content: `用户交互结果：${safeJson(input.value)}`,
      scope: 'next-turn',
      eventId: interaction.eventId,
      startNewEvent: false,
      createdAt: this.clock.nowIso(),
    };
    this.append(userId, input.sessionId, [
      ...resolutionEvents,
      this.event('conversation.event.status-changed', {
        eventId: interaction.eventId,
        status: 'open',
      }),
      this.event('agent.inbox.spliced', {
        reason: 'submit',
        operations: [{ op: 'insert', item }],
      }),
    ]);
    this.wake(userId, input.sessionId);
    return { interactionId: input.interactionId, inboxItemId };
  }

  listSessions(userId: LocalUserId): unknown[] {
    return this.repos.sessions.listSessions(userId).map((session) => {
      const projection = this.load(userId, session.id);
      return {
        ...session,
        activeTurnId: projection.activeTurn?.id ?? null,
        inboxCount: projection.inbox.length,
      };
    });
  }

  snapshot(userId: LocalUserId, sessionId: string): unknown {
    const session = this.requireSession(userId, sessionId);
    const projection = this.load(userId, sessionId);
    return serializeProjection(session, projection);
  }

  eventsPage(
    userId: LocalUserId,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): { items: SessionLogEvent[]; nextAfterSeq: number | null } {
    this.requireSession(userId, sessionId);
    const page = this.repos.sessions.readEventsAfter(userId, sessionId, afterSeq).slice(0, limit);
    const redacted = page.map(redactDiagnosticEvent);
    return {
      items: redacted,
      nextAfterSeq: page.length === limit ? (page.at(-1)?.seq ?? null) : null,
    };
  }

  conversationEventList(userId: LocalUserId, sessionId: string): unknown[] {
    return [...this.load(userId, sessionId).events.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  conversationEventRead(userId: LocalUserId, sessionId: string, eventId: string): unknown {
    const projection = this.load(userId, sessionId);
    const event = projection.events.get(eventId);
    if (!event) throw new BridgeError('INVALID_REQUEST', 'Conversation event not found');
    return {
      ...event,
      messages: projection.messages.filter(
        (message) => message.eventId === eventId && isHistoricalConversationMessage(message),
      ),
      turns: [...projection.turns.values()].filter((turn) => turn.eventId === eventId),
    };
  }

  executionTurnList(userId: LocalUserId, sessionId: string): unknown[] {
    return [...this.load(userId, sessionId).turns.values()];
  }

  executionTurnRead(userId: LocalUserId, sessionId: string, turnId: string): unknown {
    const projection = this.load(userId, sessionId);
    const turn = projection.turns.get(turnId);
    if (!turn) throw new BridgeError('INVALID_REQUEST', 'Turn not found');
    return {
      ...turn,
      messages: projection.messages.filter((message) => message.turnId === turnId),
      steps: [...projection.steps.values()].filter((step) => step.turnId === turnId),
      toolCalls: [...projection.toolCalls.values()].filter((call) => call.turnId === turnId),
    };
  }

  recover(): void {
    for (const user of this.repos.users.listUsers()) {
      for (const session of this.repos.sessions.listSessions(user.id)) {
        if (session.status !== 'active') continue;
        this.repos.sessions.clearLeaseForRecovery(user.id, session.id);
        this.repos.projections.rebuild(
          user.id,
          session.id,
          this.repos.sessions.listEvents(user.id, session.id),
          this.clock.nowIso(),
        );
        const projection = this.load(user.id, session.id);
        if (projection.activeTurn) {
          const turn = projection.activeTurn;
          const rawEvents = this.repos.sessions.listEvents(user.id, session.id);
          const cleanup = projection.inbox
            .filter((item) => item.scope === 'next-step')
            .flatMap((item) => [
              { op: 'remove' as const, itemId: item.id },
              {
                op: 'insert' as const,
                item: { ...item, scope: 'next-turn' as const, eventId: null, startNewEvent: true },
              },
            ]);
          const events: AppendEventInput[] = [];
          for (const approval of projection.approvals.values()) {
            if (approval.status !== 'pending' || approval.turnId !== turn.id) continue;
            events.push(
              this.event('approval.resolved', {
                approvalId: approval.id,
                toolIdentity: approval.toolIdentity,
                resolution: 'unavailable',
              }),
            );
          }
          for (const pendingCall of unresolvedToolCalls(rawEvents, turn.id)) {
            events.push(
              this.event('tool.result', {
                toolCallId: pendingCall.toolCallId,
                toolName: pendingCall.toolName,
                turnId: turn.id,
                eventId: turn.eventId,
                status: 'fatal_error',
                output: null,
                errorCode: 'UNKNOWN_SIDE_EFFECT',
                recovered: true,
                callIndex: pendingCall.callIndex,
              }),
            );
          }
          if (cleanup.length > 0) {
            events.push(
              this.event('agent.inbox.spliced', {
                reason: 'cancel-cleanup',
                operations: cleanup,
                turnId: turn.id,
              }),
            );
          }
          events.push(
            this.event('turn.ended', {
              turnId: turn.id,
              eventId: turn.eventId,
              status: turn.cancelRequested ? 'cancelled' : 'interrupted',
              reason: turn.cancelRequested ? 'cancelled_during_restart' : 'worker_restarted',
            }),
            this.event('conversation.exchange.completed', {
              exchangeId: turn.exchangeId,
              eventId: turn.eventId,
              turnId: turn.id,
              status: turn.cancelRequested ? 'cancelled' : 'interrupted',
            }),
          );
          this.append(user.id, session.id, events);
        }
        if (this.load(user.id, session.id).inbox.some((item) => item.scope === 'next-turn')) {
          this.wake(user.id, session.id);
        }
      }
    }
  }

  async waitForIdle(userId?: LocalUserId, sessionId?: string): Promise<void> {
    if (userId && sessionId) {
      await this.running.get(keyOf(userId, sessionId));
      return;
    }
    await Promise.all([...this.running.values()]);
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pendingApprovals.values()) pending.resolve('unavailable');
    this.pendingApprovals.clear();
    for (const execution of this.active.values()) execution.controller.abort();
    while (this.sessionWaiters.length > 0) this.sessionWaiters.shift()?.();
  }

  async shutdown(): Promise<void> {
    this.close();
    await Promise.all([...this.running.values()]);
  }

  private wake(userId: LocalUserId, sessionId: string): void {
    if (this.closed) return;
    const key = keyOf(userId, sessionId);
    if (this.running.has(key)) return;
    const task = Promise.resolve()
      .then(() => this.runSession({ userId, sessionId }))
      .catch((error: unknown) => {
        this.logger.error('session driver failed', {
          userId,
          sessionId,
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        });
      })
      .finally(() => {
        this.running.delete(key);
        this.active.delete(key);
      });
    this.running.set(key, task);
  }

  private async runSession(identity: DriverIdentity): Promise<void> {
    await this.acquireSessionSlot();
    const lease = this.acquireLease(identity);
    if (!lease) {
      this.releaseSessionSlot();
      return;
    }
    const heartbeat = setInterval(
      () => {
        const expiresAt = new Date(this.clock.now().getTime() + this.leaseDurationMs).toISOString();
        const renewed = this.repos.sessions.renewLease({
          ...identity,
          owner: this.workerId,
          expiresAt,
        });
        if (!renewed)
          this.active.get(keyOf(identity.userId, identity.sessionId))?.controller.abort();
      },
      Math.max(1000, Math.floor(this.leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      while (!this.closed) {
        const projection = this.load(identity.userId, identity.sessionId);
        if (projection.activeTurn) return;
        const item = projection.inbox.find((candidate) => candidate.scope === 'next-turn');
        if (!item) return;
        const claimed = this.claimNewTurn(identity, projection, item);
        await this.executeTurn(identity, claimed.turnId, claimed.eventId, claimed.exchangeId);
        this.renewLease(identity);
      }
    } finally {
      clearInterval(heartbeat);
      this.repos.sessions.releaseLease(identity.userId, identity.sessionId, this.workerId);
      this.releaseSessionSlot();
    }
  }

  private claimNewTurn(
    identity: DriverIdentity,
    projection: RuntimeProjection,
    item: InboxItem,
  ): { turnId: string; eventId: string; exchangeId: string } {
    const latestActive = [...projection.events.values()]
      .filter((event) => event.status === 'open' || event.status === 'awaiting_user')
      .at(-1);
    const latestEvent = [...projection.events.values()].at(-1);
    const eventId =
      item.eventId ??
      (!item.startNewEvent ? (latestActive?.id ?? latestEvent?.id) : undefined) ??
      this.ids.newId();
    const exchangeId = this.ids.newId();
    const turnId = this.ids.newId();
    const events: AppendEventInput[] = [
      this.event('agent.inbox.spliced', {
        reason: 'claim',
        turnId,
        operations: [{ op: 'remove', itemId: item.id }],
      }),
    ];
    if (!projection.events.has(eventId)) {
      events.push(
        this.event('conversation.event.created', {
          eventId,
          title: item.content.slice(0, 80),
        }),
      );
    } else if (projection.events.get(eventId)?.status !== 'open') {
      events.push(this.event('conversation.event.status-changed', { eventId, status: 'open' }));
    }
    events.push(
      this.event('conversation.exchange.started', { exchangeId, eventId, turnId }),
      this.event('turn.started', { turnId, eventId, exchangeId }),
      this.event('user.message', {
        messageId: this.ids.newId(),
        inboxItemId: item.id,
        content: item.content,
        eventId,
        exchangeId,
        turnId,
      }),
    );
    this.append(identity.userId, identity.sessionId, events, true);
    return { turnId, eventId, exchangeId };
  }

  private async executeTurn(
    identity: DriverIdentity,
    turnId: string,
    eventId: string,
    exchangeId: string,
  ): Promise<void> {
    const controller = new AbortController();
    const key = keyOf(identity.userId, identity.sessionId);
    this.active.set(key, { ...identity, turnId, controller });
    let stepIndex = 0;
    try {
      let model: ModelSnapshot;
      try {
        model = this.resolveModel(identity.userId);
      } catch (error) {
        await this.endTurn(identity, turnId, eventId, exchangeId, 'failed', errorCodeOf(error));
        return;
      }
      const adapter = this.llmAdapters.get(model.providerType);
      if (!adapter) {
        await this.endTurn(
          identity,
          turnId,
          eventId,
          exchangeId,
          'failed',
          'model_adapter_unavailable',
        );
        return;
      }
      while (true) {
        const before = this.load(identity.userId, identity.sessionId);
        if (before.turns.get(turnId)?.cancelRequested || controller.signal.aborted) {
          await this.endTurn(identity, turnId, eventId, exchangeId, 'cancelled', 'user_cancelled');
          return;
        }
        stepIndex += 1;
        const permissionPreset = this.requireSession(
          identity.userId,
          identity.sessionId,
        ).permissionPreset;
        const availableTools = modelToolsForPermission(
          this.tools.definitions(identity.userId, turnId),
          permissionPreset,
        );
        const stepId = this.ids.newId();
        this.append(
          identity.userId,
          identity.sessionId,
          [this.event('step.started', { stepId, turnId, eventId, stepIndex })],
          true,
        );
        try {
          if (stepIndex === 1) {
            await this.compactBusinessMemoryIfNeeded(
              identity,
              turnId,
              eventId,
              model,
              adapter,
              controller.signal,
              availableTools,
              permissionPreset,
            );
          }
          await this.compactSurfaceIfNeeded(
            identity,
            turnId,
            eventId,
            model,
            adapter,
            controller.signal,
            availableTools,
            permissionPreset,
          );
        } catch (error) {
          const cancelled = controller.signal.aborted;
          this.append(
            identity.userId,
            identity.sessionId,
            [
              this.event('step.ended', {
                stepId,
                turnId,
                eventId,
                status: cancelled ? 'cancelled' : 'failed',
              }),
            ],
            true,
          );
          await this.endTurn(
            identity,
            turnId,
            eventId,
            exchangeId,
            cancelled ? 'cancelled' : 'failed',
            cancelled ? 'user_cancelled' : errorCodeOf(error),
          );
          return;
        }
        const projectedForContext = this.load(identity.userId, identity.sessionId);
        const progressReminder = needsProgressReminder(
          projectedForContext,
          turnId,
          this.clock.nowIso(),
        );

        const revisions = this.repos.users.getRevisions(identity.userId);
        const skills = this.repos.skills.listInstallations(identity.userId);
        let context;
        try {
          context = this.contextProjector.project({
            userId: identity.userId,
            projection: projectedForContext,
            progressReminder,
            eventId,
            turnId,
            contextWindow: model.contextWindow,
            inputCapability: model.inputCapability,
            reservedOutputTokens: this.outputReservationTokens(model),
            safetyTokens: this.safetyTokens,
            tools: availableTools,
            skills,
            permissionPreset,
            promptEpoch: SYSTEM_PROMPT_REVISION + revisions.skillRevision + revisions.mcpRevision,
          });
        } catch (error) {
          const reason =
            error instanceof ContextBudgetError ? 'context_budget_exceeded' : 'context_failed';
          this.append(
            identity.userId,
            identity.sessionId,
            [this.event('step.ended', { stepId, turnId, eventId, status: 'failed' })],
            true,
          );
          await this.endTurn(identity, turnId, eventId, exchangeId, 'failed', reason);
          return;
        }

        const requestId = this.ids.newId();
        this.append(
          identity.userId,
          identity.sessionId,
          [
            this.event('model.request.context', {
              requestId,
              stepId,
              turnId,
              eventId,
              model,
              promptEpoch: context.promptEpoch,
              estimatedInputTokens: context.estimatedInputTokens,
              budgetTokens: context.budgetTokens,
              tokenBreakdown: context.tokenBreakdown,
              includedEventIds: context.includedEventIds,
              skillRevision: revisions.skillRevision,
              runtimeRevision: revisions.runtimeRevision,
              mcpRevision: revisions.mcpRevision,
              toolSnapshot: availableTools.map((tool) => ({
                name: tool.name,
                schemaDigest: tool.name.startsWith('mcp__')
                  ? toolSchemaDigest(tool.inputSchema)
                  : null,
              })),
              skillSnapshot: skills.map((skill) => ({
                name: skill.skillName,
                contentDigest: skill.contentDigest,
                enabled: skill.enabled,
              })),
              runtimeConfig: { progressReminder: context.progressReminder },
            }),
          ],
          true,
        );

        let response: ModelResponse;
        let chunksPersisted = false;
        let responseMetrics:
          | {
              requestStartedAt: string;
              firstTokenAt: string;
              completedAt: string;
              ttftMs: number;
              durationMs: number;
              generationDurationMs: number;
              firstTokenObserved: boolean;
            }
          | undefined;
        try {
          let overflowRetried = false;
          while (true) {
            try {
              const requestStartedAt = this.clock.nowIso();
              const requestStartedTick = performance.now();
              let firstTokenAt: string | undefined;
              let firstTokenTick: number | undefined;
              const markFirstToken = () => {
                if (firstTokenTick !== undefined) return;
                firstTokenAt = this.clock.nowIso();
                firstTokenTick = performance.now();
              };
              const generated = await this.generateModelResponse(
                adapter,
                {
                  requestId,
                  purpose: 'agent',
                  model,
                  messages: context.messages,
                  tools: availableTools,
                  maxOutputTokens: model.maxOutputTokens,
                },
                controller.signal,
                (chunk, chunkIndex) => {
                  markFirstToken();
                  chunksPersisted = true;
                  this.append(
                    identity.userId,
                    identity.sessionId,
                    [
                      this.event('assistant.chunk', {
                        requestId,
                        stepId,
                        turnId,
                        eventId,
                        chunkIndex,
                        content: chunk,
                      }),
                    ],
                    true,
                  );
                },
                (chunk, chunkIndex) => {
                  markFirstToken();
                  this.append(
                    identity.userId,
                    identity.sessionId,
                    [
                      this.event('assistant.reasoning.chunk', {
                        requestId,
                        stepId,
                        turnId,
                        eventId,
                        chunkIndex,
                        content: chunk,
                      }),
                    ],
                    true,
                  );
                },
                (phase) => {
                  this.append(
                    identity.userId,
                    identity.sessionId,
                    [
                      this.event('assistant.message.metadata', {
                        requestId,
                        stepId,
                        turnId,
                        eventId,
                        phase,
                      }),
                    ],
                    true,
                  );
                },
              );
              const completedAt = this.clock.nowIso();
              const completedTick = performance.now();
              const firstTokenObserved = firstTokenTick !== undefined;
              const effectiveFirstTokenTick = firstTokenTick ?? completedTick;
              responseMetrics = {
                requestStartedAt,
                firstTokenAt: firstTokenAt ?? completedAt,
                completedAt,
                ttftMs: Math.max(0, effectiveFirstTokenTick - requestStartedTick),
                durationMs: Math.max(0, completedTick - requestStartedTick),
                generationDurationMs: Math.max(
                  0,
                  completedTick -
                    (firstTokenObserved ? effectiveFirstTokenTick : requestStartedTick),
                ),
                firstTokenObserved,
              };
              response = validateModelResponse(generated);
              break;
            } catch (error) {
              if (
                !overflowRetried &&
                error instanceof Error &&
                error.name === 'MODEL_CONTEXT_WINDOW_EXCEEDED'
              ) {
                const surfaceChanged = await this.compactSurfaceIfNeeded(
                  identity,
                  turnId,
                  eventId,
                  model,
                  adapter,
                  controller.signal,
                  availableTools,
                  permissionPreset,
                  true,
                );
                if (surfaceChanged) {
                  overflowRetried = true;
                  const recovered = this.contextProjector.project({
                    progressReminder,
                    userId: identity.userId,
                    projection: this.load(identity.userId, identity.sessionId),
                    eventId,
                    turnId,
                    contextWindow: model.contextWindow,
                    inputCapability: model.inputCapability,
                    reservedOutputTokens: this.outputReservationTokens(model),
                    safetyTokens: this.safetyTokens,
                    tools: availableTools,
                    skills,
                    permissionPreset,
                    promptEpoch:
                      SYSTEM_PROMPT_REVISION + revisions.skillRevision + revisions.mcpRevision,
                  });
                  context = recovered;
                  this.append(
                    identity.userId,
                    identity.sessionId,
                    [
                      this.event('model.request.context', {
                        requestId,
                        stepId,
                        turnId,
                        eventId,
                        model,
                        promptEpoch: recovered.promptEpoch,
                        estimatedInputTokens: recovered.estimatedInputTokens,
                        budgetTokens: recovered.budgetTokens,
                        tokenBreakdown: recovered.tokenBreakdown,
                        includedEventIds: recovered.includedEventIds,
                        skillRevision: revisions.skillRevision,
                        runtimeRevision: revisions.runtimeRevision,
                        mcpRevision: revisions.mcpRevision,
                        toolSnapshot: availableTools.map((tool) => ({
                          name: tool.name,
                          schemaDigest: tool.name.startsWith('mcp__')
                            ? toolSchemaDigest(tool.inputSchema)
                            : null,
                        })),
                        skillSnapshot: skills.map((skill) => ({
                          name: skill.skillName,
                          contentDigest: skill.contentDigest,
                          enabled: skill.enabled,
                        })),
                        runtimeConfig: { progressReminder: recovered.progressReminder },
                      }),
                    ],
                    true,
                  );
                  continue;
                }
              }
              throw error;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) {
            await this.endTurn(
              identity,
              turnId,
              eventId,
              exchangeId,
              'cancelled',
              'user_cancelled',
            );
          } else {
            this.append(
              identity.userId,
              identity.sessionId,
              [this.event('step.ended', { stepId, turnId, eventId, status: 'failed' })],
              true,
            );
            await this.endTurn(identity, turnId, eventId, exchangeId, 'failed', errorCodeOf(error));
          }
          return;
        }

        const responseEvents: AppendEventInput[] = [];
        for (const [chunkIndex, chunk] of (chunksPersisted
          ? []
          : (response.chunks ?? [])
        ).entries()) {
          responseEvents.push(
            this.event('assistant.chunk', {
              requestId,
              stepId,
              turnId,
              eventId,
              chunkIndex,
              content: chunk,
            }),
          );
        }
        if (response.reasoning) {
          responseEvents.push(
            this.event('assistant.reasoning', {
              requestId,
              stepId,
              turnId,
              eventId,
              content: response.reasoning,
            }),
          );
        }
        responseEvents.push(
          this.event('assistant.message', {
            messageId: this.ids.newId(),
            requestId,
            stepId,
            turnId,
            eventId,
            content: response.content,
            phase: assistantMessagePhase(response),
            phaseSource: response.phase ? 'provider' : 'compatibility',
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            stopReason: response.stopReason,
            ...responseMetrics,
          }),
        );
        for (const [callIndex, call] of response.toolCalls.entries()) {
          responseEvents.push(
            this.event('tool.call', {
              toolCallId: call.id,
              requestId,
              stepId,
              turnId,
              eventId,
              toolName: call.name,
              input: call.arguments ?? null,
              replaySafe: this.tools.get(call.name, identity.userId, turnId)?.replaySafe ?? false,
              presentation:
                presentToolCall(
                  this.tools.get(call.name, identity.userId, turnId),
                  call.arguments,
                ) ?? null,
              callIndex,
            }),
          );
        }
        const emptyResponse = response.content.length === 0 && response.toolCalls.length === 0;
        if (response.toolCalls.length === 0) {
          responseEvents.push(
            this.event('step.ended', {
              stepId,
              turnId,
              eventId,
              status: emptyResponse ? 'failed' : 'completed',
            }),
          );
        }
        if (responseEvents.length > 0) {
          this.append(identity.userId, identity.sessionId, responseEvents, true);
        }

        let needsInput = false;
        if (response.toolCalls.length > 0) {
          const results = await this.scheduler.execute(response.toolCalls, {
            userId: identity.userId,
            sessionId: identity.sessionId,
            eventId,
            turnId,
            stepId,
            permissionPreset,
            signal: controller.signal,
          });
          const resultEvents: AppendEventInput[] = [];
          for (const [callIndex, { call, result }] of results.entries()) {
            resultEvents.push(
              this.event('tool.result', {
                toolCallId: call.id,
                toolName: call.name,
                stepId,
                turnId,
                eventId,
                status: result.status,
                output: result.content,
                errorCode: result.errorCode ?? null,
                meta: result.meta ?? null,
                presentation: result.presentation ?? null,
                executionFacts: result.executionFacts ?? null,
                callIndex,
              }),
            );
            if (result.status === 'needs_input' && result.interaction) {
              needsInput = true;
              resultEvents.push(
                this.event('interaction.requested', {
                  interactionId: this.ids.newId(),
                  toolCallId: call.id,
                  eventId,
                  turnId,
                  prompt: result.interaction.prompt,
                  kind: result.interaction.kind,
                  options: result.interaction.options ?? [],
                  questions: result.interaction.questions,
                  schema: result.interaction.schema,
                }),
              );
            }
          }
          resultEvents.push(
            this.event('step.ended', {
              stepId,
              turnId,
              eventId,
              status: controller.signal.aborted ? 'cancelled' : 'completed',
            }),
          );
          this.append(identity.userId, identity.sessionId, resultEvents, true);
        }

        if (controller.signal.aborted) {
          await this.endTurn(identity, turnId, eventId, exchangeId, 'cancelled', 'user_cancelled');
          return;
        }
        if (needsInput) {
          await this.endTurn(
            identity,
            turnId,
            eventId,
            exchangeId,
            'completed',
            'awaiting_user',
            true,
          );
          return;
        }
        if (emptyResponse) {
          await this.endTurn(
            identity,
            turnId,
            eventId,
            exchangeId,
            'failed',
            'empty_model_response',
          );
          return;
        }

        const claimedNextStep = this.claimNextStep(identity, turnId, eventId, exchangeId);
        if (response.toolCalls.length > 0 || claimedNextStep) continue;
        await this.endTurn(
          identity,
          turnId,
          eventId,
          exchangeId,
          'completed',
          response.stopReason === 'length' ? 'max_output_tokens' : 'complete',
        );
        return;
      }
    } finally {
      this.tools.clearTurnToolExposure(identity.userId, turnId);
      const current = this.active.get(key);
      if (current?.turnId === turnId) this.active.delete(key);
    }
  }

  private claimNextStep(
    identity: DriverIdentity,
    turnId: string,
    eventId: string,
    exchangeId: string,
  ): boolean {
    const projection = this.load(identity.userId, identity.sessionId);
    const items = projection.inbox.filter((item) => item.scope === 'next-step');
    if (items.length === 0) return false;
    const operations = items.map((item) => ({ op: 'remove' as const, itemId: item.id }));
    const events: AppendEventInput[] = [
      this.event('agent.inbox.spliced', { reason: 'claim', turnId, operations }),
      ...items.map((item) =>
        this.event('user.message', {
          messageId: this.ids.newId(),
          inboxItemId: item.id,
          content: item.content,
          eventId,
          exchangeId,
          turnId,
        }),
      ),
    ];
    this.append(identity.userId, identity.sessionId, events, true);
    return true;
  }

  private async endTurn(
    identity: DriverIdentity,
    turnId: string,
    eventId: string,
    exchangeId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    reason: string,
    awaitingUser = false,
  ): Promise<void> {
    const eventStatus = awaitingUser
      ? 'awaiting_user'
      : status === 'failed'
        ? 'failed'
        : status === 'cancelled'
          ? 'failed'
          : 'completed';
    this.append(
      identity.userId,
      identity.sessionId,
      [
        this.event('turn.ended', { turnId, eventId, status, reason }),
        this.event('conversation.exchange.completed', { exchangeId, eventId, turnId, status }),
        this.event('conversation.event.status-changed', { eventId, status: eventStatus }),
      ],
      true,
    );
    await Promise.resolve();
  }

  private async generateModelResponse(
    adapter: LlmAdapter,
    request: Parameters<LlmAdapter['generate']>[0],
    signal: AbortSignal,
    onTextDelta: (chunk: string, chunkIndex: number) => void,
    onReasoningDelta: (chunk: string, chunkIndex: number) => void,
    onMetadata: (phase: AssistantMessagePhase) => void,
  ): Promise<ModelResponse> {
    if (!adapter.stream) return validateModelResponse(await adapter.generate(request, signal));
    let completed: ModelResponse | undefined;
    let chunkIndex = 0;
    let reasoningChunkIndex = 0;
    let phase: AssistantMessagePhase | undefined;
    for await (const event of adapter.stream(request, signal)) {
      if (event.type === 'message_metadata') {
        phase = event.phase;
        onMetadata(phase);
      } else if (event.type === 'text_delta') {
        onTextDelta(event.delta, chunkIndex);
        chunkIndex += 1;
      } else if (event.type === 'reasoning_delta') {
        onReasoningDelta(event.delta, reasoningChunkIndex);
        reasoningChunkIndex += 1;
      } else if (event.type === 'completed') {
        completed = event.response;
      }
    }
    if (!completed) throw new Error('MODEL_STREAM_INCOMPLETE');
    return validateModelResponse({ ...completed, ...(completed.phase || !phase ? {} : { phase }) });
  }

  private outputReservationTokens(model: ModelSnapshot): number {
    return model.maxOutputTokens > 0 ? model.maxOutputTokens : this.reservedOutputTokens;
  }

  private async compactBusinessMemoryIfNeeded(
    identity: DriverIdentity,
    turnId: string,
    eventId: string,
    model: ModelSnapshot,
    adapter: NonNullable<ReturnType<LlmAdapterRegistry['get']>>,
    signal: AbortSignal,
    availableTools: readonly ModelToolDefinition[],
    permissionPreset: PermissionPreset,
  ): Promise<void> {
    const projection = this.load(identity.userId, identity.sessionId);
    const event = projection.events.get(eventId);
    if (!event) return;
    const skills = this.repos.skills.listInstallations(identity.userId);
    const measurement = this.contextProjector.measureFull({
      userId: identity.userId,
      projection,
      eventId,
      turnId,
      contextWindow: model.contextWindow,
      inputCapability: model.inputCapability,
      reservedOutputTokens: this.outputReservationTokens(model),
      safetyTokens: this.safetyTokens,
      tools: availableTools,
      skills,
      permissionPreset,
    });
    const trigger = Math.min(
      measurement.hardInputLimitTokens,
      Math.floor(
        model.contextWindow * (model.compactionTriggerRatio ?? this.memoryCompactionTriggerRatio),
      ),
    );
    if (measurement.estimatedInputTokens < trigger) return;
    const visible = projection.messages.filter(
      (message) => message.turnId !== turnId && isHistoricalConversationMessage(message),
    );
    const sessionMemory = projection.sessionMemorySummary;
    const sessionCandidates = visible.filter(
      (message) => message.seq > (sessionMemory?.coveredThroughSeq ?? 0),
    );
    const eventCandidates = visible.filter(
      (message) => message.eventId === eventId && message.seq > event.summaryThroughSeq,
    );
    const summarize = async (
      title: string,
      oldSummary: string | null,
      candidates: typeof visible,
    ) => {
      if (!oldSummary && candidates.length === 0) return null;
      const response = validateModelResponse(
        await adapter.generate(
          {
            requestId: this.ids.newId(),
            purpose: 'compaction',
            model,
            messages: [
              {
                role: 'system',
                content:
                  '压缩为可继续执行任务的中文记忆。仅保留事实、决定、约束、用户偏好、关键结果和未完成事项，不推测。',
              },
              {
                role: 'user',
                content: `${title}\n已有摘要：${oldSummary ?? '无'}\n新增问答：\n${candidates
                  .map((message) => `${message.role}: ${message.content}`)
                  .join('\n')}`,
              },
            ],
            tools: [],
            maxOutputTokens: Math.min(2048, model.maxOutputTokens),
          },
          signal,
        ),
      );
      return response.content.trim() ? response : null;
    };
    try {
      const [sessionResponse, eventResponse] = await Promise.all([
        summarize('会话整体记忆', sessionMemory?.summary ?? null, sessionCandidates),
        summarize('当前事件细节', event.summary, eventCandidates),
      ]);
      const latest = this.load(identity.userId, identity.sessionId);
      const updates: AppendEventInput[] = [];
      if (
        sessionResponse &&
        (latest.sessionMemorySummary?.summaryVersion ?? 0) === (sessionMemory?.summaryVersion ?? 0)
      ) {
        updates.push(
          this.event('session.memory.summary-updated', {
            summary: sessionResponse.content,
            summaryVersion: (sessionMemory?.summaryVersion ?? 0) + 1,
            coveredThroughSeq:
              sessionCandidates.at(-1)?.seq ?? sessionMemory?.coveredThroughSeq ?? 1,
            summaryTokens: estimateTextTokens(sessionResponse.content),
            inputTokens: sessionResponse.usage.inputTokens,
            outputTokens: sessionResponse.usage.outputTokens,
          }),
        );
      }
      if (eventResponse && latest.events.get(eventId)?.summaryVersion === event.summaryVersion) {
        updates.push(
          this.event('conversation.event.summary-updated', {
            eventId,
            summary: eventResponse.content,
            summaryVersion: event.summaryVersion + 1,
            coveredThroughSeq: eventCandidates.at(-1)?.seq ?? event.summaryThroughSeq,
            inputTokens: eventResponse.usage.inputTokens,
            outputTokens: eventResponse.usage.outputTokens,
          }),
        );
      }
      if (updates.length > 0) this.append(identity.userId, identity.sessionId, updates, true);
    } catch (error) {
      this.logger.warn('business memory compaction failed; continuing', {
        userId: identity.userId,
        sessionId: identity.sessionId,
        errorCode: errorCodeOf(error),
      });
    }
  }

  private async compactSurfaceIfNeeded(
    identity: DriverIdentity,
    turnId: string,
    eventId: string,
    model: ModelSnapshot,
    adapter: NonNullable<ReturnType<LlmAdapterRegistry['get']>>,
    signal: AbortSignal,
    availableTools: readonly ModelToolDefinition[],
    permissionPreset: PermissionPreset,
    force = false,
  ): Promise<boolean> {
    let changed = false;
    try {
      for (let attempt = 0; attempt <= this.compactionRetries; attempt += 1) {
        let projection = this.load(identity.userId, identity.sessionId);
        const revisions = this.repos.users.getRevisions(identity.userId);
        const measurementInput = {
          userId: identity.userId,
          eventId,
          turnId,
          contextWindow: model.contextWindow,
          inputCapability: model.inputCapability,
          reservedOutputTokens: this.outputReservationTokens(model),
          safetyTokens: this.safetyTokens,
          tools: availableTools,
          skills: this.repos.skills.listInstallations(identity.userId),
          permissionPreset,
          promptEpoch: SYSTEM_PROMPT_REVISION + revisions.skillRevision + revisions.mcpRevision,
        };
        let measurement = this.contextProjector.measureFull({
          projection,
          ...measurementInput,
        });
        const trigger = Math.min(
          measurement.hardInputLimitTokens,
          Math.floor(
            model.contextWindow *
              (model.compactionTriggerRatio ?? this.surfaceCompactionTriggerRatio),
          ),
        );
        if (!force && measurement.estimatedInputTokens < trigger) break;
        const shadowed = new Set(
          projection.surfaceReplacements.flatMap((replacement) => replacement.shadowedSeqs),
        );
        for (const message of projection.messages.filter(
          (candidate) =>
            candidate.turnId === turnId &&
            candidate.role === 'tool' &&
            !shadowed.has(candidate.seq),
        )) {
          const pruned = pruneToolResultText(message.content);
          if (!pruned) continue;
          this.append(
            identity.userId,
            identity.sessionId,
            [
              this.event('surface.replaced', {
                compactionId: this.ids.newId(),
                eventId,
                turnId,
                kind: 'tool-prune',
                surfaceGeneration: projection.surfaceReplacements.length + 1,
                shadowedSeqs: [message.seq],
                checkpointText: pruned,
                replacementRole: 'tool',
                toolCallId: message.toolCallId,
                tokensBefore: estimateTextTokens(message.content),
                tokensAfter: estimateTextTokens(pruned),
              }),
            ],
            true,
          );
          changed = true;
          projection = this.load(identity.userId, identity.sessionId);
        }
        measurement = this.contextProjector.measureFull({
          projection,
          ...measurementInput,
        });
        if (!force && measurement.estimatedInputTokens < trigger) break;
        const retainTokens = force ? 0 : Math.floor(trigger * 0.16);
        const candidates = selectCheckpointMessages(
          projection,
          turnId,
          Math.max(1, measurement.estimatedInputTokens - retainTokens),
        );
        if (candidates.length === 0) break;
        const compactionId = this.ids.newId();
        this.append(
          identity.userId,
          identity.sessionId,
          [
            this.event('compaction.started', {
              compactionId,
              eventId,
              turnId,
              fromSeq: candidates[0]!.seq,
              throughSeq: candidates.at(-1)!.seq,
            }),
          ],
          true,
        );
        const tokensBefore = candidates.reduce(
          (sum, candidate) => sum + estimateTextTokens(candidate.content),
          0,
        );
        let response: ModelResponse;
        try {
          response = validateModelResponse(
            await adapter.generate(
              {
                requestId: this.ids.newId(),
                purpose: 'compaction',
                model,
                messages: [
                  {
                    role: 'system',
                    content:
                      '生成运行检查点，只保留任务目标、已完成工作、关键工具结果、失败和下一步。',
                  },
                  {
                    role: 'user',
                    content: candidates
                      .map((message) => `${message.role}: ${message.content}`)
                      .join('\n'),
                  },
                ],
                tools: [],
                maxOutputTokens: Math.min(2048, model.maxOutputTokens),
              },
              signal,
            ),
          );
        } catch (error) {
          this.append(
            identity.userId,
            identity.sessionId,
            [
              this.event('compaction.ended', {
                compactionId,
                eventId,
                status: 'failed',
                errorCode: errorCodeOf(error),
              }),
            ],
            true,
          );
          throw error;
        }
        const checkpointText = response.content.trim();
        const tokensAfter = estimateTextTokens(checkpointText);
        const latestProjection = this.load(identity.userId, identity.sessionId);
        const latestShadowed = new Set(
          latestProjection.surfaceReplacements.flatMap((replacement) => replacement.shadowedSeqs),
        );
        const generationUnchanged =
          latestProjection.surfaceReplacements.length === projection.surfaceReplacements.length &&
          latestProjection.lastSeq === projection.lastSeq + 1;
        if (
          !checkpointText ||
          tokensAfter >= tokensBefore ||
          !generationUnchanged ||
          candidates.some((candidate) => latestShadowed.has(candidate.seq))
        ) {
          this.append(
            identity.userId,
            identity.sessionId,
            [
              this.event('compaction.ended', {
                compactionId,
                eventId,
                status: 'failed',
                errorCode: 'COMPACTION_NO_PROGRESS',
              }),
            ],
            true,
          );
          break;
        }
        this.append(
          identity.userId,
          identity.sessionId,
          [
            this.event('surface.replaced', {
              compactionId,
              eventId,
              turnId,
              kind: 'checkpoint',
              surfaceGeneration: projection.surfaceReplacements.length + 1,
              shadowedSeqs: candidates.map((candidate) => candidate.seq),
              checkpointText,
              replacementRole: 'system',
              tokensBefore,
              tokensAfter,
            }),
            this.event('compaction.ended', { compactionId, eventId, status: 'completed' }),
          ],
          true,
        );
        changed = true;
        force = false;
      }
    } catch (error) {
      this.logger.warn('surface compaction failed; continuing', {
        userId: identity.userId,
        sessionId: identity.sessionId,
        errorCode: errorCodeOf(error),
      });
    }
    return changed;
  }

  private async authorizeToolCall(
    call: ScheduledToolCall,
    tool: RuntimeTool<unknown>,
    context: Omit<ToolExecutionContext, 'toolCallId'>,
  ): Promise<ApprovalResolution | 'not-required'> {
    if (context.permissionPreset === 'full-access') {
      return 'not-required';
    }
    const configuredPolicy = tool.resolveApprovalPolicy
      ? tool.resolveApprovalPolicy(call.arguments, context)
      : (tool.approvalPolicy ?? 'never');
    const policy =
      context.permissionPreset === 'approval-required' && tool.approvalScope === 'external'
        ? 'always'
        : configuredPolicy;
    if (policy === 'never') return 'not-required';
    const toolIdentity = tool.permissionIdentity ?? ['tool', tool.name].join(':');
    const approvalId = this.ids.newId();
    const argumentsDigest = createHash('sha256').update(safeJson(call.arguments)).digest('hex');
    this.append(
      context.userId as LocalUserId,
      context.sessionId,
      [
        this.event('approval.requested', {
          approvalId,
          toolCallId: call.id,
          toolName: tool.name,
          toolIdentity,
          argumentsDigest,
          eventId: context.eventId,
          turnId: context.turnId,
          stepId: context.stepId,
          policy,
          presentation: presentToolCall(tool, call.arguments) ?? null,
        }),
      ],
      true,
    );
    return new Promise<ApprovalResolution>((resolve) => {
      let settled = false;
      const finish = (resolution: ApprovalResolution) => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        resolve(resolution);
      };
      const onAbort = () => {
        this.pendingApprovals.delete(approvalId);
        try {
          this.append(
            context.userId as LocalUserId,
            context.sessionId,
            [
              this.event('approval.resolved', {
                approvalId,
                toolIdentity,
                resolution: 'cancelled',
              }),
            ],
            true,
          );
        } catch {
          // Turn cancellation remains authoritative if the approval audit cannot be appended.
        }
        finish('cancelled');
      };
      this.pendingApprovals.set(approvalId, {
        userId: context.userId as LocalUserId,
        sessionId: context.sessionId,
        toolIdentity,
        resolve: finish,
      });
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private append(
    userId: LocalUserId,
    sessionId: string,
    events: readonly AppendEventInput[],
    requireLease = false,
  ): void {
    let conflict: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const session = this.requireSession(userId, sessionId);
      const candidate = cloneRuntimeProjection(this.load(userId, sessionId));
      for (const [index, event] of events.entries()) {
        applyRuntimeEvent(candidate, {
          userId,
          sessionId,
          seq: session.nextSeq + index,
          eventId: event.eventId,
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          occurredAt: event.occurredAt,
          requestId: event.requestId ?? null,
          idempotencyKey: event.idempotencyKey ?? null,
          payload: event.payload,
        });
      }
      try {
        const result = this.repos.sessions.append({
          userId,
          sessionId,
          expectedVersion: session.version,
          events,
          leaseOwner: requireLease ? this.workerId : undefined,
        });
        const committed = this.repos.sessions
          .readEventsAfter(userId, sessionId, result.fromSeq - 1)
          .filter((event) => event.seq <= result.toSeq);
        this.projectionCache.set(keyOf(userId, sessionId), candidate);
        this.syncProjection(userId, sessionId, committed);
        try {
          this.onEventsAppended({
            userId,
            sessionId,
            fromSeq: result.fromSeq,
            toSeq: result.toSeq,
            events: committed,
          });
        } catch {
          this.logger.warn('session event notification failed', { userId, sessionId });
        }
        return;
      } catch (error) {
        if (error instanceof BridgeError && error.code === 'REVISION_CONFLICT') {
          conflict = error;
          continue;
        }
        throw error;
      }
    }
    throw conflict ?? new BridgeError('REVISION_CONFLICT', 'Session version conflict');
  }

  private syncProjection(
    userId: LocalUserId,
    sessionId: string,
    events: readonly SessionLogEvent[],
  ): void {
    try {
      this.repos.projections.applyBatch(userId, sessionId, events, this.clock.nowIso());
    } catch (error) {
      this.logger.warn('projection rebuild deferred', {
        userId,
        sessionId,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
  }

  private event(
    eventType: RuntimeEventType,
    payload: unknown,
    requestId: string | null = null,
    idempotencyKey: string | null = null,
  ): AppendEventInput {
    validateAndUpcastRuntimeEvent(eventType, RUNTIME_EVENT_SCHEMA_VERSION, payload);
    return {
      eventId: this.ids.newId(),
      eventType,
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      occurredAt: this.clock.nowIso(),
      requestId,
      idempotencyKey,
      payload,
    };
  }

  private load(userId: LocalUserId, sessionId: string): RuntimeProjection {
    const session = this.requireSession(userId, sessionId);
    const key = keyOf(userId, sessionId);
    const cached = this.projectionCache.get(key);
    if (!cached) {
      const created = projectRuntime(this.repos.sessions.listEvents(userId, sessionId));
      this.projectionCache.set(key, created);
      return created;
    }
    if (cached.lastSeq < session.nextSeq - 1) {
      for (const event of this.repos.sessions.readEventsAfter(userId, sessionId, cached.lastSeq)) {
        applyRuntimeEvent(cached, event);
      }
    }
    return cached;
  }

  private requireSession(userId: LocalUserId, sessionId: string) {
    const session = this.repos.sessions.getSession(userId, sessionId);
    if (!session) throw new BridgeError('INVALID_REQUEST', 'Session not found');
    return session;
  }

  private requireActiveSession(userId: LocalUserId, sessionId: string): void {
    if (this.requireSession(userId, sessionId).status !== 'active') {
      throw new BridgeError('INVALID_REQUEST', 'Session is archived');
    }
  }

  private duplicateInputResult(
    event: SessionLogEvent,
    expectedContent: string,
  ): { inboxItemId: string; duplicate: true; scope: 'next-turn' | 'next-step' } {
    const parsed = inboxSplicedPayloadSchema.safeParse(event.payload);
    const operation = parsed.success
      ? parsed.data.operations.find((candidate) => candidate.op === 'insert')
      : undefined;
    if (!operation || operation.op !== 'insert' || operation.item.content !== expectedContent) {
      throw new BridgeError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used by another request');
    }
    return { inboxItemId: operation.item.id, duplicate: true, scope: operation.item.scope };
  }

  private acquireLease(identity: DriverIdentity): boolean {
    const now = this.clock.now();
    return this.repos.sessions.acquireLease({
      ...identity,
      owner: this.workerId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    });
  }

  private renewLease(identity: DriverIdentity): void {
    const expiresAt = new Date(this.clock.now().getTime() + this.leaseDurationMs).toISOString();
    if (!this.repos.sessions.renewLease({ ...identity, owner: this.workerId, expiresAt })) {
      throw new BridgeError('SESSION_BUSY', 'Session lease was lost');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new BridgeError('RUNTIME_UNAVAILABLE', 'Runtime is closed');
  }

  private async acquireSessionSlot(): Promise<void> {
    if (this.activeSessionCount < this.maxParallelSessions) {
      this.activeSessionCount += 1;
      return;
    }
    await new Promise<void>((resolve) => this.sessionWaiters.push(resolve));
    this.activeSessionCount += 1;
  }

  private releaseSessionSlot(): void {
    this.activeSessionCount = Math.max(0, this.activeSessionCount - 1);
    this.sessionWaiters.shift()?.();
  }
}

function cancelNextStepOperations(
  projection: RuntimeProjection,
  keep: boolean,
): Array<{ op: 'remove'; itemId: string } | { op: 'insert'; item: InboxItem }> {
  return projection.inbox
    .filter((item) => item.scope === 'next-step')
    .flatMap((item) => [
      { op: 'remove' as const, itemId: item.id },
      ...(keep
        ? [
            {
              op: 'insert' as const,
              item: { ...item, scope: 'next-turn' as const, startNewEvent: false },
            },
          ]
        : []),
    ]);
}

function validInteractionValue(
  interaction: RuntimeProjection['interactions'] extends Map<string, infer T> ? T : never,
  value: unknown,
): boolean {
  if (interaction.questions.length > 0) {
    const answers = asRecord(value);
    return Boolean(
      answers &&
      interaction.questions.every((question) => {
        const answer = answers[question.id];
        return typeof answer === 'string' && answer.trim().length > 0;
      }),
    );
  }
  if (interaction.kind === 'confirm' || interaction.kind === 'approval') {
    return typeof value === 'boolean';
  }
  if (interaction.kind === 'select' || interaction.kind === 'selection') {
    return typeof value === 'string' && value.trim().length > 0;
  }
  if (interaction.kind === 'form') {
    return matchesJsonSchema(value, interaction.schema ?? { type: 'object' });
  }
  return typeof value === 'string' && value.trim().length > 0;
}

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const allowed = schema.enum;
  if (
    Array.isArray(allowed) &&
    !allowed.some((candidate) => safeJson(candidate) === safeJson(value))
  ) {
    return false;
  }
  const type = schema.type;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const itemSchema = asRecord(schema.items);
    return !itemSchema || value.every((item) => matchesJsonSchema(item, itemSchema));
  }
  if (type === 'object' || schema.properties !== undefined || schema.required !== undefined) {
    const object = asRecord(value);
    if (!object) return false;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    if (required.some((key) => !(key in object))) return false;
    const properties = asRecord(schema.properties);
    if (!properties) return true;
    return Object.entries(properties).every(([key, propertySchema]) => {
      if (!(key in object)) return true;
      const parsed = asRecord(propertySchema);
      return !parsed || matchesJsonSchema(object[key], parsed);
    });
  }
  return true;
}

function keyOf(userId: LocalUserId, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return 'null';
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof BridgeError) return error.code.toLowerCase();
  if (error instanceof Error) return error.name.toLowerCase();
  return 'unknown_error';
}

function serializeProjection(session: unknown, projection: RuntimeProjection): unknown {
  return {
    session,
    lastSeq: projection.lastSeq,
    inbox: projection.inbox,
    conversationEvents: [...projection.events.values()],
    turns: [...projection.turns.values()],
    messages: projection.messages,
    interactions: [...projection.interactions.values()],
    approvals: [...projection.approvals.values()],
    permissionGrants: [...projection.permissionGrants],
    trajectory: {
      steps: [...projection.steps.values()],
      toolCalls: [...projection.toolCalls.values()],
    },
    streaming: [...projection.streams.values()],
    reasoning: [...projection.reasoning.values()],
    relations: projection.relations,
    usage: projection.usage,
    sessionMemorySummary: projection.sessionMemorySummary,
    surfaceReplacements: projection.surfaceReplacements,
    activeTurnId: projection.activeTurn?.id ?? null,
    throughSeq: projection.lastSeq,
  };
}

function unresolvedToolCalls(
  events: readonly SessionLogEvent[],
  turnId: string,
): Array<{ toolCallId: string; toolName: string; callIndex: number }> {
  const calls = new Map<string, { toolCallId: string; toolName: string; callIndex: number }>();
  const completed = new Set<string>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (stringAt(payload, 'turnId') !== turnId) continue;
    const toolCallId = stringAt(payload, 'toolCallId');
    if (!toolCallId) continue;
    if (event.eventType === 'tool.call') {
      calls.set(toolCallId, {
        toolCallId,
        toolName: stringAt(payload, 'toolName') ?? 'unknown',
        callIndex: numberAt(payload, 'callIndex') ?? 0,
      });
    } else if (event.eventType === 'tool.result') {
      completed.add(toolCallId);
    }
  }
  return [...calls.values()].filter((call) => !completed.has(call.toolCallId));
}

function presentToolCall(tool: RuntimeTool | undefined, args: unknown): unknown {
  try {
    return tool?.presentCall?.(args);
  } catch {
    return undefined;
  }
}

function toolSchemaDigest(schema: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function redactDiagnosticEvent(event: SessionLogEvent): SessionLogEvent {
  const payload = asRecord(event.payload);
  if (!payload) return event;
  if (
    event.eventType === 'user.message' ||
    event.eventType === 'assistant.message' ||
    event.eventType === 'assistant.message.metadata' ||
    event.eventType === 'assistant.chunk' ||
    event.eventType === 'assistant.reasoning.chunk' ||
    event.eventType === 'assistant.reasoning'
  ) {
    return { ...event, payload: { ...payload, content: '[redacted]' } };
  }
  if (event.eventType === 'tool.call') {
    return { ...event, payload: { ...payload, input: '[redacted]' } };
  }
  if (event.eventType === 'tool.result') {
    return {
      ...event,
      payload: {
        ...payload,
        output: '[redacted]',
        meta: '[redacted]',
        executionFacts: '[redacted]',
      },
    };
  }
  if (event.eventType === 'session.created' || event.eventType === 'conversation.event.created') {
    return { ...event, payload: { ...payload, title: '[redacted]' } };
  }
  if (
    event.eventType === 'conversation.event.summary-updated' ||
    event.eventType === 'compaction.summary-updated'
  ) {
    return { ...event, payload: { ...payload, summary: '[redacted]' } };
  }
  if (event.eventType === 'interaction.requested') {
    return {
      ...event,
      payload: {
        ...payload,
        prompt: '[redacted]',
        options: '[redacted]',
        questions: '[redacted]',
        schema: '[redacted]',
      },
    };
  }
  if (event.eventType === 'interaction.resolved') {
    return { ...event, payload: { ...payload, value: '[redacted]' } };
  }
  if (event.eventType === 'model.request.context') {
    const model = asRecord(payload.model);
    return {
      ...event,
      payload: {
        ...payload,
        model: model
          ? { ...model, endpoint: '[redacted]', credentialRef: '[redacted]', params: '[redacted]' }
          : '[redacted]',
      },
    };
  }
  if (event.eventType === 'agent.inbox.spliced') {
    const parsed = inboxSplicedPayloadSchema.safeParse(payload);
    if (!parsed.success) return event;
    return {
      ...event,
      payload: {
        ...parsed.data,
        operations: parsed.data.operations.map((operation) =>
          operation.op === 'insert'
            ? { ...operation, item: { ...operation.item, content: '[redacted]' } }
            : operation.op === 'replace'
              ? { ...operation, content: '[redacted]' }
              : operation,
        ),
      },
    };
  }
  return event;
}
