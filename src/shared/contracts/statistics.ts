import { z } from 'zod';

export const modelCallStatisticsParamsSchema = z
  .object({
    sessionId: z.string().min(1).max(128).optional(),
    modelKeyword: z.string().trim().max(256).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type ModelCallStatisticsParams = z.infer<typeof modelCallStatisticsParamsSchema>;

const nullableMetric = z.number().nonnegative().nullable();

export const modelCallStatisticSchema = z
  .object({
    requestId: z.string(),
    sessionId: z.string(),
    sessionTitle: z.string(),
    stepId: z.string(),
    stepIndex: z.number().int().positive().nullable(),
    startedAt: z.string(),
    firstTokenAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    modelId: z.string(),
    modelConfigId: z.string().nullable(),
    providerPresetId: z.string().nullable(),
    thinkingMode: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    contextWindow: z.number().int().positive().nullable(),
    estimatedInputTokens: z.number().int().nonnegative().nullable(),
    ttftMs: nullableMetric,
    tps: nullableMetric,
    durationMs: nullableMetric,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    stopReason: z.string().nullable(),
    status: z.enum(['completed', 'failed', 'running']),
    toolCallCount: z.number().int().nonnegative(),
    firstTokenObserved: z.boolean(),
  })
  .strict();
export type ModelCallStatistic = z.infer<typeof modelCallStatisticSchema>;

export const modelCallStatisticsSnapshotSchema = z
  .object({
    total: z.number().int().nonnegative(),
    summary: z
      .object({
        callCount: z.number().int().nonnegative(),
        averageTtftMs: nullableMetric,
        averageTps: nullableMetric,
        totalTokens: z.number().int().nonnegative(),
      })
      .strict(),
    sessions: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
    models: z.array(z.string()),
    items: z.array(modelCallStatisticSchema),
  })
  .strict();
export type ModelCallStatisticsSnapshot = z.infer<typeof modelCallStatisticsSnapshotSchema>;
