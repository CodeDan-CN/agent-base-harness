import type { SqliteDatabase } from '../connection';
import type { LocalUserId } from '../../../shared/domain/user';

export interface LocalAuthCredential {
  userId: LocalUserId;
  loginName: string;
  normalizedLoginName: string;
  passwordDigest: string;
  passwordSalt: string;
  passwordParams: PasswordDigestParams;
  createdAt: string;
  updatedAt: string;
}

export interface PasswordDigestParams {
  algorithm: 'scrypt';
  keyLength: number;
  cost: number;
  blockSize: number;
  parallelization: number;
}

interface CredentialRow {
  user_id: string;
  login_name: string;
  normalized_login_name: string;
  password_digest: string;
  password_salt: string;
  password_params_json: string;
  created_at: string;
  updated_at: string;
}

export class AuthRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getByUserId(userId: LocalUserId): LocalAuthCredential | undefined {
    const row = this.db
      .prepare('SELECT * FROM local_auth_credentials WHERE user_id = ?')
      .get(userId) as CredentialRow | undefined;
    return row ? mapCredential(row) : undefined;
  }

  getByNormalizedLoginName(normalizedLoginName: string): LocalAuthCredential | undefined {
    const row = this.db
      .prepare('SELECT * FROM local_auth_credentials WHERE normalized_login_name = ?')
      .get(normalizedLoginName) as CredentialRow | undefined;
    return row ? mapCredential(row) : undefined;
  }

  replaceBuiltinCredentials(
    credentials: ReadonlyArray<{
      userId: LocalUserId;
      loginName: string;
      normalizedLoginName: string;
      passwordDigest: string;
      passwordSalt: string;
      passwordParams: PasswordDigestParams;
      now: string;
    }>,
  ): void {
    const remove = this.db.prepare('DELETE FROM local_auth_credentials WHERE user_id = ?');
    const insert = this.db.prepare(
      `INSERT INTO local_auth_credentials (
           user_id, login_name, normalized_login_name, password_digest,
           password_salt, password_params_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const credential of credentials) remove.run(credential.userId);
      for (const credential of credentials) {
        insert.run(
          credential.userId,
          credential.loginName,
          credential.normalizedLoginName,
          credential.passwordDigest,
          credential.passwordSalt,
          JSON.stringify(credential.passwordParams),
          credential.now,
          credential.now,
        );
      }
    })();
  }

  createLocalAccount(input: {
    userId: LocalUserId;
    loginName: string;
    normalizedLoginName: string;
    displayName: string;
    passwordDigest: string;
    passwordSalt: string;
    passwordParams: PasswordDigestParams;
    now: string;
  }): void {
    const nextOrder = this.db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM local_users',
    );
    const insertUser = this.db.prepare(
      `INSERT INTO local_users
         (id, display_name, avatar_key, sort_order, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'active', ?, ?)`,
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO user_config_revisions
         (user_id, model_revision, skill_revision, runtime_revision, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
    );
    const insertSettings = this.db.prepare(
      `INSERT INTO user_model_settings (user_id, default_model_id, updated_at)
       VALUES (?, NULL, ?)`,
    );
    const insertCredential = this.db.prepare(
      `INSERT INTO local_auth_credentials (
         user_id, login_name, normalized_login_name, password_digest,
         password_salt, password_params_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      const order = (nextOrder.get() as { value: number }).value;
      insertUser.run(input.userId, input.displayName, order, input.now, input.now);
      insertRevision.run(input.userId, input.now);
      insertSettings.run(input.userId, input.now);
      insertCredential.run(
        input.userId,
        input.loginName,
        input.normalizedLoginName,
        input.passwordDigest,
        input.passwordSalt,
        JSON.stringify(input.passwordParams),
        input.now,
        input.now,
      );
    })();
  }
}

function mapCredential(row: CredentialRow): LocalAuthCredential {
  return {
    userId: row.user_id,
    loginName: row.login_name,
    normalizedLoginName: row.normalized_login_name,
    passwordDigest: row.password_digest,
    passwordSalt: row.password_salt,
    passwordParams: JSON.parse(row.password_params_json) as PasswordDigestParams,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
