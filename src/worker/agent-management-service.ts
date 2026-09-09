import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { ensureAgentMemoryProfile } from '../infrastructure/workspace/agent-memory-profile';
import { userMemoryProfilePath } from '../infrastructure/workspace/session-workspace';
import { readFileSync } from 'node:fs';
import type { Clock, IdProvider } from '../shared/domain/ports';
import type { LocalUserId } from '../shared/domain/user';
import type {
  AgentCreateParams,
  AgentManagementSnapshot,
  AgentRuntimeDefaultsSetParams,
  AgentUpdateParams,
} from '../shared/contracts/agent-management';
import type { AgentProfile } from '../shared/domain/agent';
import { DEFAULT_AGENT_ID } from '../shared/domain/agent';
import { BUNDLED_MEMORY_SERVER_ID } from '../runtime/mcp/bundled-memory';
import { BUILTIN_SKILL_CREATOR_NAME } from '../infrastructure/skills/generated-skill-publisher';
import { BridgeError } from '../shared/contracts/errors';

export class AgentManagementService {
  constructor(
    private readonly deps: {
      repos: SqliteRepositories;
      appDataDir: string;
      clock: Clock;
      ids: IdProvider;
    },
  ) {}

  initializeUserRecords(userId: LocalUserId): void {
    this.deps.repos.agents.ensureDylan(userId, 'guarded', this.deps.clock.nowIso());
  }

  initializeUser(userId: LocalUserId): void {
    const now = this.deps.clock.nowIso();
    this.initializeUserRecords(userId);
    const legacy = readLegacyMemory(this.deps.appDataDir, userId);
    for (const agent of this.deps.repos.agents.list(userId, true)) {
      ensureAgentMemoryProfile(
        this.deps.appDataDir,
        userId,
        agent.id,
        agent.id === DEFAULT_AGENT_ID ? legacy : '',
      );
      this.ensurePrivateMemory(userId, agent.id, now);
    }
    const creator = this.deps.repos.skills.getInstallation(userId, BUILTIN_SKILL_CREATOR_NAME);
    if (creator) {
      this.deps.repos.agents.ensureSkillBinding(userId, DEFAULT_AGENT_ID, creator.id, now);
    }
  }

  snapshot(userId: LocalUserId): AgentManagementSnapshot {
    const revisions = this.deps.repos.users.getRevisions(userId);
    const agents = this.deps.repos.agents.list(userId, true);
    return {
      revision: revisions.agentRevision,
      defaultAgentId: this.deps.repos.agents.getDefault(userId).id,
      agents: agents.map((profile) => ({
        profile,
        bindings: this.deps.repos.agents.listBindings(userId, profile.id),
      })),
      homeAgentIds: this.deps.repos.agents.listHome(userId).map((item) => item.agentId),
    };
  }

  delegation(userId: LocalUserId, delegationId: string) {
    const delegation = this.deps.repos.delegations.get(userId, delegationId);
    if (!delegation) throw new BridgeError('INVALID_REQUEST', 'Delegation not found');
    return delegation;
  }

  create(userId: LocalUserId, input: AgentCreateParams): AgentProfile {
    this.assertModelAvailable(userId, input.defaultModelId);
    const now = this.deps.clock.nowIso();
    const profile = this.deps.repos.agents.create({
      id: this.deps.ids.newId(),
      userId,
      name: input.name,
      description: input.description,
      avatarKey: input.avatarKey,
      instructions: input.instructions,
      defaultModelId: input.defaultModelId,
      permissionPreset: input.permissionPreset,
      expectedRevision: input.expectedRevision,
      now,
    });
    ensureAgentMemoryProfile(this.deps.appDataDir, userId, profile.id);
    this.ensurePrivateMemory(userId, profile.id, now);
    return profile;
  }

  update(userId: LocalUserId, input: AgentUpdateParams): AgentProfile {
    const current = this.deps.repos.agents.requireActive(userId, input.agentId);
    this.assertModelAvailable(userId, input.defaultModelId);
    const now = this.deps.clock.nowIso();
    return this.deps.repos.transaction(() => {
      const profile = this.deps.repos.agents.update({
        userId,
        agentId: input.agentId,
        name: input.name,
        description: input.description,
        avatarKey: input.avatarKey,
        instructions: input.instructions,
        defaultModelId: input.defaultModelId,
        permissionPreset: input.permissionPreset,
        expectedRevision: input.expectedRevision,
        expectedProfileRevision: input.expectedProfileRevision,
        now,
      });
      if (current.permissionPreset !== input.permissionPreset) {
        this.deps.repos.sessions.setPermissionPresetForAgent(
          userId,
          input.agentId,
          input.permissionPreset,
          now,
        );
      }
      return profile;
    });
  }

  setRuntimeDefaults(userId: LocalUserId, input: AgentRuntimeDefaultsSetParams): AgentProfile {
    const current = this.deps.repos.agents.requireActive(userId, input.agentId);
    this.assertModelAvailable(userId, input.defaultModelId);
    const now = this.deps.clock.nowIso();
    return this.deps.repos.transaction(() => {
      const profile = this.deps.repos.agents.update({
        userId,
        agentId: input.agentId,
        name: current.name,
        description: current.description,
        avatarKey: current.avatarKey,
        instructions: current.instructions,
        defaultModelId: input.defaultModelId,
        permissionPreset: input.permissionPreset,
        expectedRevision: input.expectedRevision,
        expectedProfileRevision: input.expectedProfileRevision,
        now,
      });
      if (current.permissionPreset !== input.permissionPreset) {
        this.deps.repos.sessions.setPermissionPresetForAgent(
          userId,
          input.agentId,
          input.permissionPreset,
          now,
        );
      }
      return profile;
    });
  }

  archive(userId: LocalUserId, agentId: string, expectedRevision: number): { agentId: string } {
    this.deps.repos.agents.archive(userId, agentId, expectedRevision, this.deps.clock.nowIso());
    return { agentId };
  }

  setDefault(userId: LocalUserId, agentId: string, expectedRevision: number): { agentId: string } {
    this.deps.repos.agents.setDefault(userId, agentId, expectedRevision, this.deps.clock.nowIso());
    return { agentId };
  }

  addHome(userId: LocalUserId, agentId: string, expectedRevision: number): { agentId: string } {
    this.deps.repos.agents.addHome(userId, agentId, expectedRevision, this.deps.clock.nowIso());
    return { agentId };
  }

  removeHome(userId: LocalUserId, agentId: string, expectedRevision: number): { agentId: string } {
    this.deps.repos.agents.removeHome(userId, agentId, expectedRevision, this.deps.clock.nowIso());
    return { agentId };
  }

  reorderHome(
    userId: LocalUserId,
    agentIds: readonly string[],
    expectedRevision: number,
  ): { agentIds: string[] } {
    this.deps.repos.agents.reorderHome(
      userId,
      agentIds,
      expectedRevision,
      this.deps.clock.nowIso(),
    );
    return { agentIds: [...agentIds] };
  }

  toggleSkill(
    userId: LocalUserId,
    agentId: string,
    skillId: string,
    enabled: boolean,
    expectedRevision: number,
  ): { revision: number } {
    const skill = this.deps.repos.skills
      .listInstallations(userId)
      .find((candidate) => candidate.id === skillId && candidate.status !== 'missing');
    if (!skill) throw new Error('Skill not found');
    this.deps.repos.agents.setSkillBinding(
      userId,
      agentId,
      skillId,
      enabled,
      expectedRevision,
      this.deps.clock.nowIso(),
    );
    return { revision: this.deps.repos.users.getRevisions(userId).agentRevision };
  }

  toggleMcp(
    userId: LocalUserId,
    agentId: string,
    serverId: string,
    accessScope: 'user' | 'agent',
    enabled: boolean,
    expectedRevision: number,
  ): { revision: number } {
    const server = this.deps.repos.mcp.getServer(userId, serverId);
    if (!server || server.status === 'archived') throw new Error('MCP server not found');
    if (serverId !== BUNDLED_MEMORY_SERVER_ID && accessScope !== 'user') {
      throw new Error('Only built-in memory supports agent scope');
    }
    this.deps.repos.agents.setMcpBinding(
      userId,
      agentId,
      serverId,
      accessScope,
      enabled,
      expectedRevision,
      this.deps.clock.nowIso(),
    );
    return { revision: this.deps.repos.users.getRevisions(userId).agentRevision };
  }

  toggleDelegate(
    userId: LocalUserId,
    callerAgentId: string,
    calleeAgentId: string,
    enabled: boolean,
    expectedRevision: number,
  ): { revision: number } {
    this.deps.repos.agents.setDelegateBinding(
      userId,
      callerAgentId,
      calleeAgentId,
      enabled,
      expectedRevision,
      this.deps.clock.nowIso(),
    );
    return { revision: this.deps.repos.users.getRevisions(userId).agentRevision };
  }

  private ensurePrivateMemory(userId: LocalUserId, agentId: string, now: string): void {
    this.deps.repos.agents.ensureMcpBinding(
      userId,
      agentId,
      BUNDLED_MEMORY_SERVER_ID,
      'agent',
      now,
    );
  }

  private assertModelAvailable(userId: LocalUserId, modelId: string | null): void {
    if (!modelId) return;
    const model = this.deps.repos.models.getModel(userId, modelId);
    if (!model || model.status !== 'enabled') {
      throw new BridgeError('MODEL_NOT_CONFIGURED', 'Selected model is unavailable');
    }
  }
}

function readLegacyMemory(appDataDir: string, userId: string): string {
  try {
    return readFileSync(userMemoryProfilePath(appDataDir, userId), 'utf8');
  } catch {
    return '';
  }
}
