import { describe, expect, it } from 'vitest';
import {
  McpInstanceCapacityError,
  McpInstanceManager,
  type McpInstanceKey,
} from '../../packages/runtime-core/src/mcp/mcp-instance-manager';
import { deferred } from '../../packages/test-kit/src/runtime';

class FakeClient {
  closed = 0;

  async close(): Promise<void> {
    this.closed += 1;
  }
}

describe('McpInstanceManager', () => {
  it('single-flights the same scoped instance and reference-counts leases', async () => {
    const manager = new McpInstanceManager<FakeClient>({ idleMs: 60_000 });
    const opening = deferred<FakeClient>();
    let opens = 0;
    const key = agentKey('dylan');
    const acquire = () =>
      manager.acquire({
        key,
        open: () => {
          opens += 1;
          return opening.promise;
        },
      });
    const first = acquire();
    const second = acquire();
    opening.resolve(new FakeClient());
    const [left, right] = await Promise.all([first, second]);

    expect(opens).toBe(1);
    expect(manager.snapshot('user-a')[0]).toMatchObject({
      key,
      status: 'connected',
      activeCalls: 2,
    });
    left.release();
    right.release();
    await manager.close();
  });

  it('shares user scope but isolates agent scope', async () => {
    const manager = new McpInstanceManager<FakeClient>({ idleMs: 60_000 });
    let opens = 0;
    const open = async () => {
      opens += 1;
      return new FakeClient();
    };
    const sharedA = await manager.acquire({ key: userKey(), open });
    const sharedB = await manager.acquire({ key: userKey(), open });
    const dylan = await manager.acquire({ key: agentKey('dylan'), open });
    const finance = await manager.acquire({ key: agentKey('finance'), open });

    expect(opens).toBe(3);
    expect(manager.snapshot('user-a')).toHaveLength(3);
    sharedA.release();
    sharedB.release();
    dylan.release();
    finance.release();
    await manager.close();
  });

  it('does not evict busy instances when capacity is exhausted', async () => {
    const manager = new McpInstanceManager<FakeClient>({
      maxPerUser: 1,
      maxHost: 1,
      capacityWaitMs: 1,
    });
    const busy = await manager.acquire({ key: agentKey('dylan'), open: async () => new FakeClient() });

    await expect(
      manager.acquire({ key: agentKey('finance'), open: async () => new FakeClient() }),
    ).rejects.toBeInstanceOf(McpInstanceCapacityError);

    busy.release();
    const finance = await manager.acquire({
      key: agentKey('finance'),
      open: async () => new FakeClient(),
    });
    expect(manager.snapshot('user-a').some((view) => view.key.scopeId === 'finance')).toBe(true);
    finance.release();
    await manager.close();
  });

  it('waits for a busy lease to release and supports cancellation', async () => {
    const manager = new McpInstanceManager<FakeClient>({
      maxPerUser: 1,
      maxHost: 1,
      capacityWaitMs: 1_000,
    });
    const busy = await manager.acquire({ key: agentKey('dylan'), open: async () => new FakeClient() });
    const waiting = manager.acquire({
      key: agentKey('finance'),
      open: async () => new FakeClient(),
    });
    await Promise.resolve();
    busy.release();
    const finance = await waiting;
    finance.release();

    const busyAgain = await manager.acquire({
      key: agentKey('dylan'),
      open: async () => new FakeClient(),
    });
    const controller = new AbortController();
    const cancelled = manager.acquire({
      key: agentKey('finance'),
      open: async () => new FakeClient(),
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    busyAgain.release();
    await manager.close();
  });
});

function userKey(): McpInstanceKey {
  return { userId: 'user-a', serverId: 'builtin-memory', scopeType: 'user', scopeId: 'user-a' };
}

function agentKey(agentId: string): McpInstanceKey {
  return { userId: 'user-a', serverId: 'builtin-memory', scopeType: 'agent', scopeId: agentId };
}
