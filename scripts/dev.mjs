// Source development: the launcher owns only the children it creates.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'all';
if (!['all', 'server', 'desktop'].includes(mode)) throw new Error('Expected all|server|desktop');
const serverUrl = process.env.AGENT_HARNESS_SERVER_URL || 'http://127.0.0.1:4317';
const dataDir = process.env.AGENT_HARNESS_DATA_DIR?.trim();
const cachedRuntimeRoot = path.join(root, '.runtime-cache', `${process.platform}-${process.arch}`);
const runtimeRoot =
  process.env.AGENT_HARNESS_RUNTIME_ROOT?.trim() ||
  (existsSync(path.join(cachedRuntimeRoot, 'runtime-manifest.json')) ? cachedRuntimeRoot : null);
const children = new Set();
const viteServers = [];
let stopping = false;
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  children.add(child);
  child.once('error', (error) => {
    console.error(error);
    void shutdown(1);
  });
  child.once('exit', (code) => {
    children.delete(child);
    if (!stopping) void shutdown(code ?? 1);
  });
  return child;
}
function build(target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build.mjs', target], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Build failed: ' + target)),
    );
  });
}
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(viteServers.map((server) => server.close()));
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  process.exit(code);
}
async function vite(configFile, port) {
  const server = await createServer({
    configFile: path.join(root, configFile),
    clearScreen: false,
    server: { port, strictPort: true },
  });
  viteServers.push(server);
  await server.listen();
  server.printUrls();
}
async function main() {
  if (mode !== 'desktop') {
    await build('server');
    const url = new URL(serverUrl);
    const host = process.env.AGENT_HARNESS_DEV_HOST || '127.0.0.1';
    launch(process.execPath, [
      'dist/server/index.cjs',
      ...(dataDir ? ['--data-dir', dataDir] : []),
      '--host',
      host,
      '--port',
      url.port || '4317',
      ...(runtimeRoot ? ['--runtime-root', runtimeRoot] : []),
      '--allow-web-registration',
      '--debug',
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (
          await globalThis.fetch(serverUrl + '/healthz', {
            signal: globalThis.AbortSignal.timeout(500),
          })
        ).ok;
      } catch {
        /* Await startup. */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Development Runtime did not become ready');
    console.log('[dev] Runtime: ' + serverUrl);
  }
  if (mode === 'all')
    await vite('vite.web.config.ts', Number(process.env.AGENT_WEB_DEV_PORT || 5174));
  if (mode !== 'server') {
    await build('main');
    await build('preload');
    const port = Number(process.env.AGENT_CLIENT_DEV_PORT || 5173);
    await vite('vite.config.ts', port);
    const { default: electronPath } = await import('electron');
    launch(electronPath, ['.'], {
      env: {
        ...process.env,
        AGENT_HARNESS_SERVER_URL: serverUrl,
        AGENT_CLIENT_DEV_SERVER_URL: 'http://localhost:' + port,
      },
    });
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));
void main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
