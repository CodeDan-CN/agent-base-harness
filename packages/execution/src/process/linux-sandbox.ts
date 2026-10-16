import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProcessRunOptions } from './process-runner';

/** Minimal mount view: system libraries, the bundled interpreters, and approved workspaces only. */
export function linuxSandboxCommand(
  options: ProcessRunOptions,
  readOnlyRoots: readonly string[],
): { cmd: string; args: string[] } {
  if (!existsSync('/usr/bin/bwrap'))
    throw new Error('Linux restricted execution requires bubblewrap');
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
  ];
  if (!options.sandbox?.allowNetwork) args.push('--unshare-net');
  args.push('--ro-bind', '/usr', '/usr');
  for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
    if (existsSync(`/${name}`)) args.push('--ro-bind', `/${name}`, `/${name}`);
  }
  for (const name of [
    '/etc/ssl',
    '/etc/ld.so.cache',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/etc/nsswitch.conf',
  ]) {
    if (existsSync(name)) args.push('--ro-bind', name, name);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const root of readOnlyRoots) {
    const canonical = realpathSync(root);
    args.push('--ro-bind', canonical, canonical);
    // Launch commands may use an installation symlink rather than its canonical path.
    if (path.resolve(root) !== canonical) args.push('--ro-bind', canonical, path.resolve(root));
  }
  const writable = options.sandbox?.writableRoots ?? [];
  for (const root of writable) {
    const canonical = realpathSync(root);
    args.push('--bind', canonical, canonical);
  }
  const cwd = realpathSync(options.cwd);
  if (
    !writable.some((root) => inside(realpathSync(root), cwd)) &&
    !readOnlyRoots.some((root) => inside(realpathSync(root), cwd))
  ) {
    args.push('--ro-bind', cwd, cwd);
  }
  // Keep synthetic parent directories read-only too; explicitly bound workspaces remain writable.
  args.push('--remount-ro', '/', '--remount-ro', '/tmp');
  args.push('--chdir', cwd, '--', options.cmd, ...options.args);
  return { cmd: '/usr/bin/bwrap', args };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
