import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadRuntimeTarget } from './runtime-target.mjs';
import { materializeSymlinks } from './runtime-symlinks.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'build-support', 'server-package');
const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const { lock: runtimeLock } = await loadRuntimeTarget();
const target = `${runtimeLock.target.platform}-${runtimeLock.target.arch}`;
const runtimeSource = path.join(root, '.runtime-cache', target);
const runtimeManifest = JSON.parse(
  await readFile(path.join(runtimeSource, 'runtime-manifest.json'), 'utf8'),
);

if (process.platform !== runtimeLock.target.platform || process.arch !== runtimeLock.target.arch) {
  throw new Error(`Platform package ${target} must be built on ${target}`);
}
if (
  runtimeManifest.target?.platform !== runtimeLock.target.platform ||
  runtimeManifest.target?.arch !== runtimeLock.target.arch
) {
  throw new Error('Runtime Pack manifest target does not match runtime-lock.json');
}

const releaseRoot = path.join(root, 'release', 'runtime', target);
const platformPackageName = `@agent-harness/runtime-${target}`;
const archiveName = `${platformPackageName.replace(/^@/, '').replace('/', '-')}-${packageManifest.version}.tgz`;
const artifactPath = path.join(releaseRoot, archiveName);
const checksumPath = `${artifactPath}.sha256`;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-platform-package-'));
const bundleRoot = path.join(temporaryRoot, 'package');
const serviceRoot = path.join(bundleRoot, 'service');
const bundledRuntimeRoot = path.join(bundleRoot, 'runtime');

try {
  await Promise.all([
    mkdir(path.join(bundleRoot, 'bin'), { recursive: true }),
    mkdir(path.join(serviceRoot, 'dist'), { recursive: true }),
    mkdir(releaseRoot, { recursive: true }),
  ]);
  await cp(runtimeSource, bundledRuntimeRoot, { recursive: true, verbatimSymlinks: true });
  await materializeSymlinks(bundledRuntimeRoot);
  for (const name of ['server', 'client', 'cli', 'web']) {
    await cp(path.join(packageRoot, 'dist', name), path.join(serviceRoot, 'dist', name), {
      recursive: true,
    });
  }
  await copyFile(path.join(packageRoot, 'README.md'), path.join(serviceRoot, 'README.md'));

  const platformPackageManifest = {
    name: platformPackageName,
    version: packageManifest.version,
    description: `Self-contained Agent Harness Runtime for ${target}`,
    license: packageManifest.license,
    os: [runtimeLock.target.platform],
    cpu: [runtimeLock.target.arch],
    bin: { 'agent-harness': 'bin/agent-harness' },
    files: [
      'bin/**/*',
      'runtime/**/*',
      'service/**/*',
      'vendor/**/*',
      'distribution-manifest.json',
      'README.md',
    ],
    allowScripts: packageManifest.allowScripts,
    dependencies: packageManifest.dependencies,
  };
  await Promise.all([
    writeFile(
      path.join(bundleRoot, 'package.json'),
      `${JSON.stringify(platformPackageManifest, null, 2)}\n`,
      'utf8',
    ),
    writeFile(path.join(bundleRoot, 'README.md'), platformReadme(), 'utf8'),
  ]);

  const bundledNode = path.join(bundledRuntimeRoot, runtimeManifest.node.executable);
  const bundledNodeBin = path.dirname(bundledNode);
  const npmCli = path.join(
    bundledRuntimeRoot,
    'node',
    'lib',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  await Promise.all([access(bundledNode, fsConstants.X_OK), access(npmCli, fsConstants.R_OK)]);
  const bundledNodeDir = path.dirname(bundledNodeBin);
  for (const header of ['node.h', 'node_version.h', 'common.gypi', 'config.gypi']) {
    await access(path.join(bundledNodeDir, 'include', 'node', header), fsConstants.R_OK);
  }
  // Use the headers from the SHA-256-verified Node archive, including during
  // npm lifecycle scripts. Do not inherit the host build Node's header path.
  const nativeBuildEnv = {
    ...process.env,
    PATH: [bundledNodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    npm_package_config_node_gyp_nodedir: bundledNodeDir,
  };
  await execFileAsync(bundledNode, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: bundleRoot,
    env: nativeBuildEnv,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });

  const nativeModule = path.join(bundleRoot, 'node_modules', 'better-sqlite3');
  // Compile against this target's system libraries; omit other platforms' bundled N-API binaries.
  await rm(path.join(nativeModule, 'prebuilds'), { recursive: true, force: true });
  const nodeGyp = path.join(
    path.dirname(path.dirname(npmCli)),
    'node_modules/node-gyp/bin/node-gyp.js',
  );
  await access(nodeGyp, fsConstants.R_OK);
  await execFileAsync(bundledNode, [nodeGyp, 'rebuild', '--force_build=1'], {
    cwd: nativeModule,
    env: nativeBuildEnv,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  await execFileAsync(
    bundledNode,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(':memory:');d.prepare('select 1').get();d.close()",
      nativeModule,
    ],
    { timeout: 30_000 },
  );
  const nativeManifestPath = path.join(nativeModule, 'package.json');
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'));
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (nativeManifest.scripts) delete nativeManifest.scripts[lifecycle];
  }
  await writeFile(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`, 'utf8');
  await rename(path.join(bundleRoot, 'node_modules'), path.join(bundleRoot, 'vendor'));
  delete platformPackageManifest.allowScripts;
  delete platformPackageManifest.dependencies;
  await writeFile(
    path.join(bundleRoot, 'package.json'),
    `${JSON.stringify(platformPackageManifest, null, 2)}\n`,
    'utf8',
  );

  const launcherPath = path.join(bundleRoot, 'bin', 'agent-harness');
  await writeFile(launcherPath, launcher(), { encoding: 'utf8', mode: 0o755 });
  await chmod(launcherPath, 0o755);
  const distributionManifest = {
    schemaVersion: 1,
    name: platformPackageName,
    version: packageManifest.version,
    target: runtimeLock.target,
    runtime: {
      node: runtimeManifest.node.version,
      python: runtimeManifest.python.version,
      memoryMcp: runtimeManifest.mcp.memory.version,
    },
    nativeDependencies: {
      'better-sqlite3': packageManifest.dependencies['better-sqlite3'],
      nodeModulesAbi: await moduleAbi(bundledNode),
      rebuildOnInstall: false,
    },
    entrypoint: 'bin/agent-harness',
  };
  await writeFile(
    path.join(bundleRoot, 'distribution-manifest.json'),
    `${JSON.stringify(distributionManifest, null, 2)}\n`,
    'utf8',
  );

  await rm(artifactPath, { force: true });
  const { stdout: packOutput } = await execFileAsync(
    bundledNode,
    [npmCli, 'pack', '--pack-destination', releaseRoot, '--json'],
    {
      cwd: bundleRoot,
      env: {
        ...process.env,
        PATH: [bundledNodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      },
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const packResult = JSON.parse(packOutput);
  if (packResult[0]?.filename !== archiveName) {
    throw new Error(
      `npm pack created an unexpected artifact: ${packResult[0]?.filename ?? 'none'}`,
    );
  }
  const packedFiles = new Set(packResult[0]?.files?.map((file) => file.path));
  if (!packedFiles.has('vendor/better-sqlite3/build/Release/better_sqlite3.node')) {
    throw new Error('npm pack did not include the reviewed better-sqlite3 native binary');
  }
  await access(artifactPath, fsConstants.R_OK);
  await Promise.all([
    rm(
      path.join(releaseRoot, `agent-harness-runtime-${packageManifest.version}-${target}.tar.gz`),
      { force: true },
    ),
    rm(
      path.join(
        releaseRoot,
        `agent-harness-runtime-${packageManifest.version}-${target}.tar.gz.sha256`,
      ),
      { force: true },
    ),
  ]);
  const digest = await sha256File(artifactPath);
  await writeFile(checksumPath, `${digest}  ${path.basename(artifactPath)}\n`, 'utf8');
  process.stdout.write(`[platform-package] created ${artifactPath}\n`);
  process.stdout.write(`[platform-package] sha256 ${digest}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function launcher() {
  return `#!/bin/sh
set -eu
SELF=$0
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF=$LINK ;;
    *) SELF=$(dirname "$SELF")/$LINK ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
BUNDLE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
export AGENT_HARNESS_RUNTIME_ROOT="$BUNDLE_ROOT/runtime"
export NODE_PATH="$BUNDLE_ROOT/vendor"
export PATH="$BUNDLE_ROOT/runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$BUNDLE_ROOT/runtime/node/bin/node" "$BUNDLE_ROOT/service/dist/cli/index.cjs" "$@"
`;
}

function platformReadme() {
  return `# ${platformPackageName}

Self-contained Agent Harness Runtime for ${target}. It includes Node.js, Python, Memory MCP, the
Runtime service, CLI, and native dependencies compiled for the bundled Node.js ABI.

Upgrade notes, including the one-time migration of existing API keys to SQLite, are in
[service/README.md](service/README.md). Keep the original Runtime data directory and client identity.

\`\`\`sh
npm install ${platformPackageName}@${packageManifest.version}
npx agent-harness serve
\`\`\`
`;
}

async function moduleAbi(nodeExecutable) {
  const { stdout } = await execFileAsync(nodeExecutable, ['-p', 'process.versions.modules']);
  return stdout.trim();
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
