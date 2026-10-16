import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'vitest';

const host = path.resolve('deployment/centos/host.sh');
const deploy = path.resolve('deployment/centos/deploy.sh');
const provenance = path.resolve('deployment/centos/package-provenance.py');
function bash(code, file = host, args = []) {
  return spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; shift;\n' + code, 'test', file, ...args],
    {
      encoding: 'utf8',
      env: process.env,
      timeout: 15000,
    },
  );
}
function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('CentOS entries preview on any host without provisioning', () => {
  for (const script of [deploy, path.resolve('deployment/centos/package.sh')]) {
    const result = spawnSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_DEPLOY_ROOT: '/opt/agent-harness' },
    });
    success(result);
    assert.match(result.stdout, /CentOS Stream 9\/10/);
    assert.doesNotMatch(result.stdout, /apt dependencies/);
  }
});

test('release detection accepts Stream 9/10 and rejects CentOS 7/8 and Ubuntu', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'centos-os-'));
  try {
    const osRelease = path.join(dir, 'os-release');
    for (const [id, version, expected] of [
      ['centos', '9', 0],
      ['centos', '10', 0],
      ['centos', '7', 1],
      ['centos', '8', 1],
      ['ubuntu', '24.04', 1],
    ]) {
      await writeFile(
        osRelease,
        `ID=${id}\nVERSION_ID="${version}"\nPRETTY_NAME="${id} ${version}"\n`,
      );
      const result = bash('centos_check_release "$1"', host, [osRelease]);
      assert.equal(result.status, expected, result.stdout + result.stderr);
      if (version === '7') assert.match(result.stderr, /glibc >= 2.28/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dnf installs missing dependencies without replacing curl-minimal', () => {
  const result = bash(`
rpm() { [[ "$2" != bubblewrap && "$2" != python3-devel ]]; }
g++() { echo 14.2.1; }
sudo() { printf 'SUDO:%s\\n' "$*"; }
bwrap() { echo sandbox-ok; }
centos_install_dependencies
printf 'CC:%s CXX:%s\\n' "$CC" "$CXX"
`);
  success(result);
  assert.match(result.stdout, /SUDO:dnf install -y python3-devel bubblewrap/);
  assert.doesNotMatch(result.stdout, /SUDO:.*curl|gcc-toolset/);
  assert.match(result.stdout, /sandbox-ok/);
});

test('sandbox denial fails before continuing, without changing host policy', () => {
  const result = bash(
    'bwrap() { return 1; }; sudo() { echo UNEXPECTED_MUTATION; }; centos_check_sandbox; echo UNEXPECTED_CONTINUE',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SELinux AVCs/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED/);
});

test('SELinux labels are scoped and systemd preflight failure aborts release preparation', () => {
  const result = bash(
    `
AGENT_DEPLOY_ROOT=/opt/agent-harness
DEPLOY_DATA=/opt/agent-harness/data/runtime
DEPLOY_USER=deployuser
DEPLOY_RUN=test
selinuxenabled() { return 0; }
matchpathcon() { echo system_u:object_r:usr_t:s0; }
sudo() {
  echo "$*"
  if [[ "$1" = systemd-run ]]; then return 42; fi
}
deploy_prepare_release /opt/agent-harness/releases/test
echo UNEXPECTED_CONTINUE
`,
    deploy,
  );
  assert.equal(result.status, 42);
  assert.match(result.stdout, /semanage fcontext -a -t bin_t \/opt\/agent-harness\/releases/);
  assert.match(result.stdout, /semanage fcontext -a -t var_lib_t \/opt\/agent-harness\/data/);
  assert.match(result.stdout, /restorecon -RF/);
  assert.match(result.stdout, /systemd-run .*User=deployuser/);
  assert.doesNotMatch(result.stdout, /systemctl stop|setenforce|UNEXPECTED/);
});

test('CentOS service uses its ownership marker, the deploying user and public bind', () => {
  const result = bash(
    `
DEPLOY_PLATFORM=$(deploy_platform)
AGENT_DEPLOY_ROOT=/opt/agent-harness
DEPLOY_USER=deployuser
DEPLOY_DATA=/opt/agent-harness/data/runtime
DEPLOY_PORT=14317
deploy_render_unit
`,
    deploy,
  );
  success(result);
  assert.match(result.stdout, /Managed by agent-harness centos deploy.sh/);
  assert.match(result.stdout, /User=deployuser/);
  assert.match(result.stdout, /--host 0.0.0.0 --port 14317/);
});

test('provenance rejects missing, changed, foreign-major and foreign-architecture archives', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      String.raw`
import importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('provenance', sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
identity = {'id': 'centos', 'major': '9', 'machine': 'x86_64', 'libc': 'glibc 2.34'}
p.host_identity = lambda: identity.copy()
with tempfile.TemporaryDirectory() as directory:
    archive = pathlib.Path(directory) / 'runtime.tgz'
    archive.write_bytes(b'tested runtime')
    sidecar = pathlib.Path(str(archive) + '.centos.json')
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
    archive.write_bytes(b'different runtime')
    run('check', False)
    archive.write_bytes(b'tested runtime')
    for key, value in [('major', '10'), ('machine', 'aarch64'), ('id', 'ubuntu')]:
        original = identity[key]
        identity[key] = value
        run('check', False)
        identity[key] = original
    run('check')
`,
      provenance,
    ],
    { encoding: 'utf8' },
  );
  success(result);
});
