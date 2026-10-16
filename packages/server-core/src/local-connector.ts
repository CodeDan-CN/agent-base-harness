import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AgentClient } from '../../client-sdk/src/agent-client';
import {
  liveServiceOwner,
  processIsAlive,
  readDiscovery,
  type ServiceDiscovery,
} from './lifecycle';
import { servicePaths } from './paths';
import type { ClientKind } from '../../protocol/src/contracts/auth';

export interface LocalConnectorOptions {
  dataDir: string;
  clientKind: ClientKind;
  serverEntry?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  launch?: (dataDir: string) => void;
}

export class LocalConnector {
  private readonly paths;

  constructor(private readonly options: LocalConnectorOptions) {
    this.paths = servicePaths(options.dataDir);
  }

  async connect(): Promise<{ client: AgentClient; discovery: ServiceDiscovery }> {
    const discovery = readDiscovery(this.paths.discoveryFile);
    if (!discovery || discovery.dataDir !== this.paths.dataDir || !processIsAlive(discovery.pid)) {
      throw new Error('Local service is not running');
    }
    const client = new AgentClient({
      baseUrl: discovery.baseUrl,
      clientKind: this.options.clientKind,
    });
    const health = await client.health();
    if (health.protocolVersion !== 1 || health.instanceId !== discovery.instanceId) {
      throw new Error('Local service discovery does not match the running service');
    }
    return { client, discovery };
  }

  async connectOrStart(): Promise<{ client: AgentClient; discovery: ServiceDiscovery }> {
    try {
      return await this.connect();
    } catch {
      // A draining service has already closed HTTP but still owns SQLite and
      // the directory lock. Wait for cleanup before launching its replacement.
      const ownerDeadline = Date.now() + (this.options.shutdownTimeoutMs ?? 60_000);
      while (liveServiceOwner(this.paths.lockFile) !== undefined) {
        try {
          return await this.connect();
        } catch {
          if (Date.now() >= ownerDeadline) {
            throw new Error(
              'Local Runtime still owns the data directory but is not accepting connections; timed out waiting for shutdown',
            );
          }
          await delay(75);
        }
      }
      (this.options.launch ?? ((dataDir) => this.launchDefault(dataDir)))(this.paths.dataDir);
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 15_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.connect();
      } catch (error) {
        lastError = error;
        await delay(75);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Local service did not become ready');
  }

  async restart(): Promise<{ client: AgentClient; discovery: ServiceDiscovery }> {
    let running: { client: AgentClient; discovery: ServiceDiscovery };
    try {
      running = await this.connect();
    } catch {
      return this.connectOrStart();
    }

    await running.client.stopService(this.readBootstrapToken());
    const deadline = Date.now() + (this.options.shutdownTimeoutMs ?? 60_000);
    while (processIsAlive(running.discovery.pid) && Date.now() < deadline) {
      await delay(75);
    }
    if (processIsAlive(running.discovery.pid)) {
      throw new Error('Local service did not stop');
    }
    return this.connectOrStart();
  }

  readBootstrapToken(): string {
    const token = readFileSync(this.paths.bootstrapTokenFile, 'utf8').trim();
    if (token.length < 32) throw new Error('Local bootstrap credential is invalid');
    return token;
  }

  private launchDefault(dataDir: string): void {
    const serverEntry =
      this.options.serverEntry ?? path.join(__dirname, '..', 'server', 'index.cjs');
    const child = spawn(process.execPath, [serverEntry, '--data-dir', dataDir], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
