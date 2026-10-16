import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'vitest';

const buildEnv = path.resolve('deployment/ubuntu24.04/build-env.sh');
const headers = ['node.h', 'node_version.h', 'common.gypi', 'config.gypi'];
function run(code, nodeDir = '') {
  const env = { ...process.env };
  delete env.npm_package_config_node_gyp_nodedir;
  return spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; ' + code, 'test', buildEnv, nodeDir],
    {
      env,
      encoding: 'utf8',
    },
  );
}

test('shared build environment does not select Node headers for Desktop implicitly', () => {
  const result = run('test -z "${npm_package_config_node_gyp_nodedir:-}"');
  assert.equal(result.status, 0, result.stderr);
});

test('Runtime selects and exports local headers, including paths with spaces', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'node headers '));
  try {
    await mkdir(path.join(dir, 'include/node'), { recursive: true });
    for (const header of headers)
      await writeFile(path.join(dir, 'include/node', header), 'fixture');
    const result = run(
      'agent_use_local_node_headers "$2"; bash -c \'printf "%s" "$npm_package_config_node_gyp_nodedir"\'',
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('incomplete local headers fail before dependency installation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'missing-node-header-'));
  try {
    await mkdir(path.join(dir, 'include/node'), { recursive: true });
    for (const header of headers.slice(0, -1))
      await writeFile(path.join(dir, 'include/node', header), 'fixture');
    const result = run('agent_use_local_node_headers "$2"; echo UNEXPECTED_INSTALL', dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing bundled Node header: .*config\.gypi/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_INSTALL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
