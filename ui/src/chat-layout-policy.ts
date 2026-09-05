import { assistantMessagePhase, type AssistantMessagePhase } from '@client-contracts';

export interface MessageExecutionPlacement {
  messageTurnId: string;
  streamingTurnId: string | null;
}

export interface InteractionTurnLink {
  turnId: string;
  continuationTurnId?: string;
}

/**
 * request_user_input 会用新的 Turn 续接模型执行，但聊天界面把这条内部边界合并为一段执行过程。
 */
export function interactionExecutionTurnIds(
  interactions: readonly InteractionTurnLink[],
  targetTurnId: string,
): string[] {
  let rootTurnId = targetTurnId;
  const visited = new Set<string>();
  while (!visited.has(rootTurnId)) {
    visited.add(rootTurnId);
    const parent = interactions.find(
      (interaction) => interaction.continuationTurnId === rootTurnId,
    );
    if (!parent) break;
    rootTurnId = parent.turnId;
  }

  const turnIds = [rootTurnId];
  visited.clear();
  while (!visited.has(turnIds.at(-1)!)) {
    const currentTurnId = turnIds.at(-1)!;
    visited.add(currentTurnId);
    const continuation = interactions.find(
      (interaction) =>
        interaction.turnId === currentTurnId && Boolean(interaction.continuationTurnId),
    )?.continuationTurnId;
    if (!continuation || visited.has(continuation)) break;
    turnIds.push(continuation);
  }
  return turnIds;
}

/**
 * 已完成回答保留各自 Turn 的执行过程；当前流式 Turn 由流式消息承载，避免重复渲染。
 */
export function shouldRenderExecutionForMessage(input: MessageExecutionPlacement): boolean {
  return input.messageTurnId !== input.streamingTurnId;
}

export function shouldRenderStandaloneExecution(input: {
  executionTurnId: string | null;
  hasRunningStream: boolean;
  executionTurnHasAssistant: boolean;
}): boolean {
  return (
    input.executionTurnId !== null && !input.hasRunningStream && !input.executionTurnHasAssistant
  );
}

export function isExecutionProcessAssistant(input: {
  role: string;
  toolCallCount: number;
  phase?: AssistantMessagePhase;
}): boolean {
  return (
    input.role === 'assistant' &&
    (input.phase ?? (input.toolCallCount > 0 ? 'commentary' : 'final_answer')) === 'commentary'
  );
}

/** 同一交互续接链只保留一个过程入口，避免说明与后续回答重复承载执行卡片。 */
export function selectChatMessages<
  Message extends {
    role: string;
    turnId: string;
    interactionId?: string;
    phase?: AssistantMessagePhase;
    toolCalls?: readonly unknown[];
  },
>(messages: readonly Message[], interactions: readonly InteractionTurnLink[] = []): Message[] {
  const groupId = (turnId: string) =>
    interactionExecutionTurnIds(interactions, turnId)[0] ?? turnId;
  const answered = new Set(
    messages
      .filter((m) => m.role === 'assistant' && assistantMessagePhase(m) === 'final_answer')
      .map((m) => groupId(m.turnId)),
  );
  const anchors = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === 'assistant' && !answered.has(groupId(message.turnId)))
      anchors.set(groupId(message.turnId), message);
  }
  return messages.filter(
    (message) =>
      (message.role === 'user' && !message.interactionId) ||
      (message.role === 'assistant' &&
        (assistantMessagePhase(message) === 'final_answer' ||
          anchors.get(groupId(message.turnId)) === message)),
  );
}
