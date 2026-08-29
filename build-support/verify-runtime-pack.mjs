import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = `${process.platform}-${process.arch}`;
const runtimeRoot = path.join(root, '.runtime-cache', target);
const manifest = JSON.parse(
  await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'),
);

if (manifest.target?.platform !== process.platform || manifest.target?.arch !== process.arch) {
  throw new Error(`Runtime Pack target does not match ${target}`);
}

const binDir = path.join(runtimeRoot, manifest.binDir);
const env = {
  PATH: [binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  PYTHONNOUSERSITE: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};
const script = [
  "node -e 'process.stdout.write(`node:${process.version}:${process.arch}\\n`)'",
  'python -c \'import platform,sys; print(f"python:{platform.python_version()}:{platform.machine()}")\'',
  'npm --version | awk \'{print "npm:" $0}\'',
  'pip --version | awk \'{print "pip:" $2}\'',
].join(' && ');
const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', script], {
  cwd: root,
  env,
  timeout: 30_000,
});
if (stderr.trim()) process.stderr.write(stderr);
process.stdout.write(stdout);
if (
  !stdout.includes(`node:v${manifest.node.version}:arm64`) ||
  !stdout.includes(`python:${manifest.python.version}:arm64`)
) {
  throw new Error('Bundled runtime verification output does not match its manifest');
}
const memoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-mcp-verify-'));
const memoryClient = new Client(
  { name: 'runtime-pack-verifier', version: '1.0.0' },
  { capabilities: {} },
);
try {
  await memoryClient.connect(
    new StdioClientTransport({
      command: path.join(runtimeRoot, manifest.node.executable),
      args: [path.join(runtimeRoot, manifest.mcp.memory.entrypoint)],
      cwd: memoryRoot,
      env: {
        ...getDefaultEnvironment(),
        MEMORY_FILE_PATH: path.join(memoryRoot, 'memory.jsonl'),
      },
      stderr: 'pipe',
    }),
  );
  const tools = await memoryClient.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ['create_entities', 'read_graph', 'search_nodes']) {
    if (!names.has(required)) throw new Error(`Bundled Memory MCP is missing ${required}`);
  }
  process.stdout.write(
    `[runtime-pack] verified Memory MCP ${manifest.mcp.memory.version} (${tools.tools.length} tools)\n`,
  );
} finally {
  await memoryClient.close().catch(() => undefined);
  await rm(memoryRoot, { recursive: true, force: true });
}
process.stdout.write(`[runtime-pack] verified ${target}\n`);
