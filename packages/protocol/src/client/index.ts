/**
 * Renderer-safe 的唯一公开依赖面。
 * 本目录包含跨进程 DTO、运行时校验 Schema、纯投影逻辑与浏览器兼容工具，不得引入 Node/Electron 能力。
 */
export * from './projection';
export * from './runtime';
export * from './model-output-policy';
export * from './assistant-output-policy';
export { createClientId } from './client-id';
export { API_VERSION } from './api-version';
export { MAX_SESSION_FILE_BYTES } from '../contracts/session-file';
export type { UploadedSessionFile } from '../contracts/session-file';

export type { BootstrapLocalUser, BootstrapResult } from '../contracts/bootstrap';
export type {
  AgentClientApi,
  CommandMethod,
  LifecycleEvent,
  QueryMethod,
  RpcEnvelope,
  RuntimeWorkerStatus,
  SessionSubscriptionEvent,
} from '../contracts/ipc';
export type {
  ModelDiscoveryResult,
  ModelManagementSnapshot,
  ModelSaveParams,
  ModelServiceSaveParams,
  SkillManagementSnapshot,
  McpManagementSnapshot,
  McpServerSaveParams,
} from '../contracts/management';
export type {
  ModelCallStatistic,
  ModelCallStatisticsParams,
  ModelCallStatisticsSnapshot,
} from '../contracts/statistics';
export type { AuthResult, AuthSessionView, AuthenticatedUser } from '../contracts/auth';
export type {
  AgentManagementSnapshot,
  AgentNavigationSnapshot,
  AgentCreateParams,
  AgentUpdateParams,
  AgentRuntimeDefaultsSetParams,
} from '../contracts/agent-management';
export type { AgentProfile, AgentBindings } from '../domain/agent';
export type { Session, SessionLogEvent } from '../domain/session';
export type {
  ApprovalResolution,
  PermissionPreset,
  ToolApprovalPolicy,
} from '../domain/permission';
