/** SQLite 连接与 PRAGMA 配置。 */

import Database from 'better-sqlite3';
import { BridgeError } from '../../shared/contracts/errors';

export type SqliteDatabase = Database.Database;

/**
 * 打开（或创建）数据库并应用阶段规定的 PRAGMA。
 * 把 better-sqlite3 的底层错误折叠成 DATABASE_UNAVAILABLE，不外泄 SQL 路径。
 */
export function openDatabase(filePath: string): SqliteDatabase {
  let db: SqliteDatabase;
  try {
    db = new Database(filePath);
  } catch {
    throw new BridgeError('DATABASE_UNAVAILABLE', 'Database unavailable');
  }
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    try {
      db.close();
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    if (err instanceof BridgeError) throw err;
    throw new BridgeError('DATABASE_UNAVAILABLE', 'Database unavailable');
  }
  return db;
}

/** 当前已应用的 schema 版本（0 表示尚未迁移）。 */
export function currentSchemaVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as
    { v: number } | undefined;
  return row?.v ?? 0;
}

/** 将一个任意异常折叠成稳定的 Domain 错误，绝不泄漏 SQL 文本或缺路径。 */
export function mapSqliteError(
  err: unknown,
  fallback = 'DATABASE_UNAVAILABLE' as const,
): BridgeError {
  if (err instanceof BridgeError) return err;
  const code = (err as { code?: string } | null)?.code;
  if (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    code === 'SQLITE_CONSTRAINT_CHECK' ||
    code === 'SQLITE_CONSTRAINT_NOTNULL'
  ) {
    return new BridgeError('INVALID_REQUEST', 'Request rejected by database constraint');
  }
  return new BridgeError(fallback, 'Database unavailable');
}
