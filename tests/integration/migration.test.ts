import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../packages/storage/src/connection';
import { runMigrations } from '../../packages/storage/src/migration';
import {
  STAGE1_MIGRATIONS,
  STAGE45_MIGRATIONS,
} from '../../packages/storage/src/schema';
import { BridgeError } from '../../packages/protocol/src/contracts/errors';
import { cleanupDir, makeTempDir } from '../../packages/test-kit/src/temp';
import { openMigratedDb } from '../../packages/test-kit/src/db';

const clock = () => '2026-01-01T00:00:00.000Z';

const STAGE1_TABLES = [
  'schema_migrations',
  'local_users',
  'app_settings',
  'user_config_revisions',
  'sessions',
  'session_events',
  'model_services',
  'models',
  'user_model_settings',
  'skill_installations',
];

describe('M06 SQLite 与 migration', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(root);
  });

  it('S1-M06-001 空库 migration 创建全部阶段表并记录版本', () => {
    const dbPath = `${root}/fresh.db`;
    const db = openDatabase(dbPath);
    const version = runMigrations(db, STAGE1_MIGRATIONS, { clock });
    expect(version).toBe(1);

    for (const table of STAGE1_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      expect(row, `table ${table} should exist`).toBeTruthy();
    }
    db.close();
  });

  it('S1-M06-002 迁移幂等：重复运行不重复执行、不改变业务数据', () => {
    const dbPath = `${root}/db.db`;
    const db = openDatabase(dbPath);
    runMigrations(db, STAGE1_MIGRATIONS, { clock });
    db.prepare(
      "INSERT INTO local_users (id, display_name, sort_order, status, created_at, updated_at) VALUES ('u', 'd', 0, 'active', 't', 't')",
    ).run();
    runMigrations(db, STAGE1_MIGRATIONS, { clock });
    runMigrations(db, STAGE1_MIGRATIONS, { clock });

    const rows = db.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toEqual([{ version: 1 }]);
    const user = db.prepare("SELECT id FROM local_users WHERE id = 'u'").get();
    expect(user).toBeTruthy();
    db.close();
  });

  it('S1-M06-003 checksum 不一致时 Worker 不 ready', () => {
    const dbPath = `${root}/db.db`;
    const db = openDatabase(dbPath);
    runMigrations(db, STAGE1_MIGRATIONS, { clock });
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    expect(() => runMigrations(db, STAGE1_MIGRATIONS, { clock })).toThrow(BridgeError);
    db.close();
  });

  it('S1-M06-004 迁移原子性：中途失败回滚、版本不前移', () => {
    const dbPath = `${root}/db.db`;
    const db = openDatabase(dbPath);
    const badMigration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE legit (id INTEGER); INVALID SQL HERE;',
    };
    expect(() => runMigrations(db, [...STAGE1_MIGRATIONS, badMigration], { clock })).toThrow();

    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(applied.map((r) => r.version)).toEqual([1]);
    const legit = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legit'")
      .get();
    expect(legit).toBeUndefined();
    db.close();
  });

  it('S1-M06-005 foreign_keys 开启，跨用户/不存在用户外键被拒绝', () => {
    const db = openMigratedDb(root);
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, user_id, title, status, next_seq, version, created_at, updated_at) VALUES ('s1', 'nobody', 't', 'active', 1, 0, 't', 't')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('S1-M06-006 WAL 模式', () => {
    const dbPath = `${root}/db.db`;
    const db = openDatabase(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    db.close();
  });

  it('S1-M06-008 JSON 列拒绝非法 JSON', () => {
    const db = openMigratedDb(root);
    expect(() =>
      db
        .prepare(
          "INSERT INTO app_settings (key, value_json, revision, updated_at) VALUES ('k', '{not-json', 0, 't')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('S1-M06-012 表清单符合阶段 1，无 Worker/Driver lease/Skill manifest 表', () => {
    const db = openMigratedDb(root);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const banned of [
      'worker_state',
      'driver_lease',
      'skill_manifest',
      'skill_secrets',
      'tool_manifest',
    ]) {
      expect(tables).not.toContain(banned);
    }
    db.close();
  });

  it('V9 迁移为旧用户和旧会话建立工作区默认预设', () => {
    const dbPath = `${root}/upgrade.db`;
    const db = openDatabase(dbPath);
    runMigrations(db, STAGE1_MIGRATIONS, { clock });
    db.prepare(
      "INSERT INTO local_users (id, display_name, sort_order, status, created_at, updated_at) VALUES ('u', 'User', 0, 'active', 't', 't')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, user_id, title, status, next_seq, version, created_at, updated_at) VALUES ('s', 'u', 'Session', 'active', 1, 0, 't', 't')",
    ).run();

    expect(
      runMigrations(
        db,
        STAGE45_MIGRATIONS.filter(({ version }) => version <= 10),
        { clock },
      ),
    ).toBe(10);
    expect(
      db.prepare("SELECT session_permission_preset FROM local_users WHERE id = 'u'").get(),
    ).toEqual({ session_permission_preset: 'workspace-write' });
    expect(db.prepare("SELECT permission_preset FROM sessions WHERE id = 's'").get()).toEqual({
      permission_preset: 'workspace-write',
    });
    db.close();
  });

  it('已应用历史 V8 的数据库可继续升级到 V9', () => {
    const dbPath = `${root}/upgrade-from-v8.db`;
    const db = openDatabase(dbPath);
    const migrationsThroughV8 = STAGE45_MIGRATIONS.filter(({ version }) => version <= 8);
    expect(runMigrations(db, migrationsThroughV8, { clock })).toBe(8);
    db.prepare(
      "INSERT INTO local_users (id, display_name, sort_order, status, created_at, updated_at) VALUES ('u', 'User', 0, 'active', 't', 't')",
    ).run();

    expect(
      runMigrations(
        db,
        STAGE45_MIGRATIONS.filter(({ version }) => version <= 10),
        { clock },
      ),
    ).toBe(10);
    expect(
      db.prepare("SELECT session_permission_preset FROM local_users WHERE id = 'u'").get(),
    ).toEqual({ session_permission_preset: 'workspace-write' });
    db.close();
  });

  it('V10 将旧版界面生成的 4096 输出预算切换为动态自动值', () => {
    const dbPath = `${root}/upgrade-output-budget.db`;
    const db = openDatabase(dbPath);
    const migrationsThroughV9 = STAGE45_MIGRATIONS.filter(({ version }) => version <= 9);
    expect(runMigrations(db, migrationsThroughV9, { clock })).toBe(9);
    db.prepare(
      "INSERT INTO local_users (id, display_name, sort_order, status, created_at, updated_at) VALUES ('u', 'User', 0, 'active', 't', 't')",
    ).run();
    db.prepare(
      `INSERT INTO model_services
       (id, user_id, name, provider_type, endpoint, status, config_json, created_at, updated_at)
       VALUES ('service', 'u', 'DeepSeek', 'openai-compatible', 'https://api.deepseek.com/', 'enabled', '{}', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO models
       (id, user_id, service_id, remote_model_id, display_name, context_window,
        max_output_tokens, max_output_capability, request_max_output_tokens,
        capabilities_json, default_params_json, source, status, created_at, updated_at)
       VALUES ('model', 'u', 'service', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 1000000,
        4096, 384000, 4096, '{}', '{}', 'manual', 'enabled', 't', 't')`,
    ).run();

    expect(
      runMigrations(
        db,
        STAGE45_MIGRATIONS.filter(({ version }) => version <= 10),
        { clock },
      ),
    ).toBe(10);
    expect(
      db
        .prepare(
          "SELECT request_max_output_tokens, max_output_tokens FROM models WHERE id = 'model'",
        )
        .get(),
    ).toEqual({ request_max_output_tokens: null, max_output_tokens: 200_000 });
    db.close();
  });
});
