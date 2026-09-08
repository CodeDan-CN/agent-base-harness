import { z } from 'zod';
import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import type { LocalUserId } from '../shared/domain/user';
import type { SessionOrigin } from '../shared/domain/agent';
import {
  ToolExecutionError,
  textContent,
  type RuntimeTool,
  type ToolExecutionContext,
} from './tools';

export const CAPABILITY_KINDS = ['skill', 'mcp', 'agent'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export const NO_CAPABILITY_REASON = '当前问题没有合适工具';

const capabilitySearchInput = z
  .object({
    userRequest: z.string().trim().min(1).max(8_000),
    kinds: z.array(z.enum(CAPABILITY_KINDS)).max(3).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export interface CapabilityCandidate {
  kind: CapabilityKind;
  capabilityId: string;
  name: string;
  description: string;
  action: 'skill_load' | 'mcp_load' | 'agent_call';
  scope?: 'agent' | 'user';
}

export interface CapabilitySelectorResult {
  selected: Array<{ capabilityId: string; reason: string }>;
  reason: string;
}

export type CapabilitySelector = (
  input: {
    userRequest: string;
    candidates: readonly CapabilityCandidate[];
    maxSelections: number;
  },
  context: ToolExecutionContext,
) => Promise<CapabilitySelectorResult>;

export interface SelectedCapability extends CapabilityCandidate {
  reason: string;
}

export interface CapabilitySearchResult {
  userRequest: string;
  totalAvailable: number;
  selected: SelectedCapability[];
  reason: string;
}

export function createCapabilitySearchTool(
  repos: SqliteRepositories,
  selectCapabilities: CapabilitySelector,
): RuntimeTool<CapabilitySearchResult> {
  return {
    name: 'capability_search',
    description:
      '根据完整、自包含的 userRequest，在内部复用当前会话模型，从当前智能体已授权的 Skill、MCP 与可调用智能体中做语义选择。不要只传关键词，不要指定候选名称或 ID。',
    parameters: {
      type: 'object',
      properties: {
        userRequest: {
          type: 'string',
          minLength: 1,
          maxLength: 8_000,
          description:
            '根据当前对话消解指代后得到的完整、自包含任务描述；保留用户目标、对象和约束，不要只传关键词。',
        },
        kinds: { type: 'array', items: { enum: CAPABILITY_KINDS }, maxItems: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      required: ['userRequest'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => textContent(value) },
    concurrencySafe: true,
    replaySafe: true,
    timeoutMs: 60_000,
    async execute(raw, context) {
      const input = capabilitySearchInput.parse(raw);
      const session = repos.sessions.getSession(context.userId, context.sessionId);
      if (!session || session.agentId !== context.agentId) return emptyResult(input.userRequest);
      const candidates = listCapabilityCandidates(
        repos,
        context.userId,
        context.agentId,
        session.origin,
        { kinds: input.kinds, sessionId: session.id },
      );
      if (candidates.length === 0) return emptyResult(input.userRequest);

      let selection: CapabilitySelectorResult;
      try {
        selection = await selectCapabilities(
          {
            userRequest: input.userRequest,
            candidates,
            maxSelections: Math.min(input.limit, candidates.length),
          },
          context,
        );
      } catch (error) {
        throw new ToolExecutionError(
          'CAPABILITY_SELECTION_FAILED',
          'retryable_error',
          undefined,
          error instanceof Error ? error.message : 'Capability selection failed',
        );
      }

      const candidateById = new Map(
        candidates.map((candidate) => [candidate.capabilityId, candidate]),
      );
      const selectedIds = new Set<string>();
      const selected = selection.selected.flatMap<SelectedCapability>((match) => {
        const candidate = candidateById.get(match.capabilityId);
        if (!candidate || selectedIds.has(match.capabilityId)) return [];
        selectedIds.add(match.capabilityId);
        return [{ ...candidate, reason: match.reason }];
      });
      if (selected.length !== selection.selected.length || selected.length > input.limit) {
        throw new ToolExecutionError('CAPABILITY_SELECTION_INVALID');
      }
      return {
        userRequest: input.userRequest,
        totalAvailable: candidates.length,
        selected,
        reason: selected.length === 0 ? NO_CAPABILITY_REASON : selection.reason,
      };
    },
    presentCall() {
      return { kind: 'generic', title: '选择能力' };
    },
    presentResult(_args, result) {
      return {
        kind: 'generic',
        title: '选择能力',
        status: result.status === 'success' ? 'success' : 'error',
      };
    },
  };
}

export function listCapabilityCandidates(
  repos: SqliteRepositories,
  userId: LocalUserId,
  agentId: string,
  origin: SessionOrigin,
  options: {
    kinds?: readonly CapabilityKind[];
    sessionId?: string;
  } = {},
): CapabilityCandidate[] {
  const kinds = new Set(options.kinds?.length ? options.kinds : CAPABILITY_KINDS);
  if (!repos.agents.hasSchema || !agentId) return [];
  const bindings = repos.agents.listBindings(userId, agentId);
  const sharedMemoryAllowed =
    origin === 'direct' ||
    (options.sessionId ? delegatedSharedMemoryAllowed(repos, userId, options.sessionId) : false);
  const candidates: CapabilityCandidate[] = [];

  if (kinds.has('skill')) {
    const bound = new Set(bindings.skillIds);
    for (const skill of repos.skills.listInstallations(userId)) {
      if (
        !bound.has(skill.id) ||
        !skill.enabled ||
        skill.status !== 'valid' ||
        skill.compatibilityStatus === 'incompatible'
      )
        continue;
      candidates.push({
        kind: 'skill',
        capabilityId: skill.id,
        name: skill.skillName,
        description: skill.description,
        action: 'skill_load',
      });
    }
  }

  if (kinds.has('mcp')) {
    const tools = repos.mcp.listTools(userId);
    for (const binding of bindings.mcp) {
      if (
        binding.serverId === 'builtin-memory' &&
        binding.accessScope === 'user' &&
        !sharedMemoryAllowed
      )
        continue;
      const server = repos.mcp.getServer(userId, binding.serverId);
      if (!server || server.status !== 'enabled') continue;
      const hasApprovedTool = tools.some(
        (tool) => tool.serverId === server.id && tool.enabled && tool.reviewStatus === 'approved',
      );
      if (!hasApprovedTool) continue;
      candidates.push({
        kind: 'mcp',
        capabilityId: `${server.id}:${binding.accessScope}`,
        name:
          server.id === 'builtin-memory'
            ? binding.accessScope === 'agent'
              ? '本智能体记忆'
              : '用户共享记忆'
            : server.name,
        description: server.summary,
        action: 'mcp_load',
        scope: binding.accessScope,
      });
    }
  }

  if (origin === 'direct' && kinds.has('agent')) {
    const allowed = new Set(bindings.delegateAgentIds);
    for (const profile of repos.agents.list(userId)) {
      if (profile.id === agentId || !allowed.has(profile.id)) continue;
      candidates.push({
        kind: 'agent',
        capabilityId: profile.id,
        name: profile.name,
        description: profile.description,
        action: 'agent_call',
      });
    }
  }

  return candidates.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.capabilityId.localeCompare(right.capabilityId),
  );
}

function delegatedSharedMemoryAllowed(
  repos: SqliteRepositories,
  userId: LocalUserId,
  sessionId: string,
): boolean {
  const session = repos.sessions.getSession(userId, sessionId);
  if (!session) return false;
  const created = repos.sessions
    .listEvents(userId, session.id)
    .find((event) => event.eventType === 'session.created');
  return Boolean(
    created?.payload &&
    typeof created.payload === 'object' &&
    (created.payload as Record<string, unknown>).allowSharedMemory === true,
  );
}

function emptyResult(userRequest: string): CapabilitySearchResult {
  return { userRequest, totalAvailable: 0, selected: [], reason: NO_CAPABILITY_REASON };
}
