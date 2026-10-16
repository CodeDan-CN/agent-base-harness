import type { LocalUserId } from '../../../protocol/src/domain/user';

export type CredentialStatus = 'configured' | 'missing';

/**
 * Credential 的命名空间。模型/MCP 业务表仅存 credentialRef；
 * 密钥由 Runtime 的独立 SQLite 表保存，明文不进入 Renderer/日志/诊断。
 */
export interface CredentialScope {
  userId: LocalUserId;
  purpose: string;
  entityId: string;
}

export const CREDENTIAL_APP_NAMESPACE = 'agent-client-harness';

export function credentialRefOf(scope: CredentialScope): string {
  return `${CREDENTIAL_APP_NAMESPACE}:${scope.userId}:${scope.purpose}:${scope.entityId}`;
}

export interface CredentialStore {
  set(scope: CredentialScope, value: string): Promise<void>;
  get(scope: CredentialScope): Promise<string | null>;
  /** Provider 发送边界按 SQLite 中保存的不可逆引用读取明文。 */
  getByRef(ref: string): Promise<string | null>;
  delete(scope: CredentialScope): Promise<void>;
  status(scope: CredentialScope): Promise<CredentialStatus>;
  /** 底层凭据库当前是否可用（不依赖具体 scope）。 */
  available(): Promise<boolean>;
}

export function isCredentialRef(value: string): boolean {
  return value.startsWith(`${CREDENTIAL_APP_NAMESPACE}:`) && value.split(':').length >= 4;
}
