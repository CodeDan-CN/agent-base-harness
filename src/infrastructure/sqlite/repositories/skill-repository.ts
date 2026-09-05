import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import type {
  SkillInstallation,
  SkillCompatibilityStatus,
  SkillInstallationStatus,
  SkillSourceType,
} from '../../../shared/domain/skill';
import type { LocalUserId } from '../../../shared/domain/user';
import { BridgeError } from '../../../shared/contracts/errors';

interface InstallationRow {
  id: string;
  user_id: string;
  skill_name: string;
  description: string;
  category_id: string;
  source_type: SkillSourceType;
  source_ref: string | null;
  root_path: string;
  metadata_json: string;
  content_digest: string;
  enabled: number;
  status: SkillInstallationStatus;
  compatibility_status: SkillCompatibilityStatus;
  created_at: string;
  updated_at: string;
}

export interface UpsertInstallationInput {
  id: string;
  userId: LocalUserId;
  skillName: string;
  description: string;
  sourceType: SkillSourceType;
  sourceRef: string | null;
  rootPath: string;
  metadata: Record<string, unknown>;
  contentDigest: string;
  enabled: boolean;
  status: SkillInstallationStatus;
  compatibilityStatus: SkillCompatibilityStatus;
  now: string;
}

export class SkillRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsertInstallation(input: UpsertInstallationInput): void {
    try {
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO skill_installations
               (id, user_id, skill_name, description, source_type, source_ref, root_path, metadata_json,
                content_digest, enabled, status, compatibility_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, skill_name) DO UPDATE SET
               description = excluded.description,
               source_type = excluded.source_type,
               source_ref = excluded.source_ref,
               root_path = excluded.root_path,
               metadata_json = excluded.metadata_json,
               content_digest = excluded.content_digest,
               enabled = excluded.enabled,
               status = excluded.status,
               compatibility_status = excluded.compatibility_status,
               updated_at = excluded.updated_at`,
          )
          .run(
            input.id,
            input.userId,
            input.skillName,
            input.description,
            input.sourceType,
            input.sourceRef,
            input.rootPath,
            JSON.stringify(input.metadata),
            input.contentDigest,
            input.enabled ? 1 : 0,
            input.status,
            input.compatibilityStatus,
            input.now,
            input.now,
          );
        this.db
          .prepare(
            'UPDATE user_config_revisions SET skill_revision = skill_revision + 1, updated_at = ? WHERE user_id = ?',
          )
          .run(input.now, input.userId);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  getInstallation(userId: LocalUserId, skillName: string): SkillInstallation | undefined {
    const row = this.db
      .prepare('SELECT * FROM skill_installations WHERE user_id = ? AND skill_name = ?')
      .get(userId, skillName) as InstallationRow | undefined;
    return row ? this.mapInstallation(row) : undefined;
  }

  listInstallations(userId: LocalUserId): SkillInstallation[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_installations WHERE user_id = ? ORDER BY skill_name ASC')
      .all(userId) as InstallationRow[];
    return rows.map((r) => this.mapInstallation(r));
  }

  setEnabled(userId: LocalUserId, skillName: string, enabled: boolean, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        const row = this.db
          .prepare(
            'SELECT status, compatibility_status FROM skill_installations WHERE user_id = ? AND skill_name = ?',
          )
          .get(userId, skillName) as
          | { status: SkillInstallationStatus; compatibility_status: SkillCompatibilityStatus }
          | undefined;
        if (!row) throw new BridgeError('INVALID_REQUEST', 'Skill not found');
        if (enabled && (row.status !== 'valid' || row.compatibility_status === 'incompatible')) {
          throw new BridgeError('INVALID_REQUEST', 'Skill is not compatible');
        }
        this.db
          .prepare(
            `UPDATE skill_installations SET enabled = ?, authorization_status = ?, updated_at = ?
             WHERE user_id = ? AND skill_name = ?`,
          )
          .run(enabled ? 1 : 0, enabled ? 'granted' : 'pending', now, userId, skillName);
        this.db
          .prepare(
            'UPDATE user_config_revisions SET skill_revision = skill_revision + 1, updated_at = ? WHERE user_id = ?',
          )
          .run(now, userId);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  deleteInstallation(userId: LocalUserId, skillName: string, now: string): void {
    try {
      this.db.transaction(() => {
        const result = this.db
          .prepare('DELETE FROM skill_installations WHERE user_id = ? AND skill_name = ?')
          .run(userId, skillName);
        if (result.changes !== 1) throw new BridgeError('INVALID_REQUEST', 'Skill not found');
        this.db
          .prepare(
            'UPDATE user_config_revisions SET skill_revision = skill_revision + 1, updated_at = ? WHERE user_id = ?',
          )
          .run(now, userId);
      })();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private mapInstallation(row: InstallationRow): SkillInstallation {
    return {
      id: row.id,
      userId: row.user_id,
      skillName: row.skill_name,
      description: row.description,
      categoryId: row.category_id,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      rootPath: row.root_path,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      contentDigest: row.content_digest,
      enabled: row.enabled === 1,
      status: row.status,
      compatibilityStatus: row.compatibility_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
