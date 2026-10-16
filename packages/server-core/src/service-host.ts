import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { JsonlLogger, type Logger } from '../../execution/src/logging/logger';
import { loadBundledRuntime } from '../../execution/src/runtime/bundled-runtime-registry';
import { SystemClock, type Clock } from '../../protocol/src/domain/ports';
import { createRuntimeFacade, type RuntimeFacade } from './runtime-facade';
import { Gateway, type GatewayAddress } from './gateway';
import {
  DataDirectoryLock,
  ensureBootstrapToken,
  type ServiceDiscovery,
  type ServiceState,
} from './lifecycle';
import { servicePaths, type ServicePaths } from './paths';
import { AGENT_HARNESS_VERSION } from '../../protocol/src/contracts/version';
import type { LlmAdapterRegistry } from '../../runtime-core/src/model';
import type { ToolRegistry } from '../../runtime-core/src/tools';
import type { RuntimeServiceOptions } from '../../runtime-core/src/runtime-service';
import type { IdProvider } from '../../protocol/src/domain/ports';
import type { CredentialStore } from '../../execution/src/credential/credential-store';

export interface ServiceHostOptions {
  dataDir: string;
  port?: number;
  host?: string;
  webRoot?: string;
  /** Deprecated: registration is client-local; ignored. */
  allowWebRegistration?: boolean;
  version?: string;
  debug?: boolean;
  logger?: Logger;
  clock?: Clock;
  runtimeRoot?: string;
  /** @deprecated Ignored; default storage is SQLite. */
  useSystemCredential?: boolean;
  skipRecovery?: boolean;
  llmAdapters?: LlmAdapterRegistry;
  tools?: ToolRegistry;
  runtimeOptions?: RuntimeServiceOptions;
  idProvider?: IdProvider;
  credentialStore?: CredentialStore;
}

export class ServiceHost {
  private readonly paths: ServicePaths;
  private readonly lock: DataDirectoryLock;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly version: string;
  private stateValue: ServiceState = 'stopped';
  private runtime: RuntimeFacade | undefined;
  private gateway: Gateway | undefined;
  private addressValue: GatewayAddress | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: ServiceHostOptions) {
    this.paths = servicePaths(options.dataDir);
    mkdirSync(path.join(this.paths.dataDir, 'logs'), { recursive: true });
    this.logger =
      options.logger ??
      new JsonlLogger({
        dir: path.join(this.paths.dataDir, 'logs'),
        fileName: 'service.log',
        console: options.debug ?? false,
      });
    this.clock = options.clock ?? new SystemClock();
    this.version = options.version ?? AGENT_HARNESS_VERSION;
    this.lock = new DataDirectoryLock(this.paths);
  }

  get state(): ServiceState {
    return this.stateValue;
  }

  get address(): GatewayAddress | undefined {
    return this.addressValue ? { ...this.addressValue } : undefined;
  }

  get discovery(): ServiceDiscovery | undefined {
    if (!this.addressValue) return undefined;
    return {
      protocolVersion: 1,
      instanceId: this.lock.instanceId,
      pid: process.pid,
      baseUrl: this.addressValue.baseUrl,
      dataDir: this.paths.dataDir,
      startedAt: this.startedAt,
      version: this.version,
    };
  }

  private startedAt = '';

  async start(): Promise<GatewayAddress> {
    if (this.stateValue !== 'stopped') throw new Error('Service host already started');
    this.stateValue = 'starting';
    this.startedAt = this.clock.nowIso();
    try {
      this.lock.acquire(this.startedAt);
      const bootstrapToken = ensureBootstrapToken(this.paths);
      this.logger.registerSecret(bootstrapToken);
      const runtime = this.options.runtimeRoot
        ? (loadBundledRuntime(this.options.runtimeRoot, { required: true }) ?? undefined)
        : undefined;
      this.runtime = createRuntimeFacade({
        appDataDir: this.paths.dataDir,
        logger: this.logger.child({ component: 'runtime' }),
        clock: this.clock,
        runtime,
        skipRecovery: this.options.skipRecovery,
        llmAdapters: this.options.llmAdapters,
        tools: this.options.tools,
        runtimeOptions: this.options.runtimeOptions,
        idProvider: this.options.idProvider,
        credentialStore: this.options.credentialStore,
        seedBuiltinUsers: false,
      });
      this.runtime.start();
      this.gateway = new Gateway({
        runtime: this.runtime,
        bootstrapToken,
        logger: this.logger.child({ component: 'gateway' }),
        version: this.version,
        instanceId: this.lock.instanceId,
        appDataDir: this.paths.dataDir,
        webRoot: this.options.webRoot,
        onStopRequested: () => void this.stop(),
      });
      this.addressValue = await this.gateway.listen(
        this.options.port ?? 0,
        this.options.host ?? '127.0.0.1',
      );
      const discovery = this.discovery;
      if (!discovery) throw new Error('Service discovery unavailable');
      this.lock.publish(discovery);
      this.stateValue = 'ready';
      this.logger.info('service ready', {
        instanceId: discovery.instanceId,
        host: this.addressValue.host,
        port: this.addressValue.port,
        schemaVersion: this.runtime.schemaVersion,
      });
      return { ...this.addressValue };
    } catch (error) {
      this.stateValue = 'failed';
      this.logger.error('service startup failed', {
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
      await this.cleanupAfterFailure();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.stateValue === 'stopped') return;
    this.stateValue = 'draining';
    this.logger.info('service draining', { instanceId: this.lock.instanceId });
    try {
      await this.gateway?.close();
      await this.runtime?.close();
    } finally {
      this.gateway = undefined;
      this.runtime = undefined;
      this.addressValue = undefined;
      this.lock.release();
      this.stateValue = 'stopped';
      this.logger.info('service stopped', { instanceId: this.lock.instanceId });
    }
  }

  private async cleanupAfterFailure(): Promise<void> {
    try {
      await this.gateway?.close();
    } catch {
      // Preserve the startup error.
    }
    try {
      await this.runtime?.close();
    } catch {
      // Preserve the startup error.
    }
    this.lock.release();
  }
}
