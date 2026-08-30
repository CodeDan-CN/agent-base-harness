import type { RuntimeProjection, Session } from '@client-contracts';

export interface SessionSnapshotPayload {
  session: Session;
  throughSeq: number;
  inbox: RuntimeProjection['inbox'];
  conversationEvents: Array<RuntimeProjection['events'] extends Map<string, infer T> ? T : never>;
  turns: Array<RuntimeProjection['turns'] extends Map<string, infer T> ? T : never>;
  messages: RuntimeProjection['messages'];
  interactions: Array<RuntimeProjection['interactions'] extends Map<string, infer T> ? T : never>;
  trajectory: {
    steps: Array<RuntimeProjection['steps'] extends Map<string, infer T> ? T : never>;
    toolCalls: Array<RuntimeProjection['toolCalls'] extends Map<string, infer T> ? T : never>;
  };
  streaming: Array<RuntimeProjection['streams'] extends Map<string, infer T> ? T : never>;
  reasoning?: Array<RuntimeProjection['reasoning'] extends Map<string, infer T> ? T : never>;
  relations: RuntimeProjection['relations'];
  usage: RuntimeProjection['usage'];
  sessionMemorySummary?: RuntimeProjection['sessionMemorySummary'];
  surfaceReplacements?: RuntimeProjection['surfaceReplacements'];
  activeTurnId: string | null;
}

export interface BannerState {
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export type SettingsTab = 'appearance' | 'models' | 'mcp' | 'skills' | 'statistics';
