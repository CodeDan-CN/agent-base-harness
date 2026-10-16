// Rebuild native dependencies for the plain Node.js ABI used by Vitest.
// macOS may resolve Homebrew Python 3.13 first; node-gyp 9 still needs the
// distutils copy available in the system Python shipped with supported macOS.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env };
if (!env.PYTHON && process.platform === 'darwin' && existsSync('/usr/bin/python3')) {
  env.PYTHON = '/usr/bin/python3';
}

const child = spawn(npmCommand, ['rebuild', 'better-sqlite3'], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
