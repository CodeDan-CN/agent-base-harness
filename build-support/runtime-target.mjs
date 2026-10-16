import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const supportedTargets = ['darwin-arm64', 'linux-x64', 'linux-arm64'];

export function parseRuntimeArguments(args = process.argv.slice(2)) {
  const result = {
    target: process.env.AGENT_HARNESS_BUILD_TARGET,
    force: false,
    artifact: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target') {
      result.target = args[++index];
      if (!result.target || result.target.startsWith('-'))
        throw new Error('--target requires a value');
    } else if (argument === '--force') result.force = true;
    else if (!argument.startsWith('-') && !result.artifact) result.artifact = argument;
    else throw new Error(`Unknown runtime argument: ${argument}`);
  }
  result.target ??= `${process.platform}-${process.arch}`;
  return result;
}

export async function loadRuntimeTarget(args = process.argv.slice(2), options = {}) {
  const parsed = parseRuntimeArguments(args);
  if (!supportedTargets.includes(parsed.target)) {
    throw new Error(
      `Runtime target ${parsed.target} is not implemented. Supported: ${supportedTargets.join(', ')}. Windows requires its own launcher, archives and native validation.`,
    );
  }
  const lockPath =
    parsed.target === 'darwin-arm64'
      ? path.join(repositoryRoot, 'resources/runtime-lock.json')
      : path.join(repositoryRoot, 'resources/runtime-locks', `${parsed.target}.json`);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (
    lock.schemaVersion !== 1 ||
    `${lock.target?.platform}-${lock.target?.arch}` !== parsed.target
  ) {
    throw new Error(`Lock does not match target ${parsed.target}`);
  }
  if (options.requireHost !== false && `${process.platform}-${process.arch}` !== parsed.target) {
    throw new Error(
      `Build/verify ${parsed.target} on a matching host; current host is ${process.platform}-${process.arch}. Run the same command on the target build machine.`,
    );
  }
  return { ...parsed, lock, lockPath };
}

export function matchesBinaryTarget(description, target) {
  const format = target.platform === 'linux' ? /ELF 64-bit/ : /Mach-O 64-bit/;
  const architecture =
    target.arch === 'arm64' ? /\b(?:arm64|aarch64)\b/i : /\b(?:x86-64|x86_64)\b/i;
  return format.test(description) && architecture.test(description);
}

export function pythonMachineNames(arch) {
  return arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'AMD64'];
}
