import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

const host = path.resolve('deployment/ubuntu22.04/host.sh');
const deploy = path.resolve('deployment/ubuntu22.04/deploy.sh');
function bash(code, file = host, args = []) {
  return spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; shift;\n' + code, 'test', file, ...args],
    { encoding: 'utf8', timeout: 15000 },
  );
}
function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
test('22.04 deployment can be previewed without system mutations', () => {
  const result = spawnSync('bash', [deploy, '--dry-run', '--port', '14317'], { encoding: 'utf8' });
  success(result);
  assert.match(result.stdout, /Ubuntu 22.04/);
  assert.match(result.stdout, /0.0.0.0:14317/);
});
test('only Ubuntu 22.04 enters this deployment path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ubuntu22-os-'));
  try {
    for (const [id, version, status] of [
      ['ubuntu', '22.04', 0],
      ['ubuntu', '24.04', 1],
      ['ubuntu', '20.04', 1],
      ['centos', '7', 1],
    ]) {
      const file = path.join(dir, 'os-release');
      await writeFile(file, `ID=${id}\nVERSION_ID=${version}\n`);
      assert.equal(bash('ubuntu22_check_release "$1"', host, [file]).status, status);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('missing GCC 12 is installed before toolchain selection and sandbox probe', () => {
  const result = bash(`
dpkg-query() { case "$3" in gcc-12|g++-12) return 1;; *) echo installed;; esac; }
sudo() { echo "$*"; }
ubuntu22_enable_toolchain() { echo toolchain; }
bwrap() { echo sandbox; }
ubuntu22_install_dependencies
`);
  success(result);
  assert.match(result.stdout, /apt-get install -y gcc-12 g\+\+-12/);
  assert.ok(result.stdout.indexOf('toolchain') < result.stdout.indexOf('sandbox'));
});
test('sandbox failure aborts without installing an AppArmor 4 policy', () => {
  const result = bash(
    'bwrap() { return 1; }; sudo() { echo UNEXPECTED; }; ubuntu22_check_sandbox; echo UNEXPECTED',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No Ubuntu 24.04 AppArmor policy was installed/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED/);
});
test('systemd unit retains public binding and marks the 22.04 deployment owner', () => {
  const result = bash(
    'DEPLOY_PLATFORM=$(deploy_platform); AGENT_DEPLOY_ROOT=/home/deployuser/agent-harness-deploy; DEPLOY_USER=deployuser; DEPLOY_DATA=$AGENT_DEPLOY_ROOT/data/runtime; DEPLOY_PORT=4317; deploy_render_unit',
    deploy,
  );
  success(result);
  assert.match(result.stdout, /Managed by agent-harness ubuntu22.04 deploy.sh/);
  assert.match(result.stdout, /--host 0.0.0.0 --port 4317/);
});

test('package provenance rejects 24.04 packages and modified archives', () => {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      String.raw`
import importlib.util, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('provenance', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
identity = {'id': 'ubuntu', 'version': '22.04', 'machine': 'aarch64', 'libc': 'glibc 2.35'}
p.host_identity = lambda: identity.copy()
with tempfile.TemporaryDirectory() as directory:
    archive = pathlib.Path(directory) / 'runtime.tgz'
    archive.write_bytes(b'tested runtime')
    def run(mode, expected_ok=True):
        sys.argv = ['provenance', mode, str(archive)]
        try:
            p.main()
        except SystemExit:
            assert not expected_ok
        else:
            assert expected_ok
    run('check', False)
    run('write')
    run('check')
    identity['version'] = '24.04'
    run('check', False)
    identity['version'] = '22.04'
    archive.write_bytes(b'changed')
    run('check', False)
`,
      path.resolve('deployment/ubuntu22.04/package-provenance.py'),
    ],
    { encoding: 'utf8' },
  );
  success(result);
});
