import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const resources = path.resolve(
  process.argv[2] || 'release/mac-arm64/Agent Harness.app/Contents/Resources',
);
const entries = asar.listPackage(path.join(resources, 'app.asar'));
assert.ok(entries.some((entry) => entry.endsWith('/dist/main/index.cjs')));
assert.ok(entries.some((entry) => entry.endsWith('/dist/renderer/index.html')));
assert.ok(
  !entries.some((entry) =>
    /(?:dist\/(?:server|worker|admin|web)|better-sqlite3|runtime-cache|server-memory)/.test(entry),
  ),
);
assert.ok(
  !readdirSync(resources).some((name) => ['service', 'runtimes', 'runtime'].includes(name)),
);
console.log(
  '[desktop-package] Pure client: no Server, SQLite, Node/Python Runtime Pack or MCP payload',
);
