import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
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
import type {
  AgentExecutionConfigSnapshot,
  RuntimeTool,
  ScheduledToolCall,
  ToolExecutionContext,
  ToolRegistry,
} from './tools';
import { ToolExecutionError, ToolScheduler } from './tools';
import { pruneToolResultText, selectCheckpointMessages } from './surface-compactor';
import { modelToolsForPermission } from './permission-tool-policy';
import type { AgentCallResult } from './delegation/agent-call-tool';
import {
  DEFAULT_AGENT_ID,
  type AgentDelegation,
  type DelegationStatus,
} from '../shared/domain/agent';
import {
  isAgentMemoryProfileReady,
  readAgentMemoryProfile,
} from '../infrastructure/workspace/agent-memory-profile';
import {
  sessionArtifactsPath,
  sessionWorkspacePath,
} from '../infrastructure/workspace/session-workspace';
import { listCapabilityCandidates } from './capability-discovery';
import type { SkillInstallation } from '../shared/domain/skill';

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
  resolveModel(userId: LocalUserId, agentId: string): ModelSnapshot;
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
  private readonly appDataDir: string;
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
  private readonly delegationWaiters = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(deps: RuntimeServiceDeps) {
    this.appDataDir = deps.appDataDir;
    this.contextProjector = new ContextProjector();
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

  createSession(
    userId: LocalUserId,
    input: { sessionId?: string; agentId?: string; title: string },
  ): unknown {
    this.assertOpen();
    const agent = this.resolveAgent(userId, input.agentId ?? DEFAULT_AGENT_ID);
    const sessionId = input.sessionId ?? this.ids.newId();
    const existing = this.repos.sessions.getSession(userId, sessionId);
    if (existing) {
      if (existing.title !== input.title || existing.agentId !== agent.id) {
        throw new BridgeError(
          'IDEMPOTENCY_CONFLICT',
          'Session id was used with another title or agent',
        );
      }
      return existing;
    }
    const now = this.clock.nowIso();
    const session = this.repos.sessions.createSession({
      id: sessionId,
      userId,
      title: input.title,
      agentId: agent.id,
      origin: 'direct',
      parentSessionId: null,
      permissionPreset: agent.permissionPreset,
      now,
    });
    this.append(userId, sessionId, [
      this.event('session.created', {
        sessionId,
        title: input.title,
        agentId: agent.id,
        origin: 'direct',
        parentSessionId: null,
        allowSharedMemory: false,
      }),
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
    const delegatedApprovalSession = this.delegatedSessionForApproval(
      userId,
      input.sessionId,
      input.approvalId,
    );
    if (delegatedApprovalSession) {
      return this.resolveApproval(userId, {
        ...input,
        sessionId: delegatedApprovalSession,
      });
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
    const session = this.requireActiveSession(userId, input.sessionId);
    if (!isAgentMemoryProfileReady(this.appDataDir, userId, session.agentId)) {
      throw new BridgeError(
        'CONFIGURATION_INVALID',
        'Agent memory profile is not initialized; retry initialization before starting a turn',
      );
    }
    const duplicate = this.repos.sessions.findByIdempotencyKey(
      userId,
      input.sessionId,
      input.idempotencyKey,
    );
    if (duplicate) return this.duplicateInputResult(duplicate, input.content);
    const model = this.resolveModel(userId, session.agentId);
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
    const delegatedInteractionSession = this.delegatedSessionForInteraction(
      userId,
      input.sessionId,
      input.interactionId,
    );
    if (delegatedInteractionSession) {
      return this.resolveInteraction(userId, {
        ...input,
        sessionId: delegatedInteractionSession,
      });
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
      const model = this.resolveModel(userId, this.requireSession(userId, input.sessionId).agentId);
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

  /**
   * 仅供已鉴权的会话事件流补齐断点使用。
   *
   * `eventsPage` 是面向诊断查询的脱敏视图，不能用于恢复 Renderer 的实时投影，
   * 否则重连或 Snapshot/订阅之间的竞态会用 `[redacted]` 覆盖真实消息。
   */
  replayEventsPage(
    userId: LocalUserId,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): { items: SessionLogEvent[]; nextAfterSeq: number | null } {
    this.requireSession(userId, sessionId);
    const page = this.repos.sessions.readEventsAfter(userId, sessionId, afterSeq).slice(0, limit);
    return {
      items: page,
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
      for (const delegation of this.repos.delegations.listNonTerminal(user.id)) {
        const child = this.load(user.id, delegation.delegatedSessionId);
        if (
          child.activeTurn ||
          child.inbox.length > 0 ||
          [...child.interactions.values()].some((interaction) => interaction.status === 'pending')
        ) {
          continue;
        }
        const latestTurn = [...child.turns.values()].at(-1);
        const completedMessage = latestTurn
          ? delegatedFinalReport(child, latestTurn.id)
          : undefined;
        const recoveredStatus: Exclude<DelegationStatus, 'accepted'> =
          latestTurn?.status === 'completed' && completedMessage
            ? 'completed'
            : latestTurn?.status === 'failed' || latestTurn?.status === 'completed'
              ? 'failed'
              : latestTurn?.status === 'cancelled'
                ? 'cancelled'
                : 'interrupted';
        this.setDelegationStatus(
          delegation,
          recoveredStatus,
          completedMessage?.eventId ?? null,
          completedMessage?.content,
        );
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

  async delegateAgent(
    context: ToolExecutionContext,
    input: { targetAgentId: string; task: string; allowSharedMemory: boolean },
  ): Promise<AgentCallResult> {
    const userId = context.userId as LocalUserId;
    const parent = this.requireActiveSession(userId, context.sessionId);
    if (parent.origin !== 'direct') {
      throw new BridgeError('NESTED_DELEGATION_NOT_ALLOWED', 'Delegated sessions cannot delegate');
    }
    if (parent.agentId !== context.agentId) {
      throw new BridgeError('DELEGATION_NOT_ALLOWED', 'Agent execution scope mismatch');
    }
    const existing = this.repos.delegations.getByToolCall(userId, context.toolCallId);
    if (existing) return this.delegationResult(existing);
    if (
      context.executionConfig &&
      !context.executionConfig.delegateAgentIds.includes(input.targetAgentId)
    ) {
      throw new BridgeError(
        'DELEGATION_NOT_ALLOWED',
        'Agent delegation was not authorized in this Step snapshot',
      );
    }
    if (!this.repos.agents.canDelegate(userId, parent.agentId, input.targetAgentId)) {
      throw new BridgeError('DELEGATION_NOT_ALLOWED', 'Agent delegation is not authorized');
    }
    if (this.repos.delegations.countActiveForTurn(userId, parent.id, context.turnId) >= 3) {
      throw new BridgeError('DELEGATION_LIMIT', 'This turn already has three active delegations');
    }

    const target = this.repos.agents.requireActive(userId, input.targetAgentId);
    const delegationId = this.ids.newId();
    const delegatedSessionId = this.ids.newId();
    const now = this.clock.nowIso();
    const deadline = new Date(this.clock.now().getTime() + 10 * 60_000).toISOString();
    // A delegated session is the execution trace of the caller's agent_call, not a new
    // user-owned conversation. Freeze the caller Step's authority for the child run;
    // the target profile's preset still applies when that Agent is opened directly.
    const permissionPreset = context.permissionPreset;
    this.repos.transaction(() => {
      this.repos.sessions.createSession({
        id: delegatedSessionId,
        userId,
        title: input.task.slice(0, 80),
        agentId: target.id,
        origin: 'delegated',
        parentSessionId: parent.id,
        permissionPreset,
        now,
      });
      this.append(userId, delegatedSessionId, [
        this.event('session.created', {
          sessionId: delegatedSessionId,
          title: input.task.slice(0, 80),
          agentId: target.id,
          origin: 'delegated',
          parentSessionId: parent.id,
          allowSharedMemory: input.allowSharedMemory,
        }),
      ]);
      this.repos.delegations.create({
        id: delegationId,
        userId,
        parentSessionId: parent.id,
        parentTurnId: context.turnId,
        parentToolCallId: context.toolCallId,
        delegatedSessionId,
        targetAgentId: target.id,
        status: 'accepted',
        deadline,
        resultEventRef: null,
        createdAt: now,
        updatedAt: now,
      });
    });
    const delegation = this.repos.delegations.get(userId, delegationId)!;
    this.append(userId, parent.id, [
      this.event('agent.delegation.accepted', {
        delegationId,
        parentTurnId: context.turnId,
        parentToolCallId: context.toolCallId,
        delegatedSessionId,
        targetAgentId: target.id,
        callerAgentName: this.repos.agents.get(userId, parent.agentId)?.name ?? parent.agentId,
        targetAgentName: target.name,
        status: 'accepted',
      }),
    ]);
    this.setDelegationStatus(delegation, 'running', null);
    this.submitInput(userId, {
      sessionId: delegatedSessionId,
      content: input.task,
      idempotencyKey: `delegation:${delegationId}`,
      startNewEvent: true,
    });
    try {
      while (true) {
        await this.waitForSessionIdle(userId, delegatedSessionId, context.signal);
        const child = this.load(userId, delegatedSessionId);
        const awaitingInteraction = [...child.interactions.values()].some(
          (interaction) => interaction.status === 'pending',
        );
        if (!awaitingInteraction) break;
        this.setDelegationStatus(delegation, 'awaiting_user', null);
        await this.waitForDelegatedInput(userId, delegatedSessionId, context.signal);
        this.setDelegationStatus(delegation, 'running', null);
      }
    } catch (error) {
      const child = this.load(userId, delegatedSessionId);
      if (child.activeTurn) {
        this.cancelTurn(userId, delegatedSessionId, child.activeTurn.id, {
          keepNextTurn: false,
          keepNextStep: false,
          reason: 'parent_cancelled',
        });
      } else {
        for (const interaction of child.interactions.values()) {
          if (interaction.status !== 'pending') continue;
          this.resolveInteraction(userId, {
            sessionId: delegatedSessionId,
            interactionId: interaction.id,
            resolution: 'cancelled',
            idempotencyKey: `delegation-cancel:${delegationId}:${interaction.id}`,
          });
        }
        for (const item of child.inbox) this.removeInboxItem(userId, delegatedSessionId, item.id);
      }
      this.setDelegationStatus(delegation, 'cancelled', null);
      throw new ToolExecutionError(
        'DELEGATION_CANCELLED',
        'cancelled',
        undefined,
        error instanceof Error ? error.message : 'Parent delegation was cancelled',
      );
    }
    return this.delegationResult(this.repos.delegations.get(userId, delegationId) ?? delegation);
  }

  private async delegationResult(delegation: AgentDelegation): Promise<AgentCallResult> {
    const projection = this.load(delegation.userId, delegation.delegatedSessionId);
    const latestTurn = [...projection.turns.values()].at(-1);
    const reportMessage = latestTurn ? delegatedFinalReport(projection, latestTurn.id) : undefined;
    const report = this.sanitizeDelegatedReport(
      delegation,
      reportMessage?.content.slice(0, 32 * 1024) ?? '',
    );
    if (delegation.status === 'completed' && report) {
      const locations = await this.materializeDelegatedArtifacts(delegation);
      return {
        delegationId: delegation.id,
        delegatedSessionId: delegation.delegatedSessionId,
        targetAgentId: delegation.targetAgentId,
        status: 'completed',
        report,
        locations,
      };
    }
    if (delegation.status === 'accepted' || delegation.status === 'running') {
      return {
        delegationId: delegation.id,
        delegatedSessionId: delegation.delegatedSessionId,
        targetAgentId: delegation.targetAgentId,
        status: 'awaiting_user',
        report: '受派智能体仍在执行。',
        locations: [],
      };
    }
    if (delegation.status === 'awaiting_user') {
      return {
        delegationId: delegation.id,
        delegatedSessionId: delegation.delegatedSessionId,
        targetAgentId: delegation.targetAgentId,
        status: 'awaiting_user',
        report: '受派智能体正在等待用户输入或批准。',
        locations: [],
      };
    }
    const missingFinalReport = latestTurn?.status === 'completed' && !report;
    const reason = missingFinalReport
      ? 'missing_final_answer'
      : (latestTurn?.endReason ?? delegation.status);
    const code =
      delegation.status === 'cancelled'
        ? 'DELEGATION_CANCELLED'
        : missingFinalReport || delegation.status === 'completed'
          ? 'DELEGATED_AGENT_NO_FINAL_REPORT'
          : 'DELEGATED_AGENT_FAILED';
    throw new ToolExecutionError(
      code,
      delegation.status === 'cancelled' ? 'cancelled' : 'fatal_error',
      {
        delegationId: delegation.id,
        delegatedSessionId: delegation.delegatedSessionId,
        targetAgentId: delegation.targetAgentId,
        delegationStatus: delegation.status,
        reason,
      },
      `受派智能体执行失败：${reason}`,
    );
  }

  private delegatedSessionForInteraction(
    userId: LocalUserId,
    parentSessionId: string,
    interactionId: string,
  ): string | undefined {
    return this.repos.delegations
      .listForParent(userId, parentSessionId)
      .find((delegation) =>
        this.load(userId, delegation.delegatedSessionId).interactions.has(interactionId),
      )?.delegatedSessionId;
  }

  private delegatedSessionForApproval(
    userId: LocalUserId,
    parentSessionId: string,
    approvalId: string,
  ): string | undefined {
    return this.repos.delegations
      .listForParent(userId, parentSessionId)
      .find((delegation) =>
        this.load(userId, delegation.delegatedSessionId).approvals.has(approvalId),
      )?.delegatedSessionId;
  }

  private setDelegationStatus(
    delegation: AgentDelegation,
    status: Exclude<DelegationStatus, 'accepted'>,
    resultEventRef: string | null,
    report?: string,
  ): void {
    const current = this.repos.delegations.get(delegation.userId, delegation.id);
    if (current?.status === status && current.resultEventRef === resultEventRef) return;
    if (current && isTerminalDelegationStatus(current.status)) return;
    const now = this.clock.nowIso();
    this.repos.transaction(() => {
      this.repos.delegations.updateStatus(
        delegation.userId,
        delegation.id,
        status,
        resultEventRef,
        now,
      );
      this.append(delegation.userId, delegation.parentSessionId, [
        this.event('agent.delegation.status-changed', {
          delegationId: delegation.id,
          status,
          resultEventRef,
          ...(report
            ? {
                report: this.sanitizeDelegatedReport(delegation, report).slice(0, 32 * 1024),
              }
            : {}),
        }),
      ]);
    });
  }

  private sanitizeDelegatedReport(delegation: AgentDelegation, report: string): string {
    if (!report) return report;
    const scope = {
      userId: delegation.userId,
      sessionId: delegation.delegatedSessionId,
    };
    const artifactsPrefix = `${sessionArtifactsPath(this.appDataDir, scope)}${path.sep}`;
    const workspacePrefix = `${sessionWorkspacePath(this.appDataDir, scope)}${path.sep}`;
    return report.replaceAll(artifactsPrefix, '').replaceAll(workspacePrefix, '');
  }

  private async materializeDelegatedArtifacts(
    delegation: AgentDelegation,
  ): Promise<Array<{ path: string }>> {
    const sourceRoot = sessionArtifactsPath(this.appDataDir, {
      userId: delegation.userId,
      sessionId: delegation.delegatedSessionId,
    });
    let files: string[];
    try {
      files = await listRegularFiles(sourceRoot);
    } catch (error) {
      this.logger.warn('delegated artifact discovery failed; continuing without file cards', {
        delegationId: delegation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    if (files.length === 0) return [];

    const relativeRoot = path.posix.join('artifacts', 'delegated', delegation.id);
    const targetRoot = path.join(
      sessionArtifactsPath(this.appDataDir, {
        userId: delegation.userId,
        sessionId: delegation.parentSessionId,
      }),
      'delegated',
      delegation.id,
    );
    const locations: Array<{ path: string }> = [];
    for (const relative of files) {
      const target = path.join(targetRoot, ...relative.split('/'));
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(sourceRoot, ...relative.split('/')), target);
        locations.push({ path: path.posix.join(relativeRoot, relative) });
      } catch (error) {
        this.logger.warn('delegated artifact copy failed; continuing', {
          delegationId: delegation.id,
          file: relative,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return locations;
  }

  private async waitForSessionIdle(
    userId: LocalUserId,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.running.get(keyOf(userId, sessionId));
    if (!task) return;
    if (signal.aborted) throw signal.reason ?? new Error('Operation aborted');
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Operation aborted'));
      signal.addEventListener('abort', abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async waitForDelegatedInput(
    userId: LocalUserId,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const hasPendingInteraction = () =>
      [...this.load(userId, sessionId).interactions.values()].some(
        (interaction) => interaction.status === 'pending',
      );
    if (!hasPendingInteraction()) return;
    if (signal.aborted) throw signal.reason ?? new Error('Operation aborted');
    await new Promise<void>((resolve, reject) => {
      const waiters = this.delegationWaiters.get(sessionId) ?? new Set<() => void>();
      let settled = false;
      const cleanup = () => {
        waiters.delete(finish);
        if (waiters.size === 0) this.delegationWaiters.delete(sessionId);
        signal.removeEventListener('abort', abort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal.reason ?? new Error('Operation aborted'));
      };
      waiters.add(finish);
      this.delegationWaiters.set(sessionId, waiters);
      signal.addEventListener('abort', abort, { once: true });
      if (!hasPendingInteraction()) finish();
    });
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pendingApprovals.values()) pending.resolve('unavailable');
    this.pendingApprovals.clear();
    for (const execution of this.active.values()) execution.controller.abort();
    for (const waiters of this.delegationWaiters.values()) {
      for (const wake of waiters) wake();
    }
    this.delegationWaiters.clear();
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
      const session = this.requireSession(identity.userId, identity.sessionId);
      while (true) {
        const before = this.load(identity.userId, identity.sessionId);
        if (before.turns.get(turnId)?.cancelRequested || controller.signal.aborted) {
          await this.endTurn(identity, turnId, eventId, exchangeId, 'cancelled', 'user_cancelled');
          return;
        }
        stepIndex += 1;
        const agent = this.resolveAgent(identity.userId, session.agentId);
        let model: ModelSnapshot;
        try {
          model = this.resolveModel(identity.userId, session.agentId);
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
        const permissionPreset = this.requireSession(
          identity.userId,
          identity.sessionId,
        ).permissionPreset;
        const revisions = this.repos.users.getRevisions(identity.userId);
        const agentProfile = this.repos.agents.requireActive(identity.userId, session.agentId);
        const bindings = this.repos.agents.listBindings(identity.userId, session.agentId);
        const boundSkillIds = new Set(bindings.skillIds);
        const skills = this.repos.skills
          .listInstallations(identity.userId)
          .filter(
            (skill) =>
              boundSkillIds.has(skill.id) &&
              skill.enabled &&
              skill.status === 'valid' &&
              skill.compatibilityStatus !== 'incompatible',
          );
        const validSkillIds = new Set(skills.map((skill) => skill.id));
        const capabilityCandidates = listCapabilityCandidates(
          this.repos,
          identity.userId,
          session.agentId,
          session.origin,
          { sessionId: session.id },
        );
        const fullAgentMemoryProfile = readAgentMemoryProfile(
          this.appDataDir,
          identity.userId,
          session.agentId,
        );
        const agentMemoryProfile = fullAgentMemoryProfile.slice(0, 32 * 1024);
        const agentMemoryDigest = createHash('sha256').update(fullAgentMemoryProfile).digest('hex');
        const validMcpCapabilities = new Set(
          capabilityCandidates
            .filter((candidate) => candidate.kind === 'mcp')
            .map((candidate) => candidate.capabilityId),
        );
        const validDelegateAgentIds = new Set(
          capabilityCandidates
            .filter((candidate) => candidate.kind === 'agent')
            .map((candidate) => candidate.capabilityId),
        );
        const mcpServers = new Map(
          this.repos.mcp.listServers(identity.userId).map((server) => [server.id, server] as const),
        );
        const mcpTools = this.repos.mcp.listTools(identity.userId);
        const validMcpBindings = bindings.mcp
          .filter((binding) =>
            validMcpCapabilities.has(`${binding.serverId}:${binding.accessScope}`),
          )
          .map((binding) => {
            const server = mcpServers.get(binding.serverId)!;
            const tools = mcpTools
              .filter(
                (tool) =>
                  tool.serverId === binding.serverId &&
                  tool.enabled &&
                  tool.reviewStatus === 'approved',
              )
              .map((tool) => [tool.publicName, tool.schemaDigest])
              .sort((left, right) => left[0]!.localeCompare(right[0]!));
            return {
              serverId: binding.serverId,
              accessScope: binding.accessScope,
              configDigest: createHash('sha256')
                .update(
                  safeJson({
                    transport: server.transport,
                    config: server.config,
                    credentialRef: server.credentialRef,
                    generation: server.generation,
                  }),
                )
                .digest('hex'),
              schemaDigest: createHash('sha256').update(safeJson(tools)).digest('hex'),
            };
          });
        const delegateAgentIds = bindings.delegateAgentIds.filter((agentId) =>
          validDelegateAgentIds.has(agentId),
        );
        const agentConfigDigest = createHash('sha256')
          .update(
            safeJson({
              instructions: agent.instructions,
              agentMemoryDigest,
              modelId: model.modelId,
              modelConfigRevision: model.configRevision,
              permissionPreset,
              skills: skills.map((skill) => [skill.id, skill.contentDigest]),
              mcpBindings: validMcpBindings,
              delegateAgentIds,
              capabilityCandidates,
            }),
          )
          .digest('hex');
        const executionConfig: AgentExecutionConfigSnapshot = {
          userId: identity.userId,
          agentId: session.agentId,
          agentRevision: revisions.agentRevision,
          agentProfileRevision: agentProfile.revision,
          agentInstructions: agent.instructions,
          agentMemoryProfile,
          agentMemoryDigest,
          agentConfigDigest,
          model,
          modelSource: agentProfile.defaultModelId ? 'agent-default' : 'user-default',
          permissionPreset,
          permissionUpperBound: permissionPreset,
          skillRevision: revisions.skillRevision,
          runtimeRevision: revisions.runtimeRevision,
          mcpRevision: revisions.mcpRevision,
          skillIds: bindings.skillIds.filter((skillId) => validSkillIds.has(skillId)),
          mcpBindings: validMcpBindings,
          delegateAgentIds,
          capabilityCandidates,
        };
        const canDelegate =
          session.origin === 'direct' &&
          this.repos.agents.hasSchema &&
          executionConfig.delegateAgentIds.length > 0;
        const availableTools = modelToolsForPermission(
          this.tools.definitions(identity.userId, identity.sessionId, turnId),
          permissionPreset,
        ).filter((tool) => tool.name !== 'agent_call' || canDelegate);
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
              executionConfig,
              skills,
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
            executionConfig,
            skills,
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

        let context;
        try {
          context = this.contextProjector.project({
            userId: identity.userId,
            agentId: session.agentId,
            agentInstructions: executionConfig.agentInstructions,
            agentMemoryProfile: executionConfig.agentMemoryProfile,
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
            promptEpoch:
              SYSTEM_PROMPT_REVISION +
              executionConfig.skillRevision +
              executionConfig.mcpRevision +
              executionConfig.agentRevision +
              digestEpoch(executionConfig.agentConfigDigest),
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
              agentRevision: revisions.agentRevision,
              agentProfileRevision: executionConfig.agentProfileRevision,
              agentMemoryDigest: executionConfig.agentMemoryDigest,
              agentConfigDigest: executionConfig.agentConfigDigest,
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
                  executionConfig,
                  skills,
                  true,
                );
                if (surfaceChanged) {
                  overflowRetried = true;
                  const recovered = this.contextProjector.project({
                    progressReminder,
                    userId: identity.userId,
                    agentId: session.agentId,
                    agentInstructions: executionConfig.agentInstructions,
                    agentMemoryProfile: executionConfig.agentMemoryProfile,
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
                      SYSTEM_PROMPT_REVISION +
                      executionConfig.skillRevision +
                      executionConfig.mcpRevision +
                      executionConfig.agentRevision +
                      digestEpoch(executionConfig.agentConfigDigest),
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
                        agentRevision: revisions.agentRevision,
                        agentProfileRevision: executionConfig.agentProfileRevision,
                        agentMemoryDigest: executionConfig.agentMemoryDigest,
                        agentConfigDigest: executionConfig.agentConfigDigest,
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
              replaySafe:
                this.tools.get(call.name, identity.userId, identity.sessionId, turnId)
                  ?.replaySafe ?? false,
              presentation:
                presentToolCall(
                  this.tools.get(call.name, identity.userId, identity.sessionId, turnId),
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
          const visibleProgressByTool = new Map<string, string>();
          const delegates = response.toolCalls.some((call) => call.name === 'agent_call');
          // A parent session must not occupy one of the bounded execution slots while
          // it synchronously waits for a delegated session. Otherwise N busy parents
          // can prevent every child from ever starting.
          if (delegates) this.releaseSessionSlot();
          let results: Awaited<ReturnType<ToolScheduler['execute']>>;
          try {
            results = await this.scheduler.execute(response.toolCalls, {
              userId: identity.userId,
              agentId: session.agentId,
              sessionOrigin: session.origin,
              sessionId: identity.sessionId,
              eventId,
              turnId,
              stepId,
              permissionPreset,
              executionConfig,
              signal: controller.signal,
              reportProgress: (progress) => {
                const message = normalizeToolProgressMessage(progress.message);
                if (!message || visibleProgressByTool.get(progress.toolCallId) === message) return;
                visibleProgressByTool.set(progress.toolCallId, message);
                const toolName =
                  response.toolCalls.find((call) => call.id === progress.toolCallId)?.name ??
                  'unknown';
                try {
                  this.append(
                    identity.userId,
                    identity.sessionId,
                    [
                      this.event('tool.progress', {
                        toolCallId: progress.toolCallId,
                        toolName,
                        stepId,
                        turnId,
                        eventId,
                        progress: progress.progress,
                        ...(progress.total === undefined ? {} : { total: progress.total }),
                        message,
                      }),
                    ],
                    true,
                  );
                } catch (error) {
                  this.logger.warn('MCP 进度事件写入失败', {
                    toolCallId: progress.toolCallId,
                    toolName,
                    errorCode: errorCodeOf(error),
                  });
                }
              },
            });
          } finally {
            if (delegates) await this.acquireSessionSlot();
          }
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
      this.tools.clearTurnToolExposure(identity.userId, identity.sessionId, turnId);
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
    const session = this.repos.sessions.getSession(identity.userId, identity.sessionId);
    if (session?.origin === 'delegated') {
      const delegation = this.repos.delegations.getByDelegatedSession(
        identity.userId,
        identity.sessionId,
      );
      if (delegation) {
        const child = this.load(identity.userId, identity.sessionId);
        const reportMessage =
          status === 'completed' && !awaitingUser ? delegatedFinalReport(child, turnId) : undefined;
        const delegationStatus: Exclude<DelegationStatus, 'accepted'> = awaitingUser
          ? 'awaiting_user'
          : status === 'completed' && reportMessage
            ? 'completed'
            : status === 'completed' || status === 'failed'
              ? 'failed'
              : status === 'cancelled'
                ? 'cancelled'
                : 'interrupted';
        this.setDelegationStatus(
          delegation,
          delegationStatus,
          reportMessage?.eventId ?? null,
          reportMessage?.content,
        );
      }
    }
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
    executionConfig: AgentExecutionConfigSnapshot,
    skills: readonly SkillInstallation[],
  ): Promise<void> {
    const projection = this.load(identity.userId, identity.sessionId);
    const event = projection.events.get(eventId);
    if (!event) return;
    const measurement = this.contextProjector.measureFull({
      userId: identity.userId,
      agentId: executionConfig.agentId,
      agentInstructions: executionConfig.agentInstructions,
      agentMemoryProfile: executionConfig.agentMemoryProfile,
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
    executionConfig: AgentExecutionConfigSnapshot,
    skills: readonly SkillInstallation[],
    force = false,
  ): Promise<boolean> {
    let changed = false;
    try {
      for (let attempt = 0; attempt <= this.compactionRetries; attempt += 1) {
        let projection = this.load(identity.userId, identity.sessionId);
        const measurementInput = {
          userId: identity.userId,
          agentId: executionConfig.agentId,
          agentInstructions: executionConfig.agentInstructions,
          agentMemoryProfile: executionConfig.agentMemoryProfile,
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
            SYSTEM_PROMPT_REVISION +
            executionConfig.skillRevision +
            executionConfig.mcpRevision +
            executionConfig.agentRevision +
            digestEpoch(executionConfig.agentConfigDigest),
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
        try {
          this.mirrorDelegatedEvents(userId, sessionId, committed);
        } catch (error) {
          this.logger.warn('delegated event mirroring failed', {
            userId,
            sessionId,
            errorCode: errorCodeOf(error),
          });
        }
        this.notifyDelegationWaiters(sessionId);
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

  private mirrorDelegatedEvents(
    userId: LocalUserId,
    sessionId: string,
    events: readonly SessionLogEvent[],
  ): void {
    const delegation = this.repos.delegations.getByDelegatedSession(userId, sessionId);
    if (!delegation) return;
    const parent = this.load(userId, delegation.parentSessionId);
    const parentTurn = parent.turns.get(delegation.parentTurnId);
    const parentToolCall = parent.toolCalls.get(delegation.parentToolCallId);
    if (!parentTurn || !parentToolCall?.stepId) return;
    const sourceName =
      this.repos.agents.get(userId, delegation.targetAgentId)?.name ?? '受派智能体';
    const mirrored: AppendEventInput[] = [];
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (!payload) continue;
      if (event.eventType === 'interaction.requested') {
        const interactionId = stringAt(payload, 'interactionId');
        const prompt = stringAt(payload, 'prompt');
        const kind = stringAt(payload, 'kind');
        if (!interactionId || !prompt || !kind) continue;
        mirrored.push(
          this.event('interaction.requested', {
            interactionId,
            toolCallId: delegation.parentToolCallId,
            eventId: parentTurn.eventId,
            turnId: delegation.parentTurnId,
            prompt: `来自「${sourceName}」：${prompt}`,
            kind,
            options: Array.isArray(payload.options) ? payload.options : [],
            ...(Array.isArray(payload.questions) ? { questions: payload.questions } : {}),
            ...(asRecord(payload.schema) ? { schema: payload.schema } : {}),
          }),
        );
      } else if (event.eventType === 'interaction.resolved') {
        const interactionId = stringAt(payload, 'interactionId');
        const resolution = stringAt(payload, 'resolution');
        if (!interactionId || !resolution) continue;
        mirrored.push(
          this.event('interaction.resolved', {
            interactionId,
            eventId: parentTurn.eventId,
            value: payload.value,
            resolution,
            inboxItemId: stringAt(payload, 'inboxItemId') ?? null,
          }),
        );
      } else if (event.eventType === 'approval.requested') {
        const approvalId = stringAt(payload, 'approvalId');
        const toolName = stringAt(payload, 'toolName');
        const toolIdentity = stringAt(payload, 'toolIdentity');
        const argumentsDigest = stringAt(payload, 'argumentsDigest');
        const policy = stringAt(payload, 'policy');
        if (!approvalId || !toolName || !toolIdentity || !argumentsDigest || !policy) continue;
        mirrored.push(
          this.event('approval.requested', {
            approvalId,
            toolCallId: delegation.parentToolCallId,
            toolName: `${sourceName} · ${toolName}`,
            toolIdentity,
            argumentsDigest,
            eventId: parentTurn.eventId,
            turnId: delegation.parentTurnId,
            stepId: parentToolCall.stepId,
            policy,
            presentation: payload.presentation ?? null,
          }),
        );
      } else if (event.eventType === 'approval.resolved') {
        const approvalId = stringAt(payload, 'approvalId');
        const toolIdentity = stringAt(payload, 'toolIdentity');
        const resolution = stringAt(payload, 'resolution');
        if (!approvalId || !toolIdentity || !resolution) continue;
        mirrored.push(this.event('approval.resolved', { approvalId, toolIdentity, resolution }));
      }
    }
    if (mirrored.length > 0) this.append(userId, delegation.parentSessionId, mirrored);
  }

  private notifyDelegationWaiters(sessionId: string): void {
    for (const wake of this.delegationWaiters.get(sessionId) ?? []) wake();
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

  private resolveAgent(
    userId: LocalUserId,
    agentId: string,
  ): {
    id: string;
    instructions: string;
    permissionPreset: PermissionPreset;
  } {
    if (!this.repos.agents.hasSchema) {
      return { id: DEFAULT_AGENT_ID, instructions: '', permissionPreset: 'guarded' };
    }
    return this.repos.agents.requireActive(userId, agentId);
  }

  private requireActiveSession(userId: LocalUserId, sessionId: string) {
    const session = this.requireSession(userId, sessionId);
    if (session.status !== 'active') {
      throw new BridgeError('INVALID_REQUEST', 'Session is archived');
    }
    return session;
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

function normalizeToolProgressMessage(message: string | undefined): string | null {
  const normalized = message?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  // MCP 进度来自外部服务；持久化和展示前保持有界。
  return normalized.slice(0, 500);
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
    delegations: [...projection.delegations.values()],
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

function delegatedFinalReport(
  projection: RuntimeProjection,
  turnId: string,
): RuntimeProjection['messages'][number] | undefined {
  return [...projection.messages]
    .reverse()
    .find(
      (message) =>
        message.turnId === turnId &&
        message.role === 'assistant' &&
        assistantMessagePhase(message) === 'final_answer' &&
        Boolean(message.content.trim()),
    );
}

async function listRegularFiles(root: string, relativeRoot = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, ...relativeRoot.split('/').filter(Boolean)), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativeRoot ? path.posix.join(relativeRoot, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function isTerminalDelegationStatus(status: DelegationStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function digestEpoch(digest: string): number {
  return Number.parseInt(digest.slice(0, 7), 16) || 1;
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
