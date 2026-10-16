import type { ProjectedMessage, RuntimeProjection } from '../../protocol/src/client/projection';
import { estimateTextTokens } from '../../protocol/src/token-estimate';

export const TOOL_RESULT_PRUNE_MARKER =
  '\n\n...[工具结果已裁剪；原始结果仍保留在事件日志中，可按需回查]...\n\n';

export function pruneToolResultText(
  text: string,
  threshold = 8192,
  headLength = 4096,
  tailLength = 1024,
): string | null {
  const codePoints = [...text];
  if (codePoints.length <= threshold) return null;
  return `${codePoints.slice(0, headLength).join('')}${TOOL_RESULT_PRUNE_MARKER}${codePoints
    .slice(-tailLength)
    .join('')}`;
}

/** A visible message and the original facts it replaces. Original events are never rewritten. */
export interface SurfaceMessage extends Omit<ProjectedMessage, 'role'> {
  role: ProjectedMessage['role'] | 'system';
  sourceSeqs: number[];
  replacementKind?: 'tool-prune' | 'tool-output-limit' | 'checkpoint';
}

export function materializeSurface(projection: RuntimeProjection): SurfaceMessage[] {
  let surface: SurfaceMessage[] = projection.messages.map((message) => ({
    ...message,
    stepId:
      message.stepId ??
      (message.toolCallId
        ? (projection.toolCalls.get(message.toolCallId)?.stepId ?? undefined)
        : undefined),
    sourceSeqs: [message.seq],
  }));
  for (const replacement of projection.surfaceReplacements) {
    const covered = new Set(replacement.shadowedSeqs);
    const originals = surface.filter((message) =>
      message.sourceSeqs.some((seq) => covered.has(seq)),
    );
    const sourceSeqs = [
      ...new Set([...covered, ...originals.flatMap((message) => message.sourceSeqs)]),
    ];
    if (sourceSeqs.length === 0 && replacement.anchorSeq !== undefined)
      sourceSeqs.push(replacement.anchorSeq);
    if (sourceSeqs.length === 0) continue;
    surface = surface.filter((message) => !message.sourceSeqs.some((seq) => covered.has(seq)));
    surface.push({
      seq: Math.min(...sourceSeqs),
      eventId: replacement.eventId,
      turnId: replacement.turnId,
      ...(replacement.replacementRole === 'tool' ? { stepId: originals[0]?.stepId } : {}),
      role: replacement.replacementRole,
      content: replacement.checkpointText,
      ...(replacement.toolCallId ? { toolCallId: replacement.toolCallId } : {}),
      sourceSeqs,
      replacementKind: replacement.kind,
    });
  }
  return surface.sort((left, right) => left.seq - right.seq);
}

export function estimateSurfaceMessage(
  message: Pick<ProjectedMessage, 'content' | 'toolCalls'>,
): number {
  return (
    4 +
    estimateTextTokens(message.content) +
    (message.toolCalls ? estimateTextTokens(JSON.stringify(message.toolCalls)) : 0)
  );
}

export function selectCheckpointMessages(
  projection: RuntimeProjection,
  turnId: string,
  tokensToRemove: number,
  retainTokens = 0,
  includedSourceSeqs?: readonly number[],
): SurfaceMessage[] {
  const included = includedSourceSeqs ? new Set(includedSourceSeqs) : null;
  const messages = materializeSurface(projection).filter(
    (message) => !included || message.sourceSeqs.some((seq) => included.has(seq)),
  );
  const currentSteps = [...projection.steps.values()].filter(
    (step) => step.turnId === turnId && step.status === 'completed',
  );
  const latestStepId = currentSteps.at(-1)?.id;
  const groups: SurfaceMessage[][] = [];
  for (const message of messages) {
    // Preserve the latest tool/reasoning exchange and every unfinished step.
    if (message.turnId === turnId && message.replacementKind !== 'checkpoint') {
      if (!message.stepId) continue;
      if (
        message.stepId === latestStepId ||
        projection.steps.get(message.stepId)?.status !== 'completed'
      )
        break;
    }
    const key = message.turnId === turnId ? message.stepId : message.turnId;
    const previous = groups.at(-1);
    const previousKey =
      previous?.[0]?.turnId === turnId ? previous[0].stepId : previous?.[0]?.turnId;
    if (previous && key && previousKey === key) previous.push(message);
    else groups.push([message]);
  }
  const totalTokens = messages.reduce((sum, message) => sum + estimateSurfaceMessage(message), 0);
  const selected: SurfaceMessage[] = [];
  let removed = 0;
  for (const group of groups) {
    const calls = group.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
    const results = group
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId);
    if (
      calls.length !== results.length ||
      calls.some((id) => results.filter((result) => result === id).length !== 1)
    )
      break;
    const cost = group.reduce((sum, message) => sum + estimateSurfaceMessage(message), 0);
    if (totalTokens - removed - cost < retainTokens) break;
    selected.push(...group);
    removed += cost;
    if (removed >= tokensToRemove) break;
  }
  return selected;
}

/** Memory overlays only affect this execution turn, never the persisted business summaries. */
export function checkpointMemoryCoverage(
  projection: RuntimeProjection,
  turnId: string,
  eventId: string,
) {
  return {
    session: projection.surfaceReplacements.some(
      (replacement) =>
        replacement.turnId === turnId &&
        replacement.memorySessionVersion !== undefined &&
        replacement.memorySessionVersion === projection.sessionMemorySummary?.summaryVersion,
    ),
    event: projection.surfaceReplacements.some(
      (replacement) =>
        replacement.turnId === turnId &&
        replacement.eventId === eventId &&
        replacement.memoryEventVersion !== undefined &&
        replacement.memoryEventVersion === projection.events.get(eventId)?.summaryVersion,
    ),
  };
}
