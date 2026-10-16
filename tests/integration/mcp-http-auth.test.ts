import {
  createServer,
  type Server,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AgentClient } from '../../packages/client-sdk/src/agent-client';
import { ServiceHost } from '../../packages/server-core/src/service-host';
import type { McpManagementSnapshot } from '../../packages/protocol/src/contracts/management';

let host: ServiceHost | undefined;
let server: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  await host?.stop();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
  host = undefined;
  server = undefined;
  root = undefined;
  vi.restoreAllMocks();
});
async function gateway() {
  root = mkdtempSync(path.join(os.tmpdir(), 'mcp-http-auth-'));
  host = new ServiceHost({ dataDir: root, useSystemCredential: false, skipRecovery: true });
  const { baseUrl } = await host.start();
  const client = new AgentClient({
    baseUrl,
    clientKind: 'web',
    user: { id: 'mcp-auth-user', loginName: 'tester', displayName: 'Tester' },
  });
  await client.query('app.bootstrap');
  return client;
}
function draft(url: string) {
  return {
    name: 'weekly-report',
    summary: 'Report tools',
    categoryId: 'uncategorized',
    transport: 'streamable-http' as const,
    config: { url, local: true },
    enabled: true,
    credential: { action: 'replace' as const, value: 'fixture-mcp-key' },
  };
}
async function endpoint(auth: 'bearer' | 'x-api-key') {
  const requests: IncomingHttpHeaders[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    requests.push(req.headers);
    const valid =
      auth === 'bearer'
        ? req.headers.authorization === 'Bearer fixture-mcp-key'
        : req.headers['x-api-key'] === 'fixture-mcp-key' && !req.headers.authorization;
    if (!valid) {
      res.writeHead(401).end('rejected fixture-mcp-key');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const rpc = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : {
            tools: [
              {
                name: 'report',
                description: 'Weekly report',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  };
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { url: `http://127.0.0.1:${address.port}/mcp/`, requests };
}

it('sends X-API-Key through the real gateway, persists auth mode without exposing the key, and diagnoses wrong credentials', async () => {
  const fixture = await endpoint('x-api-key');
  const client = await gateway();
  const input = {
    ...draft(fixture.url),
    config: { url: fixture.url, local: true, authType: 'x-api-key' as const },
  };
  await expect(client.command('mcp-server.test', input)).resolves.toMatchObject({
    status: 'success',
    toolCount: 1,
  });
  const before = await client.query<McpManagementSnapshot>('mcp-management.snapshot');
  const saved = await client.command<{ id: string }>('mcp-server.save', {
    ...input,
    expectedRevision: before.revision,
  });
  const snapshot = await client.query<McpManagementSnapshot>('mcp-management.snapshot');
  expect(snapshot.servers.find((s) => s.id === saved.id)?.config.authType).toBe('x-api-key');
  expect(JSON.stringify(snapshot)).not.toContain('fixture-mcp-key');
  await expect(
    client.command('mcp-server.test', {
      ...input,
      id: saved.id,
      credential: { action: 'unchanged' },
    }),
  ).resolves.toMatchObject({ status: 'success' });
  const result = await client.command('mcp-server.test', {
    ...input,
    credential: { action: 'replace', value: 'wrong-fixture-key' },
  });
  expect(result).toMatchObject({ status: 'protocol', errorCode: 'MCP_AUTHENTICATION_FAILED' });
  expect(JSON.stringify(result)).not.toContain('fixture-mcp-key');
  expect(fixture.requests.some((headers) => headers['x-api-key'] === 'fixture-mcp-key')).toBe(true);
});

it('preserves default Bearer authentication for existing configurations', async () => {
  const fixture = await endpoint('bearer');
  const client = await gateway();
  await expect(client.command('mcp-server.test', draft(fixture.url))).resolves.toMatchObject({
    status: 'success',
    toolCount: 1,
  });
  expect(
    fixture.requests.some((headers) => headers.authorization === 'Bearer fixture-mcp-key'),
  ).toBe(true);
});

it('allows LAN without a toggle, ignores the legacy flag, and still blocks loopback and link-local remote addresses', async () => {
  const client = await gateway();
  const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  const input = { ...draft('http://10.3.75.164:8000/mcp/'), credential: { action: 'unchanged' } };
  await expect(
    client.command('mcp-server.test', {
      ...input,
      config: { url: input.config.url, local: false, allowPrivateNetwork: false },
    }),
  ).resolves.toMatchObject({ status: 'success' });
  expect(connect).toHaveBeenCalled();
  for (const address of ['10.3.75.164', '172.16.1.1', '192.168.1.1']) {
    await expect(
      client.command('mcp-server.test', {
        ...input,
        config: { url: `http://${address}:8000/mcp`, local: false },
      }),
    ).resolves.toMatchObject({ status: 'success' });
  }
  connect.mockClear();
  for (const address of ['127.0.0.1', '169.254.169.254', '0.0.0.0']) {
    await expect(
      client.command('mcp-server.test', {
        ...input,
        config: { url: `http://${address}:8000/mcp`, local: false, allowPrivateNetwork: true },
      }),
    ).resolves.toMatchObject({ errorCode: 'MCP_ADDRESS_NOT_ALLOWED' });
  }
  expect(connect).not.toHaveBeenCalled();
});
