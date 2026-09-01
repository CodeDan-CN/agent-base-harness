import { z } from 'zod';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import type { McpServer, McpToolCatalogEntry } from '../shared/domain/mcp';
import type { LocalUserId } from '../shared/domain/user';
import { textContent, type RuntimeTool } from './tools';

const capabilitySearchInput = z
  .object({
    query: z.string().max(500).default(''),
    limitPerSource: z.number().int().min(1).max(10).default(5),
  })
  .strict();

type MatchMode = 'matched' | 'browse' | 'catalog_fallback' | 'empty';

interface CapabilityCandidate {
  kind: 'skill' | 'mcp';
  id: string;
  name: string;
  summary: string;
  highlights: string[];
  load: {
    tool: 'skill_load' | 'mcp_load';
    arguments: Record<string, string>;
  };
}

interface CapabilitySourceResult {
  searched: true;
  matchMode: MatchMode;
  totalAvailable: number;
  candidates: CapabilityCandidate[];
}

interface CapabilitySearchResult {
  query: string;
  priority: 'equal';
  sources: {
    skill: CapabilitySourceResult;
    mcp: CapabilitySourceResult;
  };
  usage: string;
}

interface McpCatalogEntry {
  server: McpServer;
  tool: McpToolCatalogEntry;
}

export function createCapabilitySearchTool(
  repos: SqliteRepositories,
): RuntimeTool<CapabilitySearchResult> {
  return {
    name: 'capability_search',
    description:
      '统一搜索当前用户可用的 Skill 与 MCP 能力。一次调用会同时检索两类目录，按同等优先级返回轻量候选；比较候选后再选择 skill_load、mcp_load、两者或都不使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 500,
          description: '用户目标、能力、领域或操作关键词；省略时浏览两类目录。',
        },
        limitPerSource: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 5,
          description: '每一类来源最多返回多少个候选，Skill 和 MCP 分别计算。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => textContent(value) },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 5_000,
    async execute(raw, context) {
      const input = capabilitySearchInput.parse(raw);
      return searchCapabilities(repos, context.userId, input.query, input.limitPerSource);
    },
    presentCall() {
      return { kind: 'generic', title: '搜索 Skill 与 MCP 能力' };
    },
    presentResult(_args, result) {
      return {
        kind: 'generic',
        title: '搜索 Skill 与 MCP 能力',
        status: result.status === 'success' ? 'success' : 'error',
      };
    },
  };
}

export function searchCapabilities(
  repos: SqliteRepositories,
  userId: LocalUserId,
  rawQuery: string,
  limitPerSource: number,
): CapabilitySearchResult {
  const query = rawQuery.trim().toLocaleLowerCase();
  const terms = searchTerms(query);
  const skill = searchSkills(repos, userId, query, terms, limitPerSource);
  const mcp = searchMcp(repos, userId, query, terms, limitPerSource);
  return {
    query: rawQuery,
    priority: 'equal',
    sources: { skill, mcp },
    usage:
      'Skill 与 MCP 候选同级。根据任务选择 skill_load、mcp_load、同时选择两者，或在候选均不合适时直接继续。只加载被选中的完整内容或 Schema。',
  };
}

function searchSkills(
  repos: SqliteRepositories,
  userId: LocalUserId,
  query: string,
  terms: readonly string[],
  limit: number,
): CapabilitySourceResult {
  const available = repos.skills
    .listInstallations(userId)
    .filter(
      (skill) =>
        skill.enabled && skill.status === 'valid' && skill.compatibilityStatus !== 'incompatible',
    );
  const ranked = available
    .map((skill) => ({
      skill,
      score: candidateScore(
        query,
        terms,
        skill.skillName,
        skill.description,
        JSON.stringify(skill.metadata),
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.skill.skillName.localeCompare(right.skill.skillName),
    );
  const selected = selectRanked(ranked, query, limit);
  return {
    searched: true,
    matchMode: matchMode(available.length, query, selected.fallback),
    totalAvailable: available.length,
    candidates: selected.items.map(({ skill }) => ({
      kind: 'skill',
      id: `skill:${skill.skillName}`,
      name: skill.skillName,
      summary: conciseDescription(skill.description),
      highlights: metadataHighlights(skill.metadata),
      load: { tool: 'skill_load', arguments: { skillName: skill.skillName } },
    })),
  };
}

function searchMcp(
  repos: SqliteRepositories,
  userId: LocalUserId,
  query: string,
  terms: readonly string[],
  limit: number,
): CapabilitySourceResult {
  const servers = new Map(
    repos.mcp
      .listServers(userId)
      .filter((server) => server.status === 'enabled')
      .map((server) => [server.id, server] as const),
  );
  const entries = repos.mcp
    .listTools(userId)
    .filter(
      (tool) => tool.enabled && tool.reviewStatus === 'approved' && servers.has(tool.serverId),
    )
    .map((tool) => ({ tool, server: servers.get(tool.serverId)! }));
  const grouped = new Map<string, McpCatalogEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.server.id) ?? [];
    group.push(entry);
    grouped.set(entry.server.id, group);
  }
  const ranked = [...grouped.values()]
    .map((group) => {
      const server = group[0]!.server;
      const scoredTools = group
        .map((entry) => ({
          entry,
          score: candidateScore(
            query,
            terms,
            `${server.name} ${entry.tool.rawName} ${entry.tool.publicName}`,
            `${server.summary} ${entry.tool.description}`,
          ),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.entry.tool.publicName.localeCompare(right.entry.tool.publicName),
        );
      return {
        server,
        tools: scoredTools,
        score: Math.max(
          candidateScore(query, terms, server.name, server.summary),
          ...scoredTools.map(({ score }) => score),
        ),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.server.name.localeCompare(right.server.name),
    );
  const selected = selectRanked(ranked, query, limit);
  return {
    searched: true,
    matchMode: matchMode(grouped.size, query, selected.fallback),
    totalAvailable: grouped.size,
    candidates: selected.items.map(({ server, tools }) => ({
      kind: 'mcp',
      id: `mcp:${server.name}`,
      name: server.name,
      summary: conciseDescription(server.summary),
      highlights: tools.slice(0, 5).map(({ entry }) => {
        const parameters = parameterNames(entry.tool.inputSchema);
        const suffix = parameters.length > 0 ? ` (${parameters.join(', ')})` : '';
        return `${entry.tool.rawName}${suffix}: ${conciseDescription(entry.tool.description)}`;
      }),
      load: { tool: 'mcp_load', arguments: { serverName: server.name } },
    })),
  };
}

function selectRanked<T extends { score: number }>(
  ranked: readonly T[],
  query: string,
  limit: number,
): { items: T[]; fallback: boolean } {
  if (!query) return { items: ranked.slice(0, limit), fallback: false };
  const matched = ranked.filter(({ score }) => score > 0);
  if (matched.length > 0) return { items: matched.slice(0, limit), fallback: false };
  return { items: ranked.slice(0, limit), fallback: ranked.length > 0 };
}

function matchMode(total: number, query: string, fallback: boolean): MatchMode {
  if (total === 0) return 'empty';
  if (!query) return 'browse';
  return fallback ? 'catalog_fallback' : 'matched';
}

function candidateScore(
  query: string,
  terms: readonly string[],
  name: string,
  summary = '',
  extra = '',
): number {
  if (!query) return 1;
  const normalizedName = name.toLocaleLowerCase();
  const normalizedSummary = summary.toLocaleLowerCase();
  const normalizedExtra = extra.toLocaleLowerCase();
  if (normalizedName === query) return 1_000;
  let score = 0;
  for (const term of terms) {
    if (normalizedName.includes(term)) score += 100;
    if (normalizedSummary.includes(term)) score += 30;
    if (normalizedExtra.includes(term)) score += 10;
  }
  return score;
}

function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4) terms.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    } else if (token.length > 1) {
      terms.add(token);
    }
  }
  if (terms.size === 0 && query) terms.add(query);
  return [...terms];
}

function metadataHighlights(metadata: Record<string, unknown>): string[] {
  const highlights: string[] = [];
  for (const key of ['capabilities', 'keywords', 'tags']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) highlights.push(value.trim());
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) highlights.push(item.trim());
      }
    }
  }
  return [...new Set(highlights)].slice(0, 8);
}

function conciseDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 297)}...`;
}

function parameterNames(schema: Record<string, unknown>): string[] {
  const properties = asRecord(schema.properties);
  return properties ? Object.keys(properties).slice(0, 12) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
