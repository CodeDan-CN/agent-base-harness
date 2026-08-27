/** 迁移运行器：checksum 校验、单调递增、原子应用。 */

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './connection';
import type { Migration } from './schema';
import { BridgeError } from '../../shared/contracts/errors';

export interface MigrationOptions {
  clock: () => string;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * 应用未执行的迁移。
 * - 已应用迁移的 checksum 与当前定义不一致 -> DATABASE_UNAVAILABLE（不 ready）。
 * - 每条迁移在独立事务内应用；失败整体回滚且版本不前移。
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  opts: MigrationOptions,
): number {
  // schema_migrations 元表由运行器自身保证存在（幂等）。
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedRow[];

  // checksum 一致性校验（M06-003）。
  for (const row of applied) {
    const def = migrations.find((m) => m.version === row.version);
    if (!def || checksumOf(def.sql) !== row.checksum) {
      throw new BridgeError('DATABASE_UNAVAILABLE', 'Database migration checksum mismatch');
    }
  }

  const insertStmt = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  const pending = migrations
    .filter((m) => !applied.some((r) => r.version === m.version))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const applyOne = db.transaction(() => {
      db.exec(migration.sql);
      insertStmt.run(migration.version, migration.name, checksumOf(migration.sql), opts.clock());
    });
    applyOne();
  }

  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as
    { v: number } | undefined;
  return row?.v ?? 0;
}
