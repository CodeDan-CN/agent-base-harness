import type { AgentClientApi, CommandMethod, QueryMethod, RpcEnvelope } from '@client-contracts';

let injectedClient: AgentClientApi | undefined;

export function configureClient(client: AgentClientApi): void {
  injectedClient = client;
}

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
  if (!injectedClient) throw new ClientApiError('BRIDGE_MISSING', '客户端尚未连接');
  return injectedClient;
}

export function userMessage(error: unknown): string {
  if (error instanceof ClientApiError) {
    switch (error.code) {
      case 'MODEL_NOT_CONFIGURED':
        return '请先在设置中添加可用模型，再在聊天输入框中选择模型。';
      case 'REVISION_CONFLICT':
        return '配置已在其他位置更新，请刷新后重试。';
      case 'INVALID_REQUEST':
        return '填写内容无效，请检查后重试。';
      case 'CONFLICT':
        return '该账号已存在，请换一个账号名。';
      case 'SESSION_BUSY':
        return '当前会话正在运行，请先停止任务。';
      case 'AUTHENTICATION_REQUIRED':
        return '请重新登录。';
      case 'AUTHENTICATION_FAILED':
        return '账号或密码不正确。';
      case 'AUTHORIZATION_FAILED':
        return '当前操作未获授权；如需创建账号，请由管理员启用远程注册。';
      case 'RATE_LIMITED':
        return '登录尝试过于频繁，请稍后再试。';
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
