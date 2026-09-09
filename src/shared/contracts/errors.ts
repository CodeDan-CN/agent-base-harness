/** Bridge 稳定错误码与错误载荷。 */

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED_SENDER'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'USER_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'DEFAULT_AGENT_REQUIRED'
  | 'LAST_ACTIVE_AGENT'
  | 'AGENT_ALREADY_IN_HOME'
  | 'AGENT_NOT_IN_HOME'
  | 'DELEGATION_NOT_ALLOWED'
  | 'NESTED_DELEGATION_NOT_ALLOWED'
  | 'DELEGATION_LIMIT'
  | 'MCP_CAPACITY_EXCEEDED'
  | 'MCP_SCHEMA_CHANGED'
  | 'CONFIGURATION_INVALID'
  | 'RUNTIME_NOT_READY'
  | 'RUNTIME_RESTARTED'
  | 'RUNTIME_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SESSION_BUSY'
  | 'TURN_CHANGED'
  | 'INBOX_ITEM_NOT_FOUND'
  | 'INBOX_ITEM_NOT_PROMOTABLE'
  | 'INTERACTION_NOT_PENDING'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_ADAPTER_UNAVAILABLE'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'INTERNAL_ERROR';

export interface BridgeErrorPayload {
  code: ErrorCode;
  message: string;
  requestId?: string;
}

/**
 * 面向调用方返回的稳定错误。message 不得包含 SQL、绝对路径、堆栈或凭据。
 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly requestId?: string;

  constructor(code: ErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.requestId = requestId;
  }
}

/** 将任意异常折叠成稳定的 BridgeErrorPayload，防止内部信息外泄。 */
export function toErrorPayload(
  err: unknown,
  fallback: ErrorCode = 'INTERNAL_ERROR',
): BridgeErrorPayload {
  if (err instanceof BridgeError) {
    const p: BridgeErrorPayload = { code: err.code, message: err.message };
    if (err.requestId) p.requestId = err.requestId;
    return p;
  }
  if (err instanceof Error) {
    return { code: fallback, message: 'Internal error' };
  }
  return { code: fallback, message: 'Internal error' };
}
