import type { SqliteDatabase } from '../../../storage/src/connection';
import { credentialRefOf, isCredentialRef } from './credential-store';
import type { CredentialScope, CredentialStatus, CredentialStore } from './credential-store';

/** Runtime-owned plaintext secrets. Never include this table in client projections or logs. */
export class SqliteCredentialStore implements CredentialStore {
  constructor(private readonly db: SqliteDatabase) {}

  async set(scope: CredentialScope, value: string): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO credential_secrets (credential_ref, value) VALUES (?, ?)
      ON CONFLICT (credential_ref) DO UPDATE SET value = excluded.value
    `,
      )
      .run(credentialRefOf(scope), value);
  }

  async get(scope: CredentialScope): Promise<string | null> {
    return this.getByRef(credentialRefOf(scope));
  }

  async getByRef(ref: string): Promise<string | null> {
    if (!isCredentialRef(ref)) return null;
    const row = this.db
      .prepare('SELECT value FROM credential_secrets WHERE credential_ref = ?')
      .get(ref) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async delete(scope: CredentialScope): Promise<void> {
    this.db
      .prepare('DELETE FROM credential_secrets WHERE credential_ref = ?')
      .run(credentialRefOf(scope));
  }

  async status(scope: CredentialScope): Promise<CredentialStatus> {
    return this.db
      .prepare('SELECT 1 FROM credential_secrets WHERE credential_ref = ?')
      .get(credentialRefOf(scope))
      ? 'configured'
      : 'missing';
  }

  async available(): Promise<boolean> {
    return this.db.open;
  }
}
