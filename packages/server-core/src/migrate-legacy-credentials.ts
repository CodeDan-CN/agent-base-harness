import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../storage/src/connection';
import { SqliteCredentialStore } from '../../execution/src/credential/sqlite-credential-store';
import { LinuxEncryptedCredentialStore } from '../../execution/src/credential/linux-encrypted-store';
import { runMigrations } from '../../storage/src/migration';
import { STAGE47_MIGRATIONS } from '../../storage/src/schema';
import { MacKeychainCredentialStore } from '../../execution/src/credential/mac-keychain-store';
import {
  credentialRefOf,
  type CredentialStore,
} from '../../execution/src/credential/credential-store';
import { DataDirectoryLock } from './lifecycle';
import { servicePaths } from './paths';

/** Explicit offline upgrade only. Never called by Runtime startup or credential reads. */
export async function migrateLegacyCredentials(
  dataDir: string,
  kind: 'keychain' | 'files',
  source?: Pick<CredentialStore, 'getByRef'>,
): Promise<{ migrated: number; skipped: number; missing: number; failed: number }> {
  if (!source && kind === 'keychain' && process.platform !== 'darwin') {
    throw new Error('Keychain migration must run on the original macOS host');
  }
  const dbPath = path.join(dataDir, 'database', 'app.db');
  if (!existsSync(dbPath)) throw new Error('Runtime database not found; check --data-dir');
  const lock = new DataDirectoryLock(servicePaths(dataDir));
  lock.acquire();
  try {
    const db = openDatabase(dbPath);
    try {
      // Include archived configurations: their references must remain usable after migration.
      const rows = db
        .prepare(
          `
        SELECT user_id, id, 'model-service' AS purpose, credential_ref FROM model_services
        WHERE credential_ref IS NOT NULL AND credential_ref <> ''
        UNION ALL
        SELECT user_id, id, 'mcp-server' AS purpose, credential_ref FROM mcp_servers
        WHERE credential_ref IS NOT NULL AND credential_ref <> ''
      `,
        )
        .all() as Array<{ user_id: string; id: string; purpose: string; credential_ref: string }>;
      runMigrations(db, STAGE47_MIGRATIONS, { clock: () => new Date().toISOString() });
      const target = new SqliteCredentialStore(db);
      const directory = path.join(dataDir, 'credentials');
      if (!source && kind === 'files' && !existsSync(directory)) {
        throw new Error('Legacy credentials directory not found');
      }
      const legacy =
        source ??
        (kind === 'keychain'
          ? new MacKeychainCredentialStore()
          : new LinuxEncryptedCredentialStore({
              directory,
              keyFile: process.env.AGENT_HARNESS_CREDENTIAL_KEY_FILE?.trim() || undefined,
            }));
      const result = { migrated: 0, skipped: 0, missing: 0, failed: 0 };
      for (const row of rows) {
        const scope = { userId: row.user_id, purpose: row.purpose, entityId: row.id };
        if (credentialRefOf(scope) !== row.credential_ref) {
          result.failed++;
          continue;
        }
        try {
          // Never replace an existing local credential or fall back after a read failure.
          if ((await target.getByRef(row.credential_ref)) !== null) {
            result.skipped++;
            continue;
          }
          const secret = await legacy.getByRef(row.credential_ref);
          if (!secret) {
            result.missing++;
            continue;
          }
          await target.set(scope, secret);
          if ((await target.getByRef(row.credential_ref)) !== secret) {
            throw new Error('Credential verification failed');
          }
          result.migrated++;
        } catch {
          // Errors from external stores can contain secrets; report counts only.
          result.failed++;
        }
      }
      return result;
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}
