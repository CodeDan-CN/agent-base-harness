/* global clearTimeout, setTimeout */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadRuntimeTarget } from './runtime-target.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(
  await readFile(path.join(root, 'build-support', 'server-package', 'package.json'), 'utf8'),
);
const { lock: runtimeLock, artifact } = await loadRuntimeTarget();
const target = `${runtimeLock.target.platform}-${runtimeLock.target.arch}`;
const platformPackageName = `@agent-harness/runtime-${target}`;
const archiveName = `${platformPackageName.replace(/^@/, '').replace('/', '-')}-${packageManifest.version}.tgz`;
const artifactPath = path.resolve(
  artifact ?? path.join(root, 'release', 'runtime', target, archiveName),
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-platform-verify-'));
const installRoot = path.join(temporaryRoot, 'install');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let service;

try {
  await access(artifactPath, fsConstants.R_OK);
  await mkdir(installRoot, { recursive: true });
  await run(npmCommand, [
    'install',
    '--prefix',
    installRoot,
    '--offline',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    artifactPath,
  ]);
  const bundleRoot = path.join(installRoot, 'node_modules', '@agent-harness', `runtime-${target}`);
  const launcher = path.join(installRoot, 'node_modules', '.bin', 'agent-harness');
  const bundledNode = path.join(bundleRoot, 'runtime', 'node', 'bin', 'node');
  const bundledPython = path.join(bundleRoot, 'runtime', 'python', 'bin', 'python3');
  const nativeModule = path.join(bundleRoot, 'vendor', 'better-sqlite3');
  const distribution = JSON.parse(
    await readFile(path.join(bundleRoot, 'distribution-manifest.json'), 'utf8'),
  );
  if (
    distribution.target?.platform !== process.platform ||
    distribution.target?.arch !== process.arch
  ) {
    throw new Error(`Distribution target does not match ${process.platform}-${process.arch}`);
  }

  const cleanEnvironment = {
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C',
    SHELL: '/bin/bash',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
  const runtimeEnvironment = { ...cleanEnvironment, NODE_PATH: path.join(bundleRoot, 'vendor') };
  await Promise.all([
    run(bundledNode, ['--version'], cleanEnvironment),
    run(bundledPython, ['--version'], cleanEnvironment),
    run(launcher, ['--help'], cleanEnvironment),
    run(
      bundledNode,
      [
        '-e',
        "const D=require(process.argv[1]);const d=new D(':memory:');d.exec('create table t(v);insert into t values(47)');if(d.prepare('select v from t').get().v!==47)process.exit(1);d.close()",
        nativeModule,
      ],
      runtimeEnvironment,
    ),
  ]);

  const dataDir = path.join(temporaryRoot, 'data');
  service = spawn(launcher, ['serve', '--data-dir', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnvironment,
  });
  const serviceOutput = captureOutput(service);
  const discovery = await waitForDiscovery(path.join(dataDir, 'server', 'discovery.json'), service);
  const response = await globalThis.fetch(`${discovery.baseUrl}/healthz`);
  if (!response.ok) throw new Error(`Runtime health check failed with HTTP ${response.status}`);
  const health = await response.json();
  if (serviceOutput().includes('Unknown command:')) {
    throw new Error(
      `Packaged admin entry dispatched an unintended CLI command${suffix(serviceOutput())}`,
    );
  }
  if (health.status !== 'ready' || health.instanceId !== discovery.instanceId) {
    throw new Error('Runtime health response does not match service discovery');
  }
  const webResponse = await globalThis.fetch(discovery.baseUrl);
  if (!webResponse.ok || !(await webResponse.text()).includes('<html')) {
    throw new Error('Runtime package does not serve its bundled Web UI');
  }
  await run(
    bundledPython,
    ['-c', 'import ssl, sqlite3, ctypes, venv; print(ssl.OPENSSL_VERSION)'],
    cleanEnvironment,
  );
  const removedLogin = await postJson(`${discovery.baseUrl}/v1/auth/login`, {});
  if (removedLogin.response.status !== 410) throw new Error('Runtime still exposes account login');
  const authorization = {
    'x-agent-user': encodeURIComponent(
      JSON.stringify({
        id: 'package-smoke',
        loginName: 'package_smoke',
        displayName: 'Package smoke',
      }),
    ),
    'x-agent-client-kind': 'cli',
  };
  const bootstrap = await postJson(
    `${discovery.baseUrl}/v1/queries`,
    { apiVersion: 2, method: 'app.bootstrap' },
    authorization,
  );
  if (!bootstrap.response.ok || typeof bootstrap.body?.defaultAgentId !== 'string') {
    throw new Error('Client identity could not initialize the Runtime');
  }
  const memory = await postJson(
    `${discovery.baseUrl}/v1/commands`,
    {
      apiVersion: 2,
      method: 'mcp-server.test',
      params: {
        id: 'builtin-memory',
        name: 'memory',
        summary: '',
        categoryId: 'memory',
        transport: 'stdio',
        enabled: true,
        credential: { action: 'unchanged' },
        config: {
          command: 'runtime://node',
          args: ['runtime://mcp/memory'],
          env: { MEMORY_FILE_PATH: 'runtime://mcp-data/memory.jsonl' },
        },
      },
    },
    authorization,
  );
  if (
    !memory.response.ok ||
    memory.body?.status !== 'success' ||
    !memory.body.tools?.some((tool) => tool.rawName === 'create_entities')
  ) {
    throw new Error(
      `Runtime builtin-memory sandbox connection failed: ${JSON.stringify(memory.body)}`,
    );
  }
  const session = await postJson(
    `${discovery.baseUrl}/v1/commands`,
    {
      apiVersion: 2,
      method: 'session.create',
      params: { title: 'Package smoke', agentId: bootstrap.body.defaultAgentId },
    },
    authorization,
  );
  if (!session.response.ok || typeof session.body?.id !== 'string') {
    throw new Error('Registered account could not create a session');
  }
  const missingModel = await postJson(
    `${discovery.baseUrl}/v1/commands`,
    {
      apiVersion: 2,
      method: 'input.submit',
      params: {
        sessionId: session.body.id,
        content: 'verify model gate',
        idempotencyKey: 'package-model-gate',
        startNewEvent: true,
        mode: 'queue',
      },
    },
    authorization,
  );
  if (missingModel.response.ok || missingModel.body?.error?.code !== 'MODEL_NOT_CONFIGURED') {
    throw new Error('Runtime did not reject task submission before model configuration');
  }
  service.kill('SIGTERM');
  await waitForExit(service, 10_000, serviceOutput);
  service = undefined;
  process.stdout.write(
    `[platform-package] verified ${path.basename(artifactPath)} using bundled Node/Python (package smoke only)\n`,
  );
} finally {
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await waitForExit(service, 2_000, captureOutput(service)).catch(() => service.kill('SIGKILL'));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const output = captureOutput(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output());
      else reject(new Error(formatFailure(command, code, signal, output())));
    });
  });
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function captureOutput(child) {
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString();
  });
  return () => output.trim();
}

async function waitForDiscovery(discoveryPath, child) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Runtime exited before publishing service discovery (code ${child.exitCode})`,
      );
    }
    try {
      const value = JSON.parse(await readFile(discoveryPath, 'utf8'));
      if (typeof value.baseUrl === 'string' && typeof value.instanceId === 'string') return value;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw new Error(
    `Runtime did not publish service discovery within 20 seconds: ${
      lastError instanceof Error ? lastError.message : 'unknown error'
    }`,
  );
}

function waitForExit(child, timeoutMs, output) {
  if (child.exitCode !== null)
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(
          new Error(
            formatFailure('agent-harness serve', child.exitCode, child.signalCode, output()),
          ),
        );
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Runtime did not stop within ${timeoutMs}ms${suffix(output())}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(formatFailure('agent-harness serve', code, signal, output())));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function formatFailure(command, code, signal, output) {
  return `${command} failed (${signal ? `signal ${signal}` : `exit ${code}`})${suffix(output)}`;
}

function suffix(output) {
  return output ? `\n${output}` : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
