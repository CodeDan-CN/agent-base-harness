import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../../storage/src/connection';
import { openDatabase } from '../../storage/src/connection';
import { runMigrations } from '../../storage/src/migration';
import { STAGE1_MIGRATIONS } from '../../storage/src/schema';

export const FIXED_NOW = '2026-01-01T00:00:00.000Z';

export function openMigratedDb(dataRoot: string): SqliteDatabase {
  const dbPath = path.join(dataRoot, 'database', 'app.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  runMigrations(db, STAGE1_MIGRATIONS, { clock: () => FIXED_NOW });
  return db;
}
