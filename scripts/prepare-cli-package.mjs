import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'release', 'cli', 'package');
const source = JSON.parse(readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8'));
mkdirSync(target, { recursive: true });
cpSync(path.join(root, 'dist/cli/index.cjs'), path.join(target, 'index.cjs'));
chmodSync(path.join(target, 'index.cjs'), 0o755);
writeFileSync(
  path.join(target, 'package.json'),
  JSON.stringify(
    {
      name: source.name,
      version: source.version,
      description: 'Remote Agent Harness CLI',
      bin: { 'agent-harness': './index.cjs' },
      files: ['index.cjs'],
      engines: { node: '>=20' },
    },
    null,
    2,
  ) + '\n',
);
