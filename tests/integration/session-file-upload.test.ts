import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient } from '../../packages/client-sdk/src/agent-client';
import { ServiceHost } from '../../packages/server-core/src/service-host';
import { LlmAdapterRegistry, type ModelRequest } from '../../packages/runtime-core/src/model';
import { MAX_SESSION_FILE_BYTES } from '../../packages/protocol/src/contracts/session-file';

const roots: string[] = [];
const hosts: ServiceHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(adapters?: LlmAdapterRegistry) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-upload-'));
  roots.push(root);
  const host = new ServiceHost({
    dataDir: root,
    port: 0,
    allowWebRegistration: true,
    useSystemCredential: false,
    skipRecovery: true,
    llmAdapters: adapters,
  });
  hosts.push(host);
  const { baseUrl } = await host.start();
  const client = new AgentClient({ baseUrl, clientKind: 'web' });
  const auth = await client.registerRemote({ loginName: 'file_owner', password: 'file-password' });
  const { defaultAgentId } = await client.query<{ defaultAgentId: string }>('app.bootstrap');
  const session = await client.command<{ id: string }>('session.create', {
    agentId: defaultAgentId,
    title: 'File upload',
  });
  return { root, baseUrl, client, auth, session };
}

describe('ordinary Session files', () => {
  it('persists opaque uploads, submits only a path, then reads content through a model tool call', async () => {
    const requests: ModelRequest[] = [];
    let uploadedPath = '';
    const adapters = new LlmAdapterRegistry();
    adapters.register({
      providerType: 'openai-compatible',
      async generate(request) {
        requests.push(request);
        return requests.length === 1
          ? {
              content: '',
              toolCalls: [
                { id: 'read-upload', name: 'read', arguments: { file_path: uploadedPath } },
              ],
              usage: { inputTokens: 10, outputTokens: 10 },
              stopReason: 'tool_calls',
            }
          : {
              content: '已读取文件',
              toolCalls: [],
              usage: { inputTokens: 20, outputTokens: 10 },
              stopReason: 'complete',
            };
      },
    });
    const { client, session, root, auth } = await setup(adapters);
    const contents = '正文只应在 read 工具返回后可见：upload-content-unique-7391';
    const first = await client.uploadSessionFile(session.id, new Blob([contents]), '季度 报告.txt');
    uploadedPath = first.path;
    const second = await client.uploadSessionFile(session.id, new Blob(['different']), first.name);
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, 'utf8')).toBe(contents);
    expect(readFileSync(second.path, 'utf8')).toBe('different');
    expect(first.size).toBe(Buffer.byteLength(contents));
    expect(first.path).toContain(path.join('workspaces', auth.user.id, session.id, 'attachments'));
    expect(requests).toHaveLength(0);
    const binary = await client.uploadSessionFile(
      session.id,
      new Blob([new Uint8Array([0, 255, 128])]),
      'opaque.bin',
    );
    expect([...readFileSync(binary.path)]).toEqual([0, 255, 128]);
    const relative = path.relative(
      realpathSync(path.join(root, 'workspaces', auth.user.id, session.id)),
      first.path,
    );
    expect(await (await client.downloadSessionFile(session.id, relative)).text()).toBe(contents);

    let models = await client.query<{ revision: number }>('model-management.snapshot');
    const service = await client.command<{ id: string }>('model-service.save', {
      name: 'Scripted',
      providerType: 'openai-compatible',
      endpoint: 'https://example.invalid/v1',
      enabled: true,
      config: {},
      credential: { action: 'unchanged' },
      expectedRevision: models.revision,
    });
    models = await client.query('model-management.snapshot');
    const model = await client.command<{ id: string }>('model.save', {
      serviceId: service.id,
      remoteModelId: 'scripted-model',
      displayName: 'Scripted',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: models.revision,
    });
    models = await client.query('model-management.snapshot');
    await client.command('model.default.set', {
      modelId: model.id,
      expectedRevision: models.revision,
    });
    const content = `请读取这个文件\n${JSON.stringify(first.path)}`;
    await client.command('input.submit', {
      sessionId: session.id,
      content,
      mode: 'queue',
      startNewEvent: true,
      idempotencyKey: 'upload-input',
    });
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[0]!.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content }),
    );
    expect(JSON.stringify(requests[0])).not.toContain(contents);
    expect(requests[1]!.messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining(contents),
      }),
    );
    const snapshot = await client.query<{ messages: { role: string; content: string }[] }>(
      'session.snapshot',
      { sessionId: session.id },
    );
    expect(snapshot.messages).toContainEqual(expect.objectContaining({ role: 'user', content }));
  });

  it('rejects unauthenticated, foreign-session, oversized and unsafe uploads before writing files', async () => {
    const { baseUrl, client, auth, session, root } = await setup();
    const endpoint = `${baseUrl}/v1/sessions/${session.id}/files`;
    const stranger = new AgentClient({ baseUrl, clientKind: 'web' });
    await expect(
      stranger.uploadSessionFile(session.id, new Blob(['secret']), 'a.txt'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await stranger.registerRemote({ loginName: 'file_stranger', password: 'stranger-password' });
    await expect(
      stranger.uploadSessionFile(session.id, new Blob(['secret']), 'a.txt'),
    ).rejects.toBeDefined();
    for (const name of ['../escape.txt', '..', 'a/b.txt', 'a\\b.txt', 'bad\nname', '%E0%A4%A']) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-agent-user': encodeURIComponent(JSON.stringify(auth.user)), 'x-agent-client-kind': 'cli',
          'x-agent-file-name': name === '%E0%A4%A' ? name : encodeURIComponent(name),
        },
        body: 'bytes',
      });
      expect(response.status).toBe(400);
    }
    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-agent-user': encodeURIComponent(JSON.stringify(auth.user)), 'x-agent-client-kind': 'cli', 'x-agent-file-name': 'large.bin' },
      body: new Blob([new Uint8Array(MAX_SESSION_FILE_BYTES + 1)]),
    });
    expect(oversized.status).toBe(400);
    const workspace = path.join(root, 'workspaces', auth.user.id, session.id);
    const outside = path.join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(workspace, 'attachments'));
    await expect(
      client.uploadSessionFile(session.id, new Blob(['escape']), 'a.txt'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(readdirSync(outside)).toEqual([]);
  });
});
