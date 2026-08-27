export interface MessageExecutionPlacement {
  isLastAssistant: boolean;
  messageTurnId: string;
  executionTurnId: string | null;
  hasRunningStream: boolean;
}

/**
 * 执行过程跟随当前流式消息或目标 Turn 的最终助手消息。
 * 带工具调用的助手消息属于执行轨迹，不属于聊天正文。
 */
export function shouldRenderExecutionForMessage(input: MessageExecutionPlacement): boolean {
  if (!input.isLastAssistant || input.hasRunningStream) return false;
  return input.messageTurnId === input.executionTurnId;
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
