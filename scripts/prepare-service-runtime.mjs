import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.service-cache', 'node_modules');
const packages = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

rmSync(path.dirname(target), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of packages) {
  const source = path.join(root, 'node_modules', name);
  if (!existsSync(source)) throw new Error(`Missing service runtime dependency: ${name}`);
  cpSync(source, path.join(target, name), { recursive: true });
}
