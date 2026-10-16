import type { AgentClientApi } from '@client-contracts';

declare global {
  interface Window {
    agentClient?: AgentClientApi;
    agentWindow?: {
      setOfficeOpen(open: boolean): Promise<boolean>;
    };
  }
}

export {};
