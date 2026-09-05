import type { RuntimeProjection } from '../client-contracts/projection';

export const PROGRESS_REMINDER =
  '进度沟通提醒：已有连续操作或较长等待，尚未更新进展。若仍需执行，请先用普通正文简要说明已知发现、对任务的影响及下一步；没有新发现就说明待解决的问题，不编造结论。若已完成，直接交付结果。';

/** Only inspect persisted turn facts; reasoning and tool output are not user-facing updates. */
export function needsProgressReminder(
  projection: RuntimeProjection,
  turnId: string,
  nowIso: string,
): boolean {
  const steps = [...projection.steps.values()]
    .filter((step) => step.turnId === turnId)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  const proseSteps = new Set(
    projection.messages
      .filter(
        (message) =>
          message.turnId === turnId && message.role === 'assistant' && message.content.trim(),
      )
      .map((message) => message.stepId),
  );
  const toolSteps = new Set(
    [...projection.toolCalls.values()]
      .filter((tool) => tool.turnId === turnId)
      .map((tool) => tool.stepId),
  );
  let silentRounds = 0;
  let since = projection.turns.get(turnId)?.startedAt;
  let hasToolRound = false;
  let remindedSinceProse = false;
  for (const step of steps) {
    if (step.requestContext?.progressReminder) {
      silentRounds = 0;
      since = step.startedAt;
      hasToolRound = false;
      remindedSinceProse = true;
    }
    if (proseSteps.has(step.id)) {
      silentRounds = 0;
      // Step timestamps are a conservative approximation of when prose was emitted.
      since = step.startedAt;
      hasToolRound = false;
      remindedSinceProse = false;
    }
    if (step.status === 'completed' && toolSteps.has(step.id)) {
      hasToolRound = true;
      if (!proseSteps.has(step.id)) silentRounds += 1;
    }
  }
  return (
    silentRounds >= (remindedSinceProse ? 2 : 1) ||
    Boolean(hasToolRound && since && Date.parse(nowIso) - Date.parse(since) >= 60_000)
  );
}
