import type { PermissionPreset } from './permission';
import type { LocalUserId } from './user';

export const DEFAULT_AGENT_ID = 'dylan';
export const DEFAULT_AGENT_NAME = 'Dylan';

export type AgentStatus = 'active' | 'archived';
export type AgentBindingScope = 'user' | 'agent';
export type SessionOrigin = 'direct' | 'delegated';
export type DelegationStatus =
  'accepted' | 'running' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentProfile {
  id: string;
  userId: LocalUserId;
  name: string;
  description: string;
  avatarKey: string | null;
  instructions: string;
  defaultModelId: string | null;
  permissionPreset: PermissionPreset;
  status: AgentStatus;
  isDefault: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHomeItem {
  userId: LocalUserId;
  agentId: string;
  sortOrder: number;
  createdAt: string;
}

export interface AgentMcpBinding {
  agentId: string;
  serverId: string;
  accessScope: AgentBindingScope;
  enabled: boolean;
}

export interface AgentBindings {
  skillIds: string[];
  mcp: AgentMcpBinding[];
  delegateAgentIds: string[];
}

export interface AgentExecutionScope {
  userId: LocalUserId;
  agentId: string;
  sessionId: string;
  origin: SessionOrigin;
  parentSessionId: string | null;
}

export interface AgentDelegation {
  id: string;
  userId: LocalUserId;
  parentSessionId: string;
  parentTurnId: string;
  parentToolCallId: string;
  delegatedSessionId: string;
  targetAgentId: string;
  status: DelegationStatus;
  deadline: string;
  resultEventRef: string | null;
  createdAt: string;
  updatedAt: string;
}
