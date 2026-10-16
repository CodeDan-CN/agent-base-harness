import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerApplication, type WorkerApplication } from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import { ToolRegistry, type RuntimeTool } from '../../packages/runtime-core/src/tools';
import { FixedClock } from '../../packages/test-kit/src/clock';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { FakeLlmAdapter, SequenceIdProvider, textResponse, waitUntil } from '../../packages/test-kit/src/runtime';

describe('Stage 4.5.5 runtime approval', () => {
  let root: string;
  let app: WorkerApplication;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(async () => {
    if (app) {
      await app.mcp.close();
      app.close();
    }
    cleanupDir(root);
  });

  it('commits the session preset and its audit event in one append', () => {
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: new LlmAdapterRegistry(),
      tools: new ToolRegistry(),
    });
    app.runtime.createSession('user-a', { sessionId: 'session-a', title: 'Permissions' });

    app.runtime.setPermissionPreset('user-a', 'session-a', 'approval-required');

    expect(app.repos.sessions.getSession('user-a', 'session-a')).toMatchObject({
      permissionPreset: 'approval-required',
      version: 2,
      nextSeq: 3,
    });
    expect(app.repos.sessions.listEvents('user-a', 'session-a').at(-1)).toMatchObject({
      eventType: 'permission.preset.changed',
      payload: { from: 'guarded', to: 'approval-required' },
    });
  });

  it('applies Agent permission changes to all direct sessions without crossing user boundaries', () => {
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: new LlmAdapterRegistry(),
      tools: new ToolRegistry(),
    });
    app.runtime.createSession('user-a', { sessionId: 'session-a-1', title: 'Existing A' });
    app.runtime.createSession('user-a', { sessionId: 'session-a-2', title: 'Source A' });
    app.runtime.createSession('user-b', { sessionId: 'session-b-1', title: 'Existing B' });

    app.runtime.setPermissionPreset('user-a', 'session-a-2', 'full-access');
    app.runtime.createSession('user-a', { sessionId: 'session-a-3', title: 'New A' });
    const agentSnapshot = app.agentManagement.snapshot('user-a');
    const dylan = agentSnapshot.agents.find((item) => item.profile.id === 'dylan')!.profile;
    app.agentManagement.setRuntimeDefaults('user-a', {
      agentId: dylan.id,
      defaultModelId: dylan.defaultModelId,
      permissionPreset: 'full-access',
      expectedProfileRevision: dylan.revision,
      expectedRevision: agentSnapshot.revision,
    });
    app.runtime.createSession('user-a', { sessionId: 'session-a-4', title: 'New default A' });
    app.runtime.createSession('user-b', { sessionId: 'session-b-2', title: 'New B' });

    expect(app.repos.sessions.getSession('user-a', 'session-a-1')?.permissionPreset).toBe(
      'full-access',
    );
    expect(app.repos.sessions.getSession('user-a', 'session-a-2')?.permissionPreset).toBe(
      'full-access',
    );
    expect(app.repos.sessions.getSession('user-a', 'session-a-3')?.permissionPreset).toBe(
      'full-access',
    );
    expect(app.repos.sessions.getSession('user-a', 'session-a-4')?.permissionPreset).toBe(
      'full-access',
    );
    expect(app.repos.sessions.getSession('user-b', 'session-b-2')?.permissionPreset).toBe(
      'guarded',
    );
  });

  it('persists the decision before resuming the same tool call', async () => {
    const execute = vi.fn(async () => ({ accepted: true }));
    const externalTool: RuntimeTool<unknown> = {
      name: 'external_write',
      description: 'Writes to an external service',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { accepted: { type: 'boolean' } },
          required: ['accepted'],
          additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'accepted' }],
      },
      concurrencySafe: false,
      replaySafe: false,
      exclusive: true,
      approvalPolicy: 'always',
      approvalScope: 'external',
      permissionIdentity: 'external:test:v1',
      execute,
    };
    const tools = new ToolRegistry();
    tools.register(externalTool);
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? {
            content: '',
            toolCalls: [{ id: 'call-1', name: externalTool.name, arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'tool_calls',
          }
        : textResponse('done'),
    );
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
    });
    configureModel(app);
    app.runtime.createSession('user-a', { sessionId: 'session-a', title: 'Approval' });
    app.runtime.submitInput('user-a', {
      sessionId: 'session-a',
      content: 'run',
      idempotencyKey: 'input-1',
      startNewEvent: true,
    });

    await waitUntil(() =>
      snapshot(app).approvals.some((approval) => approval.status === 'pending'),
    );
    expect(execute).not.toHaveBeenCalled();
    const approval = snapshot(app).approvals.find((item) => item.status === 'pending');
    expect(approval).toBeDefined();

    app.runtime.resolveApproval('user-a', {
      sessionId: 'session-a',
      approvalId: approval!.id,
      resolution: 'allowed-once',
      idempotencyKey: 'approval-1',
    });
    await app.runtime.waitForIdle('user-a', 'session-a');

    expect(execute).toHaveBeenCalledOnce();
    const eventTypes = app.repos.sessions
      .listEvents('user-a', 'session-a')
      .map((event) => event.eventType);
    expect(eventTypes.indexOf('approval.resolved')).toBeLessThan(eventTypes.indexOf('tool.result'));
    expect(snapshot(app).permissionGrants).toEqual([]);
  });

  it('request approval forces every external call to ask even when the tool is configured never', async () => {
    const execute = vi.fn(async () => ({ accepted: true }));
    const externalTool: RuntimeTool<unknown> = {
      name: 'external_read',
      description: 'Reads an external service',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { accepted: { type: 'boolean' } },
          required: ['accepted'],
          additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'accepted' }],
      },
      concurrencySafe: false,
      approvalPolicy: 'never',
      approvalScope: 'external',
      permissionIdentity: 'external:read:v1',
      execute,
    };
    const tools = new ToolRegistry();
    tools.register(externalTool);
    const adapter = new FakeLlmAdapter((_request, _signal, index) =>
      index === 0
        ? {
            content: '',
            toolCalls: [{ id: 'call-1', name: externalTool.name, arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'tool_calls',
          }
        : textResponse('done'),
    );
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
    });
    configureModel(app);
    app.runtime.createSession('user-a', { sessionId: 'session-a', title: 'Approval' });
    app.runtime.setPermissionPreset('user-a', 'session-a', 'approval-required');
    app.runtime.submitInput('user-a', {
      sessionId: 'session-a',
      content: 'run',
      idempotencyKey: 'input-request-mode',
      startNewEvent: true,
    });

    await waitUntil(() => snapshot(app).approvals.some(({ status }) => status === 'pending'));
    expect(execute).not.toHaveBeenCalled();
    const approval = snapshot(app).approvals.find(({ status }) => status === 'pending')!;
    const approvalEvent = app.repos.sessions
      .listEvents('user-a', 'session-a')
      .find(({ eventType }) => eventType === 'approval.requested');
    expect(approvalEvent?.payload).toMatchObject({ policy: 'always' });

    app.runtime.resolveApproval('user-a', {
      sessionId: 'session-a',
      approvalId: approval.id,
      resolution: 'allowed-once',
      idempotencyKey: 'approval-request-mode',
    });
    await app.runtime.waitForIdle('user-a', 'session-a');
    expect(execute).toHaveBeenCalledOnce();
  });
});

function snapshot(app: WorkerApplication): {
  approvals: Array<{ id: string; status: string }>;
  permissionGrants: string[];
} {
  return app.runtime.snapshot('user-a', 'session-a') as {
    approvals: Array<{ id: string; status: string }>;
    permissionGrants: string[];
  };
}

function configureModel(app: WorkerApplication): void {
  app.repos.models.createService({
    id: 'service-a',
    userId: 'user-a',
    name: 'Fake',
    providerType: 'fake',
    endpoint: 'https://invalid.local',
    credentialRef: null,
    config: {},
    now: '2025-01-01T00:00:00.000Z',
  });
  app.repos.models.createModel({
    id: 'model-a',
    userId: 'user-a',
    serviceId: 'service-a',
    remoteModelId: 'fake-model',
    displayName: 'Fake Model',
    contextWindow: 8192,
    maxOutputTokens: 512,
    capabilities: { tools: true },
    defaultParams: {},
    source: 'manual',
    now: '2025-01-01T00:00:00.000Z',
  });
  app.repos.models.setDefaultModel('user-a', 'model-a', '2025-01-01T00:00:00.000Z');
}
