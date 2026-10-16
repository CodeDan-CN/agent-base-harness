import { MemoryAccountStorage } from '../../packages/client-sdk/src/local-auth';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientError } from '../../packages/client-sdk/src/agent-client';
import { ServiceHost } from '../../packages/server-core/src/service-host';
import { servicePaths } from '../../packages/server-core/src/paths';
import {
  LlmAdapterRegistry,
  type LlmAdapter,
  type ModelRequest,
  type ModelResponse,
} from '../../packages/runtime-core/src/model';

const roots: string[] = [];
const hosts: ServiceHost[] = [];
let accountStorage = new MemoryAccountStorage();

afterEach(async () => {
  accountStorage = new MemoryAccountStorage();
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('4.7.0 Gateway integration', () => {
  it('accepts explicit client identity without a server account, rejects malformed IDs, and keeps partitions scoped', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'client-identity-gateway-'));
    roots.push(root);
    const host = new ServiceHost({ dataDir: root, useSystemCredential: false, skipRecovery: true });
    hosts.push(host);
    const { baseUrl } = await host.start();
    const identity = { id: 'external-team-user', loginName: '外部用户', displayName: '测试用户' };
    const first = new AgentClient({ baseUrl, clientKind: 'web', user: identity });
    const boots = await Promise.all(
      Array.from({ length: 5 }, () =>
        first.query<{ defaultAgentId: string; users: { id: string }[] }>('app.bootstrap'),
      ),
    );
    expect(new Set(boots.map((value) => value.defaultAgentId)).size).toBe(1);
    expect(boots[0]!.users.map((user) => user.id)).toEqual([identity.id]);
    const session = await first.command<{ id: string }>('session.create', {
      title: 'Shared external identity',
      agentId: boots[0]!.defaultAgentId,
    });
    const otherClient = new AgentClient({ baseUrl, clientKind: 'cli', user: identity });
    await expect(
      otherClient.query('session.snapshot', { sessionId: session.id }),
    ).resolves.toMatchObject({ session: { id: session.id } });
    otherClient.setUser({ ...identity, id: 'another-user' });
    await expect(
      otherClient.query('session.snapshot', { sessionId: session.id }),
    ).rejects.toBeInstanceOf(AgentClientError);
    for (const value of [
      '',
      '%invalid',
      encodeURIComponent(JSON.stringify({ ...identity, id: '../escape' })),
    ]) {
      const response = await fetch(`${baseUrl}/v1/queries`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-user': value,
          'x-agent-client-kind': 'cli',
        },
        body: JSON.stringify({ apiVersion: 2, method: 'app.bootstrap' }),
      });
      expect(response.status).toBe(value ? 400 : 401);
    }
    const oldToken = await fetch(`${baseUrl}/v1/queries`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer old-server-token-value',
      },
      body: JSON.stringify({ apiVersion: 2, method: 'app.bootstrap' }),
    });
    expect(oldToken.status).toBe(401);
  });

  it('serves the Web client on a wildcard listener while enforcing same-origin requests', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-web-gateway-'));
    roots.push(root);
    const webRoot = path.join(root, 'web');
    mkdirSync(webRoot, { recursive: true });
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Agent Web</title>');
    const host = new ServiceHost({
      dataDir: path.join(root, 'data'),
      host: '0.0.0.0',
      port: 0,
      webRoot,
      allowWebRegistration: true,
      useSystemCredential: false,
      skipRecovery: true,
    });
    hosts.push(host);
    const address = await host.start();

    expect(address.host).toBe('0.0.0.0');
    expect(address.baseUrl).toBe(`http://127.0.0.1:${address.port}`);
    const page = await fetch(`${address.baseUrl}/`, {
      headers: { origin: address.baseUrl },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Agent Web');

    const browserRegistration = await fetch(`${address.baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: address.baseUrl,
        'x-agent-client-kind': 'web',
      },
      body: JSON.stringify({ loginName: 'web_owner', password: 'web-password' }),
    });
    expect(browserRegistration.status).toBe(410);

    const crossOrigin = await fetch(`${address.baseUrl}/healthz`, {
      headers: { origin: 'https://malicious.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('initializes client-provided partitions, scopes operations and streams, and logs out locally', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-gateway-'));
    roots.push(root);
    const host = new ServiceHost({
      dataDir: root,
      port: 0,
      useSystemCredential: false,
      skipRecovery: true,
    });
    hosts.push(host);
    const address = await host.start();
    const paths = servicePaths(root);
    const bootstrap = readFileSync(paths.bootstrapTokenFile, 'utf8').trim();
    const userA = new AgentClient({ accountStorage, baseUrl: address.baseUrl, clientKind: 'cli' });
    const userB = new AgentClient({
      accountStorage,
      baseUrl: address.baseUrl,
      clientKind: 'electron',
    });
    const newUser = new AgentClient({
      accountStorage,
      baseUrl: address.baseUrl,
      clientKind: 'electron',
    });

    await expect(userA.login('user-a', '123456')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    const loggedInA = await userA.register(bootstrap, {
      loginName: 'owner_a',
      password: 'owner-a-password',
    });
    const loggedInB = await userB.register(bootstrap, {
      loginName: 'owner_b',
      password: 'owner-b-password',
    });
    const bootstrapA = await userA.query<{ defaultAgentId: string }>('app.bootstrap');
    const registered = await newUser.register(bootstrap, {
      loginName: 'new_user',
      password: '654321',
    });
    const duplicate = new AgentClient({
      accountStorage,
      baseUrl: address.baseUrl,
      clientKind: 'cli',
    });
    await expect(
      duplicate.register(bootstrap, { loginName: 'NEW_USER', password: 'abcdef' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await userA.me()).user.id).toBe(loggedInA.user.id);
    expect((await userB.me()).user.id).toBe(loggedInB.user.id);
    expect(registered.user).toMatchObject({ loginName: 'new_user', displayName: 'new_user' });
    expect(registered.user.id).toMatch(/^local-/);
    const newUserBootstrap = await newUser.query<{
      activeUser: { id: string };
      users: unknown[];
      defaultAgentId: string;
    }>('app.bootstrap');
    expect(newUserBootstrap).toMatchObject({
      activeUser: { id: registered.user.id },
      users: expect.any(Array),
    });
    const bootstrapView = await userA.query<{ activeUser: { id: string } }>('app.bootstrap', {
      userId: loggedInB.user.id,
    });
    expect(bootstrapView.activeUser.id).toBe(loggedInA.user.id);

    const originResponse = await fetch(`${address.baseUrl}/healthz`, {
      headers: { origin: 'http://malicious.example' },
    });
    expect(originResponse.status).toBe(403);

    const disabledWebRegistration = await fetch(`${address.baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-client-kind': 'web',
      },
      body: JSON.stringify({ loginName: 'public_signup', password: 'public-password' }),
    });
    expect(disabledWebRegistration.status).toBe(410);

    const session = await userA.command<{ id: string }>('session.create', {
      title: 'Gateway',
      agentId: bootstrapA.defaultAgentId,
    });
    await expect(
      userA.command('input.submit', {
        sessionId: session.id,
        content: 'must not run before model setup',
        idempotencyKey: 'missing-model-1',
        startNewEvent: true,
        mode: 'queue',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    await expect(userB.query('session.snapshot', { sessionId: session.id })).rejects.toBeInstanceOf(
      AgentClientError,
    );
    const newUserSession = await newUser.command<{ id: string }>('session.create', {
      title: 'Registered account',
      agentId: newUserBootstrap.defaultAgentId,
    });
    await expect(
      userA.query('session.snapshot', { sessionId: newUserSession.id }),
    ).rejects.toBeInstanceOf(AgentClientError);

    const event = await new Promise<{ eventType: string; payload: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('event timeout')), 3000);
      const unsubscribe = userA.subscribeSession(
        session.id,
        0,
        (item) => {
          clearTimeout(timeout);
          unsubscribe();
          resolve({ eventType: item.eventType, payload: item.payload });
        },
        { onError: reject },
      );
    });
    expect(event).toMatchObject({ eventType: 'session.created', payload: { title: 'Gateway' } });

    await userA.logout();
    await expect(userA.me()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(loggedInA.accessToken).not.toEqual('');
    const database = readFileSync(path.join(root, 'database', 'app.db'));
    const logs = readFileSync(path.join(root, 'logs', 'service.log'), 'utf8');
    expect(database.includes(Buffer.from('owner-a-password'))).toBe(false);
    expect(database.includes(Buffer.from('owner-b-password'))).toBe(false);
    expect(database.includes(Buffer.from('654321'))).toBe(false);
    expect(logs).not.toContain('owner-a-password');
    expect(logs).not.toContain('owner-b-password');
    expect(logs).not.toContain('654321');
    expect(logs).not.toContain(loggedInA.accessToken);
    if (process.platform !== 'win32') {
      expect(statSync(paths.discoveryFile).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves client-owned accounts and runtime partitions across service restarts', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-registered-accounts-'));
    roots.push(root);
    const firstHost = new ServiceHost({
      dataDir: root,
      useSystemCredential: false,
      skipRecovery: true,
    });
    hosts.push(firstHost);
    const firstAddress = await firstHost.start();
    const firstClient = new AgentClient({
      accountStorage,
      baseUrl: firstAddress.baseUrl,
      clientKind: 'cli',
    });
    const bootstrapToken = readFileSync(servicePaths(root).bootstrapTokenFile, 'utf8').trim();
    await firstClient.register(bootstrapToken, {
      loginName: 'persistent_owner',
      password: 'persistent-password',
    });
    const firstBootstrap = await firstClient.query<{ defaultAgentId: string }>('app.bootstrap');
    const session = await firstClient.command<{ id: string }>('session.create', {
      title: 'Preserved session',
      agentId: firstBootstrap.defaultAgentId,
    });
    const registeredClient = new AgentClient({
      accountStorage,
      baseUrl: firstAddress.baseUrl,
      clientKind: 'cli',
    });
    await registeredClient.register(bootstrapToken, {
      loginName: 'second_owner',
      password: 'second-password',
    });
    const registeredBootstrap = await registeredClient.query<{ defaultAgentId: string }>(
      'app.bootstrap',
    );
    const registeredSession = await registeredClient.command<{ id: string }>('session.create', {
      title: 'Registered user session',
      agentId: registeredBootstrap.defaultAgentId,
    });
    await firstHost.stop();

    const secondHost = new ServiceHost({
      dataDir: root,
      useSystemCredential: false,
      skipRecovery: true,
    });
    hosts.push(secondHost);
    const secondAddress = await secondHost.start();
    const secondClient = new AgentClient({
      accountStorage,
      baseUrl: secondAddress.baseUrl,
      clientKind: 'cli',
    });
    await expect(secondClient.login('user-a', '123456')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    await secondClient.login('persistent_owner', 'persistent-password');
    await expect(
      secondClient.query('session.snapshot', { sessionId: session.id }),
    ).resolves.toMatchObject({ session: { id: session.id, title: 'Preserved session' } });
    const persistedClient = new AgentClient({
      accountStorage,
      baseUrl: secondAddress.baseUrl,
      clientKind: 'cli',
    });
    await persistedClient.login('second_owner', 'second-password');
    await expect(
      persistedClient.query('session.snapshot', { sessionId: registeredSession.id }),
    ).resolves.toMatchObject({
      session: { id: registeredSession.id, title: 'Registered user session' },
    });
  });

  it('rejects a second service for the same data directory', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-single-instance-'));
    roots.push(root);
    const first = new ServiceHost({
      dataDir: root,
      useSystemCredential: false,
      skipRecovery: true,
    });
    const second = new ServiceHost({
      dataDir: root,
      useSystemCredential: false,
      skipRecovery: true,
    });
    hosts.push(first);
    await first.start();
    await expect(second.start()).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps an accepted task running after the submitting client disconnects', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stage47-detached-task-'));
    roots.push(root);
    let release!: () => void;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => (modelStarted = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const adapters = new LlmAdapterRegistry();
    const adapter: LlmAdapter = {
      providerType: 'openai-compatible',
      async generate(_request: ModelRequest, _signal: AbortSignal): Promise<ModelResponse> {
        modelStarted();
        await barrier;
        return {
          content: 'detached task completed',
          chunks: ['detached task completed'],
          toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 4 },
          stopReason: 'complete',
        };
      },
    };
    adapters.register(adapter);
    const host = new ServiceHost({
      dataDir: root,
      useSystemCredential: false,
      skipRecovery: true,
      llmAdapters: adapters,
    });
    hosts.push(host);
    const address = await host.start();
    const first = new AgentClient({ accountStorage, baseUrl: address.baseUrl, clientKind: 'cli' });
    const bootstrap = readFileSync(servicePaths(root).bootstrapTokenFile, 'utf8').trim();
    await first.register(bootstrap, {
      loginName: 'detached_owner',
      password: 'detached-password',
    });
    let models = await first.query<{ revision: number }>('model-management.snapshot');
    const service = await first.command<{ id: string }>('model-service.save', {
      name: 'Scripted',
      providerType: 'openai-compatible',
      endpoint: 'https://example.invalid/v1',
      enabled: true,
      config: {},
      credential: { action: 'unchanged' },
      expectedRevision: models.revision,
    });
    models = await first.query('model-management.snapshot');
    const model = await first.command<{ id: string }>('model.save', {
      serviceId: service.id,
      remoteModelId: 'scripted-model',
      displayName: 'Scripted model',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { tools: true, streaming: true, vision: false },
      defaultParams: {},
      enabled: true,
      expectedRevision: models.revision,
    });
    models = await first.query('model-management.snapshot');
    await first.command('model.default.set', {
      modelId: model.id,
      expectedRevision: models.revision,
    });
    const runtimeBootstrap = await first.query<{ defaultAgentId: string }>('app.bootstrap');
    const session = await first.command<{ id: string }>('session.create', {
      title: 'Detached',
      agentId: runtimeBootstrap.defaultAgentId,
    });
    const unsubscribe = first.subscribeSession(session.id, 0, () => undefined);
    await first.command('input.submit', {
      sessionId: session.id,
      content: 'continue after I leave',
      idempotencyKey: 'detached-input-1',
      startNewEvent: true,
      mode: 'queue',
    });
    await started;
    unsubscribe();
    release();

    const later = new AgentClient({
      accountStorage,
      baseUrl: address.baseUrl,
      clientKind: 'electron',
    });
    await later.login('detached_owner', 'detached-password');
    await waitUntil(async () => {
      const snapshot = await later.query<SessionSnapshot>('session.snapshot', {
        sessionId: session.id,
      });
      return snapshot.activeTurnId === null;
    });
    const snapshot = await later.query<SessionSnapshot>('session.snapshot', {
      sessionId: session.id,
    });
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'detached task completed' })]),
    );
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timeout');
}
