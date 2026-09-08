import type { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import type { LocalUserId } from '../shared/domain/user';
import type { AgentNavigationSnapshot } from '../shared/contracts/agent-management';

export class AgentNavigationService {
  constructor(private readonly repos: SqliteRepositories) {}

  snapshot(userId: LocalUserId, sessionsPerAgent = 20): AgentNavigationSnapshot {
    const home = this.repos.agents.listHome(userId);
    const homeIds = new Set(home.map((item) => item.agentId));
    return {
      revision: this.repos.users.getRevisions(userId).agentRevision,
      defaultAgentId: this.repos.agents.getDefault(userId).id,
      items: home.map((item) => ({
        agent: this.repos.agents.requireActive(userId, item.agentId),
        sortOrder: item.sortOrder,
        sessions: this.repos.sessions
          .listByAgent(userId, item.agentId, 'direct', sessionsPerAgent)
          .map((session) => ({ ...session, origin: 'direct' as const, parentSessionId: null })),
      })),
      availableToAdd: this.repos.agents.list(userId).filter((agent) => !homeIds.has(agent.id)),
    };
  }
}
