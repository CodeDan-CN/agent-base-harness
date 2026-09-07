import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { JsonlLogger } from '../infrastructure/logging/logger';
import { createWorkerApplication } from './application';
import type { WorkerApplication } from './application';
import { dispatch } from './dispatcher';
import { toErrorPayload } from '../shared/contracts/errors';
import type { WorkerControlMessage, WorkerEventMessage } from '../shared/contracts/worker-messages';
import type { BundledRuntimeSnapshot } from '../infrastructure/runtime/bundled-runtime-registry';
import { DEFAULT_USER_ID } from '../shared/domain/user';

export interface WorkerBootstrapData {
  appDataDir: string;
  generation: number;
  logDir?: string;
  debug?: boolean;
  useSystemCredential?: boolean;
  /** Benchmark/diagnostic workers sharing a live app database must not repair other sessions. */
  skipRecovery?: boolean;
  runtime?: BundledRuntimeSnapshot;
  env?: {
    nodePath?: string;
    pythonPaths?: string[];
    shellPath?: string;
  };
}

const data = workerData as WorkerBootstrapData;

function post(message: WorkerEventMessage): void {
  parentPort?.postMessage(message);
}

const logger = new JsonlLogger({
  dir: data.logDir ?? path.join(data.appDataDir, 'logs'),
  console: data.debug ?? false,
});

let app: WorkerApplication;

try {
  app = createWorkerApplication({
    appDataDir: data.appDataDir,
    generation: data.generation,
    logger,
    env: data.env,
    runtime: data.runtime,
    useSystemCredential: data.useSystemCredential,
    onEventsAppended: (batch) =>
      post({ type: 'session-events', workerGeneration: data.generation, ...batch }),
  });
} catch (err) {
  const error = toErrorPayload(err);
  logger.error('worker initialization failed', { errorCode: error.code });
  post({
    type: 'fatal',
    workerGeneration: data.generation,
    reason: 'initialization failed',
    errorCode: error.code,
  });
  process.exitCode = 1;
  throw err;
}

try {
  // ready 前完成持久状态修复，并异步唤醒仍有排队输入的会话。
  if (!data.skipRecovery) app.runtime.recover();
} catch (err) {
  const error = toErrorPayload(err);
  logger.error('runtime recovery failed', {
    errorCode: error.code,
  });
  post({
    type: 'fatal',
    workerGeneration: data.generation,
    reason: 'recovery failed',
    errorCode: error.code,
  });
  app.close();
  process.exitCode = 1;
  throw err;
}

post({
  type: 'ready',
  workerGeneration: data.generation,
  schemaVersion: app.schemaVersion,
  activeUserId: DEFAULT_USER_ID,
  capabilities: { model: 'foundation', skill: 'foundation', runtime: 'ready' },
});

let inflight = 0;
let shuttingDown = false;

async function finishShutdown(): Promise<void> {
  await app.runtime.shutdown();
  app.close();
  process.exit(0);
}

function maybeFinishShutdown(): void {
  if (shuttingDown && inflight === 0) {
    void finishShutdown();
  }
}

parentPort?.on('message', (raw: unknown) => {
  const msg = raw as WorkerControlMessage;
  if (msg.type === 'shutdown') {
    shuttingDown = true;
    maybeFinishShutdown();
    return;
  }
  if (msg.type === 'request') {
    if (shuttingDown) return;
    inflight += 1;
    dispatch(app, msg.method, msg.params, msg.userId)
      .then((result) => {
        post({
          type: 'response',
          requestId: msg.requestId,
          workerGeneration: data.generation,
          ok: true,
          result,
        });
      })
      .catch((err: unknown) => {
        post({
          type: 'response',
          requestId: msg.requestId,
          workerGeneration: data.generation,
          ok: false,
          error: toErrorPayload(err),
        });
      })
      .finally(() => {
        inflight -= 1;
        maybeFinishShutdown();
      });
  }
});
