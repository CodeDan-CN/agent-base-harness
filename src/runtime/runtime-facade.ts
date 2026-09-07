import type { Logger } from '../infrastructure/logging/logger';
import type { BundledRuntimeSnapshot } from '../infrastructure/runtime/bundled-runtime-registry';
import type { CredentialStore } from '../infrastructure/credential/credential-store';
import type { Clock, IdProvider } from '../shared/domain/ports';
import type { ClientKind } from '../shared/contracts/auth';
import type { SessionEventBatch } from '../shared/contracts/ipc';
import type { LocalUserId } from '../shared/domain/user';
import { BridgeError } from '../shared/contracts/errors';
import { createWorkerApplication, type WorkerApplication } from '../worker/application';
import { dispatch } from '../worker/dispatcher';
import type { LlmAdapterRegistry } from './model';
import type { RuntimeServiceOptions } from './runtime-service';
import type { ToolRegistry } from './tools';

export interface RequestContext {
  requestId: string;
  connectionId: string;
  authSessionId: string;
  userId: LocalUserId;
  clientKind: ClientKind;
}

export interface RuntimeFacade {
  readonly schemaVersion: number;
  readonly application: WorkerApplication;
  start(): void;
  request(context: RequestContext, method: string, params?: unknown): Promise<unknown>;
  subscribe(listener: (batch: SessionEventBatch) => void): () => void;
  close(): Promise<void>;
}

export interface CreateRuntimeFacadeOptions {
  appDataDir: string;
  logger: Logger;
  generation?: number;
  clock?: Clock;
  idProvider?: IdProvider;
  credentialStore?: CredentialStore;
  runtime?: BundledRuntimeSnapshot;
  useSystemCredential?: boolean;
  llmAdapters?: LlmAdapterRegistry;
  tools?: ToolRegistry;
  runtimeOptions?: RuntimeServiceOptions;
  skipRecovery?: boolean;
}

/**
 * 服务进程内的稳定业务门面。它直接调用现有 Application/Dispatcher，既不引入
 * 内部 RPC，也不让 Gateway 接触仓储、模型或工具实现。
 */
export class DirectRuntimeFacade implements RuntimeFacade {
  readonly application: WorkerApplication;
  private readonly listeners = new Set<(batch: SessionEventBatch) => void>();
  private started = false;
  private closing = false;

  constructor(private readonly options: CreateRuntimeFacadeOptions) {
    this.application = createWorkerApplication({
      appDataDir: options.appDataDir,
      generation: options.generation ?? 1,
      logger: options.logger,
      clock: options.clock,
      idProvider: options.idProvider,
      credentialStore: options.credentialStore,
      runtime: options.runtime,
      useSystemCredential: options.useSystemCredential,
      llmAdapters: options.llmAdapters,
      tools: options.tools,
      runtimeOptions: options.runtimeOptions,
      onEventsAppended: (batch) => {
        for (const listener of this.listeners) listener(batch);
      },
    });
  }

  get schemaVersion(): number {
    return this.application.schemaVersion;
  }

  start(): void {
    if (this.started) return;
    if (!this.options.skipRecovery) this.application.runtime.recover();
    this.started = true;
  }

  async request(context: RequestContext, method: string, params?: unknown): Promise<unknown> {
    if (!this.started || this.closing) {
      throw new BridgeError('RUNTIME_NOT_READY', 'Runtime not ready');
    }
    if (!this.application.repos.users.getUser(context.userId)) {
      throw new BridgeError('USER_NOT_FOUND', 'User not found');
    }
    if (method === 'user.switch' || method === 'runtime.retry') {
      throw new BridgeError('INVALID_REQUEST', 'Method is unavailable through the service');
    }
    this.options.logger.info('runtime request', {
      requestId: context.requestId,
      connectionId: context.connectionId,
      authSessionId: context.authSessionId,
      userId: context.userId,
      clientKind: context.clientKind,
      method,
    });
    return dispatch(this.application, method, params, context.userId);
  }

  subscribe(listener: (batch: SessionEventBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.listeners.clear();
    await this.application.runtime.shutdown();
    this.application.close();
  }
}

export function createRuntimeFacade(options: CreateRuntimeFacadeOptions): RuntimeFacade {
  return new DirectRuntimeFacade(options);
}
