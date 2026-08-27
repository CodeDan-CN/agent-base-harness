import type { AgentClientApi } from '@client-contracts';

declare global {
  interface Window {
    agentClient?: AgentClientApi;
  }
}

export {};
