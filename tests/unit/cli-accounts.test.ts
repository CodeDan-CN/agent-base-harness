import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileAccountStorage } from '../../packages/client-sdk/src/node-account-storage';

describe('CLI local accounts', () => {
  let root: string;
  let executable: string;
  let dataDir: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'agent-cli-accounts-'));
    executable = path.join(root, 'cli.cjs');
    buildSync({
      entryPoints: [path.resolve('apps/cli/src/main.ts')],
      outfile: executable,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'silent',
    });
  });

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(root, 'accounts-'));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function invoke(args: string[], input?: string) {
    const result = spawnSync(
      process.execPath,
      [executable, '--server', 'http://127.0.0.1:1', '--data-dir', dataDir, ...args],
      { input, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    return result;
  }

  it('registers and logs in without displaying the persisted internal account ID', () => {
    const registration = invoke(
      ['register', '--login', 'Owner', '--password-stdin'],
      'local-secret\n',
    );
    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.stdout).toBe('Registered and logged in as Owner\n');

    const storage = new FileAccountStorage(path.join(dataDir, 'local-accounts'));
    const account = JSON.parse(storage.getItem('account:owner')!);
    expect(account.user.id).toMatch(/^local-[0-9a-f]{32}$/);
    const current = invoke(['whoami']);
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toBe('Owner (Owner)\n');
    expect(current.stdout).not.toContain(account.user.id);

    expect(invoke(['logout']).status).toBe(0);
    const login = invoke(['login', '--login', 'owner', '--password-stdin'], 'local-secret\n');
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toBe('Logged in as Owner\n');
    expect(invoke(['whoami']).stdout).toBe('Owner (Owner)\n');
    expect(JSON.parse(storage.getItem('account:owner')!).user.id).toBe(account.user.id);
  });

  it.each([['--user-id', 'existing-id'], ['--user-id=existing-id'], ['--user-id']])(
    'rejects removed registration arguments %j before prompting or creating an account',
    (...removedOptions) => {
      const result = invoke(['register', '--login', 'Owner', ...removedOptions]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Unknown option: --user-id\n');
      const storage = new FileAccountStorage(path.join(dataDir, 'local-accounts'));
      expect(storage.getItem('account:owner')).toBeNull();
    },
  );

  it('describes account registration without an ID binding option', () => {
    const result = invoke(['help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('register [--login NAME]');
    expect(result.stdout).not.toContain('--user-id');
    expect(result.stdout).not.toContain('data partition');
  });
});
