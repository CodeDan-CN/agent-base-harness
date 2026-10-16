// Compatibility entry: explicitly start a Server that hosts Web.
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const args = [...process.argv.slice(2)];
if (process.env.AGENT_HARNESS_WEB_PORT) args.push('--port', process.env.AGENT_HARNESS_WEB_PORT);
if (process.env.AGENT_HARNESS_WEB_HOST) args.push('--host', process.env.AGENT_HARNESS_WEB_HOST);
const child = spawn(process.execPath, ['dist/server/index.cjs', ...args], { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
