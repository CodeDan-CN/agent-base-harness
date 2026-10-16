import { estimateTextTokens } from '../../protocol/src/token-estimate';
import type { SkillInstallation } from '../../protocol/src/domain/skill';
import { isHistoricalConversationMessage } from '../../protocol/src/client/assistant-output-policy';
import type { PermissionPreset } from '../../protocol/src/domain/permission';
import type { RuntimeProjection } from '../../protocol/src/client/projection';
import type { LocalUserId } from '../../protocol/src/domain/user';
import type { ModelToolDefinition, RuntimeMessage } from './model';
import { MINIMAL_SYSTEM_PROMPT } from './model';
import { PROGRESS_REMINDER } from './progress-communication';
import { checkpointMemoryCoverage, materializeSurface } from './surface-compactor';

export const FULL_ACCESS_AUTONOMY_PROMPT =
  '完全访问：偏好、方案、格式及可逆选择自行决定。仅缺少不可推断的必需事实时调用 request_user_input，并设 requiresUserProvidedFact=true；不得收集密码、验证码或 API Key。';

export interface ContextProjectionInput {
  userId?: LocalUserId;
  agentId?: string;
  agentInstructions?: string;
  agentMemoryProfile?: string;
  projection: RuntimeProjection;
  eventId: string;
  turnId: string;
  contextWindow: number;
  inputCapability?: number | null;
  reservedOutputTokens: number;
  safetyTokens: number;
  tools: readonly ModelToolDefinition[];
  skills: readonly SkillInstallation[];
  permissionPreset?: PermissionPreset;
  promptEpoch?: number;
  progressReminder?: boolean;
}

export interface ProjectedContext {
  progressReminder: boolean;
  includedSourceSeqs: number[];
  messages: RuntimeMessage[];
  estimatedInputTokens: number;
  budgetTokens: number;
  tokenBreakdown: ContextTokenBreakdown;
  includedEventIds: string[];
  promptEpoch: number;
  softTriggerTokens: number;
}

export interface ContextTokenBreakdown {
  fixedTokens: number;
  historyTokens: number;
  currentTurnTokens: number;
}

export interface ContextMeasurement {
  includedSourceSeqs: number[];
  estimatedInputTokens: number;
  hardInputLimitTokens: number;
  softTriggerTokens: number;
}

export class ContextBudgetError extends Error {
  constructor() {
    super('Current turn exceeds the model context budget');
    this.name = 'ContextBudgetError';
  }
}

export class ContextProjector {
  measureFull(input: ContextProjectionInput): ContextMeasurement {
    const hardInputLimitTokens = inputBudget(input);
    const projected = this.project({
      ...input,
      contextWindow: 100_000_000,
      inputCapability: null,
      reservedOutputTokens: 0,
      safetyTokens: 0,
    });
    return {
      includedSourceSeqs: projected.includedSourceSeqs,
      estimatedInputTokens: projected.estimatedInputTokens,
      hardInputLimitTokens,
      softTriggerTokens: Math.min(Math.floor(input.contextWindow * 0.8), hardInputLimitTokens),
    };
  }

  project(input: ContextProjectionInput): ProjectedContext {
    const budget = inputBudget(input);
    if (budget <= 0) throw new ContextBudgetError();

    const stableSystem = this.buildStableSystem(
      input.agentInstructions,
      input.agentMemoryProfile,
      input.tools,
      input.permissionPreset ?? 'guarded',
    );
    const stableMessage: RuntimeMessage = { role: 'system', content: stableSystem };
    const toolSchemaTokens = estimateTextTokens(JSON.stringify(input.tools));
    const currentEvent = input.projection.events.get(input.eventId);
    const shadowedSeqs = new Set(
      input.projection.surfaceReplacements.flatMap((replacement) => replacement.shadowedSeqs),
    );
    const surface = materializeSurface(input.projection);
    const currentMessages = surface
      .filter((message) => message.turnId === input.turnId)
      .filter(
        (message) =>
          message.role !== 'assistant' ||
          message.content.trim().length > 0 ||
          (message.toolCalls?.length ?? 0) > 0,
      )
      .map((message) => toRuntimeMessage(message, input.projection));

    // 保留当前 Turn 的配对完整 Surface；工具限额替换已持久化，仍超预算则明确失败。
    const stableSystemTokens = estimateMessage(stableMessage);
    let currentTurnTokens = estimateMessages(currentMessages);
    const fixedTokens = stableSystemTokens + toolSchemaTokens;
    let requiredTokens = fixedTokens + currentTurnTokens;
    if (requiredTokens > budget) throw new ContextBudgetError();
    const reminder: RuntimeMessage = { role: 'system', content: PROGRESS_REMINDER };
    const reminderTokens = estimateMessage(reminder);
    const progressReminder = Boolean(
      input.progressReminder && requiredTokens + reminderTokens <= budget,
    );
    if (progressReminder) {
      currentTurnTokens += reminderTokens;
      requiredTokens += reminderTokens;
    }

    const includedSourceSeqs = surface
      .filter((message) => message.turnId === input.turnId)
      .flatMap((message) => message.sourceSeqs);
    const optional: Array<{ message: RuntimeMessage; eventIds: string[]; sourceSeqs?: number[] }> =
      [];
    const memoryCoverage = checkpointMemoryCoverage(input.projection, input.turnId, input.eventId);
    if (input.projection.sessionMemorySummary && !memoryCoverage.session) {
      optional.push({
        message: {
          role: 'system',
          content: `会话历史摘要：\n${input.projection.sessionMemorySummary.summary}`,
        },
        eventIds: [],
      });
    }
    if (currentEvent?.summary && !memoryCoverage.event) {
      optional.push({
        message: { role: 'system', content: `当前事件摘要：\n${currentEvent.summary}` },
        eventIds: [input.eventId],
      });
    }

    const relatedIds = input.projection.relations
      .filter((relation) => relation.eventId === input.eventId)
      .map((relation) => relation.relatedEventId);
    const related = [...input.projection.events.values()]
      .filter((event) => event.id !== input.eventId && event.summary)
      .sort((left, right) => {
        const leftExplicit = relatedIds.indexOf(left.id);
        const rightExplicit = relatedIds.indexOf(right.id);
        if (leftExplicit >= 0 || rightExplicit >= 0) {
          if (leftExplicit < 0) return 1;
          if (rightExplicit < 0) return -1;
          return leftExplicit - rightExplicit;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, 3);
    const priorCurrentEventAll = input.projection.messages.filter(
      (message) =>
        message.eventId === input.eventId &&
        message.turnId !== input.turnId &&
        isVisibleHistoricalMessage(message) &&
        !shadowedSeqs.has(message.seq),
    );
    const coveredThroughSeq = currentEvent?.summaryThroughSeq ?? 0;
    const priorCurrentEvent = priorCurrentEventAll.filter(
      (message) => message.seq > coveredThroughSeq,
    );

    // Session 最近问答是跨 Event 的短期记忆保底，避免事项边界判断失误导致紧邻上下文丢失。
    const priorSessionMessages = input.projection.messages.filter(
      (message) =>
        message.turnId !== input.turnId &&
        isVisibleHistoricalMessage(message) &&
        message.seq > (input.projection.sessionMemorySummary?.coveredThroughSeq ?? 0) &&
        (message.eventId !== input.eventId || message.seq > coveredThroughSeq) &&
        !shadowedSeqs.has(message.seq),
    );
    const recentTurnIds: string[] = [];
    for (let index = priorSessionMessages.length - 1; index >= 0; index -= 1) {
      const turnId = priorSessionMessages[index]!.turnId;
      if (!recentTurnIds.includes(turnId)) recentTurnIds.push(turnId);
      if (recentTurnIds.length >= 2) break;
    }
    const recentTurnIdSet = new Set(recentTurnIds);
    const recentSessionMessages = priorSessionMessages.filter((message) =>
      recentTurnIdSet.has(message.turnId),
    );

    const rawBySeq = new Map(
      [...priorCurrentEvent, ...recentSessionMessages].map((message) => [message.seq, message]),
    );
    const rawTail = [...rawBySeq.values()].sort((left, right) => left.seq - right.seq).slice(-16);
    for (const message of rawTail) {
      optional.push({
        message: toRuntimeMessage(message, input.projection),
        eventIds: [message.eventId],
        sourceSeqs: [message.seq],
      });
    }

    for (const replacement of surface.filter(
      (candidate) =>
        candidate.turnId !== input.turnId && candidate.replacementKind === 'checkpoint',
    )) {
      optional.push({
        message: {
          role: 'system',
          content: `历史运行检查点：\n${replacement.content}`,
        },
        eventIds: [replacement.eventId],
        sourceSeqs: replacement.sourceSeqs,
      });
    }

    // 相关事项是最低优先级候选；预算不足时先丢弃，不挤占最近完整问答。
    if (related.length > 0) {
      optional.push({
        message: {
          role: 'system',
          content: `相关事件摘要：\n${related
            .map((event) => `- ${event.title}: ${event.summary ?? ''}`)
            .join('\n')}`,
        },
        eventIds: related.map((event) => event.id),
      });
    }

    const selected: RuntimeMessage[] = [];
    const includedEventIds = new Set([input.eventId]);
    let used = requiredTokens;
    let historyTokens = 0;
    for (const candidate of optional) {
      const cost = estimateMessage(candidate.message);
      if (used + cost <= budget) {
        selected.push(candidate.message);
        includedSourceSeqs.push(...(candidate.sourceSeqs ?? []));
        historyTokens += cost;
        for (const eventId of candidate.eventIds) includedEventIds.add(eventId);
        used += cost;
      }
    }

    const messages = coalesceSystemMessages([
      stableMessage,
      ...selected,
      ...currentMessages,
      ...(progressReminder ? [reminder] : []),
    ]);

    return {
      messages,
      includedSourceSeqs,
      progressReminder,
      estimatedInputTokens: used,
      budgetTokens: budget,
      tokenBreakdown: { fixedTokens, historyTokens, currentTurnTokens },
      includedEventIds: [...includedEventIds],
      promptEpoch: input.promptEpoch ?? 1,
      softTriggerTokens: Math.min(Math.floor(input.contextWindow * 0.8), budget),
    };
  }

  private buildStableSystem(
    agentInstructions: string | undefined,
    agentMemoryProfile: string | undefined,
    tools: readonly ModelToolDefinition[],
    permissionPreset: PermissionPreset,
  ): string {
    const toolText = tools.map((tool) => tool.name).join('、') || '无';
    const autonomy = permissionPreset === 'full-access' ? `\n\n${FULL_ACCESS_AUTONOMY_PROMPT}` : '';
    const memoryProfile = agentMemoryProfile?.trim()
      ? `\n\n<agent_memory_profile>\n${agentMemoryProfile.trim()}\n</agent_memory_profile>`
      : '';
    const instructions = agentInstructions?.trim()
      ? `\n\n<agent_instructions>\n${agentInstructions.trim()}\n</agent_instructions>`
      : '';
    return `${MINIMAL_SYSTEM_PROMPT}${instructions}${memoryProfile}${autonomy}\n\n可用工具：${toolText}`;
  }
}

export { estimateTextTokens } from '../../protocol/src/token-estimate';

function estimateMessage(message: RuntimeMessage): number {
  const toolCalls = message.toolCalls ? estimateTextTokens(JSON.stringify(message.toolCalls)) : 0;
  return (
    4 +
    estimateTextTokens(message.content) +
    toolCalls +
    (message.reasoningContent ? estimateTextTokens(message.reasoningContent) : 0)
  );
}

function estimateMessages(messages: readonly RuntimeMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

/**
 * Some OpenAI-compatible providers reject any system message after index 0.
 * Keep contextual summaries, checkpoints, and transient reminders in one leading
 * system message while preserving the relative order of conversation/tool facts.
 * Selection uses the unmerged message costs, so the recorded budget remains a
 * conservative upper bound after the per-message overhead is removed here.
 */
function coalesceSystemMessages(messages: readonly RuntimeMessage[]): RuntimeMessage[] {
  const systemContent = messages
    .filter((message) => message.role === 'system' && message.content.trim())
    .map((message) => message.content);
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  if (systemContent.length === 0) return nonSystemMessages;
  return [{ role: 'system', content: systemContent.join('\n\n') }, ...nonSystemMessages];
}

function toRuntimeMessage(
  message: Omit<RuntimeProjection['messages'][number], 'role'> & { role: RuntimeMessage['role'] },
  projection: RuntimeProjection,
): RuntimeMessage {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, toolCallId: message.toolCallId };
  }
  const reasoningContent =
    message.role === 'assistant' && message.toolCalls && message.stepId
      ? [...projection.reasoning.values()].find((reasoning) => reasoning.stepId === message.stepId)
          ?.content
      : undefined;
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    ...(reasoningContent ? { reasoningContent } : {}),
  };
}

function isVisibleHistoricalMessage(message: RuntimeProjection['messages'][number]): boolean {
  return isHistoricalConversationMessage(message);
}

function inputBudget(input: ContextProjectionInput): number {
  const effectiveSafetyTokens = Math.min(
    input.safetyTokens,
    Math.max(1, Math.floor(input.contextWindow * 0.1)),
  );
  const modelInputCeiling = Math.min(
    input.contextWindow - input.reservedOutputTokens,
    input.inputCapability ?? Number.POSITIVE_INFINITY,
  );
  return Math.floor(modelInputCeiling - effectiveSafetyTokens);
}
