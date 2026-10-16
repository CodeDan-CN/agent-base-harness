import type { AgentClientApi, RpcEnvelope } from '@client-contracts';
import { AgentClient, AgentClientError } from '../../../packages/client-sdk/src/agent-client';
import { browserAccountStorage } from '../../../packages/client-sdk/src/local-auth';

/** Tokens live only in this connection instance, never in localStorage or the APK. */
export function createMobileClient(baseUrl: string, transport: typeof fetch) {
  const client = new AgentClient({
    baseUrl,
    fetch: transport,
    clientKind: 'mobile',
    accountStorage: browserAccountStorage('mobile'),
  });
  let disposed = false;
  const subscriptions = new Set<() => void>();
  const wrap = async (action: () => Promise<unknown>): Promise<RpcEnvelope> => {
    try {
      if (disposed) throw new Error('服务器连接已关闭');
      return { ok: true, result: await action() };
    } catch (error) {
      if (
        !disposed &&
        error instanceof AgentClientError &&
        error.code === 'AUTHENTICATION_REQUIRED'
      ) {
        client.setAccessToken(undefined);
        window.dispatchEvent(new Event('mobile-auth-expired'));
      }
      return {
        ok: false,
        error: {
          code: (error instanceof AgentClientError ? error.code : 'CONNECTION_ERROR') as Extract<
            RpcEnvelope,
            { ok: false }
          >['error']['code'],
          message:
            error instanceof AgentClientError && error.code === 'MODEL_NOT_CONFIGURED'
              ? '请先在 Web 或桌面端为智能体配置模型。'
              : error instanceof Error
                ? error.message
                : String(error),
        },
      };
    }
  };
  const api: AgentClientApi = {
    login: (input) =>
      wrap(async () => {
        const auth = await client.login(input.loginName, input.password);
        return { user: auth.user, expiresAt: auth.expiresAt };
      }),
    register: (input) =>
      wrap(async () => {
        const auth = await client.registerRemote(input);
        return { user: auth.user, expiresAt: auth.expiresAt };
      }),
    currentAuth: () => wrap(() => client.me()),
    logout: () =>
      wrap(async () => {
        await client.logout();
        return { loggedOut: true };
      }),
    query: (method, params) => wrap(() => client.query(method, params)),
    command: (method, params) => wrap(() => client.command(method, params)),
    subscribeSession: (sessionId, afterSeq, listener) => {
      const stop = client.subscribeSession(
        sessionId,
        afterSeq,
        (event) =>
          listener({
            type: 'events',
            sessionId,
            fromSeq: event.seq,
            toSeq: event.seq,
            events: [event],
          }),
        {
          onError: () =>
            listener({
              type: 'resync-required',
              sessionId,
              expectedSeq: afterSeq + 1,
              receivedSeq: afterSeq + 1,
            }),
        },
      );
      subscriptions.add(stop);
      return () => {
        stop();
        subscriptions.delete(stop);
      };
    },
    subscribeLifecycle: (listener) => {
      let active = true;
      let previous = '';
      const probe = async () => {
        const status = await client.health().then(
          () => 'ready' as const,
          () => 'failed' as const,
        );
        if (active && previous !== status) {
          previous = status;
          listener({ type: 'runtime', status, generation: 1 });
        }
      };
      void probe();
      const timer = window.setInterval(() => void probe(), 5000);
      const stop = () => {
        active = false;
        window.clearInterval(timer);
      };
      subscriptions.add(stop);
      return () => {
        stop();
        subscriptions.delete(stop);
      };
    },
    selectAndInstallSkill: () =>
      wrap(async () => {
        throw new Error('请在 Web 或桌面端安装技能');
      }),
    openSessionFile: () =>
      wrap(async () => {
        throw new Error('手机版暂不下载产物，请在 Web 或桌面端打开同一会话下载。');
      }),
  };
  return {
    api,
    health: () => client.health(),
    dispose: async () => {
      disposed = true;
      subscriptions.forEach((stop) => stop());
      subscriptions.clear();
      try {
        if (client.accessToken) await client.logout();
      } catch {
        /* Offline: drop the local token regardless. */
      } finally {
        client.setAccessToken(undefined);
      }
    },
  };
}
