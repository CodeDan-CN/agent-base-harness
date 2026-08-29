/* global AbortSignal, fetch */
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'resources', 'runtime-lock.json');
const cacheRoot = path.join(root, '.runtime-cache');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const targetName = `${lock.target.platform}-${lock.target.arch}`;
const finalRoot = path.join(cacheRoot, targetName);

assertLock(lock);
if (process.platform !== lock.target.platform || process.arch !== lock.target.arch) {
  throw new Error(
    `Runtime Pack ${targetName} must be prepared on ${targetName}; current host is ${process.platform}-${process.arch}`,
  );
}
await assertInstalledMemoryMcp();
if (!process.argv.includes('--force') && (await preparedPackMatchesLock())) {
  process.stdout.write(`[runtime-pack] ${targetName} already matches runtime-lock.json\n`);
  process.exit(0);
}

await mkdir(cacheRoot, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-pack-'));
const stagingRoot = path.join(cacheRoot, `.prepare-${targetName}-${randomUUID()}`);

try {
  const nodeArchive = await downloadArtifact(lock.node, temporaryRoot);
  const pythonArchive = await downloadArtifact(lock.python, temporaryRoot);
  const nodeExtract = path.join(temporaryRoot, 'node-extract');
  const pythonExtract = path.join(temporaryRoot, 'python-extract');
  await Promise.all([mkdir(nodeExtract), mkdir(pythonExtract), mkdir(stagingRoot)]);

  await extractArchive(nodeArchive, nodeExtract);
  await extractArchive(pythonArchive, pythonExtract);

  const nodeSource = await findNodeRoot(nodeExtract);
  const pythonSource = await findPythonRoot(pythonExtract);
  const nodeTarget = path.join(stagingRoot, 'node');
  const pythonTarget = path.join(stagingRoot, 'python');
  await rename(nodeSource, nodeTarget);
  await rename(pythonSource, pythonTarget);

  const nodeExecutable = path.join(nodeTarget, 'bin', 'node');
  const pythonExecutable = path.join(pythonTarget, 'bin', 'python3');
  await Promise.all([
    access(nodeExecutable, fsConstants.X_OK),
    access(pythonExecutable, fsConstants.X_OK),
  ]);

  const binDir = path.join(stagingRoot, 'bin');
  await mkdir(binDir);
  await createShimLinks(binDir, nodeTarget, pythonTarget);
  const memoryMcpEntrypoint = await bundleMemoryMcp(stagingRoot);

  const [nodeVersion, pythonVersion, nodeFile, pythonFile] = await Promise.all([
    versionOf(nodeExecutable, ['--version']),
    versionOf(pythonExecutable, ['--version']),
    versionOf('/usr/bin/file', [nodeExecutable]),
    versionOf('/usr/bin/file', [pythonExecutable]),
  ]);
  if (!nodeVersion.includes(lock.node.version)) {
    throw new Error(`Prepared Node version mismatch: ${nodeVersion}`);
  }
  if (!pythonVersion.includes(lock.python.version)) {
    throw new Error(`Prepared Python version mismatch: ${pythonVersion}`);
  }
  if (!nodeFile.includes('arm64') || !pythonFile.includes('arm64')) {
    throw new Error('Prepared Runtime Pack contains a non-arm64 executable');
  }

  const manifest = {
    schemaVersion: 1,
    target: lock.target,
    node: {
      version: lock.node.version,
      executable: 'node/bin/node',
    },
    python: {
      version: lock.python.version,
      executable: 'python/bin/python3',
    },
    mcp: {
      memory: {
        package: lock.memoryMcp.package,
        version: lock.memoryMcp.version,
        entrypoint: path.relative(stagingRoot, memoryMcpEntrypoint),
      },
    },
    binDir: 'bin',
    sources: {
      node: { artifact: lock.node.artifact, sha256: lock.node.sha256 },
      python: { artifact: lock.python.artifact, sha256: lock.python.sha256 },
    },
  };
  await writeFile(
    path.join(stagingRoot, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await copyFile(lockPath, path.join(stagingRoot, 'runtime-lock.json'));

  await rm(finalRoot, { recursive: true, force: true });
  await rename(stagingRoot, finalRoot);
  process.stdout.write(
    `[runtime-pack] prepared ${targetName}: Node ${lock.node.version}, Python ${lock.python.version}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
}

function assertLock(value) {
  if (
    value?.schemaVersion !== 1 ||
    value?.target?.platform !== 'darwin' ||
    value?.target?.arch !== 'arm64'
  ) {
    throw new Error('runtime-lock.json does not describe the supported darwin-arm64 target');
  }
  for (const name of ['node', 'python']) {
    const entry = value[name];
    if (
      typeof entry?.version !== 'string' ||
      typeof entry?.artifact !== 'string' ||
      !Array.isArray(entry?.urls) ||
      entry.urls.length < 1 ||
      !entry.urls.every((url) => typeof url === 'string' && url.startsWith('https://')) ||
      !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')
    ) {
      throw new Error(`Invalid ${name} Runtime Pack lock entry`);
    }
  }
  if (
    typeof value.memoryMcp?.package !== 'string' ||
    typeof value.memoryMcp?.version !== 'string' ||
    typeof value.memoryMcp?.integrity !== 'string'
  ) {
    throw new Error('Invalid Memory MCP Runtime Pack lock entry');
  }
}

async function bundleMemoryMcp(stagingRoot) {
  const packageRoot = path.join(root, 'node_modules', '@modelcontextprotocol', 'server-memory');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (
    packageJson.name !== lock.memoryMcp.package ||
    packageJson.version !== lock.memoryMcp.version
  ) {
    throw new Error(
      `Installed Memory MCP does not match runtime-lock.json: ${packageJson.name ?? 'unknown'}@${packageJson.version ?? 'unknown'}`,
    );
  }
  const targetDir = path.join(stagingRoot, 'mcp', 'server-memory');
  const entrypoint = path.join(targetDir, 'index.mjs');
  await mkdir(targetDir, { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, 'dist', 'index.js')],
    outfile: entrypoint,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    legalComments: 'external',
    logLevel: 'silent',
  });
  await Promise.all([
    copyFile(packageJsonPath, path.join(targetDir, 'package.json')),
    copyFile(path.join(packageRoot, 'README.md'), path.join(targetDir, 'README.md')),
  ]);
  return entrypoint;
}

async function assertInstalledMemoryMcp() {
  const packageRoot = path.join(root, 'node_modules', '@modelcontextprotocol', 'server-memory');
  const [packageJson, packageLock] = await Promise.all([
    readFile(path.join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
  ]);
  const locked = packageLock.packages?.['node_modules/@modelcontextprotocol/server-memory'];
  if (
    packageJson.name !== lock.memoryMcp.package ||
    packageJson.version !== lock.memoryMcp.version ||
    locked?.version !== lock.memoryMcp.version ||
    locked?.integrity !== lock.memoryMcp.integrity
  ) {
    throw new Error('Installed Memory MCP or package-lock.json does not match runtime-lock.json');
  }
}

async function downloadArtifact(entry, directory) {
  const destination = path.join(directory, entry.artifact);
  let lastError;
  for (const url of entry.urls) {
    try {
      process.stdout.write(
        `[runtime-pack] downloading ${entry.artifact} from ${new URL(url).host}\n`,
      );
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      const digest = await sha256File(destination);
      if (digest !== entry.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${entry.sha256}, received ${digest}`);
      }
      return destination;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
    }
  }
  throw new Error(
    `Unable to download ${entry.artifact}: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
  );
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const file = await import('node:fs').then(({ createReadStream }) => createReadStream(filePath));
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}

async function extractArchive(archive, destination) {
  const { stdout } = await execFileAsync('/usr/bin/tar', ['-tf', archive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const entry of stdout.split('\n').filter(Boolean)) {
    const normalized = path.posix.normalize(entry);
    if (path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
  }
  await execFileAsync('/usr/bin/tar', ['-xf', archive, '-C', destination]);
  await assertLinksStayInside(destination);
}

async function assertLinksStayInside(rootDir) {
  const canonicalRoot = await realpath(rootDir);
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const name of await readdir(current)) {
      const candidate = path.join(current, name);
      const stat = await lstat(candidate);
      if (stat.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const resolved = await realpath(candidate);
      const relative = path.relative(canonicalRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Archive link escapes extraction root: ${candidate}`);
      }
    }
  }
}

async function findNodeRoot(extractRoot) {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('node-'));
  if (!directory) throw new Error('Node archive root was not found');
  return path.join(extractRoot, directory.name);
}

async function findPythonRoot(extractRoot) {
  const candidate = path.join(extractRoot, 'python');
  await access(path.join(candidate, 'bin', 'python3'), fsConstants.X_OK);
  return candidate;
}

async function createShimLinks(binDir, nodeRoot, pythonRoot) {
  const links = [
    ['node', path.join(nodeRoot, 'bin', 'node')],
    ['npm', path.join(nodeRoot, 'bin', 'npm')],
    ['npx', path.join(nodeRoot, 'bin', 'npx')],
    ['python', path.join(pythonRoot, 'bin', 'python3')],
    ['python3', path.join(pythonRoot, 'bin', 'python3')],
  ];
  for (const [name, target] of links) {
    await symlink(path.relative(binDir, target), path.join(binDir, name));
  }
  const pipShim = `#!/bin/sh\nexec "$(dirname "$0")/python" -m pip "$@"\n`;
  for (const name of ['pip', 'pip3']) {
    const shim = path.join(binDir, name);
    await writeFile(shim, pipShim, 'utf8');
    await chmod(shim, 0o755);
  }
}

async function versionOf(executable, args) {
  const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 10_000 });
  return `${stdout}\n${stderr}`.trim();
}

async function preparedPackMatchesLock() {
  try {
    const preparedLock = JSON.parse(
      await readFile(path.join(finalRoot, 'runtime-lock.json'), 'utf8'),
    );
    if (JSON.stringify(preparedLock) !== JSON.stringify(lock)) return false;
    const [nodeVersion, pythonVersion, nodeFile, pythonFile] = await Promise.all([
      versionOf(path.join(finalRoot, 'node', 'bin', 'node'), ['--version']),
      versionOf(path.join(finalRoot, 'python', 'bin', 'python3'), ['--version']),
      versionOf('/usr/bin/file', [path.join(finalRoot, 'node', 'bin', 'node')]),
      versionOf('/usr/bin/file', [path.join(finalRoot, 'python', 'bin', 'python3')]),
      access(path.join(finalRoot, 'mcp', 'server-memory', 'index.mjs'), fsConstants.R_OK),
    ]);
    return (
      nodeVersion.includes(lock.node.version) &&
      pythonVersion.includes(lock.python.version) &&
      nodeFile.includes('arm64') &&
      pythonFile.includes('arm64')
    );
  } catch {
    return false;
  }
}
