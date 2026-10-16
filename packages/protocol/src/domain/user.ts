/** 本地用户与可信上下文的基础类型。 */

export type LocalUserId = string;

export type LocalUserStatus = 'active';

export interface LocalUser {
  id: LocalUserId;
  displayName: string;
  avatarKey: string | null;
  sortOrder: number;
  status: LocalUserStatus;
  createdAt: string;
  updatedAt: string;
}

/** 应用首次启动时确保存在的两个预置本地用户。 */
export const BUILTIN_USERS: ReadonlyArray<{
  id: LocalUserId;
  displayName: string;
  avatarKey: string | null;
  sortOrder: number;
}> = [
  { id: 'user-a', displayName: 'User A', avatarKey: null, sortOrder: 0 },
  { id: 'user-b', displayName: 'User B', avatarKey: null, sortOrder: 1 },
];

export const DEFAULT_USER_ID: LocalUserId = 'user-a';

export function isBuiltinUser(id: unknown): id is LocalUserId {
  return typeof id === 'string' && BUILTIN_USERS.some((u) => u.id === id);
}

/** 用户级配置 revision（model / skill / runtime 三个域独立递增）。 */
export interface UserConfigRevisions {
  userId: LocalUserId;
  modelRevision: number;
  skillRevision: number;
  runtimeRevision: number;
  mcpRevision: number;
  agentRevision: number;
  updatedAt: string;
}
