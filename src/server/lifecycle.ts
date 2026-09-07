import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ServicePaths } from './paths';
import { BridgeError } from '../shared/contracts/errors';

export type ServiceState = 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';

export interface ServiceDiscovery {
  protocolVersion: 1;
  instanceId: string;
  pid: number;
  baseUrl: string;
  dataDir: string;
  startedAt: string;
  version: string;
}

interface LockRecord {
  instanceId: string;
  pid: number;
  dataDir: string;
  acquiredAt: string;
}

export class DataDirectoryLock {
  readonly instanceId = randomUUID();
  private fd: number | undefined;

  constructor(private readonly paths: ServicePaths) {}

  acquire(now = new Date().toISOString()): void {
    mkdirSync(this.paths.serviceDir, { recursive: true, mode: 0o700 });
    chmodBestEffort(this.paths.serviceDir, 0o700);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.fd = openSync(this.paths.lockFile, 'wx', 0o600);
        const record: LockRecord = {
          instanceId: this.instanceId,
          pid: process.pid,
          dataDir: this.paths.dataDir,
          acquiredAt: now,
        };
        writeFileSync(this.fd, JSON.stringify(record), 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readLock(this.paths.lockFile);
        if (existing && isProcessAlive(existing.pid)) {
          throw new BridgeError('CONFLICT', 'A service already owns this data directory');
        }
        if (attempt === 0) {
          rmSync(this.paths.lockFile, { force: true });
          continue;
        }
        throw new BridgeError('CONFLICT', 'Unable to acquire the data directory lock');
      }
    }
  }

  publish(discovery: ServiceDiscovery): void {
    if (this.fd === undefined) throw new BridgeError('RUNTIME_NOT_READY', 'Service lock missing');
    writePrivateJsonAtomic(this.paths.discoveryFile, discovery);
  }

  release(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    const lock = readLock(this.paths.lockFile);
    if (lock?.instanceId === this.instanceId) rmSync(this.paths.lockFile, { force: true });
    const discovery = readDiscovery(this.paths.discoveryFile);
    if (discovery?.instanceId === this.instanceId) {
      rmSync(this.paths.discoveryFile, { force: true });
    }
  }
}

export function readDiscovery(filePath: string): ServiceDiscovery | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ServiceDiscovery>;
    if (
      value.protocolVersion !== 1 ||
      typeof value.instanceId !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.baseUrl !== 'string' ||
      typeof value.dataDir !== 'string' ||
      typeof value.startedAt !== 'string' ||
      typeof value.version !== 'string'
    ) {
      return undefined;
    }
    return value as ServiceDiscovery;
  } catch {
    return undefined;
  }
}

export function ensureBootstrapToken(paths: ServicePaths): string {
  mkdirSync(paths.serviceDir, { recursive: true, mode: 0o700 });
  if (existsSync(paths.bootstrapTokenFile)) {
    const current = readFileSync(paths.bootstrapTokenFile, 'utf8').trim();
    if (current.length >= 32) {
      chmodBestEffort(paths.bootstrapTokenFile, 0o600);
      return current;
    }
    throw new BridgeError('INTERNAL_ERROR', 'Invalid local bootstrap credential');
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(paths.bootstrapTokenFile, token + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = readFileSync(paths.bootstrapTokenFile, 'utf8').trim();
    if (current.length < 32) {
      throw new BridgeError('INTERNAL_ERROR', 'Invalid local bootstrap credential');
    }
    return current;
  }
}

export function processIsAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

function readLock(filePath: string): LockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<LockRecord>;
    if (
      typeof value.instanceId !== 'string' ||
      !Number.isInteger(value.pid) ||
      typeof value.dataDir !== 'string' ||
      typeof value.acquiredAt !== 'string'
    ) {
      return undefined;
    }
    return value as LockRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writePrivateJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodBestEffort(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodBestEffort(filePath, 0o600);
}

function chmodBestEffort(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch {
    // Windows and unusual filesystems can ignore POSIX mode bits.
  }
}
