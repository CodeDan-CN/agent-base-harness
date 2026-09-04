import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import { BridgeError } from '../../../shared/contracts/errors';
import {
  MEMORY_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_ID,
  type CapabilityCategory,
  type CapabilityCategoryType,
} from '../../../shared/domain/capability-category';
import type { LocalUserId } from '../../../shared/domain/user';

interface CategoryRow {
  id: string;
  user_id: string;
  type: CapabilityCategoryType;
  name: string;
  sort_order: number;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export class CapabilityCategoryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  ensureDefaults(userId: LocalUserId, type: CapabilityCategoryType, now: string): void {
    const insert = this.db.prepare(
      `INSERT INTO capability_categories
         (id, user_id, type, name, sort_order, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, type, id) DO NOTHING`,
    );
    const transaction = this.db.transaction(() => {
      insert.run(UNCATEGORIZED_CATEGORY_ID, userId, type, '未分类', 1_000_000, 1, now, now);
    });
    transaction();
  }

  ensureMemoryDefault(userId: LocalUserId, now: string): void {
    this.db
      .prepare(
        `INSERT INTO capability_categories
         (id, user_id, type, name, sort_order, is_system, created_at, updated_at)
         VALUES (?, ?, 'mcp', '记忆', 10, 0, ?, ?)
         ON CONFLICT(user_id, type, id) DO NOTHING`,
      )
      .run(MEMORY_CATEGORY_ID, userId, now, now);
  }

  list(userId: LocalUserId, type: CapabilityCategoryType): CapabilityCategory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM capability_categories
         WHERE user_id = ? AND type = ?
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC`,
      )
      .all(userId, type) as CategoryRow[];
    return rows.map(mapCategory);
  }

  get(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
  ): CapabilityCategory | undefined {
    const row = this.db
      .prepare('SELECT * FROM capability_categories WHERE user_id = ? AND type = ? AND id = ?')
      .get(userId, type, id) as CategoryRow | undefined;
    return row ? mapCategory(row) : undefined;
  }

  create(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
    name: string,
    now: string,
  ): void {
    try {
      const transaction = this.db.transaction(() => {
        const row = this.db
          .prepare(
            `SELECT COALESCE(MAX(sort_order), 0) AS value
             FROM capability_categories WHERE user_id = ? AND type = ? AND id <> ?`,
          )
          .get(userId, type, UNCATEGORIZED_CATEGORY_ID) as { value: number };
        this.db
          .prepare(
            `INSERT INTO capability_categories
               (id, user_id, type, name, sort_order, is_system, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(id, userId, type, name, row.value + 10, now, now);
        this.bumpRevision(userId, type, now);
      });
      transaction();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  rename(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
    name: string,
    now: string,
  ): void {
    try {
      const transaction = this.db.transaction(() => {
        const category = this.requireMutable(userId, type, id);
        const changed = this.db
          .prepare(
            `UPDATE capability_categories SET name = ?, updated_at = ?
             WHERE user_id = ? AND type = ? AND id = ?`,
          )
          .run(name, now, userId, type, category.id);
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'Category not found');
        this.bumpRevision(userId, type, now);
      });
      transaction();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  delete(userId: LocalUserId, type: CapabilityCategoryType, id: string, now: string): void {
    try {
      const transaction = this.db.transaction(() => {
        this.requireMutable(userId, type, id);
        const table = type === 'skill' ? 'skill_installations' : 'mcp_servers';
        this.db
          .prepare(
            `UPDATE ${table} SET category_id = ?, updated_at = ?
             WHERE user_id = ? AND category_id = ?`,
          )
          .run(UNCATEGORIZED_CATEGORY_ID, now, userId, id);
        this.db
          .prepare('DELETE FROM capability_categories WHERE user_id = ? AND type = ? AND id = ?')
          .run(userId, type, id);
        this.bumpRevision(userId, type, now);
      });
      transaction();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  setSkillCategory(userId: LocalUserId, skillName: string, categoryId: string, now: string): void {
    try {
      const transaction = this.db.transaction(() => {
        this.requireCategory(userId, 'skill', categoryId);
        const changed = this.db
          .prepare(
            `UPDATE skill_installations SET category_id = ?, updated_at = ?
             WHERE user_id = ? AND skill_name = ?`,
          )
          .run(categoryId, now, userId, skillName);
        if (changed.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'Skill not found');
        this.bumpSkillRevision(userId, now);
      });
      transaction();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private requireCategory(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
  ): CapabilityCategory {
    const category = this.get(userId, type, id);
    if (!category) throw new BridgeError('INVALID_REQUEST', 'Category not found');
    return category;
  }

  private requireMutable(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
  ): CapabilityCategory {
    const category = this.requireCategory(userId, type, id);
    if (category.system)
      throw new BridgeError('INVALID_REQUEST', 'System category cannot be changed');
    return category;
  }

  private bumpSkillRevision(userId: LocalUserId, now: string): void {
    this.db
      .prepare(
        `UPDATE user_config_revisions
         SET skill_revision = skill_revision + 1, updated_at = ? WHERE user_id = ?`,
      )
      .run(now, userId);
  }

  private bumpRevision(userId: LocalUserId, type: CapabilityCategoryType, now: string): void {
    const column = type === 'skill' ? 'skill_revision' : 'mcp_revision';
    this.db
      .prepare(
        `UPDATE user_config_revisions
         SET ${column} = ${column} + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(now, userId);
  }
}

function mapCategory(row: CategoryRow): CapabilityCategory {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    name: row.name,
    sortOrder: row.sort_order,
    system: row.is_system === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
