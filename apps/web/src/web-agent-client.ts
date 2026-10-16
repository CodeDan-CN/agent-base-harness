import type { AgentClientApi, RpcEnvelope } from '@client-contracts';
import { AgentClient, AgentClientError } from '../../../packages/client-sdk/src/agent-client';
import { browserAccountStorage } from '../../../packages/client-sdk/src/local-auth';

const TOKEN_KEY = 'agent-harness-web-token';

export function createWebAgentClient(): AgentClientApi {
  const client = new AgentClient({
    baseUrl: '',
    clientKind: 'web',
    accountStorage: browserAccountStorage('web'),
    accessToken: sessionStorage.getItem(TOKEN_KEY) ?? undefined,
  });
  const wrap = async (action: () => Promise<unknown>): Promise<RpcEnvelope> => {
    try {
      return { ok: true, result: await action() };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: (error instanceof AgentClientError ? error.code : 'CONNECTION_ERROR') as Extract<
            RpcEnvelope,
            { ok: false }
          >['error']['code'],
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const authenticate = (action: () => ReturnType<AgentClient['login']>) =>
    wrap(async () => {
      const result = await action();
      sessionStorage.setItem(TOKEN_KEY, result.accessToken);
      return { expiresAt: result.expiresAt, user: result.user };
    });
  return {
    register: (input) => authenticate(() => client.registerRemote(input)),
    login: (input) => authenticate(() => client.login(input.loginName, input.password)),
    logout: () =>
      wrap(async () => {
        await client.logout();
        sessionStorage.removeItem(TOKEN_KEY);
        return { loggedOut: true };
      }),
    currentAuth: () => wrap(() => client.me()),
    query: (method, params) => wrap(() => client.query(method, params)),
    command: (method, params) => wrap(() => client.command(method, params)),
    subscribeSession: (sessionId, afterSeq, listener) =>
      client.subscribeSession(
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
      ),
    subscribeLifecycle: (listener) => {
      let active = true;
      let previous: 'ready' | 'failed' | undefined;
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
      return () => {
        active = false;
        window.clearInterval(timer);
      };
    },
    selectAndInstallSkill: () =>
      wrap(async () => {
        const file = await selectZip();
        return file ? client.installSkill(file, file.name) : { cancelled: true };
      }),
    uploadSessionFile: (sessionId, name, bytes) =>
      wrap(() => client.uploadSessionFile(sessionId, new Blob([bytes]), name)),
    openSessionFile: (sessionId, target) =>
      wrap(async () => {
        const blob = await client.downloadSessionFile(sessionId, target);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = target.split(/[\\/]/).pop() || 'download';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { opened: true };
      }),
  };
}

function selectZip(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.addEventListener(
      'change',
      () => {
        resolve(input.files?.[0]);
        input.remove();
      },
      { once: true },
    );
    input.addEventListener(
      'cancel',
      () => {
        resolve(undefined);
        input.remove();
      },
      { once: true },
    );
    input.hidden = true;
    document.body.append(input);
    input.click();
  });
}
