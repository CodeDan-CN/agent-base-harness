/** Session 容器与仅追加 EventStore 的领域类型。 */

import type { LocalUserId } from './user';
import type { PermissionPreset } from './permission';

export type SessionStatus = 'active' | 'archived';

export interface Session {
  id: string;
  userId: LocalUserId;
  title: string;
  status: SessionStatus;
  permissionPreset: PermissionPreset;
  nextSeq: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** EventStore 中一条仅追加事实的持久化形态。 */
export interface SessionLogEvent {
  userId: LocalUserId;
  sessionId: string;
  seq: number;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  requestId: string | null;
  idempotencyKey?: string | null;
  /** 已经过 Schema 校验的合法 payload。 */
  payload: unknown;
}

/** 追加一个事件所需的最小输入。 */
export interface AppendEventInput {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  requestId?: string | null;
  idempotencyKey?: string | null;
  payload: unknown;
}

/** 一次追加操作的结果。 */
export interface AppendResult {
  /** 追加后的 Session version。 */
  version: number;
  /** 追加后的 Session next_seq。 */
  nextSeq: number;
  /** 本次追加的 seq 闭区间。 */
  fromSeq: number;
  toSeq: number;
}

/** 追加命令的入参。 */
export interface AppendCommand {
  userId: LocalUserId;
  sessionId: string;
  expectedVersion: number;
  events: readonly AppendEventInput[];
  /** Driver 写入时携带；普通 Inbox Command 不需要占用执行 lease。 */
  leaseOwner?: string;
}
