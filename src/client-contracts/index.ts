/**
 * Renderer-safe 的唯一公开依赖面。
 * 本目录只能包含跨进程 DTO、运行时校验 Schema 与纯投影逻辑，不得引入 Node/Electron 能力。
 */
export * from './projection';
export * from './runtime';
export * from './model-output-policy';
export * from './assistant-output-policy';

export type { BootstrapLocalUser, BootstrapResult } from '../shared/contracts/bootstrap';
export type {
  AgentClientApi,
  CommandMethod,
  LifecycleEvent,
  QueryMethod,
  RpcEnvelope,
  RuntimeWorkerStatus,
  SessionSubscriptionEvent,
} from '../shared/contracts/ipc';
export type {
  ModelDiscoveryResult,
  ModelManagementSnapshot,
  ModelSaveParams,
  ModelServiceSaveParams,
  SkillManagementSnapshot,
  McpManagementSnapshot,
  McpServerSaveParams,
} from '../shared/contracts/management';
export type {
  ModelCallStatistic,
  ModelCallStatisticsParams,
  ModelCallStatisticsSnapshot,
} from '../shared/contracts/statistics';
export type { AuthResult, AuthSessionView, AuthenticatedUser } from '../shared/contracts/auth';
export type {
  AgentManagementSnapshot,
  AgentNavigationSnapshot,
  AgentCreateParams,
  AgentUpdateParams,
  AgentRuntimeDefaultsSetParams,
} from '../shared/contracts/agent-management';
export type { AgentProfile, AgentBindings } from '../shared/domain/agent';
export type { Session, SessionLogEvent } from '../shared/domain/session';
export type {
  ApprovalResolution,
  PermissionPreset,
  ToolApprovalPolicy,
} from '../shared/domain/permission';
