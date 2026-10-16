import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'build-support', 'server-package');
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const archiveName = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
const archivePath = path.resolve(
  process.argv[2] ?? path.join(root, 'release', 'server', archiveName),
);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-package-smoke-'));
const installRoot = path.join(tempRoot, 'install');
const dataDir = path.join(tempRoot, 'data');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let service;

try {
  await access(archivePath);
  await mkdir(installRoot, { recursive: true });
  await run(npmCommand, [
    'install',
    '--prefix',
    installRoot,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    archivePath,
  ]);

  const modulesRoot = path.join(installRoot, 'node_modules');
  const nativeModule = path.join(modulesRoot, 'better-sqlite3');
  const installedPackage = path.join(modulesRoot, '@agent-harness', 'server');
  const cliEntry = path.join(installedPackage, 'dist', 'cli', 'index.cjs');
  const webEntry = path.join(installedPackage, 'dist', 'web', 'index.html');

  await run(process.execPath, [
    '-e',
    `const Database = require(process.argv[1]);
const database = new Database(':memory:');
database.exec('CREATE TABLE smoke (value INTEGER NOT NULL); INSERT INTO smoke VALUES (47)');
const row = database.prepare('SELECT value FROM smoke').get();
database.close();
if (row?.value !== 47) throw new Error('SQLite package smoke returned an unexpected value');`,
    nativeModule,
  ]);
  await run(process.execPath, ['-e', 'require(process.argv[1])', installedPackage]);
  await run(process.execPath, [cliEntry, '--help']);
  await access(webEntry);

  service = spawn(process.execPath, [cliEntry, 'serve', '--data-dir', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const serviceOutput = captureOutput(service);
  const discovery = await waitForDiscovery(path.join(dataDir, 'server', 'discovery.json'), service);
  const response = await globalThis.fetch(`${discovery.baseUrl}/healthz`);
  if (!response.ok) throw new Error(`Runtime health check failed with HTTP ${response.status}`);
  const health = await response.json();
  if (health.status !== 'ready' || health.instanceId !== discovery.instanceId) {
    throw new Error('Runtime health response does not match service discovery');
  }
  const webResponse = await globalThis.fetch(`${discovery.baseUrl}/`);
  if (!webResponse.ok || !(await webResponse.text()).includes('<div id="root"></div>')) {
    throw new Error('Runtime did not serve the packaged Web client');
  }

  service.kill('SIGTERM');
  await waitForExit(service, 10_000, serviceOutput);
  service = undefined;
  process.stdout.write(
    `Standalone Runtime package verified: ${path.basename(archivePath)} ` +
      `(${process.platform}-${process.arch}, Node ${process.versions.node})\n`,
  );
} finally {
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await waitForExit(service, 2_000, captureOutput(service)).catch(() => service.kill('SIGKILL'));
  }
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = captureOutput(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(formatFailure(command, code, signal, output())));
    });
  });
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
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Runtime did not stop within ${timeoutMs}ms${suffix(output())}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      if (code === 0 || signal === 'SIGTERM') resolve();
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
