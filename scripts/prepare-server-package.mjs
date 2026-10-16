import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'build-support', 'server-package');
const target = path.join(packageRoot, 'dist');
const releaseRoot = path.join(root, 'release', 'server');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
mkdirSync(releaseRoot, { recursive: true });
for (const name of ['server', 'client', 'web']) {
  cpSync(path.join(root, 'dist', name), path.join(target, name), { recursive: true });
}
cpSync(path.join(root, 'dist', 'admin'), path.join(target, 'cli'), { recursive: true });
chmodSync(path.join(target, 'cli', 'index.cjs'), 0o755);
