import { describe, expect, it, vi } from 'vitest';
import { hash } from 'bcryptjs';
import { AgentClient } from '../../packages/client-sdk/src/agent-client';
import {
  ClientLocalAuth,
  MemoryAccountStorage,
  normalizeLoginName,
} from '../../packages/client-sdk/src/local-auth';

describe('client-owned local accounts', () => {
  it('logs the built-in account into the legacy partition without HTTP and rejects wrong passwords', async () => {
    const storage = new MemoryAccountStorage();
    const transport = vi.fn();
    const client = new AgentClient({
      baseUrl: 'http://unused',
      clientKind: 'web',
      accountStorage: storage,
      fetch: transport,
    });
    await expect(client.login('user-a', 'wrong-password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect((await client.login('user-a', 'user-a123')).user.id).toBe('user-a');
    expect(storage.getItem('account:user-a')).not.toContain('user-a123');
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves an existing user-a account and password when initializing a client', async () => {
    const storage = new MemoryAccountStorage();
    storage.setItem(
      'account:user-a',
      JSON.stringify({
        user: { id: 'existing-id', loginName: 'user-a', displayName: 'Existing account' },
        digest: await hash('existing-secret', 4),
      }),
    );
    const before = storage.getItem('account:user-a');
    const second = new ClientLocalAuth(storage, 'electron');
    expect(storage.getItem('account:user-a')).toBe(before);
    expect((await second.login('user-a', 'existing-secret')).user.id).toBe('existing-id');
    await expect(second.login('user-a', 'user-a123')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('normalizes names, stores a salted digest, and verifies passwords without HTTP', async () => {
    const storage = new MemoryAccountStorage();
    const transport = vi.fn();
    const client = new AgentClient({
      baseUrl: 'http://unused',
      clientKind: 'web',
      accountStorage: storage,
      fetch: transport,
    });
    const auth = await client.registerRemote({ loginName: 'Owner', password: 'test-secret' });
    expect(normalizeLoginName(' Ｏｗｎｅｒ ')).toBe('owner');
    expect(storage.getItem('account:owner')).not.toContain('test-secret');
    await client.logout();
    await expect(client.login('owner', 'bad-password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect((await client.login('OWNER', 'test-secret')).user.id).toBe(auth.user.id);
    expect(transport).not.toHaveBeenCalled();
    await expect(
      client.registerRemote({ loginName: 'owner', password: 'another-secret' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('generates distinct account IDs and retains them across sessions and client restarts', async () => {
    const storage = new MemoryAccountStorage();
    const first = new ClientLocalAuth(storage, 'cli');
    const auth = await first.register({
      loginName: 'owner',
      password: 'local-secret',
    });
    expect(auth.user.id).toMatch(/^local-[0-9a-f]{32}$/);
    const second = new ClientLocalAuth(storage, 'cli');
    expect(second.current(auth.accessToken).user.id).toBe(auth.user.id);
    expect((await second.login('owner', 'local-secret')).user.id).toBe(auth.user.id);
    const anotherAccount = await second.register({
      loginName: 'another-owner',
      password: 'another-secret',
    });
    expect(anotherAccount.user.id).not.toBe(auth.user.id);
    const otherDevice = new ClientLocalAuth(new MemoryAccountStorage(), 'web');
    await expect(otherDevice.login('owner', 'local-secret')).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(
      (
        await otherDevice.register({
          loginName: 'owner',
          password: 'device-secret',
        })
      ).user.id,
    ).not.toBe(auth.user.id);
    first.logout(auth.accessToken);
    expect(() => second.current(auth.accessToken)).toThrow();
  });

  it.each(['local-existing-user', '../escape', ''])(
    'rejects an explicit registration ID %j without creating an account',
    async (userId) => {
      const storage = new MemoryAccountStorage();
      const auth = new ClientLocalAuth(storage, 'web');
      const input = { loginName: 'owner', password: 'local-secret', userId };
      await expect(auth.register(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(storage.getItem('account:owner')).toBeNull();
    },
  );

  it('rejects oversized UTF-8 passwords and expired sessions', async () => {
    const storage = new MemoryAccountStorage();
    const auth = new ClientLocalAuth(storage, 'web');
    await expect(
      auth.register({ loginName: 'owner', password: '密'.repeat(25) }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(() => auth.current('old-server-token')).toThrow();
    const result = await auth.register({ loginName: 'owner', password: 'abcdef' });
    const session = JSON.parse(storage.getItem(`session:${result.accessToken}`)!);
    storage.setItem(
      `session:${result.accessToken}`,
      JSON.stringify({ ...session, expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(() => auth.current(result.accessToken)).toThrow();
  });

  it('sends only client identity, never local tokens or passwords', async () => {
    const transport = vi.fn(
      async (_input: unknown, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    const client = new AgentClient({
      baseUrl: 'http://unused',
      clientKind: 'web',
      fetch: transport,
    });
    const auth = await client.registerRemote({ loginName: 'owner', password: 'local-secret' });
    await client.query('app.bootstrap');
    const init = transport.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(decodeURIComponent(headers['x-agent-user']!))).toEqual(auth.user);
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain(auth.accessToken);
    expect(JSON.stringify(init)).not.toContain('local-secret');
    await client.logout();
    await expect(client.me()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
});
