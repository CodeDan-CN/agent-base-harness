import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('4.7.0 Electron boundary', () => {
  it('uses the shared client without owning Runtime, Worker, or SQLite', () => {
    const source = readFileSync(path.resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(source).toContain('packages/client-sdk/src/agent-client');
    expect(source).not.toContain('LocalConnector');
    expect(source).not.toContain("from 'node:worker_threads'");
    expect(source).not.toContain('RuntimeWorkerSupervisor');
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('openDatabase');
  });

  it('connects to a configured server without launching a Runtime', () => {
    const source = readFileSync(path.resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(source).toContain('AGENT_HARNESS_SERVER_URL');
    expect(source).toContain('connection.set');
    expect(source).not.toContain('connectOrStart');
    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('runtime-cache');
  });

  it('keeps bootstrap and access tokens outside Renderer contracts', () => {
    const preload = readFileSync(path.resolve('apps/desktop/src/preload/index.ts'), 'utf8');
    const main = readFileSync(path.resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(preload).not.toContain('x-agent-bootstrap');
    expect(preload).not.toContain('accessToken');
    expect(main).toContain('result.expiresAt, user: result.user');
  });

  it('keeps parent and embedded delegated session subscriptions independent', () => {
    const preload = readFileSync(path.resolve('apps/desktop/src/preload/index.ts'), 'utf8');
    const main = readFileSync(path.resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(preload).toContain('const subscriptionId = crypto.randomUUID()');
    expect(preload).toContain("{ kind: 'session', subscriptionId }");
    expect(main).toContain('`${senderId}\\u0000${subscriptionId}`');
    expect(main).toContain('sessionUnsubscribers.set(subscriptionKey, unsubscribe)');
  });
});
