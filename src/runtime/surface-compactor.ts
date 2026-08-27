import type { ProjectedMessage, RuntimeProjection } from '../client-contracts/projection';
import { estimateTextTokens } from './context-projector';

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

export function selectCheckpointMessages(
  projection: RuntimeProjection,
  turnId: string,
  tokensToRemove: number,
): ProjectedMessage[] {
  const alreadyShadowed = new Set(
    projection.surfaceReplacements.flatMap((replacement) => replacement.shadowedSeqs),
  );
  const messages = projection.messages
    .filter((message) => !alreadyShadowed.has(message.seq))
    .sort((left, right) => left.seq - right.seq);
  const historicalTurns = groupByTurn(messages).filter((group) => group[0]?.turnId !== turnId);
  const closedCurrentSteps = groupByStep(
    messages.filter(
      (message) =>
        message.turnId === turnId &&
        message.stepId !== undefined &&
        projection.steps.get(message.stepId)?.status === 'completed',
    ),
  );
  const groups = [...historicalTurns, ...closedCurrentSteps].sort(
    (left, right) => (left[0]?.seq ?? 0) - (right[0]?.seq ?? 0),
  );
  const selected: ProjectedMessage[] = [];
  let removed = 0;
  for (const group of groups) {
    selected.push(...group);
    removed += group.reduce((sum, message) => sum + estimateTextTokens(message.content) + 4, 0);
    if (removed >= tokensToRemove) break;
  }
  return selected;
}

function groupByStep(messages: readonly ProjectedMessage[]): ProjectedMessage[][] {
  const groups = new Map<string, ProjectedMessage[]>();
  for (const message of messages) {
    if (!message.stepId) continue;
    const group = groups.get(message.stepId) ?? [];
    group.push(message);
    groups.set(message.stepId, group);
  }
  return [...groups.values()];
}

function groupByTurn(messages: readonly ProjectedMessage[]): ProjectedMessage[][] {
  const groups: ProjectedMessage[][] = [];
  for (const message of messages) {
    const current = groups.at(-1);
    if (!current || current[0]?.turnId !== message.turnId) groups.push([message]);
    else current.push(message);
  }
  return groups;
}
