import type { SessionLogEvent } from '../shared/domain/session';
import {
  readAssistantPhase,
  type AssistantMessagePhase,
  type AssistantPhaseSource,
} from './assistant-output-policy';
import { inboxSplicedPayloadSchema, validateAndUpcastRuntimeEvent } from './runtime';
import type { InboxItem } from './runtime';

export interface ProjectedMessage {
  requestId?: string;
  phase?: AssistantMessagePhase;
  phaseSource?: AssistantPhaseSource;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  eventId: string;
  turnId: string;
  inboxItemId?: string;
  interactionId?: string;
  stepId?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCallProjection[];
}

export interface ModelToolCallProjection {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ProjectedConversationEvent {
  id: string;
  title: string;
  status: 'open' | 'awaiting_user' | 'completed' | 'failed';
  summary: string | null;
  summaryVersion: number;
  summaryThroughSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectedTurn {
  id: string;
  eventId: string;
  exchangeId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stepCount: number;
  cancelRequested: boolean;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ProjectedInteraction {
  id: string;
  toolCallId?: string;
  eventId: string;
  turnId: string;
  status: 'pending' | 'resolved';
  prompt: string;
  kind: string;
  options: string[];
  questions: ProjectedInteractionQuestion[];
  schema: Record<string, unknown> | null;
  resolution?: string;
  value?: unknown;
  inboxItemId?: string;
  continuationTurnId?: string;
}

export interface ProjectedInteractionQuestion {
  id: string;
  header?: string;
  question: string;
  options: string[];
}

export interface ProjectedApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  toolIdentity: string;
  argumentsDigest: string;
  eventId: string;
  turnId: string;
  stepId: string;
  policy: 'first-use' | 'always';
  presentation: unknown;
  status: 'pending' | 'resolved';
  resolution?: string;
}

export interface ProjectedStep {
  id: string;
  turnId: string;
  eventId: string;
  stepIndex: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  requestContext: {
    requestId: string;
    progressReminder?: boolean;
    modelId: string | null;
    configRevision: number | null;
    promptEpoch: number;
    estimatedInputTokens: number;
    budgetTokens: number;
    tokenBreakdown: {
      fixedTokens: number;
      historyTokens: number;
      currentTurnTokens: number;
    } | null;
    includedEventIds: string[];
    skillRevision: number;
    runtimeRevision: number;
    mcpRevision: number;
  } | null;
}

export interface ProjectedToolCall {
  id: string;
  stepId: string | null;
  turnId: string;
  eventId: string;
  name: string;
  callIndex: number;
  resultSeq?: number;
  input: unknown;
  status: string;
  output?: unknown;
  errorCode?: string | null;
  meta?: unknown;
  presentation?: unknown;
  executionFacts?: unknown;
  progress?: {
    current: number;
    total?: number;
    message: string;
    updatedAt: string;
  };
}

export interface ProjectedStream {
  requestId: string;
  stepId?: string;
  turnId?: string;
  phase?: AssistantMessagePhase;
  /** Frozen when prose starts, so late metadata cannot move text mid-stream. */
  displayPhase?: AssistantMessagePhase;
  interrupted?: boolean;
  content: string;
  chunkCount: number;
  finalized: boolean;
}

export interface ProjectedReasoningStream extends ProjectedStream {
  stepId: string;
  turnId: string;
}

export interface UsageProjection {
  modelRequests: number;
  compactionRequests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface ProjectedSessionMemorySummary {
  summary: string;
  summaryVersion: number;
  coveredThroughSeq: number;
  summaryTokens: number;
  inputTokens: number;
  outputTokens: number;
  updatedAt: string;
}

export interface ProjectedSurfaceReplacement {
  compactionId: string;
  eventId: string;
  turnId: string;
  kind: 'tool-prune' | 'checkpoint';
  surfaceGeneration: number;
  shadowedSeqs: number[];
  checkpointText: string;
  replacementRole: 'system' | 'tool';
  toolCallId?: string;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
}

export interface ProjectedEventRelation {
  eventId: string;
  relatedEventId: string;
  relationType: 'explicit' | 'continuation';
  createdAt: string;
}

export interface RuntimeProjection {
  lastSeq: number;
  inbox: InboxItem[];
  events: Map<string, ProjectedConversationEvent>;
  turns: Map<string, ProjectedTurn>;
  messages: ProjectedMessage[];
  interactions: Map<string, ProjectedInteraction>;
  approvals: Map<string, ProjectedApproval>;
  permissionGrants: Set<string>;
  steps: Map<string, ProjectedStep>;
  toolCalls: Map<string, ProjectedToolCall>;
  streams: Map<string, ProjectedStream>;
  reasoning: Map<string, ProjectedReasoningStream>;
  relations: ProjectedEventRelation[];
  usage: UsageProjection;
  sessionMemorySummary: ProjectedSessionMemorySummary | null;
  surfaceReplacements: ProjectedSurfaceReplacement[];
  activeTurn: ProjectedTurn | null;
}

export class ProjectionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionInvariantError';
  }
}

export function projectRuntime(events: readonly SessionLogEvent[]): RuntimeProjection {
  const state: RuntimeProjection = {
    lastSeq: 0,
    inbox: [],
    events: new Map(),
    turns: new Map(),
    messages: [],
    interactions: new Map(),
    approvals: new Map(),
    permissionGrants: new Set(),
    steps: new Map(),
    toolCalls: new Map(),
    streams: new Map(),
    reasoning: new Map(),
    relations: [],
    usage: {
      modelRequests: 0,
      compactionRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    },
    sessionMemorySummary: null,
    surfaceReplacements: [],
    activeTurn: null,
  };
  for (const event of events) applyRuntimeEvent(state, event);
  return state;
}

export function cloneRuntimeProjection(source: RuntimeProjection): RuntimeProjection {
  const turns = new Map([...source.turns].map(([key, value]) => [key, { ...value }] as const));
  return {
    lastSeq: source.lastSeq,
    inbox: source.inbox.map((item) => ({ ...item })),
    events: new Map([...source.events].map(([key, value]) => [key, { ...value }] as const)),
    turns,
    messages: source.messages.map((message) => ({ ...message })),
    interactions: new Map(
      [...source.interactions].map(
        ([key, value]) =>
          [
            key,
            {
              ...value,
              options: [...value.options],
              questions: value.questions.map((question) => ({
                ...question,
                options: [...question.options],
              })),
              schema: value.schema ? { ...value.schema } : null,
            },
          ] as const,
      ),
    ),
    approvals: new Map([...source.approvals].map(([key, value]) => [key, { ...value }] as const)),
    permissionGrants: new Set(source.permissionGrants),
    steps: new Map(
      [...source.steps].map(
        ([key, value]) =>
          [
            key,
            {
              ...value,
              requestContext: value.requestContext
                ? {
                    ...value.requestContext,
                    includedEventIds: [...value.requestContext.includedEventIds],
                    tokenBreakdown: value.requestContext.tokenBreakdown
                      ? { ...value.requestContext.tokenBreakdown }
                      : null,
                  }
                : null,
            },
          ] as const,
      ),
    ),
    toolCalls: new Map([...source.toolCalls].map(([key, value]) => [key, { ...value }] as const)),
    streams: new Map([...source.streams].map(([key, value]) => [key, { ...value }] as const)),
    reasoning: new Map([...source.reasoning].map(([key, value]) => [key, { ...value }] as const)),
    relations: source.relations.map((relation) => ({ ...relation })),
    usage: { ...source.usage },
    sessionMemorySummary: source.sessionMemorySummary ? { ...source.sessionMemorySummary } : null,
    surfaceReplacements: source.surfaceReplacements.map((replacement) => ({
      ...replacement,
      shadowedSeqs: [...replacement.shadowedSeqs],
    })),
    activeTurn: source.activeTurn ? (turns.get(source.activeTurn.id) ?? null) : null,
  };
}

export function applyRuntimeEvent(state: RuntimeProjection, event: SessionLogEvent): void {
  state.lastSeq = event.seq;
  const upcastPayload = validateAndUpcastRuntimeEvent(
    event.eventType,
    event.schemaVersion,
    event.payload,
  );
  const payload = asRecord(upcastPayload);
  switch (event.eventType) {
    case 'agent.inbox.spliced': {
      const parsed = inboxSplicedPayloadSchema.safeParse(upcastPayload);
      if (!parsed.success) return;
      for (const operation of parsed.data.operations) {
        if (operation.op === 'insert') {
          if (state.inbox.some((item) => item.id === operation.item.id)) {
            throw new ProjectionInvariantError('Inbox item already exists');
          }
          state.inbox.push(operation.item);
        } else if (operation.op === 'remove') {
          if (!state.inbox.some((item) => item.id === operation.itemId)) {
            throw new ProjectionInvariantError('Inbox item does not exist');
          }
          state.inbox = state.inbox.filter((item) => item.id !== operation.itemId);
        } else {
          if (!state.inbox.some((item) => item.id === operation.itemId)) {
            throw new ProjectionInvariantError('Inbox item does not exist');
          }
          state.inbox = state.inbox.map((item) =>
            item.id === operation.itemId ? { ...item, content: operation.content } : item,
          );
        }
      }
      break;
    }
    case 'conversation.event.created': {
      const id = stringAt(payload, 'eventId');
      if (!id) break;
      state.events.set(id, {
        id,
        title: stringAt(payload, 'title') ?? '',
        status: 'open',
        summary: null,
        summaryVersion: 0,
        summaryThroughSeq: 0,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
      break;
    }
    case 'conversation.event.status-changed': {
      const id = stringAt(payload, 'eventId');
      const status = stringAt(payload, 'status');
      const target = id ? state.events.get(id) : undefined;
      if (target && isConversationStatus(status)) {
        target.status = status;
        target.updatedAt = event.occurredAt;
      }
      break;
    }
    case 'conversation.event.summary-updated':
    case 'compaction.summary-updated': {
      const id = stringAt(payload, 'eventId');
      const summary = stringAt(payload, 'summary');
      const version = numberAt(payload, 'summaryVersion');
      const target = id ? state.events.get(id) : undefined;
      if (target && summary !== undefined && version !== undefined) {
        target.summary = summary;
        target.summaryVersion = version;
        target.summaryThroughSeq = numberAt(payload, 'coveredThroughSeq') ?? event.seq;
        target.updatedAt = event.occurredAt;
        if (
          event.eventType === 'compaction.summary-updated' ||
          (event.eventType === 'conversation.event.summary-updated' &&
            numberAt(payload, 'inputTokens') !== undefined)
        ) {
          state.usage.compactionRequests += 1;
          state.usage.inputTokens += numberAt(payload, 'inputTokens') ?? 0;
          state.usage.outputTokens += numberAt(payload, 'outputTokens') ?? 0;
        }
      }
      break;
    }
    case 'conversation.event.related': {
      const eventId = stringAt(payload, 'eventId');
      const relatedEventId = stringAt(payload, 'relatedEventId');
      const relationType = stringAt(payload, 'relationType');
      if (
        eventId &&
        relatedEventId &&
        (relationType === 'explicit' || relationType === 'continuation')
      ) {
        state.relations.push({
          eventId,
          relatedEventId,
          relationType,
          createdAt: event.occurredAt,
        });
      }
      break;
    }
    case 'session.memory.summary-updated': {
      const summary = stringAt(payload, 'summary');
      const summaryVersion = numberAt(payload, 'summaryVersion');
      const coveredThroughSeq = numberAt(payload, 'coveredThroughSeq');
      const summaryTokens = numberAt(payload, 'summaryTokens');
      if (
        summary !== undefined &&
        summaryVersion !== undefined &&
        coveredThroughSeq !== undefined &&
        summaryTokens !== undefined
      ) {
        state.sessionMemorySummary = {
          summary,
          summaryVersion,
          coveredThroughSeq,
          summaryTokens,
          inputTokens: numberAt(payload, 'inputTokens') ?? 0,
          outputTokens: numberAt(payload, 'outputTokens') ?? 0,
          updatedAt: event.occurredAt,
        };
        state.usage.compactionRequests += 1;
        state.usage.inputTokens += numberAt(payload, 'inputTokens') ?? 0;
        state.usage.outputTokens += numberAt(payload, 'outputTokens') ?? 0;
      }
      break;
    }
    case 'surface.replaced': {
      const compactionId = stringAt(payload, 'compactionId');
      const eventId = stringAt(payload, 'eventId');
      const turnId = stringAt(payload, 'turnId');
      const kind = stringAt(payload, 'kind');
      const checkpointText = stringAt(payload, 'checkpointText');
      const shadowedSeqs = numberArrayAt(payload, 'shadowedSeqs');
      if (
        compactionId &&
        eventId &&
        turnId &&
        (kind === 'tool-prune' || kind === 'checkpoint') &&
        checkpointText &&
        shadowedSeqs.length > 0
      ) {
        state.surfaceReplacements.push({
          compactionId,
          eventId,
          turnId,
          kind,
          surfaceGeneration: numberAt(payload, 'surfaceGeneration') ?? 0,
          shadowedSeqs,
          checkpointText,
          replacementRole: stringAt(payload, 'replacementRole') === 'tool' ? 'tool' : 'system',
          toolCallId: stringAt(payload, 'toolCallId'),
          tokensBefore: numberAt(payload, 'tokensBefore') ?? 0,
          tokensAfter: numberAt(payload, 'tokensAfter') ?? 0,
          createdAt: event.occurredAt,
        });
      }
      break;
    }
    case 'turn.started': {
      const id = stringAt(payload, 'turnId');
      const eventId = stringAt(payload, 'eventId');
      const exchangeId = stringAt(payload, 'exchangeId');
      if (!id || !eventId || !exchangeId) break;
      if (state.activeTurn || state.turns.has(id)) {
        throw new ProjectionInvariantError('Only one execution turn may be open');
      }
      const turn: ProjectedTurn = {
        id,
        eventId,
        exchangeId,
        status: 'running',
        stepCount: 0,
        cancelRequested: false,
        startedAt: event.occurredAt,
        endedAt: null,
        endReason: null,
      };
      state.turns.set(id, turn);
      state.activeTurn = turn;
      break;
    }
    case 'turn.cancel.requested': {
      const id = stringAt(payload, 'turnId');
      const target = id ? state.turns.get(id) : undefined;
      if (target) target.cancelRequested = true;
      break;
    }
    case 'step.started': {
      const id = stringAt(payload, 'turnId');
      const target = id ? state.turns.get(id) : undefined;
      if (!target || target.status !== 'running') {
        throw new ProjectionInvariantError('Step requires an open turn');
      }
      target.stepCount += 1;
      const stepId = stringAt(payload, 'stepId');
      const eventId = stringAt(payload, 'eventId');
      const stepIndex = numberAt(payload, 'stepIndex');
      if (stepId && id && eventId && stepIndex !== undefined) {
        state.steps.set(stepId, {
          id: stepId,
          turnId: id,
          eventId,
          stepIndex,
          status: 'running',
          startedAt: event.occurredAt,
          endedAt: null,
          requestContext: null,
        });
      }
      break;
    }
    case 'model.request.context': {
      const stepId = stringAt(payload, 'stepId');
      const target = stepId ? state.steps.get(stepId) : undefined;
      const model = asRecord(payload?.model);
      if (target) {
        target.requestContext = {
          requestId: stringAt(payload, 'requestId') ?? '',
          progressReminder: asRecord(payload?.runtimeConfig)?.progressReminder === true,
          modelId: stringAt(model, 'modelId') ?? null,
          configRevision: numberAt(model, 'configRevision') ?? null,
          promptEpoch: numberAt(payload, 'promptEpoch') ?? 0,
          estimatedInputTokens: numberAt(payload, 'estimatedInputTokens') ?? 0,
          budgetTokens: numberAt(payload, 'budgetTokens') ?? 0,
          tokenBreakdown: contextTokenBreakdownAt(payload, 'tokenBreakdown'),
          includedEventIds: stringArrayAt(payload, 'includedEventIds'),
          skillRevision: numberAt(payload, 'skillRevision') ?? 0,
          runtimeRevision: numberAt(payload, 'runtimeRevision') ?? 0,
          mcpRevision: numberAt(payload, 'mcpRevision') ?? 0,
        };
      }
      break;
    }
    case 'step.ended': {
      const stepId = stringAt(payload, 'stepId');
      const status = stringAt(payload, 'status');
      const target = stepId ? state.steps.get(stepId) : undefined;
      if (target && isStepStatus(status)) {
        target.status = status;
        target.endedAt = event.occurredAt;
      }
      break;
    }
    case 'turn.ended': {
      const id = stringAt(payload, 'turnId');
      const status = stringAt(payload, 'status');
      const target = id ? state.turns.get(id) : undefined;
      if (!target || target.status !== 'running' || state.activeTurn?.id !== id) {
        throw new ProjectionInvariantError('Turn end does not match the open turn');
      }
      if (isTurnStatus(status)) {
        target.status = status;
        target.endedAt = event.occurredAt;
        target.endReason = stringAt(payload, 'reason') ?? null;
        for (const stream of state.streams.values()) {
          if (stream.turnId === id && !stream.finalized) {
            stream.finalized = true;
            stream.interrupted = true;
          }
        }
        for (const stream of state.reasoning.values()) {
          if (stream.turnId === id) stream.finalized = true;
        }
        if (state.activeTurn?.id === id) state.activeTurn = null;
      }
      break;
    }
    case 'assistant.message.metadata': {
      const requestId = stringAt(payload, 'requestId');
      const phase = readAssistantPhase(payload?.phase);
      if (!requestId || !phase) break;
      const stream: ProjectedStream = state.streams.get(requestId) ?? {
        requestId,
        content: '',
        chunkCount: 0,
        finalized: false,
      };
      stream.stepId = stringAt(payload, 'stepId');
      stream.turnId = stringAt(payload, 'turnId');
      stream.phase = phase;
      if (stream.chunkCount === 0) stream.displayPhase = phase;
      state.streams.set(requestId, stream);
      break;
    }
    case 'assistant.chunk': {
      const requestId = stringAt(payload, 'requestId');
      if (!requestId) break;
      const current: ProjectedStream = state.streams.get(requestId) ?? {
        requestId,
        content: '',
        chunkCount: 0,
        finalized: false,
      };
      current.content += stringAt(payload, 'content') ?? '';
      current.stepId = stringAt(payload, 'stepId');
      current.turnId = stringAt(payload, 'turnId');
      current.chunkCount += 1;
      state.streams.set(requestId, current);
      break;
    }
    case 'assistant.reasoning.chunk': {
      const requestId = stringAt(payload, 'requestId');
      const stepId = stringAt(payload, 'stepId');
      const turnId = stringAt(payload, 'turnId');
      if (!requestId || !stepId || !turnId) break;
      const current = state.reasoning.get(requestId) ?? {
        requestId,
        stepId,
        turnId,
        content: '',
        chunkCount: 0,
        finalized: false,
      };
      current.content += stringAt(payload, 'content') ?? '';
      current.chunkCount += 1;
      state.reasoning.set(requestId, current);
      break;
    }
    case 'assistant.reasoning': {
      const requestId = stringAt(payload, 'requestId');
      const stepId = stringAt(payload, 'stepId');
      const turnId = stringAt(payload, 'turnId');
      const content = stringAt(payload, 'content');
      if (!requestId || !stepId || !turnId || content === undefined) break;
      const current = state.reasoning.get(requestId) ?? {
        requestId,
        stepId,
        turnId,
        content: '',
        chunkCount: 0,
        finalized: false,
      };
      current.content = content;
      current.finalized = true;
      state.reasoning.set(requestId, current);
      break;
    }
    case 'user.message':
    case 'assistant.message': {
      const content = stringAt(payload, 'content');
      const eventId = stringAt(payload, 'eventId');
      const turnId = stringAt(payload, 'turnId');
      if (content === undefined || !eventId || !turnId) break;
      const inboxItemId = stringAt(payload, 'inboxItemId');
      const sourceInteraction =
        event.eventType === 'user.message' && inboxItemId
          ? [...state.interactions.values()].find(
              (interaction) => interaction.inboxItemId === inboxItemId,
            )
          : undefined;
      if (sourceInteraction) sourceInteraction.continuationTurnId = turnId;
      state.messages.push({
        seq: event.seq,
        role: event.eventType === 'user.message' ? 'user' : 'assistant',
        content,
        eventId,
        turnId,
        inboxItemId,
        interactionId: sourceInteraction?.id,
        stepId: stringAt(payload, 'stepId'),
        ...(event.eventType === 'assistant.message'
          ? {
              requestId: stringAt(payload, 'requestId'),
              phase: readAssistantPhase(payload?.phase),
              phaseSource:
                payload?.phaseSource === 'provider'
                  ? ('provider' as const)
                  : payload?.phaseSource === 'compatibility'
                    ? ('compatibility' as const)
                    : undefined,
            }
          : {}),
      });
      if (event.eventType === 'assistant.message') {
        const requestId = stringAt(payload, 'requestId');
        if (requestId) {
          const stream: ProjectedStream = state.streams.get(requestId) ?? {
            requestId,
            content,
            chunkCount: 0,
            finalized: true,
          };
          stream.content = content;
          stream.finalized = true;
          stream.stepId = stringAt(payload, 'stepId');
          stream.turnId = turnId;
          stream.phase = readAssistantPhase(payload?.phase) ?? stream.phase;
          stream.displayPhase = stream.phase;
          state.streams.set(requestId, stream);
        }
        state.usage.modelRequests += 1;
        state.usage.inputTokens += numberAt(payload, 'inputTokens') ?? 0;
        state.usage.outputTokens += numberAt(payload, 'outputTokens') ?? 0;
      }
      break;
    }
    case 'tool.call': {
      state.usage.toolCalls += 1;
      const toolCallId = stringAt(payload, 'toolCallId');
      const turnId = stringAt(payload, 'turnId');
      const eventId = stringAt(payload, 'eventId');
      if (toolCallId && turnId && eventId) {
        const stepId = stringAt(payload, 'stepId');
        state.toolCalls.set(toolCallId, {
          id: toolCallId,
          stepId: stepId ?? null,
          turnId,
          eventId,
          name: stringAt(payload, 'toolName') ?? 'unknown',
          callIndex: numberAt(payload, 'callIndex') ?? 0,
          input: payload?.input,
          presentation: payload?.presentation,
          status: 'running',
        });
        const assistantMessage = [...state.messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'assistant' &&
              message.turnId === turnId &&
              message.eventId === eventId &&
              (stepId === undefined || message.stepId === stepId),
          );
        if (assistantMessage) {
          assistantMessage.toolCalls = [
            ...(assistantMessage.toolCalls ?? []),
            {
              id: toolCallId,
              name: stringAt(payload, 'toolName') ?? 'unknown',
              arguments: payload?.input ?? null,
            },
          ];
        }
      }
      break;
    }
    case 'tool.progress': {
      const toolCallId = stringAt(payload, 'toolCallId');
      if (!toolCallId) break;
      const call = state.toolCalls.get(toolCallId);
      const current = numberAt(payload, 'progress');
      const message = stringAt(payload, 'message');
      if (!call || current === undefined || !message) break;
      const total = numberAt(payload, 'total');
      call.progress = {
        current,
        ...(total === undefined ? {} : { total }),
        message,
        updatedAt: event.occurredAt,
      };
      break;
    }
    case 'tool.result': {
      const content = toolOutputText(payload?.output);
      const eventId = stringAt(payload, 'eventId');
      const turnId = stringAt(payload, 'turnId');
      const toolCallId = stringAt(payload, 'toolCallId');
      if (content === undefined || !eventId || !turnId || !toolCallId) break;
      const call = state.toolCalls.get(toolCallId);
      if (call) {
        call.resultSeq = event.seq;
        call.status = stringAt(payload, 'status') ?? 'unknown';
        call.output = payload?.output;
        call.errorCode = stringAt(payload, 'errorCode') ?? null;
        call.meta = payload?.meta;
        call.presentation = payload?.presentation ?? call.presentation;
        call.executionFacts = payload?.executionFacts;
        delete call.progress;
      }
      state.messages.push({ seq: event.seq, role: 'tool', content, eventId, turnId, toolCallId });
      break;
    }
    case 'interaction.requested': {
      const id = stringAt(payload, 'interactionId');
      const eventId = stringAt(payload, 'eventId');
      const turnId = stringAt(payload, 'turnId');
      if (!id || !eventId || !turnId) break;
      state.interactions.set(id, {
        id,
        toolCallId: stringAt(payload, 'toolCallId'),
        eventId,
        turnId,
        status: 'pending',
        prompt: stringAt(payload, 'prompt') ?? '',
        kind: stringAt(payload, 'kind') ?? 'text',
        options: stringArrayAt(payload, 'options'),
        questions: interactionQuestionsAt(payload, 'questions'),
        schema: asRecord(payload?.schema) ?? null,
      });
      break;
    }
    case 'interaction.resolved': {
      const id = stringAt(payload, 'interactionId');
      const target = id ? state.interactions.get(id) : undefined;
      if (target) {
        target.status = 'resolved';
        target.value = payload?.value;
        target.resolution = stringAt(payload, 'resolution') ?? 'submitted';
        target.inboxItemId = stringAt(payload, 'inboxItemId');
        const toolCall = target.toolCallId ? state.toolCalls.get(target.toolCallId) : undefined;
        if (toolCall?.status === 'needs_input') {
          toolCall.status = target.resolution === 'submitted' ? 'answered' : target.resolution;
        }
      }
      break;
    }
    case 'approval.requested': {
      const approvalId = stringAt(payload, 'approvalId');
      const toolCallId = stringAt(payload, 'toolCallId');
      const toolName = stringAt(payload, 'toolName');
      const toolIdentity = stringAt(payload, 'toolIdentity');
      const argumentsDigest = stringAt(payload, 'argumentsDigest');
      const eventId = stringAt(payload, 'eventId');
      const turnId = stringAt(payload, 'turnId');
      const stepId = stringAt(payload, 'stepId');
      const policy = stringAt(payload, 'policy');
      if (
        !approvalId ||
        !toolCallId ||
        !toolName ||
        !toolIdentity ||
        !argumentsDigest ||
        !eventId ||
        !turnId ||
        !stepId ||
        (policy !== 'first-use' && policy !== 'always')
      )
        break;
      state.approvals.set(approvalId, {
        id: approvalId,
        toolCallId,
        toolName,
        toolIdentity,
        argumentsDigest,
        eventId,
        turnId,
        stepId,
        policy,
        presentation: payload?.presentation ?? null,
        status: 'pending',
      });
      break;
    }
    case 'approval.resolved': {
      const approvalId = stringAt(payload, 'approvalId');
      const approval = approvalId ? state.approvals.get(approvalId) : undefined;
      if (approval) {
        approval.status = 'resolved';
        approval.resolution = stringAt(payload, 'resolution');
      }
      break;
    }
    case 'permission.grant.created': {
      const toolIdentity = stringAt(payload, 'toolIdentity');
      if (toolIdentity) state.permissionGrants.add(toolIdentity);
      break;
    }
  }
}

function toolOutputText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map((candidate) => {
      const block = asRecord(candidate);
      const type = stringAt(block, 'type');
      if (type === 'text') return stringAt(block, 'text') ?? '';
      if (type === 'image') return `[image: ${stringAt(block, 'mimeType') ?? 'unknown'}]`;
      if (type === 'audio') return `[audio: ${stringAt(block, 'mimeType') ?? 'unknown'}]`;
      if (type === 'resource') {
        return stringAt(block, 'text') ?? `[resource: ${stringAt(block, 'uri') ?? 'unknown'}]`;
      }
      return '';
    });
    return parts.join('\n');
  }
  return stringifyValue(value);
}

function stringifyValue(value: unknown): string | undefined {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
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

function stringArrayAt(value: Record<string, unknown> | undefined, key: string): string[] {
  const found = value?.[key];
  return Array.isArray(found)
    ? found.filter((item): item is string => typeof item === 'string')
    : [];
}

function interactionQuestionsAt(
  value: Record<string, unknown> | undefined,
  key: string,
): ProjectedInteractionQuestion[] {
  const found = value?.[key];
  if (!Array.isArray(found)) return [];
  return found.flatMap((candidate) => {
    const question = asRecord(candidate);
    const id = stringAt(question, 'id');
    const text = stringAt(question, 'question');
    if (!id || !text) return [];
    const header = stringAt(question, 'header');
    return [
      {
        id,
        ...(header ? { header } : {}),
        question: text,
        options: stringArrayAt(question, 'options'),
      },
    ];
  });
}

function contextTokenBreakdownAt(
  value: Record<string, unknown> | undefined,
  key: string,
): { fixedTokens: number; historyTokens: number; currentTurnTokens: number } | null {
  const breakdown = asRecord(value?.[key]);
  const fixedTokens = numberAt(breakdown, 'fixedTokens');
  const historyTokens = numberAt(breakdown, 'historyTokens');
  const currentTurnTokens = numberAt(breakdown, 'currentTurnTokens');
  if (fixedTokens === undefined || historyTokens === undefined || currentTurnTokens === undefined) {
    return null;
  }
  return { fixedTokens, historyTokens, currentTurnTokens };
}

function numberArrayAt(value: Record<string, unknown> | undefined, key: string): number[] {
  const found = value?.[key];
  return Array.isArray(found)
    ? found.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
}

function isConversationStatus(
  value: string | undefined,
): value is ProjectedConversationEvent['status'] {
  return (
    value === 'open' || value === 'awaiting_user' || value === 'completed' || value === 'failed'
  );
}

function isTurnStatus(value: string | undefined): value is ProjectedTurn['status'] {
  return (
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
  );
}

function isStepStatus(value: string | undefined): value is ProjectedStep['status'] {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}
