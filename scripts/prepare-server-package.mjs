import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'packages', 'server');
const target = path.join(packageRoot, 'dist');
const releaseRoot = path.join(root, 'release', 'server');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
mkdirSync(releaseRoot, { recursive: true });
for (const name of ['server', 'client', 'cli']) {
  cpSync(path.join(root, 'dist', name), path.join(target, name), { recursive: true });
}
chmodSync(path.join(target, 'cli', 'index.cjs'), 0o755);
