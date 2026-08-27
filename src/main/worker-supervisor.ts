import type { EventEmitter } from 'node:events';
import { BridgeError } from '../shared/contracts/errors';
import type {
  LifecycleEvent,
  RuntimeWorkerStatus,
  SessionEventBatch,
} from '../shared/contracts/ipc';
import type { WorkerControlMessage, WorkerEventMessage } from '../shared/contracts/worker-messages';
import type { Clock } from '../shared/domain/ports';
import type { Logger } from '../infrastructure/logging/logger';
import type { WorkerBootstrapData } from '../worker/index';

export interface WorkerLike extends EventEmitter {
  postMessage(message: WorkerControlMessage): void;
  terminate(): Promise<number> | void;
}

export type WorkerFactory = (data: WorkerBootstrapData) => WorkerLike;

export interface SupervisorState {
  status: RuntimeWorkerStatus;
  generation: number;
  startedAt?: string;
  readyAt?: string;
  restartAttempt: number;
  lastExit?: { code?: number; reason: string; at: string };
  lastErrorCode?: string;
}

export interface SupervisorOptions {
  factory: WorkerFactory;
  workerData: (generation: number) => WorkerBootstrapData;
  clock: Clock;
  logger: Logger;
  startupTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  maxRestartAttempts?: number;
  onLifecycle?: (event: LifecycleEvent) => void;
}

export interface SupervisorRequestInput {
  requestId: string;
  userId: string;
  windowId: string;
  method: string;
  params?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: BridgeError) => void;
}

export function backoffDelayMs(attempt: number, minMs: number, maxMs: number): number {
  const exp = Math.min(minMs * 2 ** Math.max(0, attempt - 1), maxMs);
  return Math.min(exp, maxMs);
}

const SHUTDOWN_GRACE_MS = 2000;

export class RuntimeWorkerSupervisor {
  private readonly options: Required<Omit<SupervisorOptions, 'onLifecycle'>>;
  private lifecycleHandler: ((event: LifecycleEvent) => void) | null = null;
  private state: SupervisorState;
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;
  private startWaiter: { resolve: () => void; reject: (err: BridgeError) => void } | null = null;
  private activeUserId: string | null = null;
  private sessionEventHandler: ((batch: SessionEventBatch) => void) | null = null;

  constructor(options: SupervisorOptions) {
    const { onLifecycle, ...rest } = options;
    this.options = {
      startupTimeoutMs: 10_000,
      backoffMinMs: 100,
      backoffMaxMs: 5000,
      maxRestartAttempts: 5,
      ...rest,
    };
    this.lifecycleHandler = onLifecycle ?? null;
    this.state = {
      status: 'stopped',
      generation: 0,
      restartAttempt: 0,
    };
  }

  setLifecycleHandler(handler: (event: LifecycleEvent) => void): void {
    this.lifecycleHandler = handler;
  }

  setSessionEventHandler(handler: (batch: SessionEventBatch) => void): void {
    this.sessionEventHandler = handler;
  }

  getState(): SupervisorState {
    return { ...this.state };
  }

  getActiveUserId(): string | null {
    return this.activeUserId;
  }

  start(): Promise<void> {
    if (this.state.status !== 'stopped') {
      return Promise.reject(new BridgeError('RUNTIME_UNAVAILABLE', 'Supervisor already started'));
    }
    this.state.lastErrorCode = undefined;
    return new Promise<void>((resolve, reject) => {
      this.startWaiter = { resolve, reject };
      this.spawnWorker();
    });
  }

  retry(): Promise<void> {
    if (this.state.status !== 'failed') {
      return Promise.reject(new BridgeError('RUNTIME_UNAVAILABLE', 'Not in failed state'));
    }
    return new Promise<void>((resolve, reject) => {
      this.startWaiter = { resolve, reject };
      this.state.restartAttempt = 0;
      this.state.lastErrorCode = undefined;
      this.spawnWorker();
    });
  }

  request(input: SupervisorRequestInput): Promise<unknown> {
    const { requestId } = input;
    if (this.state.status !== 'ready' || !this.worker) {
      const code = this.state.status === 'failed' ? 'RUNTIME_UNAVAILABLE' : 'RUNTIME_NOT_READY';
      return Promise.reject(new BridgeError(code, 'Runtime not ready'));
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const message: WorkerControlMessage = {
        type: 'request',
        requestId,
        userId: input.userId,
        windowId: input.windowId,
        workerGeneration: this.state.generation,
        method: input.method,
        params: input.params,
      };
      this.worker?.postMessage(message);
    });
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.state.status === 'stopped' || this.state.status === 'stopping') {
      return;
    }
    this.state.status = 'stopping';
    this.rejectAllPending(new BridgeError('RUNTIME_RESTARTED', 'Runtime shutting down'));
    await this.shutdownWorker();
    this.state.status = 'stopped';
    this.emitLifecycle({ type: 'runtime', status: 'stopped', generation: this.state.generation });
  }

  private spawnWorker(): void {
    this.state.generation += 1;
    const generation = this.state.generation;
    this.state.status = 'starting';
    this.state.startedAt = this.options.clock.nowIso();
    this.options.logger.info('worker starting', { workerGeneration: generation });
    this.emitLifecycle({ type: 'runtime', status: 'starting', generation });

    this.startupTimer = setTimeout(() => this.onStartupTimeout(), this.options.startupTimeoutMs);

    const worker = this.options.factory(this.options.workerData(generation));
    this.worker = worker;
    worker.on('message', (msg: WorkerEventMessage) => this.onWorkerMessage(msg, generation));
    worker.on('error', (err: Error) => this.onWorkerError(err, generation));
    worker.on('exit', (code: number) => this.onWorkerExit(code, generation));
  }

  private onWorkerMessage(msg: WorkerEventMessage, generation: number): void {
    if (generation !== this.state.generation) {
      return;
    }
    if (msg.type === 'ready') {
      this.clearStartupTimer();
      this.state.status = 'ready';
      this.state.readyAt = this.options.clock.nowIso();
      this.state.restartAttempt = 0;
      this.state.lastErrorCode = undefined;
      this.activeUserId = msg.activeUserId;
      this.options.logger.info('worker ready', {
        workerGeneration: generation,
        schemaVersion: msg.schemaVersion,
      });
      this.startWaiter?.resolve();
      this.startWaiter = null;
      this.emitLifecycle({ type: 'runtime', status: 'ready', generation });
      return;
    }
    if (msg.type === 'response') {
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new BridgeError(msg.error.code, msg.error.message, msg.error.requestId));
      }
      return;
    }
    if (msg.type === 'session-events') {
      this.sessionEventHandler?.({
        userId: msg.userId,
        sessionId: msg.sessionId,
        fromSeq: msg.fromSeq,
        toSeq: msg.toSeq,
        events: msg.events,
      });
      return;
    }
    if (msg.type === 'fatal') {
      this.options.logger.error('worker fatal', {
        workerGeneration: generation,
        reason: msg.reason,
        errorCode: msg.errorCode,
      });
      this.state.lastErrorCode = msg.errorCode;
      void this.terminateWorker();
    }
  }

  private onWorkerError(err: Error, generation: number): void {
    if (generation !== this.state.generation) return;
    this.options.logger.error('worker error', {
      workerGeneration: generation,
      errorCode: err.name,
    });
    this.state.lastErrorCode = 'WORKER_ERROR';
  }

  private onWorkerExit(code: number, generation: number): void {
    if (generation !== this.state.generation) return;
    this.clearStartupTimer();
    this.state.lastExit = {
      code: code ?? undefined,
      reason: 'exited',
      at: this.options.clock.nowIso(),
    };
    this.options.logger.warn('worker exited', { workerGeneration: generation, code });
    this.handleCrash();
  }

  private onStartupTimeout(): void {
    this.options.logger.error('worker startup timeout', {
      workerGeneration: this.state.generation,
    });
    this.state.lastErrorCode = 'STARTUP_TIMEOUT';
    void this.terminateWorker();
  }

  private handleCrash(): void {
    this.rejectAllPending(new BridgeError('RUNTIME_RESTARTED', 'Runtime restarted'));
    if (this.shutdownRequested) {
      this.state.status = 'stopped';
      return;
    }
    if (this.state.status === 'starting') {
      if (this.state.restartAttempt >= this.options.maxRestartAttempts) {
        this.state.status = 'failed';
        this.state.lastErrorCode ??= 'STARTUP_FAILED';
        this.options.logger.error('worker startup failed', {
          workerGeneration: this.state.generation,
        });
        this.startWaiter?.reject(new BridgeError('RUNTIME_UNAVAILABLE', 'Runtime unavailable'));
        this.startWaiter = null;
        this.emitLifecycle({
          type: 'runtime',
          status: 'failed',
          generation: this.state.generation,
        });
        return;
      }
      this.scheduleRestart();
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    this.state.status = 'restarting';
    this.state.restartAttempt += 1;
    this.emitLifecycle({
      type: 'runtime',
      status: 'restarting',
      generation: this.state.generation,
    });
    const delay = backoffDelayMs(
      this.state.restartAttempt,
      this.options.backoffMinMs,
      this.options.backoffMaxMs,
    );
    this.options.logger.warn('scheduling worker restart', {
      workerGeneration: this.state.generation,
      attempt: this.state.restartAttempt,
      delayMs: delay,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shutdownRequested) {
        this.state.status = 'stopped';
        return;
      }
      this.spawnWorker();
    }, delay);
  }

  private rejectAllPending(err: BridgeError): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private async terminateWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // 忽略终止错误。
      }
    }
  }

  private async shutdownWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;

    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        void worker.terminate();
      }, SHUTDOWN_GRACE_MS);
      const done = () => {
        clearTimeout(fallback);
        resolve();
      };
      let exited = false;
      worker.once('exit', () => {
        if (exited) return;
        exited = true;
        done();
      });
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        clearTimeout(fallback);
        void worker.terminate();
        done();
      }
    });
  }

  private emitLifecycle(event: LifecycleEvent): void {
    this.lifecycleHandler?.(event);
  }
}
