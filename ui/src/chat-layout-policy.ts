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
}): boolean {
  return input.role === 'assistant' && input.toolCallCount > 0;
}

export function selectTemporaryAssistantMessage<
  Message extends {
    seq: number;
    role: string;
    turnId: string;
    content: string;
    toolCalls?: readonly unknown[];
  },
>(input: {
  messages: readonly Message[];
  executionTurnId: string | null;
  hasRunningStream: boolean;
  hasFinalAssistant: boolean;
}): Message | null {
  if (!input.executionTurnId || input.hasRunningStream || input.hasFinalAssistant) return null;
  return (
    input.messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          message.turnId === input.executionTurnId &&
          (message.toolCalls?.length ?? 0) > 0 &&
          Boolean(message.content.trim()),
      )
      .sort((left, right) => left.seq - right.seq)
      .at(-1) ?? null
  );
}
