import { describe, expect, it } from 'vitest';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { MacKeychainCredentialStore } from '../../packages/execution/src/credential/mac-keychain-store';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';

describe('M10 Credential Store', () => {
  it('S1-M10-001 写入后同 Scope 可读回原值', async () => {
    const store = new FakeCredentialStore();
    const scope = { userId: 'user-a', purpose: 'model-service', entityId: 'srv-1' };
    await store.set(scope, 'sk-sentinel-12345');
    const value = await store.get(scope);
    expect(value).toBe('sk-sentinel-12345');
  });

  it('S1-M10-002 跨用户读取拒绝且不 fallback', async () => {
    const store = new FakeCredentialStore();
    await store.set({ userId: 'user-a', purpose: 'model-service', entityId: 'srv-1' }, 'sk-secret');
    const fromB = await store.get({
      userId: 'user-b',
      purpose: 'model-service',
      entityId: 'srv-1',
    });
    expect(fromB).toBeNull();
  });

  it('S1-M10-005 status 只返回状态不返回 value', async () => {
    const store = new FakeCredentialStore();
    const scope = { userId: 'user-a', purpose: 'p', entityId: 'e' };
    expect(await store.status(scope)).toBe('missing');
    await store.set(scope, 'secret-value');
    expect(await store.status(scope)).toBe('configured');
    expect(await store.get(scope)).toBe('secret-value');
  });

  it('S1-M10-006 删除后读取明确失败', async () => {
    const store = new FakeCredentialStore();
    const scope = { userId: 'user-a', purpose: 'p', entityId: 'e' };
    await store.set(scope, 'secret');
    await store.delete(scope);
    expect(await store.status(scope)).toBe('missing');
    expect(await store.get(scope)).toBeNull();
  });

  it('S1-M10-007 Store 不可用时状态为 error', async () => {
    const store = new FakeCredentialStore();
    store.setUnavailable(true);
    await expect(store.get({ userId: 'user-a', purpose: 'p', entityId: 'e' })).rejects.toThrow();
  });

  it('S1-M10 通过 security CLI 存储到命名空间', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const store = new MacKeychainCredentialStore({
      service: 'test-service',
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
    });
    await store.set({ userId: 'user-a', purpose: 'model-service', entityId: 'srv-1' }, 'sk-secret');
    expect(calls[0]?.file).toBe('/usr/bin/security');
    expect(calls[0]?.args).toContain('add-generic-password');
    expect(calls[0]?.args).toContain('agent-client-harness:user-a:model-service:srv-1');
  });

  it('S1-M10-004 日志不包含明文 secret（Redactor）', () => {
    const logger = new MemoryLogger();
    const secret = 'sk-topsecret-value';
    logger.registerSecret(secret);
    logger.error('credential write failed', { value: secret });
    logger.error('credential write failed', { authorization: `Bearer ${secret}` });

    expect(logger.contains(secret)).toBe(false);
    expect(logger.entries.every((e) => !(e._redacted as string).includes('topsecret'))).toBe(true);
  });
});
