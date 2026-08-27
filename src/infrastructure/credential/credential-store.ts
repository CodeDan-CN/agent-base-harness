import type { LocalUserId } from '../../shared/domain/user';

export type CredentialStatus = 'configured' | 'missing';

/**
 * Credential 的命名空间。明文绝不进入 SQLite/Renderer/日志/诊断，
 * SQLite 业务表只保存不可逆引用 credentialRef（由 namespace 派生）。
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
