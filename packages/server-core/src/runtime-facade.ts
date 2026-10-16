import type { Logger } from '../../execution/src/logging/logger';
import type { BundledRuntimeSnapshot } from '../../execution/src/runtime/bundled-runtime-registry';
import type { CredentialStore } from '../../execution/src/credential/credential-store';
import type { Clock, IdProvider } from '../../protocol/src/domain/ports';
import type { ClientKind } from '../../protocol/src/contracts/auth';
import {
  clientUserSchema,
  clientUserIdSchema,
  type AuthenticatedUser,
} from '../../protocol/src/contracts/auth';
import type { SessionEventBatch } from '../../protocol/src/contracts/ipc';
import type { LocalUserId } from '../../protocol/src/domain/user';
import { BridgeError } from '../../protocol/src/contracts/errors';
import { createWorkerApplication, type WorkerApplication } from './application/application';
import { dispatch } from './application/dispatcher';
import type { LlmAdapterRegistry } from '../../runtime-core/src/model';
import type { RuntimeServiceOptions } from '../../runtime-core/src/runtime-service';
import type { ToolRegistry } from '../../runtime-core/src/tools';

export interface RequestContext {
  requestId: string;
  connectionId: string;
  userId: LocalUserId;
  user?: AuthenticatedUser;
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
  /** @deprecated Ignored; default storage is SQLite. */
  useSystemCredential?: boolean;
  llmAdapters?: LlmAdapterRegistry;
  tools?: ToolRegistry;
  runtimeOptions?: RuntimeServiceOptions;
  skipRecovery?: boolean;
  seedBuiltinUsers?: boolean;
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
  private readonly incompleteUsers = new Set<string>();
  private readonly userInitialization = new Map<string, Promise<void>>();

  constructor(private readonly options: CreateRuntimeFacadeOptions) {
    this.application = createWorkerApplication({
      appDataDir: options.appDataDir,
      generation: options.generation ?? 1,
      refreshCatalogOnStart: !options.llmAdapters,
      logger: options.logger,
      clock: options.clock,
      idProvider: options.idProvider,
      credentialStore: options.credentialStore,
      runtime: options.runtime,
      llmAdapters: options.llmAdapters,
      tools: options.tools,
      runtimeOptions: options.runtimeOptions,
      seedBuiltinUsers: options.seedBuiltinUsers,
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
    // Validate only the shape/path-safe identifier, not the client's identity claim.
    const parsed = clientUserIdSchema.safeParse(context.userId);
    const user = clientUserSchema.safeParse(
      context.user ?? {
        id: context.userId,
        loginName: context.userId.slice(0, 64),
        displayName: context.userId,
      },
    );
    if (!parsed.success || !user.success || user.data.id !== context.userId)
      throw new BridgeError('INVALID_REQUEST', 'Invalid client user identity');
    let initializing = this.userInitialization.get(context.userId);
    if (
      !initializing &&
      (this.incompleteUsers.has(context.userId) ||
        !this.application.repos.users.getUser(context.userId))
    ) {
      this.application.repos.users.ensureUser(
        context.userId,
        user.data.displayName,
        this.options.clock?.nowIso() ?? new Date().toISOString(),
      );
      this.incompleteUsers.add(context.userId);
      initializing = this.application.initializeUser(context.userId);
      this.userInitialization.set(context.userId, initializing);
    }
    if (initializing) {
      try {
        await initializing;
        this.incompleteUsers.delete(context.userId);
      } finally {
        this.userInitialization.delete(context.userId);
      }
    }
    if (method === 'user.switch' || method === 'runtime.retry') {
      throw new BridgeError('INVALID_REQUEST', 'Method is unavailable through the service');
    }
    this.options.logger.info('runtime request', {
      requestId: context.requestId,
      connectionId: context.connectionId,
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
