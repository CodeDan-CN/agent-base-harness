import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalConnector } from '../../packages/server-core/src/local-connector';
import { DataDirectoryLock, ensureBootstrapToken } from '../../packages/server-core/src/lifecycle';
import { serve } from '../../packages/server-core/src';
import { servicePaths } from '../../packages/server-core/src/paths';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('4.7.0 data directory lifecycle', () => {
  it('waits for a draining owner to release the lock before launching', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-draining-'));
    directories.push(root);
    const lock = new DataDirectoryLock(servicePaths(root));
    lock.acquire();
    const launch = vi.fn(() => {
      // Deliberately fail after proving launch happens only after release.
      expect(() => lock.acquire()).not.toThrow();
      lock.release();
      throw new Error('replacement launched');
    });
    const connector = new LocalConnector({ dataDir: root, clientKind: 'electron', launch });
    const attempt = connector.connectOrStart();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(launch).not.toHaveBeenCalled();
    lock.release();
    await expect(attempt).rejects.toThrow('replacement launched');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not launch over an unresponsive live owner on timeout', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-owner-timeout-'));
    directories.push(root);
    const lock = new DataDirectoryLock(servicePaths(root));
    lock.acquire();
    const launch = vi.fn();
    try {
      const connector = new LocalConnector({
        dataDir: root, clientKind: 'electron', launch, shutdownTimeoutMs: 1,
      });
      await expect(connector.connectOrStart()).rejects.toThrow('timed out waiting for shutdown');
      expect(launch).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('uses the packaged runtime root from the environment when no argument is provided', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-runtime-root-'));
    directories.push(root);
    const previous = process.env.AGENT_HARNESS_RUNTIME_ROOT;
    process.env.AGENT_HARNESS_RUNTIME_ROOT = path.join(root, 'missing-runtime');
    try {
      await expect(serve({ dataDir: path.join(root, 'data') })).rejects.toThrow(
        'Bundled Runtime Pack is unavailable',
      );
    } finally {
      if (previous === undefined) delete process.env.AGENT_HARNESS_RUNTIME_ROOT;
      else process.env.AGENT_HARNESS_RUNTIME_ROOT = previous;
    }
  });

  it('allows exactly one live owner for a data directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-lock-'));
    directories.push(root);
    const paths = servicePaths(root);
    const first = new DataDirectoryLock(paths);
    const second = new DataDirectoryLock(paths);
    first.acquire();
    expect(() => second.acquire()).toThrow('already owns');
    expect(JSON.parse(readFileSync(paths.lockFile, 'utf8')).pid).toBe(process.pid);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });

  it('creates one stable owner-only bootstrap credential', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-bootstrap-'));
    directories.push(root);
    const paths = servicePaths(root);
    const first = ensureBootstrapToken(paths);
    const second = ensureBootstrapToken(paths);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== 'win32') {
      expect(statSync(paths.bootstrapTokenFile).mode & 0o777).toBe(0o600);
    }
  });
});
