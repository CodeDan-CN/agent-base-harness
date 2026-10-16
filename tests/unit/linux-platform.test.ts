import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
  copyFile,
  symlink,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinuxEncryptedCredentialStore } from '../../packages/execution/src/credential/linux-encrypted-store';
import { credentialRefOf } from '../../packages/execution/src/credential/credential-store';
import { ProcessRunner } from '../../packages/execution/src/process/process-runner';

const temporaryRoots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linux-platform-test-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
const scope = { userId: 'linux-test-user', purpose: 'model', entityId: 'one' };

describe('persistent Linux credentials', () => {
  it('survives new instances, isolates references, replaces and deletes without plaintext files', async () => {
    const directory = path.join(await temporary(), 'credentials');
    const first = new LinuxEncryptedCredentialStore({ directory });
    const secret = `test-secret-${randomBytes(16).toString('hex')}`;
    await first.set(scope, secret);
    const second = new LinuxEncryptedCredentialStore({ directory });
    expect(await second.get(scope)).toBe(secret);
    expect(await second.get({ ...scope, userId: 'another-user' })).toBeNull();
    expect(await second.getByRef('../../outside')).toBeNull();
    for (const file of await readdir(directory)) {
      expect((await readFile(path.join(directory, file))).includes(Buffer.from(secret))).toBe(
        false,
      );
    }
    await second.set(scope, 'replaced-test-value');
    expect(await first.get(scope)).toBe('replaced-test-value');
    await second.delete(scope);
    expect(await first.status(scope)).toBe('missing');
  });

  it('rejects swapped ciphertext, symlink files and missing original master keys', async () => {
    const directory = path.join(await temporary(), 'credentials');
    const store = new LinuxEncryptedCredentialStore({ directory });
    await store.set(scope, 'private-test-value');
    const filename = (ref: string) =>
      path.join(directory, `${createHash('sha256').update(ref).digest('hex')}.json`);
    const other = { ...scope, entityId: 'two' };
    await copyFile(filename(credentialRefOf(scope)), filename(credentialRefOf(other)));
    await expect(store.get(other)).rejects.toThrow('authentication failed');
    await unlink(filename(credentialRefOf(other)));
    await symlink(filename(credentialRefOf(scope)), filename(credentialRefOf(other)));
    await expect(store.get(other)).rejects.toThrow('safely');
    await unlink(path.join(directory, 'master.key'));
    expect(() => new LinuxEncryptedCredentialStore({ directory })).toThrow('original key');
  });
});

describe.runIf(process.platform === 'linux')('Linux restricted process execution', () => {
  it('allows workspace writes while hiding credentials and blocking outside writes', async () => {
    const root = await temporary();
    const workspace = path.join(root, 'workspace');
    const credentials = path.join(root, 'credentials');
    await mkdir(workspace);
    await mkdir(credentials);
    await writeFile(path.join(credentials, 'secret'), 'test-only');
    const runner = new ProcessRunner({ allowedRoots: [root] });
    const result = await runner.run({
      cmd: '/bin/bash',
      args: [
        '-c',
        'set -e; printf ok > result; test ! -e "$1"; if touch "$2" 2>/dev/null; then exit 7; fi',
        'test',
        path.join(credentials, 'secret'),
        path.join(root, 'outside'),
      ],
      cwd: workspace,
      sandbox: { mode: 'workspace-write', writableRoots: [workspace], allowNetwork: false },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(workspace, 'result'), 'utf8')).toBe('ok');
    await expect(readFile(path.join(root, 'outside'))).rejects.toThrow();
  });

  it('denies network until explicitly enabled, and cancels a child process tree', async () => {
    const root = await temporary();
    const server = createServer((_request, response) => response.end('sandbox-network-ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const runner = new ProcessRunner({ allowedRoots: [root] });
      for (const allowNetwork of [false, true]) {
        const result = await runner.run({
          cmd: '/usr/bin/curl',
          args: ['--fail', '--silent', '--max-time', '2', `http://127.0.0.1:${address.port}`],
          cwd: root,
          sandbox: { mode: 'workspace-write', writableRoots: [root], allowNetwork },
        });
        expect(result.exitCode === 0, result.stderr).toBe(allowNetwork);
        if (allowNetwork) expect(result.stdout).toBe('sandbox-network-ok');
      }
      const controller = new AbortController();
      const pending = runner.run({
        cmd: '/bin/bash',
        args: ['-c', 'sleep 30 & wait'],
        cwd: root,
        signal: controller.signal,
        sandbox: { mode: 'workspace-write', writableRoots: [root], allowNetwork: false },
      });
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        expect((await pending).cancelled).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
