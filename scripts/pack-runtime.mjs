import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadRuntimeTarget, repositoryRoot } from '../build-support/runtime-target.mjs';

const args = process.argv.slice(2);
const options = { target: undefined, dryRun: false, force: false };
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--target') {
    options.target = args[++index];
    if (!options.target || options.target.startsWith('-'))
      throw new Error('--target requires a value');
  } else if (args[index] === '--dry-run') options.dryRun = true;
  else if (args[index] === '--force') options.force = true;
  else if (args[index] === '--help') {
    console.log(
      'npm run pack:runtime -- [--target darwin-arm64|linux-x64|linux-arm64] [--dry-run] [--force]\nWithout --target, choose macOS, Linux or Windows interactively. Windows is not implemented yet.\nRun on the matching OS/architecture. Includes Server, Web, Node, Python and Memory MCP; excludes Desktop/APK.',
    );
    process.exit(0);
  } else throw new Error(`Unknown option: ${args[index]}`);
}

if (!options.target) {
  if (!process.stdin.isTTY)
    throw new Error('Non-interactive execution requires --target (use --help).');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      'Runtime + Web 打包\n1. macOS（当前支持 arm64）\n2. Linux（Ubuntu 24.04 x64 已实测；其他目标需验证）\n3. Windows（尚未实现，选择后显示所需工作）',
    );
    const platformAnswer = (await prompt.question('选择系统 [1/2/3]: ')).trim().toLowerCase();
    const platform = {
      1: 'darwin',
      mac: 'darwin',
      macos: 'darwin',
      2: 'linux',
      linux: 'linux',
      3: 'win32',
      windows: 'win32',
    }[platformAnswer];
    if (!platform) throw new Error('请选择 macOS、Linux 或 Windows。');
    if (platform === 'win32') {
      throw new Error(
        'Windows Runtime 尚未实现：需要 Windows Node/Python 归档解压、.cmd 启动器、凭据/进程适配，并在 Windows x64 构建 SQLite 和执行验收。不会生成未验证的 Windows 包。',
      );
    }
    const defaultArch = platform === 'darwin' ? 'arm64' : 'x64';
    const arch =
      (await prompt.question(`选择 CPU 架构 [x64/arm64，默认 ${defaultArch}]: `)).trim() ||
      defaultArch;
    options.target = `${platform}-${arch}`;
  } finally {
    prompt.close();
  }
}

const { target, lock, lockPath } = await loadRuntimeTarget(['--target', options.target], {
  requireHost: !options.dryRun,
});
const steps = [
  [
    'build-support/prepare-runtime-pack.mjs',
    '--target',
    target,
    ...(options.force ? ['--force'] : []),
  ],
  ['build-support/verify-runtime-pack.mjs', '--target', target],
  ['scripts/build.mjs', 'server'],
  ['scripts/build.mjs', 'admin'],
  ['scripts/build.mjs', 'client'],
  ['scripts/check-ui-boundary.mjs'],
  ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.web.config.ts'],
  ['scripts/prepare-server-package.mjs'],
  ['build-support/package-platform-runtime.mjs', '--target', target],
  ['build-support/verify-platform-runtime.mjs', '--target', target],
];
console.log(
  `Target: ${target}\nLock: ${lockPath}\nNode ${lock.node.version}; Python ${lock.python.version}\nIncludes Server + Web + admin CLI + SDK + Node/Python + Memory MCP + native dependencies.`,
);
if (lock.target.platform === 'linux')
  console.log(
    'Linux 受限 Bash 需要 bubblewrap 与适用的 AppArmor 策略；完整部署与验收见 deployment/ubuntu24.04/RUNBOOK.md。',
  );
for (const step of steps) {
  console.log(`> node ${step.join(' ')}`);
  if (options.dryRun) continue;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, step, { cwd: repositoryRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${step[0]} failed (${signal ?? code})`)),
    );
  });
}
