import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'vitest';

const script = path.resolve('deployment/ubuntu24.04/deploy.sh');
// Only host integrations are substituted. Extraction, backup, ownership checks,
// release switching, failure handling and generated units use the actual script.
const harness = String.raw`
source "$1"
shift
deploy_check_host() { :; }
deploy_prepare_host() { :; }
deploy_lock() { [[ "$FAIL_LOCK" != 1 ]] || deploy_fail 'Another deployment'; }
deploy_systemd_dir() { echo "$FIXTURE/systemd"; }
deploy_build() {
  echo build >> "$FIXTURE/events"
  [[ "$FAIL_BUILD" != 1 ]] || deploy_fail 'build failed'
}
deploy_check_archive() { [[ "$FAIL_PROVENANCE" != 1 ]] || deploy_fail 'provenance failed'; }
deploy_prepare_release() { [[ "$FAIL_PREFLIGHT" != 1 ]] || deploy_fail 'systemd preflight failed'; }
deploy_wait_ready() {
  echo health >> "$FIXTURE/events"
  [[ "$FAIL_HEALTH" != 1 ]] || deploy_fail 'health failed'
}
sudo() {
  [[ "$1" != -v ]] || return 0
  if [[ "$1" = -n ]]; then shift; fi
  "$@"
}
systemd-analyze() { echo verify >> "$FIXTURE/events"; }
systemctl() {
  echo "systemctl $*" >> "$FIXTURE/events"
  case "$1" in
    show)
      if [[ "$4" = FragmentPath && -f "$FIXTURE/systemd/$DEPLOY_SERVICE" ]]; then
        echo "$FIXTURE/systemd/$DEPLOY_SERVICE"
      elif [[ ! -f "$FIXTURE/systemd/$DEPLOY_SERVICE" ]]; then
        return 1
      fi ;;
    start)
      echo running > "$FIXTURE/state"
      echo new-schema > "$DEPLOY_DATA/db"
      ;;
    stop) echo stopped > "$FIXTURE/state" ;;
    disable) echo disabled > "$FIXTURE/enabled" ;;
    enable) echo enabled > "$FIXTURE/enabled" ;;
  esac
  return 0
}
# macOS mv lacks GNU -T; os.replace supplies the same atomic rename for this test.
mv() {
  if [[ "$1" = -Tf ]]; then
    python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$2" "$3"
  else command mv "$@"; fi
}
deploy_main "$@"
`;

async function fixture(run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ubuntu-deploy-'));
  // Match production's canonical root even when /var is a symlink on macOS.
  const root = execFileSync('pwd', ['-P'], { cwd: temporary, encoding: 'utf8' }).trim();
  try {
    const repo = path.join(root, 'repo');
    const deploy = path.join(root, 'deploy');
    const scriptDir = path.join(repo, 'deployment/ubuntu24.04');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const output = path.join(repo, `release/runtime/linux-${arch}`);
    const pkg = path.join(root, 'package');
    await Promise.all([
      mkdir(scriptDir, { recursive: true }),
      mkdir(path.join(repo, 'build-support/server-package'), { recursive: true }),
      mkdir(path.join(pkg, 'bin'), { recursive: true }),
      mkdir(path.join(pkg, 'service/dist/web'), { recursive: true }),
      mkdir(path.join(root, 'systemd')),
      mkdir(output, { recursive: true }),
    ]);
    await copyFile(script, path.join(scriptDir, 'deploy.sh'));
    await writeFile(
      path.join(repo, 'build-support/server-package/package.json'),
      '{"version":"1.0.0"}',
    );
    await writeFile(
      path.join(pkg, 'bin/agent-harness'),
      '#!/bin/sh\nif [ "$1" = credentials ]; then\n  echo migrate >> "$FIXTURE/events"\n  [ "$FAIL_MIGRATE" != 1 ] || exit 1\n  touch "$4/migrated"\nfi\nexit 0\n',
      { mode: 0o755 },
    );
    await writeFile(path.join(pkg, 'service/dist/web/index.html'), '<html>Web</html>');
    const archive = `agent-harness-runtime-linux-${arch}-1.0.0.tgz`;
    execFileSync('tar', ['-czf', path.join(output, archive), '-C', root, 'package']);
    const hash = createHash('sha256')
      .update(await readFile(path.join(output, archive)))
      .digest('hex');
    await writeFile(path.join(output, `${archive}.sha256`), `${hash}  ${archive}\n`);
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const invoke = (env = {}, args = ['--port', String(port)]) =>
      spawnSync(
        'bash',
        ['-c', harness, 'test-deploy', path.join(scriptDir, 'deploy.sh'), ...args],
        {
          env: {
            ...process.env,
            FIXTURE: root,
            AGENT_DEPLOY_ROOT: deploy,
            FAIL_LOCK: '',
            FAIL_BUILD: '',
            FAIL_HEALTH: '',
            FAIL_PROVENANCE: '',
            FAIL_PREFLIGHT: '',
            ...env,
          },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
    await run({ root, deploy, invoke, port, output, archive });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('dry-run is read-only and rejects invalid port/path arguments before host actions', async () => {
  await fixture(async ({ root, deploy, invoke }) => {
    const result = invoke({}, ['--dry-run']);
    success(result);
    assert.match(result.stdout, /0\.0\.0\.0:4317/);
    assert.equal((await readdir(root)).includes('deploy'), false);
    for (const port of ['0', '80', '65536', '04317', '4317\nUser=root']) {
      assert.notEqual(invoke({}, ['--port', port, '--dry-run']).status, 0);
    }
    assert.notEqual(invoke({ AGENT_DEPLOY_ROOT: `${deploy}%n` }, ['--dry-run']).status, 0);
    assert.notEqual(invoke({}, ['--port']).status, 0);
  });
});

test('fresh deployment installs Web service on all interfaces and upgrade backs up stopped data', async () => {
  await fixture(async ({ root, deploy, invoke, port }) => {
    success(invoke());
    const previous = await readlink(path.join(deploy, 'current'));
    const unit = await readFile(path.join(root, 'systemd/agent-harness-web.service'), 'utf8');
    assert.match(unit, new RegExp(`--host 0.0.0.0 --port ${port}`));
    assert.ok(unit.includes(`--data-dir ${deploy}/data/runtime`));
    assert.equal((await readFile(path.join(root, 'enabled'), 'utf8')).trim(), 'enabled');
    await writeFile(path.join(deploy, 'data/runtime/db'), 'original-database');
    await writeFile(path.join(deploy, 'data/runtime/credentials'), 'retained-secret');
    await writeFile(path.join(root, 'events'), '');
    success(invoke());
    const current = await readlink(path.join(deploy, 'current'));
    assert.notEqual(current, previous);
    const backup = path.join(
      deploy,
      'backups',
      (await readdir(path.join(deploy, 'backups'))).sort().at(-1),
    );
    assert.equal(
      (await readFile(path.join(backup, 'previous-release.txt'), 'utf8')).trim(),
      previous,
    );
    assert.equal(
      execFileSync('tar', ['-xOzf', path.join(backup, 'data.tar.gz'), './db'], {
        encoding: 'utf8',
      }),
      'original-database',
    );
    assert.equal(
      await readFile(path.join(deploy, 'data/runtime/credentials'), 'utf8'),
      'retained-secret',
    );
    assert.ok((await readdir(backup)).includes('COMPLETE'));
    const events = await readFile(path.join(root, 'events'), 'utf8');
    assert.ok(events.indexOf('build') < events.indexOf('systemctl stop'));
    assert.ok(events.indexOf('health') < events.indexOf('systemctl enable'));
  });
});

test('build/provenance/preflight/checksum failure preserves the currently running service and release', async () => {
  await fixture(async ({ root, deploy, invoke, output, archive }) => {
    success(invoke());
    const previous = await readlink(path.join(deploy, 'current'));
    for (const env of [
      { FAIL_BUILD: '1' },
      { FAIL_PROVENANCE: '1' },
      { FAIL_PREFLIGHT: '1' },
      {},
    ]) {
      if (Object.keys(env).length === 0) await writeFile(path.join(output, archive), 'corrupt');
      await writeFile(path.join(root, 'events'), '');
      assert.notEqual(invoke(env).status, 0);
      assert.equal(await readlink(path.join(deploy, 'current')), previous);
      assert.equal((await readFile(path.join(root, 'state'), 'utf8')).trim(), 'running');
      assert.doesNotMatch(await readFile(path.join(root, 'events'), 'utf8'), /systemctl stop/);
    }
  });
});

test('failed new start retains migrated data and pre-upgrade backup, stops and disables service', async () => {
  await fixture(async ({ root, deploy, invoke }) => {
    success(invoke());
    const previous = await readlink(path.join(deploy, 'current'));
    await writeFile(path.join(deploy, 'data/runtime/db'), 'old-schema');
    const result = invoke({ FAIL_HEALTH: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /No automatic database rollback/);
    assert.notEqual(await readlink(path.join(deploy, 'current')), previous);
    assert.equal(await readFile(path.join(deploy, 'data/runtime/db'), 'utf8'), 'new-schema\n');
    assert.equal((await readFile(path.join(root, 'state'), 'utf8')).trim(), 'stopped');
    assert.equal((await readFile(path.join(root, 'enabled'), 'utf8')).trim(), 'disabled');
    const backup = path.join(
      deploy,
      'backups',
      (await readdir(path.join(deploy, 'backups'))).sort().at(-1),
    );
    assert.equal(
      execFileSync('tar', ['-xOzf', path.join(backup, 'data.tar.gz'), './db'], {
        encoding: 'utf8',
      }),
      'old-schema',
    );
  });
});

test('unmanaged service and a deployment lock prevent build and service changes', async () => {
  await fixture(async ({ root, invoke }) => {
    await writeFile(
      path.join(root, 'systemd/agent-harness-web.service'),
      '[Service]\nUser=other\n',
    );
    const result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /unmanaged/);
    assert.doesNotMatch(await readFile(path.join(root, 'events'), 'utf8'), /build|systemctl stop/);
    assert.notEqual(invoke({ FAIL_LOCK: '1' }).status, 0);
  });
});

test('live Runtime data lock blocks cutover without backing up or replacing the release', async () => {
  await fixture(async ({ deploy, invoke }) => {
    success(invoke());
    const previous = await readlink(path.join(deploy, 'current'));
    await mkdir(path.join(deploy, 'data/runtime/server'), { recursive: true });
    await writeFile(
      path.join(deploy, 'data/runtime/server/instance.lock'),
      JSON.stringify({ pid: process.pid }),
    );
    const before = await readdir(path.join(deploy, 'backups'));
    const result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /still in use/);
    assert.equal(await readlink(path.join(deploy, 'current')), previous);
    assert.deepEqual(await readdir(path.join(deploy, 'backups')), before);
  });
});

test('health acceptance requires matching systemd PID, discovery instance and an HTML Web page', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deploy-health-'));
  let instanceId = 'expected-instance';
  let contentType = 'text/html';
  const server = createHttpServer((request, response) => {
    if (request.url === '/healthz') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ready', instanceId }));
    } else {
      response.setHeader('Content-Type', contentType);
      response.end('<html>Web</html>');
    }
  });
  try {
    await mkdir(path.join(temporary, 'server'));
    await writeFile(
      path.join(temporary, 'server/discovery.json'),
      JSON.stringify({
        pid: 1234,
        dataDir: temporary,
        instanceId,
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const check = (pid = '1234') =>
      promisify(execFile)(
        'bash',
        [
          '-c',
          String.raw`
source "$1"
DEPLOY_DATA=$2
DEPLOY_PORT=$3
DEPLOY_SERVICE=fixture.service
systemctl() { echo "$FIXTURE_PID"; }
deploy_health_once
`,
          'health-test',
          script,
          temporary,
          String(server.address().port),
        ],
        {
          env: { ...process.env, FIXTURE_PID: pid },
        },
      );
    await check();
    await assert.rejects(check('5678'));
    instanceId = 'unrelated-service';
    await assert.rejects(check());
    instanceId = 'expected-instance';
    contentType = 'application/json';
    await assert.rejects(check());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('legacy data can be retained with a verified package and credentials migrated after backup', async () => {
  await fixture(async ({ root, deploy, invoke, port }) => {
    const data = path.join(deploy, 'data/service-test');
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'db'), 'legacy-db');
    const args = ['--port', String(port), '--data-dir', data, '--skip-build', '--migrate-files'];
    success(invoke({ FAIL_BUILD: '1' }, args));
    assert.ok((await readdir(data)).includes('migrated'));
    const backup = path.join(deploy, 'backups', (await readdir(path.join(deploy, 'backups')))[0]);
    const contents = execFileSync('tar', ['-tzf', path.join(backup, 'data.tar.gz')], {
      encoding: 'utf8',
    });
    assert.doesNotMatch(contents, /migrated/);
    const events = await readFile(path.join(root, 'events'), 'utf8');
    assert.doesNotMatch(events, /^build$/m);
    assert.ok(events.indexOf('migrate') < events.indexOf('systemctl start'));
    // Omitting --data-dir on the next run must not silently switch to empty data.
    assert.notEqual(invoke().status, 0);
    const previous = await readlink(path.join(deploy, 'current'));
    assert.notEqual(invoke({ FAIL_MIGRATE: '1' }, args).status, 0);
    assert.equal(await readlink(path.join(deploy, 'current')), previous);
  });
});
