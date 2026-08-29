import { z } from 'zod';

export const INBOX_SCOPES = ['next-turn', 'next-step'] as const;
export type InboxScope = (typeof INBOX_SCOPES)[number];

export const inboxItemSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1),
    scope: z.enum(INBOX_SCOPES),
    eventId: z.string().min(1).nullable(),
    startNewEvent: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict();
export type InboxItem = z.infer<typeof inboxItemSchema>;

const insertOperationSchema = z.object({ op: z.literal('insert'), item: inboxItemSchema }).strict();
const removeOperationSchema = z
  .object({ op: z.literal('remove'), itemId: z.string().min(1) })
  .strict();
const replaceOperationSchema = z
  .object({ op: z.literal('replace'), itemId: z.string().min(1), content: z.string().min(1) })
  .strict();

export const inboxOperationSchema = z.discriminatedUnion('op', [
  insertOperationSchema,
  removeOperationSchema,
  replaceOperationSchema,
]);
export type InboxOperation = z.infer<typeof inboxOperationSchema>;

export const inboxSplicedPayloadSchema = z
  .object({
    reason: z.enum(['submit', 'claim', 'promote', 'remove', 'replace', 'cancel-cleanup']),
    operations: z.array(inboxOperationSchema).min(1),
    turnId: z.string().min(1).optional(),
  })
  .strict();

export const sessionCreateParamsSchema = z
  .object({ sessionId: z.string().min(1).max(128).optional(), title: z.string().min(1).max(200) })
  .strict();
export const sessionRenameParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(200),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const sessionArchiveParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();
export const sessionTargetSchema = z.object({ sessionId: z.string().min(1) }).strict();

export const inputSubmitParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    content: z
      .string()
      .trim()
      .min(1)
      .max(128 * 1024),
    idempotencyKey: z.string().min(1).max(256),
    startNewEvent: z.boolean().default(true),
    mode: z.enum(['queue', 'steer']).default('queue'),
    eventId: z.string().min(1).optional(),
  })
  .strict();

export const inboxRemoveParamsSchema = z
  .object({ sessionId: z.string().min(1), inboxItemId: z.string().min(1) })
  .strict();
export const inboxReplaceParamsSchema = inboxRemoveParamsSchema
  .extend({
    content: z
      .string()
      .trim()
      .min(1)
      .max(128 * 1024),
  })
  .strict();
export const inboxPromoteParamsSchema = inboxRemoveParamsSchema
  .extend({ expectedTurnId: z.string().min(1) })
  .strict();
export const turnCancelParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    keepNextTurn: z.boolean().default(true),
    keepNextStep: z.boolean().default(false),
    reason: z.string().min(1).max(200).default('user_cancelled'),
  })
  .strict();
export const turnCancelAndQueueParamsSchema = turnCancelParamsSchema
  .extend({
    content: z
      .string()
      .trim()
      .min(1)
      .max(128 * 1024),
    idempotencyKey: z.string().min(1).max(256),
    startNewEvent: z.boolean().default(true),
  })
  .strict();
export const interactionResolveParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    interactionId: z.string().min(1),
    value: z.unknown(),
    resolution: z.enum(['submitted', 'cancelled', 'rejected']).default('submitted'),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
export const eventsPageParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    afterSeq: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export const eventReadParamsSchema = z
  .object({ sessionId: z.string().min(1), eventId: z.string().min(1) })
  .strict();
export const turnReadParamsSchema = z
  .object({ sessionId: z.string().min(1), turnId: z.string().min(1) })
  .strict();

export type RuntimeEventType =
  | 'session.created'
  | 'agent.inbox.spliced'
  | 'conversation.event.created'
  | 'conversation.event.status-changed'
  | 'conversation.event.summary-updated'
  | 'conversation.event.related'
  | 'session.memory.summary-updated'
  | 'conversation.exchange.started'
  | 'conversation.exchange.completed'
  | 'turn.started'
  | 'turn.cancel.requested'
  | 'turn.ended'
  | 'step.started'
  | 'step.ended'
  | 'model.request.context'
  | 'user.message'
  | 'assistant.reasoning.chunk'
  | 'assistant.reasoning'
  | 'assistant.chunk'
  | 'assistant.message'
  | 'tool.call'
  | 'tool.result'
  | 'interaction.requested'
  | 'interaction.resolved'
  | 'compaction.started'
  | 'compaction.summary-updated'
  | 'surface.replaced'
  | 'compaction.ended';

export const RUNTIME_EVENT_TYPES: readonly RuntimeEventType[] = [
  'session.created',
  'agent.inbox.spliced',
  'conversation.event.created',
  'conversation.event.status-changed',
  'conversation.event.summary-updated',
  'conversation.event.related',
  'session.memory.summary-updated',
  'conversation.exchange.started',
  'conversation.exchange.completed',
  'turn.started',
  'turn.cancel.requested',
  'turn.ended',
  'step.started',
  'step.ended',
  'model.request.context',
  'user.message',
  'assistant.reasoning.chunk',
  'assistant.reasoning',
  'assistant.chunk',
  'assistant.message',
  'tool.call',
  'tool.result',
  'interaction.requested',
  'interaction.resolved',
  'compaction.started',
  'compaction.summary-updated',
  'surface.replaced',
  'compaction.ended',
];

export const RUNTIME_EVENT_SCHEMA_VERSION = 1;

const id = z.string().min(1);
const eventSchemas: Record<RuntimeEventType, z.ZodTypeAny> = {
  'session.created': z.object({ sessionId: id, title: z.string() }).strict(),
  'agent.inbox.spliced': inboxSplicedPayloadSchema,
  'conversation.event.created': z.object({ eventId: id, title: z.string() }).strict(),
  'conversation.event.status-changed': z
    .object({ eventId: id, status: z.enum(['open', 'awaiting_user', 'completed', 'failed']) })
    .strict(),
  'conversation.event.summary-updated': summarySchema(),
  'conversation.event.related': z
    .object({
      eventId: id,
      relatedEventId: id,
      relationType: z.enum(['explicit', 'continuation']),
    })
    .strict(),
  'session.memory.summary-updated': z
    .object({
      summary: z.string().min(1),
      summaryVersion: z.number().int().positive(),
      coveredThroughSeq: z.number().int().positive(),
      summaryTokens: z.number().int().positive(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .strict(),
  'conversation.exchange.started': z.object({ exchangeId: id, eventId: id, turnId: id }).strict(),
  'conversation.exchange.completed': z
    .object({
      exchangeId: id,
      eventId: id,
      turnId: id,
      status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    })
    .strict(),
  'turn.started': z.object({ turnId: id, eventId: id, exchangeId: id }).strict(),
  'turn.cancel.requested': z.object({ turnId: id, reason: z.string().min(1) }).strict(),
  'turn.ended': z
    .object({
      turnId: id,
      eventId: id,
      status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
      reason: z.string().min(1),
    })
    .strict(),
  'step.started': z
    .object({ stepId: id, turnId: id, eventId: id, stepIndex: z.number().int().positive() })
    .strict(),
  'step.ended': z
    .object({
      stepId: id,
      turnId: id,
      eventId: id,
      status: z.enum(['completed', 'failed', 'cancelled']),
    })
    .strict(),
  'model.request.context': z
    .object({
      requestId: id,
      stepId: id,
      turnId: id,
      eventId: id,
      model: z.record(z.unknown()),
      promptEpoch: z.number().int().positive(),
      estimatedInputTokens: z.number().int().nonnegative(),
      budgetTokens: z.number().int().positive(),
      includedEventIds: z.array(id),
      skillRevision: z.number().int().nonnegative(),
      runtimeRevision: z.number().int().nonnegative(),
      mcpRevision: z.number().int().nonnegative().optional(),
      toolSnapshot: z
        .array(z.object({ name: id, schemaDigest: id.nullable() }).strict())
        .optional(),
      skillSnapshot: z.array(
        z.object({ name: id, contentDigest: id, enabled: z.boolean() }).strict(),
      ),
      // maxStepsPerTurn 仅为旧事件兼容字段；当前 Agent Loop 不设 Step 数量上限。
      runtimeConfig: z.object({ maxStepsPerTurn: z.number().int().positive().optional() }).strict(),
    })
    .strict(),
  'user.message': messageSchema().extend({ inboxItemId: id, exchangeId: id }).strict(),
  'assistant.reasoning.chunk': z
    .object({
      requestId: id,
      stepId: id,
      turnId: id,
      eventId: id,
      chunkIndex: z.number().int().nonnegative(),
      content: z.string(),
    })
    .strict(),
  'assistant.reasoning': z
    .object({
      requestId: id,
      stepId: id,
      turnId: id,
      eventId: id,
      content: z.string(),
    })
    .strict(),
  'assistant.chunk': z
    .object({
      requestId: id,
      stepId: id,
      turnId: id,
      eventId: id,
      chunkIndex: z.number().int().nonnegative(),
      content: z.string(),
    })
    .strict(),
  'assistant.message': messageSchema()
    .extend({
      requestId: id,
      stepId: id,
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      stopReason: z.enum(['complete', 'tool_calls', 'length']),
      requestStartedAt: z.string().optional(),
      firstTokenAt: z.string().optional(),
      completedAt: z.string().optional(),
      ttftMs: z.number().nonnegative().optional(),
      durationMs: z.number().nonnegative().optional(),
      generationDurationMs: z.number().nonnegative().optional(),
      firstTokenObserved: z.boolean().optional(),
    })
    .strict(),
  'tool.call': z
    .object({
      toolCallId: id,
      requestId: id,
      stepId: id,
      turnId: id,
      eventId: id,
      toolName: id,
      input: z.unknown(),
      replaySafe: z.boolean(),
      presentation: z.unknown().nullable().optional(),
      callIndex: z.number().int().nonnegative(),
    })
    .strict(),
  'tool.result': z
    .object({
      toolCallId: id,
      toolName: id,
      stepId: id.optional(),
      turnId: id,
      eventId: id,
      status: z.enum(['success', 'needs_input', 'retryable_error', 'fatal_error', 'cancelled']),
      output: z.unknown(),
      errorCode: z.string().nullable(),
      meta: z.unknown().nullable().optional(),
      presentation: z.unknown().nullable().optional(),
      executionFacts: z.unknown().nullable().optional(),
      recovered: z.boolean().optional(),
      callIndex: z.number().int().nonnegative(),
    })
    .strict(),
  'interaction.requested': z
    .object({
      interactionId: id,
      toolCallId: id,
      eventId: id,
      turnId: id,
      prompt: z.string().min(1),
      kind: z.enum(['text', 'confirm', 'select', 'approval', 'selection', 'form']),
      options: z.array(z.string()),
      schema: z.record(z.unknown()).optional(),
    })
    .strict(),
  'interaction.resolved': z
    .object({
      interactionId: id,
      eventId: id,
      value: z.unknown(),
      resolution: z.enum(['submitted', 'cancelled', 'rejected']),
      inboxItemId: id.nullable(),
    })
    .strict(),
  'compaction.started': z
    .object({
      compactionId: id,
      eventId: id,
      turnId: id,
      fromSeq: z.number().int().nonnegative(),
      throughSeq: z.number().int().nonnegative(),
    })
    .strict(),
  'compaction.summary-updated': summarySchema().extend({ compactionId: id }).strict(),
  'compaction.ended': z
    .object({
      compactionId: id,
      eventId: id,
      status: z.enum(['completed', 'failed']),
      errorCode: z.string().optional(),
    })
    .strict(),
  'surface.replaced': z
    .object({
      compactionId: id,
      eventId: id,
      turnId: id,
      kind: z.enum(['tool-prune', 'checkpoint']),
      surfaceGeneration: z.number().int().nonnegative(),
      shadowedSeqs: z.array(z.number().int().positive()).min(1),
      checkpointText: z.string().min(1),
      replacementRole: z.enum(['system', 'tool']).default('system'),
      toolCallId: id.optional(),
      tokensBefore: z.number().int().nonnegative(),
      tokensAfter: z.number().int().nonnegative(),
    })
    .strict(),
};

export class UnsupportedRuntimeEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRuntimeEventError';
  }
}

/** V1 Upcaster 入口。后续版本在这里先转为当前内部形态，Projection 不直接猜测。 */
export function validateAndUpcastRuntimeEvent(
  eventType: string,
  schemaVersion: number,
  payload: unknown,
): unknown {
  if (!RUNTIME_EVENT_TYPES.includes(eventType as RuntimeEventType)) return payload;
  if (schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw new UnsupportedRuntimeEventError(`Unsupported runtime event schema ${schemaVersion}`);
  }
  const schema = eventSchemas[eventType as RuntimeEventType];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new UnsupportedRuntimeEventError(`Invalid ${eventType} payload`);
  return parsed.data;
}

function messageSchema() {
  return z.object({ messageId: id, turnId: id, eventId: id, content: z.string() });
}

function summarySchema() {
  return z.object({
    eventId: id,
    summary: z.string(),
    summaryVersion: z.number().int().positive(),
    coveredThroughSeq: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  });
}
