import { z } from 'zod';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import type { LocalUserId } from '../shared/domain/user';
import { textContent, type RuntimeTool } from './tools';

const capabilitySearchInput = z
  .object({
    query: z.string().max(500).default(''),
  })
  .strict();

interface CapabilityDescription {
  name: string;
  description: string;
}

interface SkillCandidate extends CapabilityDescription {
  kind: 'skill';
  load: { tool: 'skill_load'; arguments: { skillName: string } };
}

interface McpCandidate extends CapabilityDescription {
  kind: 'mcp';
  tools: CapabilityDescription[];
  load: { tool: 'mcp_load'; arguments: { serverName: string } };
}

interface CapabilitySourceResult<Candidate> {
  totalAvailable: number;
  candidates: Candidate[];
}

interface CapabilitySearchResult {
  query: string;
  priority: 'equal';
  sources: {
    skill: CapabilitySourceResult<SkillCandidate>;
    mcp: CapabilitySourceResult<McpCandidate>;
  };
  usage: string;
}

export function createCapabilitySearchTool(
  repos: SqliteRepositories,
): RuntimeTool<CapabilitySearchResult> {
  return {
    name: 'capability_search',
    description:
      '同时列出当前用户全部可用的 Skill 与 MCP 名称和完整 description，由你根据任务选择。两类目录同级，不按关键词筛选、相关性打分或限制数量；选中后再调用 skill_load、mcp_load，也可以两者都选或都不使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 500,
          description: '可选的任务目标，仅作为选择上下文原样返回，不用于筛选或排序目录。',
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
      return searchCapabilities(repos, context.userId, input.query);
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
  query = '',
): CapabilitySearchResult {
  return {
    query,
    priority: 'equal',
    sources: { skill: listSkills(repos, userId), mcp: listMcp(repos, userId) },
    usage:
      '这是全部可用的 Skill 与 MCP 轻量目录，不是相关性筛选结果。请根据任务和各项名称、description 自行判断，可选择 Skill、MCP、两者或都不使用。只对选中项调用对应 load；Skill 正文和 MCP 完整工具 Schema 在加载后提供，MCP 工具从下一模型步骤开始可用。',
  };
}

function listSkills(
  repos: SqliteRepositories,
  userId: LocalUserId,
): CapabilitySourceResult<SkillCandidate> {
  const available = repos.skills
    .listInstallations(userId)
    .filter(
      (skill) =>
        skill.enabled && skill.status === 'valid' && skill.compatibilityStatus !== 'incompatible',
    )
    .sort((left, right) => left.skillName.localeCompare(right.skillName));
  return {
    totalAvailable: available.length,
    candidates: available.map((skill) => ({
      kind: 'skill',
      name: skill.skillName,
      description: skill.description,
      load: { tool: 'skill_load', arguments: { skillName: skill.skillName } },
    })),
  };
}

function listMcp(
  repos: SqliteRepositories,
  userId: LocalUserId,
): CapabilitySourceResult<McpCandidate> {
  const servers = repos.mcp
    .listServers(userId)
    .filter((server) => server.status === 'enabled')
    .sort((left, right) => left.name.localeCompare(right.name));
  const toolsByServer = new Map<string, CapabilityDescription[]>();
  for (const tool of repos.mcp.listTools(userId)) {
    if (!tool.enabled || tool.reviewStatus !== 'approved') continue;
    const group = toolsByServer.get(tool.serverId) ?? [];
    group.push({ name: tool.rawName, description: tool.description });
    toolsByServer.set(tool.serverId, group);
  }
  // 保持与 mcp_load 相同的可用性边界，只提供有已审核启用工具的 Server。
  const candidates: McpCandidate[] = servers
    .filter((server) => toolsByServer.has(server.id))
    .map((server) => ({
      kind: 'mcp',
      name: server.name,
      description: server.summary,
      tools: toolsByServer
        .get(server.id)!
        .sort((left, right) => left.name.localeCompare(right.name)),
      load: { tool: 'mcp_load', arguments: { serverName: server.name } },
    }));
  return { totalAvailable: candidates.length, candidates };
}
