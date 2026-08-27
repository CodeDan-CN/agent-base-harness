import type { CommandMethod, QueryMethod, RpcEnvelope } from '@client-contracts';

export class ClientApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClientApiError';
    this.code = code;
  }
}

export async function query<T>(method: QueryMethod, params?: unknown): Promise<T> {
  const client = requireClient();
  return unwrap<T>(await client.query(method, params));
}

export async function command<T>(method: CommandMethod, params?: unknown): Promise<T> {
  const client = requireClient();
  return unwrap<T>(await client.command(method, params));
}

export function unwrap<T>(envelope: RpcEnvelope): T {
  if (!envelope.ok) throw new ClientApiError(envelope.error.code, envelope.error.message);
  return envelope.result as T;
}

export function requireClient() {
  if (!window.agentClient) throw new ClientApiError('BRIDGE_MISSING', '客户端安全桥不可用');
  return window.agentClient;
}

export function userMessage(error: unknown): string {
  if (error instanceof ClientApiError) {
    switch (error.code) {
      case 'MODEL_NOT_CONFIGURED':
        return '请先在设置中配置并选择默认模型。';
      case 'REVISION_CONFLICT':
        return '配置已在其他位置更新，请刷新后重试。';
      case 'SESSION_BUSY':
        return '当前会话正在运行，请先停止任务。';
      case 'RUNTIME_NOT_READY':
      case 'RUNTIME_UNAVAILABLE':
      case 'RUNTIME_RESTARTED':
        return '运行时暂不可用，正在等待恢复。';
      default:
        return error.message || '操作失败';
    }
  }
  return error instanceof Error ? error.message : '操作失败';
}
