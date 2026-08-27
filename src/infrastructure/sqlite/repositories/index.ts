import type { SqliteDatabase } from '../connection';
import { UserRepository } from './user-repository';
import { SessionRepository } from './session-repository';
import { ModelRepository } from './model-repository';
import { SkillRepository } from './skill-repository';
import { ProjectionRepository } from './projection-repository';

/**
 * SQLite 仓储聚合。所有业务读取都携带 userId 作用域，不提供无 Scope 查询。
 */
export class SqliteRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly models: ModelRepository;
  readonly skills: SkillRepository;
  readonly projections: ProjectionRepository;

  constructor(db: SqliteDatabase) {
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
    this.models = new ModelRepository(db);
    this.skills = new SkillRepository(db);
    this.projections = new ProjectionRepository(db);
  }
}

export { UserRepository } from './user-repository';
export { SessionRepository } from './session-repository';
export { ModelRepository } from './model-repository';
export { SkillRepository } from './skill-repository';
export { ProjectionRepository } from './projection-repository';
