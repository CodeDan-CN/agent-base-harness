import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerApplication,
  type WorkerApplication,
} from '../../packages/server-core/src/application/application';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { createCapabilitySearchTool } from '../../packages/runtime-core/src/capability-discovery';
import { LlmAdapterRegistry } from '../../packages/runtime-core/src/model';
import { publicToolName } from '../../packages/runtime-core/src/mcp/mcp-manager';
import { McpConnectionError } from '../../packages/execution/src/process/mcp-stdio-sandbox';
import { ToolRegistry } from '../../packages/runtime-core/src/tools';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { FixedClock } from '../../packages/test-kit/src/clock';
import {
  FakeLlmAdapter,
  SequenceIdProvider,
  textResponse,
} from '../../packages/test-kit/src/runtime';

describe('统一能力 Runtime 渐进披露', () => {
  let root: string;
  let app: WorkerApplication;

  afterEach(() => {
    app?.close();
    vi.restoreAllMocks();
    cleanupDir(root);
  });

  it('测试未保存的 MCP 配置会返回工具目录且不持久化 Server', async () => {
    root = makeTempDir('agent-mcp-draft-test-');
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [
        {
          name: 'search_nodes',
          description: 'Search long-term memory nodes by query.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    });
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: new LlmAdapterRegistry(),
      tools: new ToolRegistry(),
    });

    const result = await app.testMcpServer('user-a', {
      name: 'draft_memory',
      summary: '',
      categoryId: 'uncategorized',
      transport: 'streamable-http',
      config: { url: 'http://127.0.0.1:9099/mcp', local: true },
      enabled: true,
      credential: { action: 'unchanged' },
    });

    expect(result).toEqual({
      status: 'success',
      toolCount: 1,
      tools: [
        {
          rawName: 'search_nodes',
          publicName: publicToolName('draft_memory', 'search_nodes'),
          description: 'Search long-term memory nodes by query.',
        },
      ],
    });
    const management = await app.mcpManagement('user-a');
    expect(management.servers.some((server) => server.name === 'draft_memory')).toBe(false);
  });

  it('连接测试返回可定位的错误码，同时不泄露底层错误中的凭据', async () => {
    root = makeTempDir('agent-mcp-diagnostic-');
    const connect = vi.spyOn(Client.prototype, 'connect');
    connect.mockRejectedValue(new McpConnectionError('MCP_SANDBOX_DENIED', '沙箱被系统拒绝'));
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: new LlmAdapterRegistry(),
      tools: new ToolRegistry(),
    });
    const input = {
      name: 'diagnostic',
      summary: '',
      categoryId: 'uncategorized',
      transport: 'streamable-http' as const,
      config: { url: 'http://127.0.0.1:9099/mcp', local: true },
      enabled: true,
      credential: { action: 'unchanged' as const },
    };
    expect(await app.testMcpServer('user-a', input)).toMatchObject({
      status: 'protocol',
      toolCount: 0,
      errorCode: 'MCP_SANDBOX_DENIED',
      message: '沙箱被系统拒绝',
    });
    connect.mockRejectedValue(new Error('password=private-credential-fixture'));
    const result = await app.testMcpServer('user-a', input);
    expect(result.errorCode).toBe('MCP_CONNECTION_FAILED');
    expect(JSON.stringify(result)).not.toContain('private-credential-fixture');
  });

  it('主模型读取当前步骤轻量目录、下一步刷新配置，再加载 MCP 完整 Schema', async () => {
    root = makeTempDir('agent-mcp-runtime-');
    const searchToolName = publicToolName('memory', 'search_nodes');
    const getToolName = publicToolName('memory', 'get_node');
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [
        {
          name: 'search_nodes',
          description: 'Search long-term memory nodes by query.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'get_node',
          description: 'Get one long-term memory node by id.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      ],
    });
    let refreshedDirectory = '';
    const adapter = new FakeLlmAdapter((request, _signal, index) => {
      if (index === 0) {
        expect(request.tools.map((tool) => tool.name)).toEqual(['capability_search', 'mcp_load']);
        // Legacy global flags do not override the Agent's explicit Skill binding.
        app.repos.skills.setEnabled('user-a', 'trip-planner', false, '2026-08-28T00:00:05.000Z');
        const server = app.repos.mcp.getServer('user-a', 'memory-server')!;
        app.repos.mcp.updateServer(
          'user-a',
          server.id,
          {
            name: 'Updated memory',
            summary: 'Updated memory description.',
            transport: server.transport,
            config: server.config,
            credentialRef: server.credentialRef,
            enabled: true,
            categoryId: server.categoryId,
          },
          '2026-08-28T00:00:05.000Z',
        );
        return {
          content: '',
          toolCalls: [
            {
              id: 'discover-capabilities',
              name: 'capability_search',
              arguments: {},
            },
          ],
          usage: { inputTokens: 10, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      if (index === 1) {
        expect(request.tools.map((tool) => tool.name)).toEqual(['capability_search', 'mcp_load']);
        const discovery = request.messages.find(
          (message) => message.role === 'tool' && message.content.includes('"candidates"'),
        );
        expect(discovery).toMatchObject({ role: 'tool' });
        expect(discovery?.content).toContain('"candidates"');
        expect(discovery?.content).toContain('"memory"');
        expect(discovery?.content).toContain('"trip-planner"');
        expect(discovery?.content).not.toContain('Updated memory');
        expect(discovery?.content).not.toContain('"inputSchema"');
        return {
          content: '',
          toolCalls: [{ id: 'refresh-capabilities', name: 'capability_search', arguments: {} }],
          usage: { inputTokens: 12, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      if (index === 2) {
        const discoveries = request.messages.filter(
          (message) => message.role === 'tool' && message.content.includes('"candidates"'),
        );
        refreshedDirectory = discoveries.at(-1)?.content ?? '';
        return {
          content: '',
          toolCalls: [
            {
              id: 'load-memory-search',
              name: 'mcp_load',
              arguments: { name: 'Updated memory' },
            },
          ],
          usage: { inputTokens: 12, outputTokens: 2 },
          stopReason: 'tool_calls',
        };
      }
      expect(request.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: publicToolName('Updated memory', 'search_nodes'),
            inputSchema: expect.objectContaining({ required: ['query'] }),
          }),
          expect.objectContaining({
            name: publicToolName('Updated memory', 'get_node'),
            inputSchema: expect.objectContaining({ required: ['id'] }),
          }),
        ]),
      );
      return textResponse('已加载所需 MCP 工具');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    const tools = new ToolRegistry();
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
      tools,
    });
    tools.register(createCapabilitySearchTool(app.repos));
    configureModel(app);
    app.repos.mcp.createServer({
      id: 'memory-server',
      userId: 'user-a',
      name: 'memory',
      summary: 'Search and retrieve long-term memory nodes.',
      transport: 'streamable-http',
      config: { url: 'http://127.0.0.1:9099/mcp', local: true },
      credentialRef: null,
      enabled: true,
      now: '2026-08-28T00:00:00.000Z',
    });
    app.repos.mcp.replaceDiscoveredTools(
      'user-a',
      'memory-server',
      1,
      [
        {
          rawName: 'search_nodes',
          publicName: searchToolName,
          description: 'Search long-term memory nodes by query.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          outputSchema: null,
          schemaDigest: 'digest-1',
        },
        {
          rawName: 'get_node',
          publicName: getToolName,
          description: 'Get one long-term memory node by id.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          outputSchema: null,
          schemaDigest: 'digest-2',
        },
      ],
      '2026-08-28T00:00:01.000Z',
    );
    // Seed the real discovery digest so the subsequent load does not invalidate approval.
    await app.mcp.refreshServer('user-a', 'memory-server');
    app.repos.mcp.setToolEnabled(
      'user-a',
      'memory-server',
      'search_nodes',
      true,
      '2026-08-28T00:00:02.000Z',
    );
    app.repos.mcp.setToolEnabled(
      'user-a',
      'memory-server',
      'get_node',
      true,
      '2026-08-28T00:00:02.000Z',
    );
    app.repos.skills.upsertInstallation({
      id: 'trip-planner',
      userId: 'user-a',
      skillName: 'trip-planner',
      description: 'Plan multi-stage travel and transfer workflows.',
      sourceType: 'local',
      sourceRef: null,
      rootPath: path.join(root, 'trip-planner'),
      metadata: { tags: ['travel', 'planning'] },
      contentDigest: 'trip-planner-digest',
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
      now: '2026-08-28T00:00:02.000Z',
    });
    let agentRevision = app.repos.users.getRevisions('user-a').agentRevision;
    app.repos.agents.setSkillBinding(
      'user-a',
      'dylan',
      'trip-planner',
      true,
      agentRevision,
      '2026-08-28T00:00:03.000Z',
    );
    agentRevision = app.repos.users.getRevisions('user-a').agentRevision;
    app.repos.agents.setMcpBinding(
      'user-a',
      'dylan',
      'memory-server',
      'user',
      true,
      agentRevision,
      '2026-08-28T00:00:04.000Z',
    );
    app.mcp.rebuildUserTools('user-a');
    app.runtime.createSession('user-a', { sessionId: 'session-1', title: 'MCP Test' });
    app.runtime.submitInput('user-a', {
      sessionId: 'session-1',
      content: '搜索长期记忆',
      idempotencyKey: 'mcp-progressive-1',
      startNewEvent: true,
    });

    await app.runtime.waitForIdle('user-a', 'session-1');
    expect(JSON.parse(refreshedDirectory)).toEqual({
      totalAvailable: 3,
      candidates: [
        {
          kind: 'mcp',
          name: 'Updated memory',
          description: 'Updated memory description.',
          action: 'mcp_load',
          scope: 'user',
        },
        expect.objectContaining({ kind: 'skill', name: 'skill-creator' }),
        expect.objectContaining({ kind: 'skill', name: 'trip-planner' }),
      ],
    });
    expect(adapter.requests).toHaveLength(4);
    expect(connect).toHaveBeenCalledOnce();
    const loadResult = app.repos.sessions
      .listEvents('user-a', 'session-1')
      .find(
        (event) =>
          event.eventType === 'tool.result' &&
          (event.payload as { toolName?: string }).toolName === 'mcp_load',
      );
    expect(loadResult?.payload).toMatchObject({ status: 'success' });
    expect(adapter.requests.every((request) => request.tools.length > 0)).toBe(true);
    expect(tools.get(searchToolName, 'user-a')).toBeUndefined();
    expect(tools.get(getToolName, 'user-a')).toBeUndefined();
    const snapshot = app.runtime.snapshot('user-a', 'session-1') as {
      turns: Array<{ id: string; status: string }>;
    };
    expect(snapshot.turns[0]?.status).toBe('completed');
    expect(tools.get(searchToolName, 'user-a', snapshot.turns[0]!.id)).toBeUndefined();
    expect(tools.get(getToolName, 'user-a', snapshot.turns[0]!.id)).toBeUndefined();
  });

  it('摘要留空时使用默认模型根据工具目录自动生成并持久化', async () => {
    root = makeTempDir('agent-mcp-summary-');
    const adapter = new FakeLlmAdapter((request) => {
      expect(request.purpose).toBe('metadata');
      expect(request.tools).toEqual([]);
      expect(request.messages.at(-1)?.content).toContain('search_nodes');
      return textResponse('提供长期记忆节点的搜索与读取能力。');
    });
    const adapters = new LlmAdapterRegistry();
    adapters.register(adapter);
    app = createWorkerApplication({
      appDataDir: root,
      generation: 1,
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      idProvider: new SequenceIdProvider(),
      llmAdapters: adapters,
    });
    configureModel(app);
    app.repos.mcp.createServer({
      id: 'memory-server',
      userId: 'user-a',
      name: 'memory',
      summary: '',
      transport: 'streamable-http',
      config: { url: 'https://memory.example.com/mcp', local: false },
      credentialRef: null,
      enabled: false,
      now: '2026-08-28T00:00:00.000Z',
    });
    app.repos.mcp.replaceDiscoveredTools(
      'user-a',
      'memory-server',
      1,
      [
        {
          rawName: 'search_nodes',
          publicName: publicToolName('memory', 'search_nodes'),
          description: 'Search long-term memory nodes by query.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          outputSchema: null,
          schemaDigest: 'digest-1',
        },
      ],
      '2026-08-28T00:00:01.000Z',
    );

    await app.saveMcpServer('user-a', {
      id: 'memory-server',
      name: 'memory',
      categoryId: 'uncategorized',
      summary: '',
      transport: 'streamable-http',
      config: { url: 'https://memory.example.com/mcp', local: false },
      enabled: false,
      credential: { action: 'unchanged' },
      expectedRevision: app.repos.users.getRevisions('user-a').mcpRevision,
    });

    expect(adapter.requests).toHaveLength(1);
    expect(app.repos.mcp.getServer('user-a', 'memory-server')?.summary).toBe(
      '提供长期记忆节点的搜索与读取能力。',
    );
    const management = await app.mcpManagement('user-a');
    expect(management.servers[0]?.summary).toBe('提供长期记忆节点的搜索与读取能力。');
  });
});

function configureModel(app: WorkerApplication): void {
  const now = '2026-08-28T00:00:00.000Z';
  app.repos.models.createService({
    id: 'fake-service',
    userId: 'user-a',
    name: 'Fake',
    providerType: 'fake',
    endpoint: 'https://invalid.local',
    credentialRef: null,
    config: {},
    now,
  });
  app.repos.models.createModel({
    id: 'fake-model',
    userId: 'user-a',
    serviceId: 'fake-service',
    remoteModelId: 'fake-model',
    displayName: 'Fake Model',
    contextWindow: 8192,
    maxOutputTokens: 512,
    capabilities: { tools: true },
    defaultParams: {},
    source: 'manual',
    now,
  });
  app.repos.models.setDefaultModel('user-a', 'fake-model', now);
}
