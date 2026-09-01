import type { LocalUserId } from './user';
import type { ToolApprovalPolicy } from './permission';

export type McpTransport = 'stdio' | 'streamable-http';
export type McpServerStatus = 'enabled' | 'disabled' | 'archived';
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type McpToolReviewStatus = 'pending' | 'approved' | 'changed';

export interface McpStdioConfig {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export interface McpHttpConfig {
  url: string;
  local: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpServer {
  id: string;
  userId: LocalUserId;
  name: string;
  summary: string;
  transport: McpTransport;
  status: McpServerStatus;
  config: McpServerConfig;
  credentialRef: string | null;
  connectionStatus: McpConnectionStatus;
  generation: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface McpToolCatalogEntry {
  userId: LocalUserId;
  serverId: string;
  rawName: string;
  publicName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaDigest: string;
  enabled: boolean;
  reviewStatus: McpToolReviewStatus;
  approvalPolicy: ToolApprovalPolicy;
  generation: number;
  discoveredAt: string;
  updatedAt: string;
}
