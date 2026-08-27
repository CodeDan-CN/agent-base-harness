import type { SqliteDatabase } from '../connection';
import { BUILTIN_USERS, DEFAULT_USER_ID, isBuiltinUser } from '../../../shared/domain/user';
import type { LocalUser, LocalUserId, UserConfigRevisions } from '../../../shared/domain/user';

interface UserRow {
  id: string;
  display_name: string;
  avatar_key: string | null;
  sort_order: number;
  status: 'active';
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  user_id: string;
  model_revision: number;
  skill_revision: number;
  runtime_revision: number;
  updated_at: string;
}

const ACTIVE_USER_KEY = 'active_user_id';

export class UserRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listUsers(): LocalUser[] {
    const rows = this.db
      .prepare('SELECT * FROM local_users ORDER BY sort_order ASC')
      .all() as UserRow[];
    return rows.map((r) => this.mapUser(r));
  }

  getUser(id: LocalUserId): LocalUser | undefined {
    const row = this.db.prepare('SELECT * FROM local_users WHERE id = ?').get(id) as
      UserRow | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  getRevisions(userId: LocalUserId): UserConfigRevisions {
    const row = this.db
      .prepare('SELECT * FROM user_config_revisions WHERE user_id = ?')
      .get(userId) as RevisionRow | undefined;
    if (!row) {
      throw new Error(`revision missing for user ${userId}`);
    }
    return {
      userId: row.user_id,
      modelRevision: row.model_revision,
      skillRevision: row.skill_revision,
      runtimeRevision: row.runtime_revision,
      updatedAt: row.updated_at,
    };
  }

  getActiveUserId(): LocalUserId {
    const row = this.db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(ACTIVE_USER_KEY) as { value_json: string } | undefined;
    let parsed: unknown;
    if (row) {
      try {
        parsed = JSON.parse(row.value_json);
      } catch {
        parsed = undefined;
      }
    }
    if (!isBuiltinUser(parsed)) {
      return DEFAULT_USER_ID;
    }
    return parsed;
  }

  setActiveUserId(userId: LocalUserId, now: string): void {
    if (!isBuiltinUser(userId)) {
      throw new Error('not a builtin user');
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, revision, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
           revision = app_settings.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(ACTIVE_USER_KEY, JSON.stringify(userId), now);
  }

  /** 缺失或非法 active_user_id 回退为 user-a 并持久化修复。 */
  repairActiveUserId(now: string): LocalUserId {
    const row = this.db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(ACTIVE_USER_KEY) as { value_json: string } | undefined;
    let parsed: unknown;
    if (row) {
      try {
        parsed = JSON.parse(row.value_json);
      } catch {
        parsed = undefined;
      }
    }
    if (!isBuiltinUser(parsed)) {
      this.setActiveUserId(DEFAULT_USER_ID, now);
      return DEFAULT_USER_ID;
    }
    return parsed;
  }

  seedUsers(now: string): void {
    const insertUser = this.db.prepare(
      `INSERT INTO local_users (id, display_name, avatar_key, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO user_config_revisions (user_id, model_revision, skill_revision, runtime_revision, updated_at)
       VALUES (?, 0, 0, 0, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    );
    const insertSettings = this.db.prepare(
      `INSERT INTO user_model_settings (user_id, default_model_id, updated_at)
       VALUES (?, NULL, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    );

    const seed = this.db.transaction(() => {
      for (const user of BUILTIN_USERS) {
        insertUser.run(user.id, user.displayName, user.avatarKey, user.sortOrder, now, now);
        insertRevision.run(user.id, now);
        insertSettings.run(user.id, now);
      }
    });
    seed();
  }

  private mapUser(row: UserRow): LocalUser {
    return {
      id: row.id,
      displayName: row.display_name,
      avatarKey: row.avatar_key,
      sortOrder: row.sort_order,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
