# SQLite 数据模型与迁移设计

## 1. 设计目标

- 一个 SQLite 文件承载两个内置用户。
- 用户私有表使用 `user_id NOT NULL`、复合唯一键、复合外键和作用域 Repository 共同隔离。
- Session Event 只追加；模型与 Skill 配置使用带 revision 的 CRUD 表。
- Projection 表可删除重建，不能反向成为运行事实。
- 密钥明文不进入 SQLite。

本文件 SQL 为 V1 迁移设计草案，阶段 1 根据最终 SQLite 驱动写成正式 migration。

## 2. 数据库连接基线

每个正式连接必须执行并验证：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

约束：

- Runtime Worker 是唯一常规写入口。
- 长模型请求和工具调用期间不得持有数据库事务。
- 写事务只完成事件追加、配置变更、claim 或 Projection commit。
- 所有时间使用 UTC RFC3339 固定格式；ID 是不透明字符串，由注入的 ID Provider 生成。
- JSON 字段必须通过应用 Schema 校验，并在 SQLite 支持时增加 `json_valid` 检查。

## 3. Schema 版本与迁移表

```sql
CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at    TEXT NOT NULL
);
```

迁移规则：

- 已发布 migration 不原地修改；修复使用新版本。
- 升级前备份策略由发布阶段确定，迁移本身必须事务化或提供明确恢复步骤。
- migration checksum 不一致时拒绝启动写服务并进入诊断状态。
- 降级不自动执行破坏性逆迁移；应用回滚必须声明支持的数据库版本范围。

## 4. 用户与应用级配置

```sql
CREATE TABLE local_users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  avatar        TEXT,
  status        TEXT NOT NULL CHECK (status = 'active'),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE app_settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE user_config_revisions (
  user_id           TEXT PRIMARY KEY,
  model_revision    INTEGER NOT NULL DEFAULT 0,
  skill_revision    INTEGER NOT NULL DEFAULT 0,
  runtime_revision  INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);
```

`active_user_id` 属于 Main 管理的应用级设置，可以存入 `app_settings`；所有业务请求仍必须重新校验该 ID 是已注册内置用户。

## 5. Session 与事件事实表

```sql
CREATE TABLE sessions (
  id                TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
  next_seq          INTEGER NOT NULL DEFAULT 1,
  version           INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE session_events (
  user_id         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  event_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  time            TEXT NOT NULL,
  request_id      TEXT,
  payload_json    TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, seq),
  UNIQUE (user_id, event_id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE INDEX idx_sessions_user_status_updated
  ON sessions(user_id, status, updated_at DESC);

CREATE INDEX idx_session_events_user_event
  ON session_events(user_id, event_id);

CREATE INDEX idx_session_events_user_session_type_seq
  ON session_events(user_id, session_id, type, seq);
```

事件追加事务必须：

1. 校验 `(user_id, session_id)`、Session version 和 leaseOwner。
2. 为一批事件分配从 `next_seq` 开始的连续 seq。
3. 插入全部事件。
4. 更新 `next_seq`、`version` 和 `updated_at`。
5. 任一步失败则整批回滚。

禁止 UPDATE/DELETE `session_events`。隐私删除采用 Session tombstone、导出/清理策略和明确的数据迁移，不以普通 Repository 方法暴露。

## 6. 模型管理配置表

```sql
CREATE TABLE model_services (
  id                 TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  provider_type      TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  provider_endpoint  TEXT,
  credential_ref     TEXT,
  status             TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  config_json        TEXT NOT NULL,
  config_version     INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE models (
  id                   TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  service_id           TEXT NOT NULL,
  remote_model_id      TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  context_window       INTEGER NOT NULL CHECK (context_window > 0),
  max_output_tokens    INTEGER NOT NULL CHECK (max_output_tokens > 0),
  capabilities_json    TEXT NOT NULL,
  default_params_json  TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('discovered', 'manual')),
  status               TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  config_version       INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, service_id, remote_model_id),
  FOREIGN KEY (user_id, service_id) REFERENCES model_services(user_id, id)
);

CREATE TABLE user_model_settings (
  user_id            TEXT PRIMARY KEY,
  default_model_id   TEXT,
  revision           INTEGER NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id, default_model_id),
  FOREIGN KEY (user_id) REFERENCES local_users(id),
  FOREIGN KEY (user_id, default_model_id) REFERENCES models(user_id, id)
);

CREATE INDEX idx_model_services_user_status
  ON model_services(user_id, status, updated_at DESC);

CREATE INDEX idx_models_user_service_status
  ON models(user_id, service_id, status, display_name);
```

模型配置保存和默认模型切换必须在同一事务中递增 `user_config_revisions.model_revision`。Credential Store 写入失败时不能提交引用；SQLite 提交失败时应删除本次新建且尚未被其他配置引用的 Credential。

## 7. Skill 管理配置表

```sql
CREATE TABLE skill_packages (
  digest             TEXT PRIMARY KEY,
  skill_id           TEXT NOT NULL,
  version            TEXT NOT NULL,
  manifest_json      TEXT NOT NULL,
  managed_path       TEXT NOT NULL UNIQUE,
  size_bytes         INTEGER NOT NULL CHECK (size_bytes >= 0),
  validation_status  TEXT NOT NULL CHECK (validation_status = 'valid'),
  created_at         TEXT NOT NULL
);

CREATE TABLE skill_installations (
  id                TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  package_digest    TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  version           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
    'needs_configuration', 'needs_authorization', 'disabled', 'enabled',
    'incompatible', 'failed', 'uninstalling'
  )),
  config_version    INTEGER NOT NULL,
  installed_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, skill_id),
  FOREIGN KEY (user_id) REFERENCES local_users(id),
  FOREIGN KEY (package_digest) REFERENCES skill_packages(digest)
);

CREATE TABLE skill_settings (
  user_id                 TEXT NOT NULL,
  installation_id         TEXT NOT NULL,
  config_json             TEXT NOT NULL,
  permission_grants_json  TEXT NOT NULL,
  revision                INTEGER NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES skill_installations(user_id, id)
);

CREATE TABLE skill_secret_bindings (
  user_id          TEXT NOT NULL,
  installation_id  TEXT NOT NULL,
  secret_name      TEXT NOT NULL,
  credential_ref   TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id, secret_name),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES skill_installations(user_id, id)
);

CREATE INDEX idx_skill_installations_user_status
  ON skill_installations(user_id, status, updated_at DESC);
```

暂存中的包不写入 `skill_packages`。只有全部静态校验通过并原子移动到受管目录后，才能在事务中创建 package/installation。若数据库事务失败，文件发布操作必须可补偿；启动修复会清理没有数据库引用的暂存或孤立包。

共享 `skill_packages` 只共享不可变内容，不共享发现性、启用、配置、授权或凭据。业务 Query 必须从当前用户 `skill_installations` 出发，不能列举全局包表。

## 8. 附件与受控文件引用

```sql
CREATE TABLE attachments (
  id            TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  display_name  TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  digest        TEXT NOT NULL,
  managed_path  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ready', 'deleted')),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);
```

Renderer 只持有 attachmentId 或一次性文件引用，不持有受管绝对路径。

## 9. 可重建 Projection 表

Projection 表是性能优化，可以在版本不兼容时清空重建：

```sql
CREATE TABLE conversation_events (
  id                             TEXT NOT NULL,
  user_id                        TEXT NOT NULL,
  session_id                     TEXT NOT NULL,
  status                         TEXT NOT NULL,
  title                          TEXT,
  summary                        TEXT,
  summary_through_exchange_seq   INTEGER,
  summary_tokens                 INTEGER,
  summary_version                INTEGER NOT NULL DEFAULT 0,
  exchange_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  completed_at                   TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE TABLE conversation_exchanges (
  id                 TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  exchange_seq       INTEGER NOT NULL,
  execution_turn_id  TEXT NOT NULL,
  status             TEXT NOT NULL,
  started_seq        INTEGER NOT NULL,
  completed_seq      INTEGER,
  created_at         TEXT NOT NULL,
  completed_at       TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, event_id, exchange_seq),
  UNIQUE (user_id, execution_turn_id),
  FOREIGN KEY (user_id, event_id) REFERENCES conversation_events(user_id, id)
);

CREATE TABLE projection_checkpoints (
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  projection     TEXT NOT NULL,
  through_seq    INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, projection),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);
```

Chat、Trajectory、Inbox 和 usage 可以使用独立表或按需 JSON Snapshot，但必须满足：从 seq 1 回放得到的结果与实时增量结果一致。

## 10. Repository 作用域规则

允许的形状：

```ts
sessionRepository.get({ userId, sessionId });
eventStore.append({ userId, sessionId, expectedVersion, events });
modelRepository.listByUser(userId);
skillInstallationRepository.get({ userId, installationId });
```

禁止的形状：

```ts
sessionRepository.getById(sessionId);
modelRepository.findAll();
skillPackageRepository.listForUi();
```

仅迁移、完整性检查和应用级诊断可以使用无用户作用域访问；这些入口放在独立 internal API，不能被业务服务或 Bridge 引用。

## 11. 删除与保留策略

- Session：V1 先软删除，停止出现在普通 Query；后台运行时禁止删除或先明确 Cancel。
- Model/Service：有历史引用时归档；未引用且不是默认模型时可物理删除配置行。
- SkillInstallation：先进入 `uninstalling`、撤销 Registry，再等待 lease，最后删除用户配置和无引用包。
- Credential：先移除配置引用，确认无引用后从 OS Credential Store 删除。
- Attachment：先 tombstone，物理清理由保留策略处理。
- Event：普通产品流程永不修改；隐私清除属于独立受审计操作。

## 12. 数据库验收

- 两个用户使用相同实体 ID 时仍不能交叉读取或建立外键。
- 任意跨用户 Session/Model/Skill/Attachment 关联都由数据库或 Repository 拒绝。
- Event batch 追加要么全部成功且 seq 连续，要么完全回滚。
- 配置保存与 revision 递增原子完成。
- Projection 表清空后可由 Session Event 全量重建。
- 重复 migration 可检测且不会再次执行。
- 外键关闭时启动检查必须失败，不允许静默运行。
