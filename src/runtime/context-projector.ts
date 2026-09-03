import type { SkillInstallation } from '../shared/domain/skill';
import type { PermissionPreset } from '../shared/domain/permission';
import type { RuntimeProjection } from '../client-contracts/projection';
import { readUserMemoryProfile } from '../infrastructure/workspace/session-workspace';
import type { LocalUserId } from '../shared/domain/user';
import type { ModelToolDefinition, RuntimeMessage } from './model';
import { MINIMAL_SYSTEM_PROMPT } from './model';

export const FULL_ACCESS_AUTONOMY_PROMPT =
  '完全访问：偏好、方案、格式及可逆选择自行决定。仅缺少不可推断的必需事实时调用 request_user_input，并设 requiresUserProvidedFact=true；不得收集密码、验证码或 API Key。';

export interface ContextProjectionInput {
  userId?: LocalUserId;
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
}

export interface ProjectedContext {
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
  constructor(private readonly appDataDir?: string) {}

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
      estimatedInputTokens: projected.estimatedInputTokens,
      hardInputLimitTokens,
      softTriggerTokens: Math.min(Math.floor(input.contextWindow * 0.8), hardInputLimitTokens),
    };
  }

  project(input: ContextProjectionInput): ProjectedContext {
    const budget = inputBudget(input);
    if (budget <= 0) throw new ContextBudgetError();

    const stableSystem = this.buildStableSystem(
      input.userId,
      input.tools,
      input.permissionPreset ?? 'guarded',
    );
    const stableMessage: RuntimeMessage = { role: 'system', content: stableSystem };
    const toolSchemaTokens = estimateTextTokens(JSON.stringify(input.tools));
    const currentEvent = input.projection.events.get(input.eventId);
    const shadowedSeqs = new Set(
      input.projection.surfaceReplacements.flatMap((replacement) => replacement.shadowedSeqs),
    );
    const currentMessages = materializeTurnMessages(input.projection, input.turnId);

    // 当前 Turn（尤其 Tool Result）必须完整保留，超过预算时明确失败，不能截断事实。
    const stableSystemTokens = estimateMessage(stableMessage);
    const currentTurnTokens = estimateMessages(currentMessages);
    const fixedTokens = stableSystemTokens + toolSchemaTokens;
    const requiredTokens = fixedTokens + currentTurnTokens;
    if (requiredTokens > budget) throw new ContextBudgetError();

    const optional: Array<{ message: RuntimeMessage; eventIds: string[] }> = [];
    if (input.projection.sessionMemorySummary) {
      optional.push({
        message: {
          role: 'system',
          content: `会话历史摘要：\n${input.projection.sessionMemorySummary.summary}`,
        },
        eventIds: [],
      });
    }
    if (currentEvent?.summary) {
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
    const latestPriorTurnId = priorCurrentEventAll.at(-1)?.turnId;
    const coveredThroughSeq = currentEvent?.summaryThroughSeq ?? 0;
    const priorCurrentEvent = priorCurrentEventAll.filter(
      (message) =>
        message.seq > coveredThroughSeq ||
        (latestPriorTurnId !== undefined && message.turnId === latestPriorTurnId),
    );

    // Session 最近问答是跨 Event 的短期记忆保底，避免事项边界判断失误导致紧邻上下文丢失。
    const priorSessionMessages = input.projection.messages.filter(
      (message) =>
        message.turnId !== input.turnId &&
        isVisibleHistoricalMessage(message) &&
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
      });
    }

    for (const replacement of input.projection.surfaceReplacements.filter(
      (candidate) => candidate.turnId !== input.turnId && candidate.kind === 'checkpoint',
    )) {
      optional.push({
        message: {
          role: 'system',
          content: `历史运行检查点：\n${replacement.checkpointText}`,
        },
        eventIds: [replacement.eventId],
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
        historyTokens += cost;
        for (const eventId of candidate.eventIds) includedEventIds.add(eventId);
        used += cost;
      }
    }

    return {
      messages: [stableMessage, ...selected, ...currentMessages],
      estimatedInputTokens: used,
      budgetTokens: budget,
      tokenBreakdown: { fixedTokens, historyTokens, currentTurnTokens },
      includedEventIds: [...includedEventIds],
      promptEpoch: input.promptEpoch ?? 1,
      softTriggerTokens: Math.min(Math.floor(input.contextWindow * 0.8), budget),
    };
  }

  private buildStableSystem(
    userId: LocalUserId | undefined,
    tools: readonly ModelToolDefinition[],
    permissionPreset: PermissionPreset,
  ): string {
    const toolText = tools.map((tool) => tool.name).join('、') || '无';
    const autonomy = permissionPreset === 'full-access' ? `\n\n${FULL_ACCESS_AUTONOMY_PROMPT}` : '';
    const profile = this.appDataDir && userId ? readUserMemoryProfile(this.appDataDir, userId) : '';
    const memoryProfile = profile
      ? `\n\n<user_memory_profile>\n${profile}\n</user_memory_profile>`
      : '';
    return `${MINIMAL_SYSTEM_PROMPT}${memoryProfile}${autonomy}\n\n可用工具：${toolText}`;
  }
}

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

function estimateMessage(message: RuntimeMessage): number {
  const toolCalls = message.toolCalls ? estimateTextTokens(JSON.stringify(message.toolCalls)) : 0;
  return 4 + estimateTextTokens(message.content) + toolCalls;
}

function estimateMessages(messages: readonly RuntimeMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

function toRuntimeMessage(
  message: RuntimeProjection['messages'][number],
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

function materializeTurnMessages(projection: RuntimeProjection, turnId: string): RuntimeMessage[] {
  const originals = projection.messages
    .filter((message) => message.turnId === turnId)
    .sort((left, right) => left.seq - right.seq);
  const replacements = projection.surfaceReplacements
    .filter((replacement) => replacement.turnId === turnId)
    .sort(
      (left, right) =>
        Math.min(...left.shadowedSeqs) - Math.min(...right.shadowedSeqs) ||
        left.surfaceGeneration - right.surfaceGeneration,
    );
  const replacementAt = new Map<number, (typeof replacements)[number]>();
  const shadowed = new Set<number>();
  for (const replacement of replacements) {
    const firstSeq = Math.min(...replacement.shadowedSeqs);
    replacementAt.set(firstSeq, replacement);
    for (const seq of replacement.shadowedSeqs) shadowed.add(seq);
  }
  const result: RuntimeMessage[] = [];
  for (const message of originals) {
    const replacement = replacementAt.get(message.seq);
    if (replacement) {
      result.push(
        replacement.replacementRole === 'tool'
          ? {
              role: 'tool',
              content: replacement.checkpointText,
              toolCallId: replacement.toolCallId,
            }
          : {
              role: 'system',
              content: `运行上下文检查点：\n${replacement.checkpointText}`,
            },
      );
    }
    if (!shadowed.has(message.seq)) result.push(toRuntimeMessage(message, projection));
  }
  return result;
}

function isVisibleHistoricalMessage(message: RuntimeProjection['messages'][number]): boolean {
  return message.role !== 'tool' && !(message.role === 'assistant' && message.toolCalls?.length);
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
