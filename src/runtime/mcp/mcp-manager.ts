import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { CredentialStore } from '../../infrastructure/credential/credential-store';
import type { Logger } from '../../infrastructure/logging/logger';
import type { BundledRuntimeSnapshot } from '../../infrastructure/runtime/bundled-runtime-registry';
import type { SqliteRepositories } from '../../infrastructure/sqlite/repositories';
import type {
  McpHttpConfig,
  McpServer,
  McpStdioConfig,
  McpToolCatalogEntry,
} from '../../shared/domain/mcp';
import type { Clock } from '../../shared/domain/ports';
import type { LocalUserId } from '../../shared/domain/user';
import {
  ToolExecutionError,
  textContent,
  type ContentBlock,
  type JsonValue,
  type RuntimeTool,
} from '../tools';
import type { ToolRegistry } from '../tools';
import {
  BUNDLED_MEMORY_DATA_FILE,
  BUNDLED_MEMORY_ENTRYPOINT,
  BUNDLED_NODE_COMMAND,
} from './bundled-memory';

interface Connection {
  client: Client;
  generation: number;
  closing: boolean;
}

interface McpCanonicalResult {
  content: JsonValue[];
  structuredContent?: JsonValue;
}

interface McpCatalogEntry {
  tool: McpToolCatalogEntry;
  server: McpServer;
}

interface McpCatalog {
  servers: ReadonlyMap<string, McpServer>;
  tools: McpCatalogEntry[];
}

const mcpSearchInput = z
  .object({
    query: z.string().max(500).default(''),
    limit: z.number().int().min(1).max(10).default(6),
  })
  .strict();

const mcpLoadInput = z.object({ serverName: z.string().min(1).max(200) }).strict();

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly deps: {
      repos: SqliteRepositories;
      tools: ToolRegistry;
      credentialStore: CredentialStore;
      logger: Logger;
      clock: Clock;
      appDataDir: string;
      runtime?: BundledRuntimeSnapshot;
    },
  ) {}

  start(): void {
    for (const user of this.deps.repos.users.listUsers()) {
      this.rebuildUserTools(user.id);
      for (const server of this.deps.repos.mcp.listServers(user.id)) {
        if (server.status === 'enabled') {
          void this.refreshServer(user.id, server.id).catch((error) => {
            this.deps.logger.warn('MCP startup connection failed', {
              userId: user.id,
              serverId: server.id,
              error: safeError(error),
            });
            this.scheduleReconnect(user.id, server.id);
          });
        }
      }
    }
  }

  async refreshServer(userId: LocalUserId, serverId: string): Promise<number> {
    const server = this.requireEnabledServer(userId, serverId);
    const client = await this.connect(server);
    const count = await this.discover(server, client);
    this.rebuildUserTools(userId);
    return count;
  }

  async testServer(server: McpServer): Promise<{ toolCount: number }> {
    await validateServerNetwork(server);
    const client = this.createClient(server);
    const transport = await this.createTransport(server);
    try {
      await client.connect(transport);
      return { toolCount: (await listAllTools(client)).length };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async reloadServer(userId: LocalUserId, serverId: string): Promise<void> {
    await this.disconnect(userId, serverId);
    const server = this.deps.repos.mcp.getServer(userId, serverId);
    this.rebuildUserTools(userId);
    if (server?.status === 'enabled') await this.refreshServer(userId, serverId);
  }

  async removeServer(userId: LocalUserId, serverId: string): Promise<void> {
    await this.disconnect(userId, serverId);
    this.rebuildUserTools(userId);
  }

  rebuildUserTools(userId: LocalUserId): void {
    const catalog = this.availableCatalog(userId);
    this.deps.tools.replaceUserTools(
      userId,
      catalog.tools.length === 0
        ? []
        : [this.createSearchTool(userId, catalog), this.createLoadTool(userId)],
    );
  }

  async close(): Promise<void> {
    this.disposed = true;
    for (const user of this.deps.repos.users.listUsers()) {
      this.deps.tools.clearUserTools(user.id);
    }
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    const entries = [...this.connections.entries()];
    await Promise.all(
      entries.map(async ([key, connection]) => {
        connection.closing = true;
        await connection.client.close().catch(() => undefined);
        this.connections.delete(key);
      }),
    );
  }

  private async connect(server: McpServer): Promise<Client> {
    const key = connectionKey(server.userId, server.id);
    const current = this.connections.get(key);
    if (current) return current.client;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const task = this.openConnection(server);
    this.connecting.set(key, task);
    try {
      return await task;
    } finally {
      this.connecting.delete(key);
    }
  }

  private async openConnection(server: McpServer): Promise<Client> {
    await validateServerNetwork(server);
    const generation = server.generation + 1;
    this.deps.repos.mcp.setConnectionStatus(
      server.userId,
      server.id,
      'connecting',
      generation,
      null,
      this.deps.clock.nowIso(),
    );
    const client = this.createClient(server);
    const connection: Connection = {
      client,
      generation,
      closing: false,
    };
    const key = connectionKey(server.userId, server.id);
    client.onclose = () => this.handleClose(server.userId, server.id, connection);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (this.connections.get(key) !== connection || connection.closing) return;
      try {
        await this.discover(server, client);
        this.rebuildUserTools(server.userId);
      } catch (error) {
        this.deps.logger.warn('MCP tool list refresh failed', {
          userId: server.userId,
          serverId: server.id,
          error: safeError(error),
        });
      }
    });
    try {
      await client.connect(await this.createTransport(server));
      if (this.disposed) throw new Error('MCP manager disposed');
      this.connections.set(key, connection);
      this.reconnectAttempts.delete(key);
      const reconnectTimer = this.reconnectTimers.get(key);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(key);
      this.deps.repos.mcp.setConnectionStatus(
        server.userId,
        server.id,
        'connected',
        generation,
        null,
        this.deps.clock.nowIso(),
      );
      return client;
    } catch (error) {
      connection.closing = true;
      await client.close().catch(() => undefined);
      this.deps.repos.mcp.setConnectionStatus(
        server.userId,
        server.id,
        'error',
        generation,
        safeError(error),
        this.deps.clock.nowIso(),
      );
      throw error;
    }
  }

  private createClient(_server: McpServer): Client {
    return new Client({ name: 'agent-base-harness', version: '0.1.0' }, { capabilities: {} });
  }

  private async createTransport(server: McpServer): Promise<Transport> {
    if (server.transport === 'stdio') {
      const config = server.config as McpStdioConfig;
      const base = path.join(this.deps.appDataDir, 'mcp', server.userId, server.id);
      await mkdir(base, { recursive: true });
      const cwd = config.cwd ? path.resolve(base, config.cwd) : base;
      if (!isInside(base, cwd)) throw new Error('MCP stdio cwd is outside its managed directory');
      await mkdir(cwd, { recursive: true });
      const command =
        config.command === BUNDLED_NODE_COMMAND
          ? this.requireBundledRuntime().node.executable
          : config.command;
      const args = config.args.map((arg) =>
        arg === BUNDLED_MEMORY_ENTRYPOINT
          ? this.requireBundledRuntime().mcp.memory.entrypoint
          : arg,
      );
      const configuredEnv = Object.fromEntries(
        Object.entries(config.env).map(([name, value]) => [
          name,
          value === BUNDLED_MEMORY_DATA_FILE ? path.join(base, 'memory.jsonl') : value,
        ]),
      );
      return new StdioClientTransport({
        command,
        args,
        cwd,
        env: { ...getDefaultEnvironment(), ...configuredEnv },
        stderr: 'pipe',
      });
    }
    const config = server.config as McpHttpConfig;
    const credential = server.credentialRef
      ? await this.deps.credentialStore.getByRef(server.credentialRef)
      : null;
    if (credential) this.deps.logger.registerSecret(credential);
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: credential ? { authorization: `Bearer ${credential}` } : undefined,
        redirect: 'error',
      },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
    }) as Transport;
  }

  private requireBundledRuntime(): BundledRuntimeSnapshot {
    if (!this.deps.runtime) throw new Error('Bundled MCP runtime is unavailable');
    return this.deps.runtime;
  }

  private async discover(server: McpServer, client: Client): Promise<number> {
    const listed = await listAllTools(client);
    const seen = new Set<string>();
    const tools = listed.map((tool) => {
      const publicName = publicToolName(server.name, tool.name);
      if (seen.has(publicName)) throw new Error(`Duplicate MCP tool: ${tool.name}`);
      seen.add(publicName);
      const inputSchema = asSchema(tool.inputSchema);
      const outputSchema = tool.outputSchema ? asSchema(tool.outputSchema) : null;
      return {
        rawName: tool.name,
        publicName,
        description: tool.description ?? '',
        inputSchema,
        outputSchema,
        schemaDigest: schemaDigest({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema,
          outputSchema,
        }),
      };
    });
    const generation =
      this.connections.get(connectionKey(server.userId, server.id))?.generation ?? 0;
    this.deps.repos.mcp.replaceDiscoveredTools(
      server.userId,
      server.id,
      generation,
      tools,
      this.deps.clock.nowIso(),
    );
    return tools.length;
  }

  private createRuntimeTool(tool: McpToolCatalogEntry, server: McpServer): RuntimeTool<unknown> {
    return {
      name: tool.publicName,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: tool.outputSchema ?? {},
          },
          required: tool.outputSchema ? ['content', 'structuredContent'] : ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return renderMcpResult(value as McpCanonicalResult, tool.rawName);
        },
        presentationMeta(_args, value) {
          const result = value as McpCanonicalResult;
          return {
            serverId: server.id,
            serverName: server.name,
            rawName: tool.rawName,
            schemaDigest: tool.schemaDigest,
            contentTypes: result.content.map((block) => {
              const record = asRecord(block);
              return typeof record?.type === 'string' ? record.type : 'unknown';
            }),
            structured: result.structuredContent !== undefined,
          };
        },
      },
      concurrencySafe: false,
      replaySafe: false,
      timeoutMs: 65_000,
      execute: async (raw, context) => {
        const current = this.availableCatalog(context.userId).tools.find(
          (entry) =>
            entry.tool.publicName === tool.publicName &&
            entry.tool.schemaDigest === tool.schemaDigest,
        );
        if (!current) throw new ToolExecutionError('MCP_TOOL_NOT_AVAILABLE');
        const currentServer = current.server;
        const client = await this.connect(currentServer);
        const result = await client.callTool(
          {
            name: tool.rawName,
            arguments: asRecord(raw) ?? {},
          },
          undefined,
          { signal: context.signal, timeout: 60_000 },
        );
        const normalized = normalizeCallResult(result);
        if (normalized.isError) {
          throw new ToolExecutionError(
            'MCP_TOOL_ERROR',
            'fatal_error',
            normalized.result,
            extractMcpText(normalized.result.content, tool.rawName),
          );
        }
        return normalized.result;
      },
      presentCall() {
        return {
          kind: 'generic',
          title: tool.description || tool.rawName,
          detail: server.name,
        };
      },
      presentResult(_args, result) {
        return {
          kind: 'generic',
          title: tool.description || tool.rawName,
          detail: server.name,
          status: result.status === 'success' ? 'success' : 'error',
        };
      },
    };
  }

  private createSearchTool(userId: LocalUserId, initialCatalog: McpCatalog): RuntimeTool<unknown> {
    return {
      name: 'mcp_search',
      description:
        '搜索当前用户已启用并审核通过的 MCP Server；只返回 Server 与工具的精简摘要，需要使用时再调用 mcp_load 暴露该 Server 的全部可用工具 Schema。' +
        ` ${catalogSummary(initialCatalog)}`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: 500,
            description: '能力、Server、工具或操作关键词；省略时浏览最相关 Server。',
          },
          limit: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
        },
        additionalProperties: false,
      },
      output: { schema: {}, render: (_args, value) => textContent(value) },
      concurrencySafe: true,
      replaySafe: true,
      timeoutMs: 5_000,
      execute: async (raw, context) => {
        if (context.userId !== userId) throw new ToolExecutionError('MCP_CATALOG_NOT_AVAILABLE');
        const input = mcpSearchInput.parse(raw);
        const catalog = this.availableCatalog(userId);
        return searchCatalog(catalog, input.query, input.limit);
      },
      presentCall() {
        return { kind: 'generic', title: '搜索 MCP 能力' };
      },
      presentResult(_args, result) {
        return {
          kind: 'generic',
          title: '搜索 MCP 能力',
          status: result.status === 'success' ? 'success' : 'error',
        };
      },
    };
  }

  private createLoadTool(userId: LocalUserId): RuntimeTool<unknown> {
    return {
      name: 'mcp_load',
      description:
        'MCP Server 的连接由应用启动和重连机制管理；此工具不负责启动或连接 Server，只将 mcp_search 返回的指定 Server 下全部已启用且审核通过的工具完整 Schema 暴露到当前 Turn，并从下一模型步骤开始可用。',
      parameters: {
        type: 'object',
        properties: {
          serverName: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'mcp_search 返回的精确 serverName。',
          },
        },
        required: ['serverName'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_args, value) => textContent(value) },
      concurrencySafe: false,
      replaySafe: true,
      exclusive: true,
      timeoutMs: 5_000,
      execute: async (raw, context) => {
        if (context.userId !== userId) throw new ToolExecutionError('MCP_CATALOG_NOT_AVAILABLE');
        const input = mcpLoadInput.parse(raw);
        const catalog = this.availableCatalog(userId);
        const entries = catalog.tools.filter((entry) => entry.server.name === input.serverName);
        if (entries.length === 0) {
          throw new ToolExecutionError(
            'MCP_SERVER_NOT_AVAILABLE',
            'fatal_error',
            { serverName: input.serverName },
            `MCP Server is not available or has no enabled tools: ${input.serverName}`,
          );
        }
        this.deps.tools.exposeTurnTools(
          userId,
          context.turnId,
          entries.map(({ tool, server }) => this.createRuntimeTool(tool, server)),
        );
        const toolNames = entries.map(({ tool }) => tool.publicName);
        return {
          serverName: input.serverName,
          exposedToolCount: toolNames.length,
          exposedTools: toolNames.slice(0, 20),
          omittedToolCount: Math.max(0, toolNames.length - 20),
          usage: '该 MCP Server 的全部可用工具 Schema 将从下一模型步骤开始出现。',
        };
      },
      presentCall() {
        return { kind: 'generic', title: '暴露 MCP Schema' };
      },
      presentResult(_args, result) {
        return {
          kind: 'generic',
          title: '暴露 MCP Schema',
          status: result.status === 'success' ? 'success' : 'error',
        };
      },
    };
  }

  private availableCatalog(userId: LocalUserId): McpCatalog {
    const servers = new Map(
      this.deps.repos.mcp
        .listServers(userId)
        .filter((server) => server.status === 'enabled')
        .map((server) => [server.id, server] as const),
    );
    return {
      servers,
      tools: this.deps.repos.mcp
        .listTools(userId)
        .filter(
          (tool) => tool.enabled && tool.reviewStatus === 'approved' && servers.has(tool.serverId),
        )
        .map((tool) => ({ tool, server: servers.get(tool.serverId)! })),
    };
  }

  private handleClose(userId: LocalUserId, serverId: string, connection: Connection): void {
    const key = connectionKey(userId, serverId);
    const current = this.connections.get(key);
    if (current && current !== connection) return;
    if (current === connection) this.connections.delete(key);
    if (connection.closing || this.disposed) return;
    this.deps.repos.mcp.setConnectionStatus(
      userId,
      serverId,
      'error',
      connection.generation,
      'Connection closed',
      this.deps.clock.nowIso(),
    );
    this.scheduleReconnect(userId, serverId);
  }

  private scheduleReconnect(userId: LocalUserId, serverId: string): void {
    const key = connectionKey(userId, serverId);
    const attempt = (this.reconnectAttempts.get(key) ?? 0) + 1;
    if (attempt > 5 || this.reconnectTimers.has(key)) return;
    this.reconnectAttempts.set(key, attempt);
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(key);
      const server = this.deps.repos.mcp.getServer(userId, serverId);
      if (!server || server.status !== 'enabled' || this.disposed) return;
      void this.refreshServer(userId, serverId).catch(() => {
        this.scheduleReconnect(userId, serverId);
      });
    }, delay);
    timer.unref();
    this.reconnectTimers.set(key, timer);
  }

  private async disconnect(userId: LocalUserId, serverId: string): Promise<void> {
    const key = connectionKey(userId, serverId);
    const connection = this.connections.get(key);
    const reconnectTimer = this.reconnectTimers.get(key);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.reconnectTimers.delete(key);
    this.reconnectAttempts.delete(key);
    if (connection) {
      connection.closing = true;
      this.connections.delete(key);
      await connection.client.close().catch(() => undefined);
    }
    this.deps.repos.mcp.setConnectionStatus(
      userId,
      serverId,
      'disconnected',
      connection?.generation ?? this.deps.repos.mcp.getServer(userId, serverId)?.generation ?? 0,
      null,
      this.deps.clock.nowIso(),
    );
  }

  private requireEnabledServer(userId: LocalUserId, serverId: string): McpServer {
    const server = this.deps.repos.mcp.getServer(userId, serverId);
    if (!server || server.status !== 'enabled') throw new Error('MCP server is not enabled');
    return server;
  }
}

function catalogSummary(catalog: McpCatalog): string {
  const grouped = new Map<string, McpCatalogEntry[]>();
  for (const entry of catalog.tools) {
    const entries = grouped.get(entry.server.id) ?? [];
    entries.push(entry);
    grouped.set(entry.server.id, entries);
  }
  const summaries = [...grouped.values()].slice(0, 8).map((entries) => {
    const server = entries[0]!.server;
    const operations = entries
      .slice(0, 4)
      .map(({ tool }) => tool.rawName)
      .join('、');
    const more = entries.length > 4 ? ` 等 ${entries.length} 个工具` : '';
    const summary = server.summary ? `：${conciseDescription(server.summary)}` : '';
    return `${server.name}${summary}（${operations}${more}）`;
  });
  return summaries.length > 0 ? `可用 MCP 摘要：${summaries.join('；').slice(0, 1500)}。` : '';
}

function searchCatalog(catalog: McpCatalog, rawQuery: string, limit: number): unknown {
  const query = rawQuery.trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const grouped = new Map<
    string,
    {
      server: McpServer;
      tools: Array<{ entry: McpCatalogEntry; score: number }>;
      bestScore: number;
      totalScore: number;
    }
  >();
  for (const entry of catalog.tools) {
    const score = catalogScore(entry, query, terms);
    const group = grouped.get(entry.server.id) ?? {
      server: entry.server,
      tools: [],
      bestScore: 0,
      totalScore: 0,
    };
    group.tools.push({ entry, score });
    group.bestScore = Math.max(group.bestScore, score);
    group.totalScore += score;
    grouped.set(entry.server.id, group);
  }
  const scored = [...grouped.values()]
    .map((group) => ({
      ...group,
      tools: group.tools.sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.tool.publicName.localeCompare(right.entry.tool.publicName),
      ),
    }))
    .sort(
      (left, right) =>
        right.bestScore - left.bestScore ||
        right.totalScore - left.totalScore ||
        left.server.name.localeCompare(right.server.name),
    );
  const lexical = scored.filter(({ bestScore }) => query.length === 0 || bestScore > 0);
  const fallback = query.length > 0 && lexical.length === 0;
  const matches = (fallback ? scored : lexical).slice(0, limit).map((group) => ({
    serverName: group.server.name,
    summary: conciseDescription(group.server.summary),
    toolCount: group.tools.length,
    matchedTools: group.tools
      .filter(({ score }) => fallback || query.length === 0 || score > 0)
      .slice(0, 5)
      .map(({ entry }) => ({
        toolName: entry.tool.publicName,
        description: conciseDescription(entry.tool.description),
        parameters: parameterNames(entry.tool.inputSchema),
        required: requiredParameterNames(entry.tool.inputSchema),
      })),
  }));
  return {
    query: rawQuery,
    matches,
    usage:
      matches.length > 0 && !fallback
        ? '选择所需 serverName 调用 mcp_load；它会暴露该 Server 的全部可用工具 Schema。'
        : fallback
          ? '没有直接关键词匹配，已返回目录浏览结果；选择合适 serverName 调用 mcp_load，或换更具体关键词搜索。'
          : '当前没有包含可用工具的 MCP Server。',
  };
}

function conciseDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 297)}...`;
}

function catalogScore(entry: McpCatalogEntry, query: string, terms: readonly string[]): number {
  if (!query) return 1;
  const toolName = entry.tool.publicName.toLocaleLowerCase();
  const rawName = entry.tool.rawName.toLocaleLowerCase();
  const serverName = entry.server.name.toLocaleLowerCase();
  const serverSummary = entry.server.summary.toLocaleLowerCase();
  const description = entry.tool.description.toLocaleLowerCase();
  if (toolName === query || rawName === query) return 1_000;
  let score = 0;
  for (const term of terms) {
    if (toolName.includes(term)) score += 100;
    if (rawName.includes(term)) score += 80;
    if (serverName.includes(term)) score += 50;
    if (serverSummary.includes(term)) score += 40;
    if (description.includes(term)) score += 20;
  }
  return score;
}

function parameterNames(schema: Record<string, unknown>): string[] {
  const properties = asRecord(schema.properties);
  return properties ? Object.keys(properties).slice(0, 20) : [];
}

function requiredParameterNames(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string').slice(0, 20)
    : [];
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

async function listAllTools(client: Client) {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function validateServerNetwork(server: McpServer): Promise<void> {
  if (server.transport !== 'streamable-http') return;
  const config = server.config as McpHttpConfig;
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported MCP URL protocol');
  if (
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      /(api[-_]?key|token|secret|password|authorization|credential)/i.test(key),
    )
  ) {
    throw new Error('MCP URL must not contain credentials');
  }
  const loopbackHost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]';
  if (config.local) {
    if (!loopbackHost) throw new Error('Local MCP HTTP endpoint must use loopback');
    return;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Remote MCP endpoint resolved to a private address');
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

function normalizeCallResult(value: unknown): { result: McpCanonicalResult; isError: boolean } {
  const record = asRecord(value) ?? {};
  let content: JsonValue[];
  if (Array.isArray(record.content)) {
    content = snapshotJson(record.content) as JsonValue[];
  } else {
    const legacy = Object.hasOwn(record, 'toolResult')
      ? JSON.stringify(record.toolResult)
      : '(no output)';
    content = [{ type: 'text', text: legacy } as JsonValue];
  }
  const structuredContent =
    record.structuredContent === undefined
      ? undefined
      : (snapshotJson(record.structuredContent) as JsonValue);
  return {
    result: {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
    },
    isError: record.isError === true,
  };
}

function renderMcpResult(result: McpCanonicalResult, rawName: string): ContentBlock[] {
  return textContent(extractMcpText(result.content, rawName));
}

function extractMcpText(content: readonly JsonValue[], rawName: string): string {
  const parts = content.map((value) => {
    const block = asRecord(value);
    const type = typeof block?.type === 'string' ? block.type : 'unknown';
    if (type === 'text') return typeof block?.text === 'string' ? block.text : '';
    if (type === 'image') {
      return `[image: ${typeof block?.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`;
    }
    if (type === 'audio') {
      return `[audio: ${typeof block?.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`;
    }
    if (type === 'resource' || type === 'resource_link') return '[resource: content discarded]';
    return `[unsupported content type: ${type}]`;
  });
  return parts.join('\n') || `(${rawName} returned no text content)`;
}

function asSchema(value: unknown): Record<string, unknown> {
  return asRecord(snapshotJson(value)) ?? {};
}

function schemaDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function snapshotJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function connectionKey(userId: string, serverId: string): string {
  return `${userId}\0${serverId}`;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : 'Unknown MCP error';
}
