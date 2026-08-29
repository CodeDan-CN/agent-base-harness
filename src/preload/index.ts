import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  lifecycleEventSchema,
  sessionSubscriptionEventSchema,
} from '../shared/contracts/ipc';
import type {
  AgentClientApi,
  CommandMethod,
  LifecycleEvent,
  QueryMethod,
  RpcEnvelope,
  SessionSubscriptionEvent,
} from '../shared/contracts/ipc';
import { API_VERSION } from '../shared/contracts/schemas';

const api: AgentClientApi = {
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
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const parsed = sessionSubscriptionEventSchema.safeParse(data);
      if (parsed.success && parsed.data.sessionId === sessionId) {
        listener(parsed.data as SessionSubscriptionEvent);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.sessionEvents, handler);
    ipcRenderer.send(IPC_CHANNELS.subscribe, { kind: 'session', sessionId, afterSeq });
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.sessionEvents, handler);
      ipcRenderer.send(IPC_CHANNELS.unsubscribe, { kind: 'session' });
    };
  },
  selectAndInstallSkill(): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.selectSkillDirectory);
  },
  openSessionFile(sessionId: string, target: string): Promise<RpcEnvelope> {
    return ipcRenderer.invoke(IPC_CHANNELS.openSessionFile, { sessionId, target });
  },
};

contextBridge.exposeInMainWorld('agentClient', api);
