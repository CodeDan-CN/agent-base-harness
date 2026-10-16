export type AssistantMessagePhase = 'commentary' | 'final_answer';
export type AssistantPhaseSource = 'provider' | 'compatibility';

/** Only protocol metadata can establish a native phase; prose is never parsed for it. */
export function readAssistantPhase(value: unknown): AssistantMessagePhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

export function assistantMessagePhase(message: {
  phase?: AssistantMessagePhase | null;
  toolCalls?: readonly unknown[];
}): AssistantMessagePhase {
  return message.phase ?? (message.toolCalls?.length ? 'commentary' : 'final_answer');
}

export function isHistoricalConversationMessage(message: {
  role: string;
  phase?: AssistantMessagePhase | null;
  toolCalls?: readonly unknown[];
}): boolean {
  return (
    message.role === 'user' ||
    (message.role === 'assistant' &&
      !message.toolCalls?.length &&
      assistantMessagePhase(message) === 'final_answer')
  );
}
