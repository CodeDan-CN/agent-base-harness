/** Electron Main 与 Runtime Worker 线程之间的控制/事件消息协议。 */

import type { BridgeErrorPayload, ErrorCode } from './errors';
import type { SessionEventBatch } from './ipc';

export type WorkerControlMessage =
  | {
      type: 'request';
      requestId: string;
      userId: string;
      windowId: string;
      workerGeneration: number;
      method: string;
      params?: unknown;
    }
  | { type: 'shutdown' };

export type WorkerResponseOk = {
  type: 'response';
  requestId: string;
  workerGeneration: number;
  ok: true;
  result: unknown;
};

export type WorkerResponseErr = {
  type: 'response';
  requestId: string;
  workerGeneration: number;
  ok: false;
  error: BridgeErrorPayload;
};

export type WorkerEventMessage =
  | {
      type: 'ready';
      workerGeneration: number;
      schemaVersion: number;
      activeUserId: string;
      capabilities: { model: 'foundation'; skill: 'foundation'; runtime: 'pending' | 'ready' };
    }
  | WorkerResponseOk
  | WorkerResponseErr
  | ({ type: 'session-events'; workerGeneration: number } & SessionEventBatch)
  | { type: 'fatal'; workerGeneration: number; reason: string; errorCode: ErrorCode };
