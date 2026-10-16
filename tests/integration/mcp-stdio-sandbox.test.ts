import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundledRuntime } from '../../packages/execution/src/runtime/bundled-runtime-registry';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { ToolRegistry, type ToolExecutionContext } from '../../packages/runtime-core/src/tools';
import { createCapabilitySearchTool } from '../../packages/runtime-core/src/capability-discovery';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { SequenceIdProvider } from '../../packages/test-kit/src/runtime';

const runtimeRoot =
  process.env.AGENT_TEST_RUNTIME_ROOT ??
  path.resolve(`.runtime-cache/${process.platform}-${process.arch}`);
const supported = ['linux', 'darwin'].includes(process.platform);
const runtimeAvailable =
  Boolean(process.env.AGENT_TEST_RUNTIME_ROOT) ||
  existsSync(path.join(runtimeRoot, 'runtime-manifest.json'));
const roots: string[] = [];
const apps: WorkerApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.mcp.close();
    app.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.runIf(supported && runtimeAvailable)('real Runtime MCP stdio sandbox', () => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-real-'));
    roots.push(root);
    const runtime = loadBundledRuntime(runtimeRoot, { required: true })!;
    const tools = new ToolRegistry();
    const app = createWorkerApplication({
      appDataDir: root,
      runtime,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: new LlmAdapterRegistry(),
      tools,
    });
    apps.push(app);
    return { root, runtime, tools, app };
  }

  it('connects builtin-memory, persists writes across reconnect, and isolates users and agent/user scope', async () => {
    const { app, tools } = await setup();
    for (const userId of ['user-a', 'user-b']) {
      app.repos.agents.ensureDylan(userId, 'guarded', new Date().toISOString());
      app.runtime.createSession(userId, { sessionId: `session-${userId}`, title: 'MCP isolation' });
      const server = app.repos.mcp.getServer(userId, 'builtin-memory')!;
      expect((await app.mcp.testServer(server)).tools.map((tool) => tool.rawName)).toContain(
        'create_entities',
      );
      await app.mcp.refreshServer(userId, server.id);
      for (const rawName of ['create_entities', 'read_graph']) {
        app.repos.mcp.setToolEnabled(userId, server.id, rawName, true, new Date().toISOString());
      }
      for (const scope of ['user', 'agent'] as const) {
        app.repos.agents.ensureMcpBinding(
          userId,
          'dylan',
          server.id,
          scope,
          new Date().toISOString(),
        );
      }
      app.mcp.rebuildUserTools(userId);
    }
    async function call(userId: string, scope: 'user' | 'agent', name: string, args: unknown = {}) {
      const context: ToolExecutionContext = {
        userId,
        agentId: 'dylan',
        sessionOrigin: 'direct',
        sessionId: `session-${userId}`,
        eventId: 'event',
        turnId: `${userId}-${scope}`,
        stepId: 'step',
        toolCallId: 'call',
        permissionPreset: 'guarded',
        signal: new AbortController().signal,
      };
      const discovered = await createCapabilitySearchTool(app.repos).execute({}, context);
      const memoryCandidates = discovered.candidates.filter(
        (candidate) => candidate.kind === 'mcp',
      );
      expect(memoryCandidates.map((candidate) => candidate.name).sort()).toEqual(
        ['本智能体记忆', '用户共享记忆'].sort(),
      );
      expect(memoryCandidates.every((candidate) => !('capabilityId' in candidate))).toBe(true);
      const candidate = memoryCandidates.find((entry) => entry.scope === scope)!;
      const loaded = await tools
        .get('mcp_load', userId)!
        .execute({ name: candidate.name }, context);
      expect(loaded).toMatchObject({ name: candidate.name });
      expect(loaded).not.toHaveProperty('capabilityId');
      return tools
        .get(`mcp__memory_${scope}__${name}`, userId, context.sessionId, context.turnId)!
        .execute(args, context);
    }
    await call('user-a', 'agent', 'create_entities', {
      entities: [
        { name: 'PrivateMemorySentinel', entityType: 'test', observations: ['survives reconnect'] },
      ],
    });
    expect(JSON.stringify(await call('user-a', 'agent', 'read_graph'))).toContain(
      'PrivateMemorySentinel',
    );
    expect(JSON.stringify(await call('user-a', 'user', 'read_graph'))).not.toContain(
      'PrivateMemorySentinel',
    );
    expect(JSON.stringify(await call('user-b', 'agent', 'read_graph'))).not.toContain(
      'PrivateMemorySentinel',
    );
    await app.mcp.reloadServer('user-a', 'builtin-memory');
    expect(JSON.stringify(await call('user-a', 'agent', 'read_graph'))).toContain(
      'PrivateMemorySentinel',
    );
  }, 30_000);

  it('connects a custom stdio server while blocking outside writes and Linux private-file reads', async () => {
    const { app, root, runtime } = await setup();
    const secret = path.join(root, 'credentials', 'probe-secret');
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, 'private');
    const outside = path.join(root, 'outside-write');
    const script = `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      fs.writeFileSync('inside', 'ok');
      fs.writeFileSync(process.env.TMPDIR + '/temporary', 'ok');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'bad'));
      assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(runtime.rootDir, 'forbidden-write'))}, 'bad'));
      if (process.platform === 'linux') assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));
      process.stderr.write('x'.repeat(128 * 1024));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        const result = request.method === 'initialize'
          ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sandbox-probe', version: '1' } }
          : { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] };
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result}) + '\\n');
      });`;
    const result = await app.testMcpServer('user-a', {
      id: 'custom',
      name: 'custom',
      summary: '',
      categoryId: 'uncategorized',
      transport: 'stdio',
      enabled: true,
      credential: { action: 'unchanged' },
      config: { command: 'runtime://node', args: ['-e', script], cwd: 'work', env: {} },
    });
    expect(result).toMatchObject({ status: 'success', toolCount: 1 });
    expect(
      await readFile(path.join(root, 'mcp/users/user-a/user/custom/work/inside'), 'utf8'),
    ).toBe('ok');
    expect(existsSync(outside)).toBe(false);
  }, 15_000);

  it('rejects a cwd symlink that escapes the instance directory', async () => {
    const { app, root } = await setup();
    const base = path.join(root, 'mcp/users/user-a/user/escape');
    await mkdir(base, { recursive: true });
    await symlink(root, path.join(base, 'escape'));
    expect(
      await app.testMcpServer('user-a', {
        id: 'escape',
        name: 'escape',
        summary: '',
        categoryId: 'uncategorized',
        transport: 'stdio',
        enabled: true,
        credential: { action: 'unchanged' },
        config: {
          command: 'runtime://node',
          args: ['-e', 'process.exit(0)'],
          cwd: 'escape',
          env: {},
        },
      }),
    ).toMatchObject({ status: 'protocol', errorCode: 'MCP_STDIO_PATH_INVALID' });
  });
});
