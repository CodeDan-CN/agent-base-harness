import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  lifecycleEventSchema,
  sessionSubscriptionEventSchema,
} from '../../../../packages/protocol/src/contracts/ipc';
import type {
  AgentClientApi,
  CommandMethod,
  LifecycleEvent,
  QueryMethod,
  RpcEnvelope,
  SessionSubscriptionEvent,
} from '../../../../packages/protocol/src/contracts/ipc';
import { API_VERSION } from '../../../../packages/protocol/src/contracts/schemas';

const api: AgentClientApi = {
  register(input): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.authRegister, input);
  },
  login(input): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.authLogin, input);
  },
  logout(): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.authLogout);
  },
  currentAuth(): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.authMe);
  },
  query(method: QueryMethod, params?: unknown): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.query, { apiVersion: API_VERSION, method, params });
  },
  command(method: CommandMethod, params?: unknown): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.command, { apiVersion: API_VERSION, method, params });
  },
  subscribeLifecycle(listener: (event: LifecycleEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const parsed = lifecycleEventSchema.safeParse(data);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.lifecycle, handler);
    ipcRenderer.send(IPC_CHANNELS.subscribe);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.lifecycle, handler);
      ipcRenderer.send(IPC_CHANNELS.unsubscribe);
    };
  },
  subscribeSession(
    sessionId: string,
    afterSeq: number,
    listener: (event: SessionSubscriptionEvent) => void,
  ): () => void {
    const subscriptionId = crypto.randomUUID();
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const parsed = sessionSubscriptionEventSchema.safeParse(data);
      if (
        parsed.success &&
        parsed.data.sessionId === sessionId &&
        (!parsed.data.subscriptionId || parsed.data.subscriptionId === subscriptionId)
      ) {
        listener(parsed.data as SessionSubscriptionEvent);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.sessionEvents, handler);
    ipcRenderer.send(IPC_CHANNELS.subscribe, {
      kind: 'session',
      subscriptionId,
      sessionId,
      afterSeq,
    });
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.sessionEvents, handler);
      ipcRenderer.send(IPC_CHANNELS.unsubscribe, { kind: 'session', subscriptionId });
    };
  },
  selectAndInstallSkill(): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.selectSkillDirectory);
  },
  openSessionFile(sessionId: string, target: string): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.openSessionFile, { sessionId, target });
  },
  uploadSessionFile(sessionId: string, name: string, bytes: ArrayBuffer): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.uploadSessionFile, { sessionId, name, bytes });
  },
};

contextBridge.exposeInMainWorld('agentClient', api);
contextBridge.exposeInMainWorld('agentConnection', {
  get: (): Promise<RpcEnvelope> => ipcRenderer.invoke('connection.get'),
  set: (baseUrl: string): Promise<RpcEnvelope> => ipcRenderer.invoke('connection.set', baseUrl),
});
contextBridge.exposeInMainWorld('agentWindow', {
  setOfficeOpen: (open: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window.set-office-open', open),
});
