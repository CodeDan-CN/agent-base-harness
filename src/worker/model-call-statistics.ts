import type {
  ModelCallStatistic,
  ModelCallStatisticsParams,
  ModelCallStatisticsSnapshot,
} from '../shared/contracts/statistics';
import type { Session, SessionLogEvent } from '../shared/domain/session';

interface SessionLog {
  session: Session;
  events: readonly SessionLogEvent[];
}

interface IndexedCall extends ModelCallStatistic {
  sequence: number;
}

/** 从仅追加 Session Event Log 重建模型调用统计，不引入第二事实源。 */
export function buildModelCallStatistics(
  logs: readonly SessionLog[],
  params: ModelCallStatisticsParams,
): ModelCallStatisticsSnapshot {
  const allItems = logs.flatMap(({ session, events }) => callsForSession(session, events));
  const sessions = logs
    .map(({ session }) => ({ id: session.id, title: session.title }))
    .sort((left, right) => left.title.localeCompare(right.title));
  const models = [...new Set(allItems.map((item) => item.modelId))].sort((left, right) =>
    left.localeCompare(right),
  );
  const keyword = params.modelKeyword?.trim().toLocaleLowerCase() ?? '';
  const fromMs = params.from ? Date.parse(params.from) : Number.NEGATIVE_INFINITY;
  const toMs = params.to ? Date.parse(params.to) : Number.POSITIVE_INFINITY;
  const filtered = allItems
    .filter((item) => !params.sessionId || item.sessionId === params.sessionId)
    .filter((item) => !keyword || item.modelId.toLocaleLowerCase().includes(keyword))
    .filter((item) => {
      const startedMs = Date.parse(item.startedAt);
      return startedMs >= fromMs && startedMs <= toMs;
    })
    .sort((left, right) => {
      const byTime = Date.parse(right.startedAt) - Date.parse(left.startedAt);
      return byTime || right.sequence - left.sequence;
    });
  const ttfts = filtered.flatMap((item) => (item.ttftMs === null ? [] : [item.ttftMs]));
  const tpsValues = filtered.flatMap((item) => (item.tps === null ? [] : [item.tps]));
  const items = filtered.slice(0, params.limit ?? 100).map(({ sequence: _, ...item }) => item);

  return {
    total: filtered.length,
    summary: {
      callCount: filtered.length,
      averageTtftMs: average(ttfts),
      averageTps: average(tpsValues),
      totalTokens: filtered.reduce((total, item) => total + item.totalTokens, 0),
    },
    sessions,
    models,
    items,
  };
}

function callsForSession(session: Session, events: readonly SessionLogEvent[]): IndexedCall[] {
  const stepIndexes = new Map<string, number>();
  const stepEnds = new Map<string, SessionLogEvent>();
  const responses = new Map<string, SessionLogEvent>();
  const firstChunks = new Map<string, SessionLogEvent>();
  const toolCounts = new Map<string, number>();

  for (const event of events) {
    const payload = record(event.payload);
    if (event.eventType === 'step.started') {
      const stepId = stringAt(payload, 'stepId');
      const stepIndex = integerAt(payload, 'stepIndex');
      if (stepId && stepIndex) stepIndexes.set(stepId, stepIndex);
    } else if (event.eventType === 'step.ended') {
      const stepId = stringAt(payload, 'stepId');
      if (stepId) stepEnds.set(stepId, event);
    } else if (event.eventType === 'assistant.message') {
      const requestId = stringAt(payload, 'requestId');
      if (requestId) responses.set(requestId, event);
    } else if (
      event.eventType === 'assistant.chunk' ||
      event.eventType === 'assistant.reasoning.chunk'
    ) {
      const requestId = stringAt(payload, 'requestId');
      if (requestId && !firstChunks.has(requestId)) firstChunks.set(requestId, event);
    } else if (event.eventType === 'tool.call') {
      const requestId = stringAt(payload, 'requestId');
      if (requestId) toolCounts.set(requestId, (toolCounts.get(requestId) ?? 0) + 1);
    }
  }

  const seen = new Set<string>();
  const calls: IndexedCall[] = [];
  for (const event of events) {
    if (event.eventType !== 'model.request.context') continue;
    const context = record(event.payload);
    const requestId = stringAt(context, 'requestId');
    const stepId = stringAt(context, 'stepId');
    if (!requestId || !stepId || seen.has(requestId)) continue;
    seen.add(requestId);

    const responseEvent = responses.get(requestId);
    const response = record(responseEvent?.payload);
    const firstChunk = firstChunks.get(requestId);
    const stepEnd = stepEnds.get(stepId);
    const model = record(context?.model);
    const startedAt = stringAt(response, 'requestStartedAt') ?? event.occurredAt;
    const completedAt = stringAt(response, 'completedAt') ?? responseEvent?.occurredAt ?? null;
    const firstTokenObserved =
      booleanAt(response, 'firstTokenObserved') ?? firstChunk !== undefined;
    const firstTokenAt =
      stringAt(response, 'firstTokenAt') ?? firstChunk?.occurredAt ?? completedAt;
    const durationMs =
      numberAt(response, 'durationMs') ??
      millisecondsBetween(startedAt, completedAt ?? stepEnd?.occurredAt ?? null);
    const ttftMs = numberAt(response, 'ttftMs') ?? millisecondsBetween(startedAt, firstTokenAt);
    const inputTokens = integerAt(response, 'inputTokens') ?? 0;
    const outputTokens = integerAt(response, 'outputTokens') ?? 0;
    const generationDurationMs =
      numberAt(response, 'generationDurationMs') ??
      (firstTokenObserved ? millisecondsBetween(firstTokenAt, completedAt) : durationMs);
    const tps =
      outputTokens > 0 && generationDurationMs !== null && generationDurationMs > 0
        ? outputTokens / (generationDurationMs / 1000)
        : null;
    const stepStatus = stringAt(record(stepEnd?.payload), 'status');

    calls.push({
      requestId,
      sessionId: session.id,
      sessionTitle: session.title,
      stepId,
      stepIndex: stepIndexes.get(stepId) ?? null,
      startedAt,
      firstTokenAt,
      completedAt,
      modelId: stringAt(model, 'remoteModelId') ?? '未知模型',
      modelConfigId: stringAt(model, 'modelId') ?? null,
      providerPresetId: stringAt(model, 'providerPresetId') ?? null,
      thinkingMode: stringAt(model, 'thinkingMode') ?? null,
      reasoningEffort: stringAt(model, 'reasoningEffort') ?? null,
      contextWindow: integerAt(model, 'contextWindow') ?? null,
      estimatedInputTokens: integerAt(context, 'estimatedInputTokens') ?? null,
      ttftMs,
      tps,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      stopReason: stringAt(response, 'stopReason') ?? null,
      status: responseEvent ? 'completed' : stepStatus ? 'failed' : 'running',
      toolCallCount: toolCounts.get(requestId) ?? 0,
      firstTokenObserved,
      sequence: event.seq,
    });
  }
  return calls;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function millisecondsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function numberAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = value?.[key];
  return typeof found === 'number' && Number.isFinite(found) && found >= 0 ? found : undefined;
}

function integerAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const found = numberAt(value, key);
  return found !== undefined && Number.isInteger(found) ? found : undefined;
}

function booleanAt(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const found = value?.[key];
  return typeof found === 'boolean' ? found : undefined;
}
