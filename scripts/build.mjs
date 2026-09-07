// Builds the Main / Preload / Worker entry bundles with esbuild.
// Kept separate from the Renderer (Vite) build so Node-only bindings
// (better-sqlite3, electron, worker_threads) never enter the Renderer graph.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const targets = {
  main: {
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.cjs'),
    platform: 'node',
    external: ['electron', 'better-sqlite3'],
  },
  preload: {
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.cjs'),
    platform: 'node',
    external: ['electron'],
  },
  worker: {
    entryPoints: [path.join(root, 'src/worker/index.ts')],
    outfile: path.join(root, 'dist/worker/index.cjs'),
    platform: 'node',
    external: ['better-sqlite3'],
  },
  server: {
    entryPoints: [path.join(root, 'src/server/entry.ts')],
    outfile: path.join(root, 'dist/server/index.cjs'),
    platform: 'node',
    external: ['better-sqlite3'],
  },
  cli: {
    entryPoints: [path.join(root, 'src/cli/index.ts')],
    outfile: path.join(root, 'dist/cli/index.cjs'),
    platform: 'node',
    external: ['better-sqlite3'],
    banner: { js: '#!/usr/bin/env node' },
  },
  client: {
    entryPoints: [path.join(root, 'src/client/index.ts')],
    outfile: path.join(root, 'dist/client/index.cjs'),
    platform: 'node',
  },
};

const name = process.argv[2];
if (!name || !targets[name]) {
  console.error(`usage: node scripts/build.mjs <${Object.keys(targets).join('|')}>`);
  process.exit(1);
}

const wasWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const opts = {
  ...targets[name],
  bundle: true,
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

if (wasWatch) {
  const ctx = await build({ ...opts });
  await ctx.watch();
  console.log(`[build] watching ${name}...`);
} else {
  await build(opts);
  console.log(`[build] ${name} -> ${path.relative(root, opts.outfile)}`);
}
