import { describe, expect, it } from 'vitest';
import { BridgeController } from '../../packages/server-core/src/legacy/bridge-controller';
import type { RequestDispatcher } from '../../packages/server-core/src/legacy/bridge-controller';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import type { LifecycleEvent } from '../../packages/protocol/src/contracts/ipc';
import { API_VERSION, MAX_REQUEST_BYTES } from '../../packages/protocol/src/contracts/schemas';

const user = {
  id: 'user-a',
  displayName: 'User A',
  avatarKey: null,
  sortOrder: 0,
  status: 'active',
  createdAt: 't',
  updatedAt: 't',
};

const VALID_BOOTSTRAP = {
  activeUser: user,
  users: [user],
  runtime: { status: 'ready', generation: 1 },
  schemaVersion: 1,
  revisions: {
    userId: 'user-a',
    modelRevision: 0,
    skillRevision: 0,
    runtimeRevision: 0,
    mcpRevision: 0,
    agentRevision: 0,
    updatedAt: 't',
  },
  defaultAgentId: 'dylan',
  capabilities: {
    model: 'foundation',
    skill: 'foundation',
    runtime: 'ready',
    agentProfiles: 'ready',
    agentDelegation: 'ready',
    scopedMcpInstances: 'ready',
  },
};

const VALID_HEALTH = {
  worker: { status: 'ready', generation: 1 },
  database: { status: 'ok', schemaVersion: 1 },
  credential: { status: 'configured' },
  skillRoot: { status: 'ok', invalidCount: 0 },
  interpreters: {
    node: { status: 'available', version: '20.0.0' },
    python: { status: 'missing', version: null },
    shell: { status: 'available', version: 'zsh 5.9' },
  },
};

function q(method: string, params?: unknown): unknown {
  return { apiVersion: API_VERSION, method, params };
}

function c(method: string, params?: unknown): unknown {
  return { apiVersion: API_VERSION, method, params };
}

function makeController(result: unknown, opts: { generateRequestId?: () => string } = {}) {
  const calls: Array<{
    requestId: string;
    userId: string;
    windowId: string;
    method: string;
    params?: unknown;
  }> = [];
  const dispatcher: RequestDispatcher = {
    retry: async () => undefined,
    request: async (input) => {
      calls.push(input);
      return result;
    },
  };
  const lifecycle: LifecycleEvent[] = [];
  const controller = new BridgeController({
    dispatcher,
    logger: new MemoryLogger(),
    isAuthorizedSender: (id) => id === 'authorized-window',
    sendLifecycle: (event) => lifecycle.push(event),
    generateRequestId: opts.generateRequestId,
  });
  return { controller, calls, lifecycle };
}

describe('M04 Bridge Controller 契约', () => {
  it('S1-M04-003 非法 sender 返回 UNAUTHORIZED_SENDER', async () => {
    const { controller, calls } = makeController(VALID_BOOTSTRAP);
    await expect(controller.handleQuery('evil-window', q('app.bootstrap'))).rejects.toMatchObject({
      code: 'UNAUTHORIZED_SENDER',
    });
    expect(calls).toHaveLength(0);
  });

  it('S1-M04-004 malformed payload 被 Schema 拒绝', async () => {
    const { controller } = makeController(VALID_BOOTSTRAP);
    await expect(controller.handleQuery('authorized-window', {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      controller.handleQuery('authorized-window', q('not.a.method')),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('S1-M04-014 不支持 apiVersion 明确拒绝', async () => {
    const { controller } = makeController(VALID_BOOTSTRAP);
    await expect(
      controller.handleQuery('authorized-window', { apiVersion: 999, method: 'app.bootstrap' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('strict Schema 拒绝额外危险字段', async () => {
    const { controller } = makeController(VALID_BOOTSTRAP);
    await expect(
      controller.handleQuery('authorized-window', {
        apiVersion: API_VERSION,
        method: 'app.bootstrap',
        cmd: 'rm -rf',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      controller.handleCommand('authorized-window', {
        apiVersion: API_VERSION,
        method: 'user.switch',
        params: { userId: 'user-b', admin: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('S1-M04-005 app.bootstrap 伪造 userId 被忽略，scope 来自 Main', async () => {
    const { controller, calls } = makeController(VALID_BOOTSTRAP);
    controller.syncActiveUser('user-a');
    await controller.handleQuery('authorized-window', q('app.bootstrap', { userId: 'user-b' }));
    expect(calls[0]?.userId).toBe('user-a');
  });

  it('S1-M04-006 user.switch 合法特例', async () => {
    const { controller, calls, lifecycle } = makeController(VALID_BOOTSTRAP);
    controller.syncActiveUser('user-a');
    controller.handleSubscribe('authorized-window');
    await controller.handleCommand('authorized-window', c('user.switch', { userId: 'user-b' }));
    expect(calls[0]?.method).toBe('user.switch');
    expect(controller.getActiveUserId()).toBe('user-b');
    expect(lifecycle.some((e) => e.type === 'user-changed')).toBe(true);
  });

  it('S1-M04-007 user.switch 隐藏用户返回 USER_NOT_FOUND', async () => {
    const { controller } = makeController(VALID_BOOTSTRAP);
    await expect(
      controller.handleCommand('authorized-window', c('user.switch', { userId: 'random' })),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('S1-M04-008 bootstrap 响应通过 Schema 校验', async () => {
    const { controller } = makeController(VALID_BOOTSTRAP);
    const result = await controller.handleQuery('authorized-window', q('app.bootstrap'));
    expect(result).toEqual(VALID_BOOTSTRAP);
  });

  it('S1-M03-009 failed 后可通过固定 Command 重试并重新 bootstrap', async () => {
    const { controller, calls } = makeController(VALID_BOOTSTRAP);
    const result = await controller.handleCommand('authorized-window', c('runtime.retry'));

    expect(result).toEqual(VALID_BOOTSTRAP);
    expect(calls).toEqual([expect.objectContaining({ method: 'app.bootstrap', userId: 'user-a' })]);
  });

  it('S1-M04-010 requestId 贯穿并一致', async () => {
    const { controller, calls } = makeController(VALID_BOOTSTRAP, {
      generateRequestId: () => 'fixed-request-id',
    });
    await controller.handleQuery('authorized-window', q('app.bootstrap'));
    expect(calls[0]?.requestId).toBe('fixed-request-id');
  });

  it('阶段 3 输入策略参数经 Bridge 原样转发给 Runtime', async () => {
    const { controller, calls } = makeController({
      inboxItemId: 'inbox-1',
      duplicate: false,
      scope: 'next-turn',
    });
    await controller.handleCommand(
      'authorized-window',
      c('input.submit', {
        sessionId: 'session-1',
        content: '连续追问',
        idempotencyKey: 'request-1',
        startNewEvent: false,
        mode: 'queue',
      }),
    );
    expect(calls[0]).toMatchObject({
      userId: 'user-a',
      method: 'input.submit',
      params: {
        sessionId: 'session-1',
        content: '连续追问',
        idempotencyKey: 'request-1',
        startNewEvent: false,
        mode: 'queue',
      },
    });
  });

  it('权限档位切换通过 Bridge 白名单并原样转发', async () => {
    const result = { sessionId: 'session-1', permissionPreset: 'approval-required' };
    const { controller, calls } = makeController(result);

    await expect(
      controller.handleCommand(
        'authorized-window',
        c('permission.preset.set', {
          sessionId: 'session-1',
          preset: 'approval-required',
        }),
      ),
    ).resolves.toEqual(result);
    expect(calls[0]).toMatchObject({
      userId: 'user-a',
      method: 'permission.preset.set',
      params: { sessionId: 'session-1', preset: 'approval-required' },
    });
  });

  it('权限审批提交通过 Bridge 白名单并原样转发', async () => {
    const result = { approvalId: 'approval-1', resolution: 'allowed-once' };
    const { controller, calls } = makeController(result);

    await expect(
      controller.handleCommand(
        'authorized-window',
        c('approval.resolve', {
          sessionId: 'session-1',
          approvalId: 'approval-1',
          resolution: 'allowed-once',
          idempotencyKey: 'request-1',
        }),
      ),
    ).resolves.toEqual(result);
    expect(calls[0]).toMatchObject({
      userId: 'user-a',
      method: 'approval.resolve',
      params: {
        sessionId: 'session-1',
        approvalId: 'approval-1',
        resolution: 'allowed-once',
        idempotencyKey: 'request-1',
      },
    });
  });

  it('阶段 4.5 MCP 管理查询通过 Bridge 白名单并校验响应', async () => {
    const snapshot = { revision: 0, categories: [], servers: [], instances: [], tools: [] };
    const { controller, calls } = makeController(snapshot);

    await expect(
      controller.handleQuery('authorized-window', q('mcp-management.snapshot')),
    ).resolves.toEqual(snapshot);
    expect(calls[0]).toMatchObject({
      userId: 'user-a',
      method: 'mcp-management.snapshot',
    });
  });

  it('阶段 4.5 MCP 测试连接通过 Bridge 白名单并原样转发', async () => {
    const result = { status: 'success', toolCount: 2, tools: [
      { rawName: 'search', publicName: 'mcp__memory__search', description: 'Search memory' },
      { rawName: 'read', publicName: 'mcp__memory__read', description: 'Read memory' },
    ] };
    const { controller, calls } = makeController(result);
    const params = {
      name: 'memory',
      summary: '',
      categoryId: 'uncategorized',
      transport: 'streamable-http',
      config: { url: 'https://memory.example.com/mcp', local: false },
      enabled: true,
      credential: { action: 'unchanged' },
    };

    await expect(
      controller.handleCommand('authorized-window', c('mcp-server.test', params)),
    ).resolves.toEqual(result);
    expect(calls[0]).toMatchObject({
      userId: 'user-a',
      method: 'mcp-server.test',
      params,
    });
  });

  it('S1-M04-011 unsubscribe 后 listener 不再接收', () => {
    const { controller, lifecycle } = makeController(VALID_BOOTSTRAP);
    controller.handleSubscribe('authorized-window');
    expect(controller.hasSubscriber('authorized-window')).toBe(true);
    controller.handleUnsubscribe('authorized-window');
    expect(controller.hasSubscriber('authorized-window')).toBe(false);

    controller.handleLifecycle({ type: 'runtime', status: 'ready', generation: 1 });
    expect(lifecycle).toHaveLength(0);
  });

  it('S1-M04-012 超大 payload 在转发前被拒绝（按 UTF-8 字节）', async () => {
    const { controller, calls } = makeController(VALID_BOOTSTRAP);
    const huge = '中'.repeat(MAX_REQUEST_BYTES + 100);
    await expect(
      controller.handleQuery('authorized-window', q('system.health', { huge })),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('S1-M04-013 Worker 响应 Schema 错误映射 INTERNAL_ERROR', async () => {
    const { controller } = makeController({ totally: 'wrong-shape' });
    await expect(
      controller.handleQuery('authorized-window', q('app.bootstrap')),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('user.switch 响应脏数据映射 INTERNAL_ERROR', async () => {
    const { controller } = makeController({ garbage: true });
    await expect(
      controller.handleCommand('authorized-window', c('user.switch', { userId: 'user-b' })),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('health 响应通过 Schema 校验', async () => {
    const { controller } = makeController(VALID_HEALTH);
    const result = await controller.handleQuery('authorized-window', q('system.health'));
    expect(result).toEqual(VALID_HEALTH);
  });
});
