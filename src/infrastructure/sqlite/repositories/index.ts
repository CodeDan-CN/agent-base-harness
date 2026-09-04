import type { SqliteDatabase } from '../connection';
import { UserRepository } from './user-repository';
import { SessionRepository } from './session-repository';
import { ModelRepository } from './model-repository';
import { SkillRepository } from './skill-repository';
import { ProjectionRepository } from './projection-repository';
import { McpRepository } from './mcp-repository';
import { CapabilityCategoryRepository } from './capability-category-repository';

/**
 * SQLite 仓储聚合。所有业务读取都携带 userId 作用域，不提供无 Scope 查询。
 */
export class SqliteRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly models: ModelRepository;
  readonly skills: SkillRepository;
  readonly projections: ProjectionRepository;
  readonly mcp: McpRepository;
  readonly categories: CapabilityCategoryRepository;

  constructor(db: SqliteDatabase) {
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
    this.models = new ModelRepository(db);
    this.skills = new SkillRepository(db);
    this.projections = new ProjectionRepository(db);
    this.mcp = new McpRepository(db);
    this.categories = new CapabilityCategoryRepository(db);
  }
}

export { UserRepository } from './user-repository';
export { SessionRepository } from './session-repository';
export { ModelRepository } from './model-repository';
export { SkillRepository } from './skill-repository';
export { ProjectionRepository } from './projection-repository';
export { McpRepository } from './mcp-repository';
export { CapabilityCategoryRepository } from './capability-category-repository';
