import { describe, expect, it } from 'vitest';
import { FakeCredentialStore } from '../../packages/execution/src/credential/fake-credential-store';
import { MemoryLogger } from '../../packages/execution/src/logging/logger';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import { SqliteRepositories } from '../../packages/storage/src/repositories';
import { STAGE47_MIGRATIONS } from '../../packages/storage/src/schema';
import {
  createCapabilitySearchTool,
  listCapabilityCandidates,
} from '../../packages/runtime-core/src/capability-discovery';
import { BUNDLED_MEMORY_SERVER_SUMMARY } from '../../packages/runtime-core/src/mcp/bundled-memory';
import { McpManager, publicToolName } from '../../packages/runtime-core/src/mcp/mcp-manager';
import {
  ToolRegistry,
  ToolScheduler,
  type AgentExecutionConfigSnapshot,
} from '../../packages/runtime-core/src/tools';
import { FixedClock } from '../../packages/test-kit/src/clock';

describe('统一能力渐进披露', () => {
  it('返回 Skill/MCP 轻量目录，不因发现暴露完整 Schema', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, STAGE47_MIGRATIONS, { clock: () => '2026-08-28T00:00:00.000Z' });
    const repos = new SqliteRepositories(db);
    repos.users.seedUsers('2026-08-28T00:00:00.000Z');
    repos.agents.ensureDylan('user-a', 'guarded', '2026-08-28T00:00:00.000Z');
    repos.sessions.createSession({
      id: 'session-1',
      userId: 'user-a',
      title: 'test',
      agentId: 'dylan',
      origin: 'direct',
      parentSessionId: null,
      now: '2026-08-28T00:00:00.000Z',
    });
    repos.mcp.createServer({
      id: 'memory-server',
      userId: 'user-a',
      name: 'memory',
      summary: BUNDLED_MEMORY_SERVER_SUMMARY,
      transport: 'streamable-http',
      config: { url: 'https://memory.example.com/mcp', local: false },
      credentialRef: null,
      enabled: true,
      now: '2026-08-28T00:00:00.000Z',
    });
    const searchToolName = publicToolName('memory', 'search_nodes');
    const getToolName = publicToolName('memory', 'get_node');
    repos.mcp.replaceDiscoveredTools(
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
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
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
    repos.mcp.setToolEnabled(
      'user-a',
      'memory-server',
      'search_nodes',
      true,
      '2026-08-28T00:00:02.000Z',
    );
    repos.mcp.setToolEnabled(
      'user-a',
      'memory-server',
      'get_node',
      true,
      '2026-08-28T00:00:02.000Z',
    );
    repos.skills.upsertInstallation({
      id: 'weather-helper',
      userId: 'user-a',
      skillName: 'weather-helper',
      description: 'Plan weather-aware travel and outdoor activities.',
      sourceType: 'local',
      sourceRef: null,
      rootPath: '/tmp/weather-helper',
      metadata: { tags: ['weather', 'travel'] },
      contentDigest: 'skill-digest',
      enabled: true,
      status: 'valid',
      compatibilityStatus: 'compatible',
      now: '2026-08-28T00:00:02.000Z',
    });

    let revision = repos.users.getRevisions('user-a').agentRevision;
    repos.agents.setSkillBinding(
      'user-a',
      'dylan',
      'weather-helper',
      true,
      revision,
      '2026-08-28T00:00:03.000Z',
    );
    revision = repos.users.getRevisions('user-a').agentRevision;
    repos.agents.setMcpBinding(
      'user-a',
      'dylan',
      'memory-server',
      'user',
      true,
      revision,
      '2026-08-28T00:00:04.000Z',
    );

    const registry = new ToolRegistry();
    registry.register(createCapabilitySearchTool(repos));
    const manager = new McpManager({
      repos,
      tools: registry,
      credentialStore: new FakeCredentialStore(),
      logger: new MemoryLogger(),
      clock: new FixedClock(),
      appDataDir: '/tmp/agent-mcp-progressive-test',
    });
    manager.rebuildUserTools('user-a');

    expect(registry.definitions('user-a').map((tool) => tool.name)).toEqual([
      'capability_search',
      'mcp_load',
    ]);
    expect(registry.get(searchToolName, 'user-a')).toBeUndefined();
    expect(registry.get(getToolName, 'user-a')).toBeUndefined();

    const scheduler = new ToolScheduler(registry);
    const context = {
      userId: 'user-a',
      agentId: 'dylan',
      sessionOrigin: 'direct' as const,
      sessionId: 'session-1',
      eventId: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      permissionPreset: 'guarded' as const,
      signal: new AbortController().signal,
    };
    const [searched] = await scheduler.execute(
      [
        {
          id: 'search',
          name: 'capability_search',
          arguments: {},
        },
      ],
      context,
    );
    const searchedText =
      searched?.result.content[0]?.type === 'text' ? searched.result.content[0].text : '';
    const searchedResult = JSON.parse(searchedText) as {
      totalAvailable: number;
      candidates: Array<{
        kind: string;
        capabilityId?: string;
        name: string;
        description: string;
        action: string;
      }>;
    };
    expect(searchedResult).toMatchObject({
      totalAvailable: 2,
      candidates: [
        expect.objectContaining({
          kind: 'mcp',
          name: 'memory',
          action: 'mcp_load',
        }),
        expect.objectContaining({
          kind: 'skill',
          name: 'weather-helper',
          action: 'skill_load',
        }),
      ],
    });
    expect(searchedText).not.toContain('"inputSchema"');

    expect(registry.definitions('user-a').map((tool) => tool.name)).toEqual([
      'capability_search',
      'mcp_load',
    ]);
    expect(registry.definitions('user-a', 'session-1', 'turn-1')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: searchToolName }),
        expect.objectContaining({ name: getToolName }),
      ]),
    );
    expect(registry.get(searchToolName, 'user-a', 'session-1', 'turn-1')).toBeUndefined();
    expect(registry.get(getToolName, 'user-a', 'session-1', 'turn-1')).toBeUndefined();
    expect(registry.get(searchToolName, 'user-a', 'session-1', 'turn-2')).toBeUndefined();
    expect(registry.get(getToolName, 'user-a', 'session-1', 'turn-2')).toBeUndefined();
    const load = registry.get('mcp_load', 'user-a')!;
    const loadContext = { ...context, toolCallId: 'load' };
    expect(load.parameters).toMatchObject({ required: ['name'], additionalProperties: false });
    for (const input of [
      { capabilityId: 'memory-server:user' },
      { name: 'memory', scope: 'user' },
    ]) {
      await expect(load.execute(input, loadContext)).rejects.toThrow();
    }
    await expect(load.execute({ name: 'missing' }, loadContext)).rejects.toThrow(
      'MCP_SERVER_NOT_AVAILABLE',
    );
    await expect(
      load.execute({ name: 'memory' }, { ...loadContext, userId: 'user-b' }),
    ).rejects.toThrow('MCP_CATALOG_NOT_AVAILABLE');
    const candidates = listCapabilityCandidates(repos, 'user-a', 'dylan', 'direct');
    const frozen = {
      capabilityCandidates: candidates,
      mcpBindings: [],
    } as unknown as AgentExecutionConfigSnapshot;
    // A discoverable name cannot bypass the frozen Step authorization.
    await expect(
      load.execute({ name: 'memory' }, { ...loadContext, executionConfig: frozen }),
    ).rejects.toThrow('MCP_SERVER_NOT_AVAILABLE');
    const mcp = candidates.find((candidate) => candidate.kind === 'mcp')!;
    await expect(
      load.execute(
        { name: 'memory' },
        {
          ...loadContext,
          executionConfig: {
            ...frozen,
            capabilityCandidates: [mcp, { ...mcp, capabilityId: 'other:user' }],
          },
        },
      ),
    ).rejects.toThrow('MCP_NAME_AMBIGUOUS');
    await manager.close();
    db.close();
  });
});
