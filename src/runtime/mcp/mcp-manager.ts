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
  BUNDLED_MEMORY_SERVER_ID,
  BUNDLED_NODE_COMMAND,
} from './bundled-memory';
import {
  McpInstanceCapacityError,
  McpInstanceManager,
  type McpInstanceKey,
  type McpInstanceView,
} from './mcp-instance-manager';

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

const mcpLoadInput = z.object({ capabilityId: z.string().min(1).max(260) }).strict();
// MCP 服务会在模型调用期间发送 progress 心跳：90 秒无心跳才认为空闲超时，
// 单次工具调用仍有 10 分钟硬上限，避免无限续期。
const MCP_TOOL_IDLE_TIMEOUT_MS = 90_000;
const MCP_TOOL_MAX_TOTAL_TIMEOUT_MS = 10 * 60_000;

interface InstanceRoute {
  scopeType: 'user' | 'agent';
  scopeId: string;
}

export class McpManager {
  private readonly instances = new McpInstanceManager<Client>();
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
    }
  }

  async refreshServer(userId: LocalUserId, serverId: string): Promise<number> {
    const server = this.requireEnabledServer(userId, serverId);
    const route = userRoute(server.userId);
    const lease = await this.acquire(server, route);
    try {
      const count = await lease.runExclusive((client) =>
        this.discover(server, client, lease.generation),
      );
      this.rebuildUserTools(userId);
      return count;
    } finally {
      lease.release();
    }
  }

  async testServer(server: McpServer): Promise<{ toolCount: number }> {
    const stored = this.deps.repos.mcp.getServer(server.userId, server.id);
    if (stored && connectionFingerprint(stored) !== connectionFingerprint(server)) {
      await this.instances.invalidate(server.userId, server.id);
    }
    const lease = await this.acquire(server, userRoute(server.userId));
    try {
      return {
        toolCount: await lease.runExclusive(async (client) => (await listAllTools(client)).length),
      };
    } finally {
      lease.release();
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
      catalog.tools.length === 0 ? [] : [this.createLoadTool(userId)],
    );
  }

  instanceSnapshot(userId: LocalUserId): readonly McpInstanceView[] {
    return this.instances.snapshot(userId);
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const user of this.deps.repos.users.listUsers()) {
      this.deps.tools.clearUserTools(user.id);
    }
    await this.instances.close();
  }

  private async openConnection(
    server: McpServer,
    route: InstanceRoute,
    instanceKey: McpInstanceKey,
  ): Promise<Client> {
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
    client.onclose = () => {
      this.instances.connectionClosed(instanceKey, client);
      if (this.disposed) return;
      this.deps.repos.mcp.setConnectionStatus(
        server.userId,
        server.id,
        'error',
        generation,
        'Connection closed',
        this.deps.clock.nowIso(),
      );
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.discover(server, client, generation);
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
      await client.connect(await this.createTransport(server, route));
      if (this.disposed) throw new Error('MCP manager disposed');
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

  private async acquire(server: McpServer, route: InstanceRoute, signal?: AbortSignal) {
    const key = instanceKey(server.userId, server.id, route);
    const backoffMs = [100, 500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.instances.acquire({
          key,
          signal,
          open: () => this.openConnection(server, route, key),
        });
      } catch (error) {
        if (error instanceof McpInstanceCapacityError) {
          throw new ToolExecutionError('MCP_CAPACITY_EXCEEDED');
        }
        if (signal?.aborted || attempt >= backoffMs.length) throw error;
        await abortableDelay(backoffMs[attempt]!, signal);
      }
    }
  }

  private createClient(_server: McpServer): Client {
    return new Client({ name: 'agent-base-harness', version: '0.1.0' }, { capabilities: {} });
  }

  private async createTransport(server: McpServer, route: InstanceRoute): Promise<Transport> {
    if (server.transport === 'stdio') {
      const config = server.config as McpStdioConfig;
      const base = instanceDataRoot(this.deps.appDataDir, server.userId, server.id, route);
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
      const home = path.join(base, 'home');
      const temporary = path.join(base, 'tmp');
      await Promise.all([mkdir(home, { recursive: true }), mkdir(temporary, { recursive: true })]);
      const launch = stdioSandboxCommand(command, args, base);
      return new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        cwd,
        env: {
          ...getDefaultEnvironment(),
          HOME: home,
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
          ...configuredEnv,
        },
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

  private async discover(server: McpServer, client: Client, generation: number): Promise<number> {
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
        defaultApprovalPolicy: defaultMcpApprovalPolicy(server, tool.name),
      };
    });
    this.deps.repos.mcp.replaceDiscoveredTools(
      server.userId,
      server.id,
      generation,
      tools,
      this.deps.clock.nowIso(),
    );
    return tools.length;
  }

  private createRuntimeTool(
    tool: McpToolCatalogEntry,
    server: McpServer,
    route: InstanceRoute,
  ): RuntimeTool<unknown> {
    const exposedName =
      server.id === BUNDLED_MEMORY_SERVER_ID
        ? publicToolName(`${server.name}_${route.scopeType}`, tool.rawName)
        : tool.publicName;
    return {
      name: exposedName,
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
      approvalPolicy: tool.approvalPolicy,
      approvalScope: 'external',
      permissionIdentity: `mcp:${server.id}:${tool.rawName}:${tool.schemaDigest}`,
      timeoutMs: MCP_TOOL_MAX_TOTAL_TIMEOUT_MS + 5_000,
      execute: async (raw, context) => {
        const binding = (
          context.executionConfig?.mcpBindings ??
          this.deps.repos.agents.listBindings(context.userId, context.agentId).mcp
        ).some(
          (candidate) =>
            candidate.serverId === server.id && candidate.accessScope === route.scopeType,
        );
        if (
          !binding ||
          route.scopeId !== (route.scopeType === 'agent' ? context.agentId : context.userId)
        ) {
          throw new ToolExecutionError('MCP_TOOL_NOT_AVAILABLE');
        }
        const current = this.availableCatalog(context.userId).tools.find(
          (entry) =>
            entry.tool.publicName === tool.publicName &&
            entry.tool.schemaDigest === tool.schemaDigest,
        );
        if (!current) {
          const schemaChanged = this.availableCatalog(context.userId).tools.some(
            (entry) =>
              entry.server.id === server.id &&
              entry.tool.rawName === tool.rawName &&
              entry.tool.schemaDigest !== tool.schemaDigest,
          );
          throw new ToolExecutionError(
            schemaChanged ? 'MCP_SCHEMA_CHANGED' : 'MCP_TOOL_NOT_AVAILABLE',
          );
        }
        const currentServer = current.server;
        const result = await (async () => {
          const lease = await this.acquire(currentServer, route, context.signal);
          try {
            return await lease.runExclusive(
              (client) =>
                client.callTool(
                  {
                    name: tool.rawName,
                    arguments: asRecord(raw) ?? {},
                  },
                  undefined,
                  {
                    signal: context.signal,
                    timeout: MCP_TOOL_IDLE_TIMEOUT_MS,
                    maxTotalTimeout: MCP_TOOL_MAX_TOTAL_TIMEOUT_MS,
                    resetTimeoutOnProgress: true,
                    onprogress: (progress) => {
                      const message = progress.message ?? '服务仍在执行';
                      this.deps.logger.info('MCP 工具收到进度', {
                        serverId: server.id,
                        serverName: server.name,
                        toolName: tool.rawName,
                        progress: progress.progress,
                        total: progress.total,
                        message,
                      });
                      context.reportProgress?.({
                        toolCallId: context.toolCallId,
                        progress: progress.progress,
                        ...(progress.total === undefined ? {} : { total: progress.total }),
                        message,
                      });
                    },
                  },
                ),
              context.signal,
            );
          } finally {
            lease.release();
          }
        })();
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
      presentCall(args) {
        return {
          kind: 'generic',
          title: mcpActionTitle(tool.rawName),
          detail: summarizeMcpArguments(args) ?? `服务：${server.name}`,
        };
      },
      presentResult(_args, result) {
        return {
          kind: 'generic',
          title: tool.description || tool.rawName,
          detail: `${server.name} · ${route.scopeType === 'agent' ? '本智能体' : '用户共享'}`,
          status: result.status === 'success' ? 'success' : 'error',
        };
      },
    };
  }

  private createLoadTool(userId: LocalUserId): RuntimeTool<unknown> {
    return {
      name: 'mcp_load',
      description:
        '按 capability_search 返回的 capabilityId 按需连接 MCP 实例、校验目录，并从下一模型步骤暴露已审核工具 Schema。',
      parameters: {
        type: 'object',
        properties: {
          capabilityId: {
            type: 'string',
            minLength: 1,
            maxLength: 260,
            description: 'capability_search 返回的 MCP capabilityId。',
          },
        },
        required: ['capabilityId'],
        additionalProperties: false,
      },
      output: { schema: {}, render: (_args, value) => textContent(value) },
      concurrencySafe: false,
      replaySafe: true,
      exclusive: true,
      timeoutMs: 120_000,
      execute: async (raw, context) => {
        if (context.userId !== userId) throw new ToolExecutionError('MCP_CATALOG_NOT_AVAILABLE');
        const input = mcpLoadInput.parse(raw);
        const separator = input.capabilityId.lastIndexOf(':');
        if (separator <= 0) throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        const serverId = input.capabilityId.slice(0, separator);
        const scopeType = input.capabilityId.slice(separator + 1);
        if (scopeType !== 'user' && scopeType !== 'agent') {
          throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        }
        const binding = (
          context.executionConfig?.mcpBindings ??
          this.deps.repos.agents.listBindings(userId, context.agentId).mcp
        ).find(
          (candidate) => candidate.serverId === serverId && candidate.accessScope === scopeType,
        );
        if (!binding) throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        const session = this.deps.repos.sessions.getSession(userId, context.sessionId);
        if (!session || session.agentId !== context.agentId) {
          throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        }
        if (
          serverId === BUNDLED_MEMORY_SERVER_ID &&
          scopeType === 'user' &&
          session.origin === 'delegated' &&
          !sharedMemoryAllowed(this.deps.repos, userId, session.id)
        ) {
          throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        }
        const catalog = this.availableCatalog(userId);
        const server = catalog.servers.get(serverId);
        if (!server) throw new ToolExecutionError('MCP_SERVER_NOT_AVAILABLE');
        const route: InstanceRoute = {
          scopeType,
          scopeId: scopeType === 'agent' ? context.agentId : context.userId,
        };
        const lease = await this.acquire(server, route, context.signal);
        try {
          await lease.runExclusive(
            (client) => this.discover(server, client, lease.generation),
            context.signal,
          );
        } finally {
          lease.release();
        }
        const entries = this.availableCatalog(userId).tools.filter(
          (entry) => entry.server.id === serverId,
        );
        if (entries.length === 0) {
          throw new ToolExecutionError(
            'MCP_SERVER_NOT_AVAILABLE',
            'fatal_error',
            { capabilityId: input.capabilityId },
            `MCP Server is not available or has no enabled tools: ${input.capabilityId}`,
          );
        }
        this.deps.tools.exposeTurnTools(
          userId,
          context.sessionId,
          context.turnId,
          entries.map(({ tool, server }) => this.createRuntimeTool(tool, server, route)),
        );
        const toolNames = entries.map(({ tool, server }) =>
          server.id === BUNDLED_MEMORY_SERVER_ID
            ? publicToolName(`${server.name}_${route.scopeType}`, tool.rawName)
            : tool.publicName,
        );
        return {
          capabilityId: input.capabilityId,
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

  private async disconnect(userId: LocalUserId, serverId: string): Promise<void> {
    const generation = this.deps.repos.mcp.getServer(userId, serverId)?.generation ?? 0;
    await this.instances.invalidate(userId, serverId);
    this.deps.repos.mcp.setConnectionStatus(
      userId,
      serverId,
      'disconnected',
      generation,
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

function mcpActionTitle(rawName: string): string {
  const normalized = rawName.toLowerCase();
  if (/web[_-]?search|search[_-]?web|search[_-]?exa/.test(normalized)) return '联网搜索';
  if (/web[_-]?fetch|fetch[_-]?url|read[_-]?url/.test(normalized)) return '读取网页';
  if (/\bdelete\b|[_-]delete|remove/.test(normalized)) return '删除外部数据';
  if (/\bsend\b|[_-]send|message|email/.test(normalized)) return '发送外部内容';
  if (/\bwrite\b|[_-]write|create|update|edit/.test(normalized)) return '修改外部数据';
  if (/\bread\b|[_-]read|list|get|search/.test(normalized)) return '读取外部数据';
  return rawName.replace(/[_-]+/g, ' ').trim() || '外部工具调用';
}

function summarizeMcpArguments(value: unknown): string | undefined {
  const args = asRecord(value);
  if (!args) return undefined;
  const preferred: Array<[string, string]> = [
    ['query', '搜索内容'],
    ['url', '访问地址'],
    ['prompt', '请求内容'],
    ['path', '目标'],
    ['name', '对象'],
  ];
  for (const [key, label] of preferred) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return `${label}：${truncatePresentation(candidate.trim())}`;
    }
  }
  const compact = JSON.stringify(args);
  return compact && compact !== '{}' ? `调用参数：${truncatePresentation(compact)}` : undefined;
}

function truncatePresentation(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}…` : value;
}

const BUNDLED_MEMORY_READ_TOOLS = new Set(['open_nodes', 'read_graph', 'search_nodes']);

function defaultMcpApprovalPolicy(
  server: McpServer,
  rawName: string,
): McpToolCatalogEntry['approvalPolicy'] {
  if (server.id === BUNDLED_MEMORY_SERVER_ID && BUNDLED_MEMORY_READ_TOOLS.has(rawName)) {
    return 'never';
  }
  return 'always';
}

function stdioSandboxCommand(
  command: string,
  args: string[],
  writableRoot: string,
): { command: string; args: string[] } {
  if (process.platform !== 'darwin') {
    throw new Error('Restricted MCP stdio sandbox is unavailable on this platform');
  }
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (subpath ' + JSON.stringify(writableRoot) + '))',
  ].join('\n');
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, command, ...args],
  };
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

function connectionFingerprint(server: McpServer): string {
  return schemaDigest({
    transport: server.transport,
    config: server.config,
    credentialRef: server.credentialRef,
  });
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

function instanceKey(userId: string, serverId: string, route: InstanceRoute): McpInstanceKey {
  return { userId, serverId, scopeType: route.scopeType, scopeId: route.scopeId };
}

function userRoute(userId: string): InstanceRoute {
  return { scopeType: 'user', scopeId: userId };
}

function instanceDataRoot(
  appDataDir: string,
  userId: string,
  serverId: string,
  route: InstanceRoute,
): string {
  const user = encodeURIComponent(userId);
  const server = encodeURIComponent(serverId);
  return route.scopeType === 'agent'
    ? path.join(
        appDataDir,
        'mcp',
        'users',
        user,
        'agents',
        encodeURIComponent(route.scopeId),
        server,
      )
    : path.join(appDataDir, 'mcp', 'users', user, 'user', server);
}

function sharedMemoryAllowed(
  repos: SqliteRepositories,
  userId: LocalUserId,
  sessionId: string,
): boolean {
  const created = repos.sessions
    .listEvents(userId, sessionId)
    .find((event) => event.eventType === 'session.created');
  return Boolean(
    created?.payload &&
    typeof created.payload === 'object' &&
    (created.payload as Record<string, unknown>).allowSharedMemory === true,
  );
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : 'Unknown MCP error';
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted'));
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(signal?.reason ?? new Error('Operation aborted'));
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, milliseconds);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
  });
}
