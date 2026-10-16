import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'vitest';
import {
  loadRuntimeTarget,
  matchesBinaryTarget,
  parseRuntimeArguments,
  repositoryRoot,
} from '../../build-support/runtime-target.mjs';
import { materializeSymlinks } from '../../build-support/runtime-symlinks.mjs';

test('each supported target selects matching pinned assets', async () => {
  for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
    const { lock } = await loadRuntimeTarget(['--target', target], { requireHost: false });
    assert.equal(`${lock.target.platform}-${lock.target.arch}`, target);
    assert.match(lock.node.sha256, /^[a-f0-9]{64}$/);
    assert.match(lock.python.sha256, /^[a-f0-9]{64}$/);
    assert.ok(lock.node.urls.every((url) => url.startsWith('https://')));
    if (target.startsWith('linux'))
      assert.ok(lock.python.artifact.includes('unknown-linux-gnu-install_only'));
  }
});

test('rejects unsupported targets, missing arguments and foreign execution', async () => {
  assert.throws(() => parseRuntimeArguments(['--target']), /requires a value/);
  await assert.rejects(loadRuntimeTarget(['--target', 'win32-x64']), /not implemented/);
  await assert.rejects(loadRuntimeTarget(['--target', '../../etc/passwd']), /not implemented/);
  const other = process.platform === 'linux' ? 'darwin-arm64' : 'linux-x64';
  await assert.rejects(loadRuntimeTarget(['--target', other]), /matching host/);
});

test('checks executable format as well as Linux architecture spelling', () => {
  assert.ok(
    matchesBinaryTarget('ELF 64-bit LSB pie executable, ARM aarch64', {
      platform: 'linux',
      arch: 'arm64',
    }),
  );
  assert.ok(
    matchesBinaryTarget('ELF 64-bit LSB executable, x86-64', { platform: 'linux', arch: 'x64' }),
  );
  assert.equal(
    matchesBinaryTarget('Mach-O 64-bit executable arm64', { platform: 'linux', arch: 'arm64' }),
    false,
  );
  assert.equal(
    matchesBinaryTarget('ELF 64-bit LSB executable, x86-64', { platform: 'linux', arch: 'arm64' }),
    false,
  );
});

test('dry run propagates target and includes Web without building artifacts', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/pack-runtime.mjs', '--target', 'linux-x64', '--dry-run'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.match(output, /prepare-runtime-pack\.mjs --target linux-x64/);
  assert.match(output, /verify-platform-runtime\.mjs --target linux-x64/);
  assert.match(output, /vite\.web\.config\.ts/);
});

test('npm materialization preserves executable shared-library content and relocates shims', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'runtime-links-test-'));
  try {
    const root = path.join(temporary, 'runtime');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'lib/libpython.so.1'), 'ELF-test-library');
    await chmod(path.join(root, 'lib/libpython.so.1'), 0o755);
    await symlink('libpython.so.1', path.join(root, 'lib/libpython.so'));
    await writeFile(path.join(root, 'bin/python3'), '#!/bin/sh\nprintf shim-ok');
    await chmod(path.join(root, 'bin/python3'), 0o755);
    await symlink('python3', path.join(root, 'bin/python'));
    await materializeSymlinks(root);
    assert.equal(await readFile(path.join(root, 'lib/libpython.so'), 'utf8'), 'ELF-test-library');
    assert.equal(execFileSync(path.join(root, 'bin/python'), { encoding: 'utf8' }), 'shim-ok');
    await writeFile(path.join(temporary, 'outside'), 'outside');
    await symlink('../outside', path.join(root, 'escape'));
    await assert.rejects(materializeSymlinks(root), /escapes its root/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
