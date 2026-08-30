/** 模型服务 / 模型 / 默认模型配置的领域类型。 */

import type { LocalUserId } from './user';

export type ModelServiceStatus = 'enabled' | 'disabled' | 'archived';
export type ModelStatus = 'enabled' | 'disabled' | 'archived';
export type ModelSource = 'discovered' | 'manual';
export type ModelMetadataSource = 'manual' | 'endpoint' | 'catalog' | 'fallback' | 'legacy';
export type ModelCapabilityMatchKind =
  'profile' | 'preset' | 'host' | 'model-unique' | 'model-consensus' | 'manual' | 'unresolved';
export type ModelThinkingMode = 'auto' | 'enabled' | 'disabled';
export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelService {
  id: string;
  userId: LocalUserId;
  name: string;
  providerType: string;
  endpoint: string;
  credentialRef: string | null;
  providerPresetId: string | null;
  providerPresetVersion: number | null;
  status: ModelServiceStatus;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Model {
  id: string;
  userId: LocalUserId;
  serviceId: string;
  remoteModelId: string;
  displayName: string;
  contextWindow: number | null;
  contextWindowOverride: number | null;
  compactionTriggerRatio: number;
  inputCapability: number | null;
  maxOutputCapability: number | null;
  requestMaxOutputTokens: number | null;
  maxOutputTokens: number | null;
  metadataSource: ModelMetadataSource;
  catalogVersion: string | null;
  capabilityProfileRef: string | null;
  capabilityMatchKind: ModelCapabilityMatchKind;
  thinkingMode: ModelThinkingMode;
  reasoningEffort: ModelReasoningEffort | null;
  capabilities: Record<string, unknown>;
  defaultParams: Record<string, unknown>;
  source: ModelSource;
  status: ModelStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface UserModelSettings {
  userId: LocalUserId;
  defaultModelId: string | null;
  updatedAt: string;
}
