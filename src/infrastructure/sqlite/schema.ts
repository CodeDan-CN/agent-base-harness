/** Stage 1 migration 定义。SQL 来自《阶段1架构设计》第 6 节，发布后不可改写。 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_SQL = `
CREATE TABLE local_users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  avatar_key    TEXT,
  sort_order    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status = 'active'),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE app_settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  revision      INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE sessions (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  next_seq    INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),
  version     INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE session_events (
  user_id         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq > 0),
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL CHECK (schema_version > 0),
  occurred_at     TEXT NOT NULL,
  request_id      TEXT,
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, session_id, seq),
  UNIQUE (user_id, event_id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE INDEX idx_sessions_user_status_updated
  ON sessions(user_id, status, updated_at DESC);

CREATE INDEX idx_session_events_user_event
  ON session_events(user_id, event_id);

CREATE INDEX idx_session_events_user_session_type_seq
  ON session_events(user_id, session_id, event_type, seq);

CREATE TABLE model_services (
  id              TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  provider_type   TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  credential_ref  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  config_json     TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE models (
  id                   TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  service_id           TEXT NOT NULL,
  remote_model_id      TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  context_window       INTEGER CHECK (context_window IS NULL OR context_window > 0),
  max_output_tokens    INTEGER CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  capabilities_json    TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  default_params_json  TEXT NOT NULL CHECK (json_valid(default_params_json)),
  source               TEXT NOT NULL CHECK (source IN ('discovered', 'manual')),
  status               TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, service_id, remote_model_id),
  FOREIGN KEY (user_id, service_id) REFERENCES model_services(user_id, id)
);

CREATE TABLE user_model_settings (
  user_id           TEXT PRIMARY KEY,
  default_model_id  TEXT,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES local_users(id),
  FOREIGN KEY (user_id, default_model_id) REFERENCES models(user_id, id)
);

CREATE INDEX idx_model_services_user_status
  ON model_services(user_id, status, updated_at DESC);

CREATE INDEX idx_models_user_service_status
  ON models(user_id, service_id, status, display_name);

CREATE TABLE skill_installations (
  id                    TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  skill_name            TEXT NOT NULL,
  description           TEXT NOT NULL,
  source_type           TEXT NOT NULL CHECK (source_type IN ('local', 'modelscope', 'clawhub', 'bundled')),
  source_ref            TEXT,
  root_path             TEXT NOT NULL,
  metadata_json         TEXT NOT NULL CHECK (json_valid(metadata_json)),
  content_digest        TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  status                TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'missing', 'incompatible')),
  compatibility_status  TEXT NOT NULL CHECK (compatibility_status IN ('compatible', 'incompatible', 'unknown')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, skill_name),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE INDEX idx_skill_installations_user_enabled
  ON skill_installations(user_id, enabled, updated_at DESC);
`;

export const STAGE1_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial-schema', sql: V1_SQL },
];

/**
 * Stage 2 只追加结构，不改写已经发布的 V1。
 * Runtime 的事实仍写入 session_events；其余表是可重建的查询投影与租约元数据。
 */
const V2_SQL = `
ALTER TABLE sessions ADD COLUMN lease_owner TEXT;
ALTER TABLE sessions ADD COLUMN lease_expires_at TEXT;
ALTER TABLE session_events ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_session_events_input_idempotency
  ON session_events(user_id, session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE conversation_events (
  id                            TEXT NOT NULL,
  user_id                       TEXT NOT NULL,
  session_id                    TEXT NOT NULL,
  status                        TEXT NOT NULL CHECK (status IN ('open', 'awaiting_user', 'completed', 'failed')),
  title                         TEXT,
  summary                       TEXT,
  summary_through_exchange_seq  INTEGER NOT NULL DEFAULT 0,
  summary_tokens                INTEGER NOT NULL DEFAULT 0,
  summary_version               INTEGER NOT NULL DEFAULT 0,
  exchange_count                INTEGER NOT NULL DEFAULT 0,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL,
  completed_at                  TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE TABLE conversation_exchanges (
  id                        TEXT NOT NULL,
  user_id                   TEXT NOT NULL,
  event_id                  TEXT NOT NULL,
  exchange_seq              INTEGER NOT NULL,
  execution_turn_id         TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('open', 'completed', 'interrupted', 'failed')),
  user_visible_from_seq     INTEGER,
  user_visible_through_seq  INTEGER,
  created_at                TEXT NOT NULL,
  completed_at              TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, event_id, exchange_seq),
  UNIQUE (user_id, execution_turn_id),
  FOREIGN KEY (user_id, event_id) REFERENCES conversation_events(user_id, id)
);

CREATE TABLE conversation_event_relations (
  user_id         TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  relation        TEXT NOT NULL CHECK (relation IN ('explicit', 'continuation')),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, source_event_id, target_event_id, relation),
  FOREIGN KEY (user_id, source_event_id) REFERENCES conversation_events(user_id, id),
  FOREIGN KEY (user_id, target_event_id) REFERENCES conversation_events(user_id, id)
);

CREATE TABLE projection_checkpoints (
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  projection     TEXT NOT NULL,
  through_seq    INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, projection),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE INDEX idx_conversation_events_user_session_status
  ON conversation_events(user_id, session_id, status, updated_at DESC);
CREATE INDEX idx_conversation_exchanges_user_event_seq
  ON conversation_exchanges(user_id, event_id, exchange_seq);
`;

export const STAGE2_MIGRATIONS: readonly Migration[] = [
  ...STAGE1_MIGRATIONS,
  { version: 2, name: 'single-agent-runtime', sql: V2_SQL },
];

/** Stage 3 Client 管理界面所需的配置版本、受管资源和设置结构。 */
const V3_SQL = `
ALTER TABLE sessions ADD COLUMN tombstoned_at TEXT;
ALTER TABLE model_services ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE models ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skill_installations ADD COLUMN managed_root_path TEXT;
ALTER TABLE skill_installations ADD COLUMN authorization_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (authorization_status IN ('pending', 'granted', 'denied'));

CREATE TABLE skill_settings (
  user_id                TEXT NOT NULL,
  installation_id        TEXT NOT NULL,
  settings_json          TEXT NOT NULL CHECK (json_valid(settings_json)),
  permission_grants_json TEXT NOT NULL CHECK (json_valid(permission_grants_json)),
  content_digest         TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES skill_installations(user_id, id)
);

CREATE TABLE skill_secret_bindings (
  user_id          TEXT NOT NULL,
  installation_id  TEXT NOT NULL,
  secret_name      TEXT NOT NULL,
  credential_ref   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id, secret_name),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES skill_installations(user_id, id)
);

CREATE TABLE runtime_settings (
  user_id       TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  revision      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE attachments (
  id             TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  session_id     TEXT,
  display_name   TEXT NOT NULL,
  media_type     TEXT NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size >= 0),
  content_digest TEXT NOT NULL,
  storage_key    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ready', 'deleted', 'missing')),
  created_at     TEXT NOT NULL,
  deleted_at     TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);

CREATE INDEX idx_attachments_user_session_status
  ON attachments(user_id, session_id, status, created_at DESC);
`;

export const STAGE3_MIGRATIONS: readonly Migration[] = [
  ...STAGE2_MIGRATIONS,
  { version: 3, name: 'client-product-management', sql: V3_SQL },
];

/** Stage 4 模型能力、思考配置与 Session 业务记忆。 */
const V4_SQL = `
ALTER TABLE model_services ADD COLUMN provider_preset_id TEXT;
ALTER TABLE model_services ADD COLUMN provider_preset_version INTEGER;

ALTER TABLE models ADD COLUMN input_capability INTEGER
  CHECK (input_capability IS NULL OR input_capability > 0);
ALTER TABLE models ADD COLUMN max_output_capability INTEGER
  CHECK (max_output_capability IS NULL OR max_output_capability > 0);
ALTER TABLE models ADD COLUMN request_max_output_tokens INTEGER
  CHECK (request_max_output_tokens IS NULL OR request_max_output_tokens > 0);
ALTER TABLE models ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'legacy'
  CHECK (metadata_source IN ('manual', 'endpoint', 'catalog', 'fallback', 'legacy'));
ALTER TABLE models ADD COLUMN catalog_version TEXT;
ALTER TABLE models ADD COLUMN capability_profile_ref TEXT;
ALTER TABLE models ADD COLUMN capability_match_kind TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (capability_match_kind IN ('profile', 'preset', 'host', 'model-unique', 'model-consensus', 'manual', 'unresolved'));
ALTER TABLE models ADD COLUMN thinking_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (thinking_mode IN ('auto', 'enabled', 'disabled'));
ALTER TABLE models ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

UPDATE models SET
  request_max_output_tokens = max_output_tokens,
  max_output_capability = max_output_tokens
WHERE request_max_output_tokens IS NULL;

CREATE TABLE session_memory_summaries (
  user_id                     TEXT NOT NULL,
  session_id                  TEXT NOT NULL,
  summary                     TEXT NOT NULL,
  covered_through_session_seq INTEGER NOT NULL CHECK (covered_through_session_seq > 0),
  summary_tokens              INTEGER NOT NULL CHECK (summary_tokens > 0),
  summary_version             INTEGER NOT NULL CHECK (summary_version > 0),
  input_tokens                INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens               INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, id)
);
`;

export const STAGE4_MIGRATIONS: readonly Migration[] = [
  ...STAGE3_MIGRATIONS,
  { version: 4, name: 'model-capability-and-context-management', sql: V4_SQL },
];

/** Stage 4.5 通用 MCP Server、工具目录与逐工具审核。 */
const V5_SQL = `
ALTER TABLE user_config_revisions ADD COLUMN mcp_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE mcp_servers (
  id                 TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  transport          TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable-http')),
  status             TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'archived')),
  config_json        TEXT NOT NULL CHECK (json_valid(config_json)),
  credential_ref     TEXT,
  connection_status  TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_status IN ('disconnected', 'connecting', 'connected', 'error')),
  generation         INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, name),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE TABLE mcp_tools (
  user_id             TEXT NOT NULL,
  server_id           TEXT NOT NULL,
  raw_name            TEXT NOT NULL,
  public_name         TEXT NOT NULL,
  description         TEXT NOT NULL,
  input_schema_json   TEXT NOT NULL CHECK (json_valid(input_schema_json)),
  output_schema_json  TEXT CHECK (output_schema_json IS NULL OR json_valid(output_schema_json)),
  schema_digest       TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  review_status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'changed')),
  generation          INTEGER NOT NULL CHECK (generation >= 0),
  discovered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (user_id, server_id, raw_name),
  UNIQUE (user_id, public_name),
  FOREIGN KEY (user_id, server_id) REFERENCES mcp_servers(user_id, id)
);

CREATE INDEX idx_mcp_servers_user_status
  ON mcp_servers(user_id, status, updated_at DESC);
CREATE INDEX idx_mcp_tools_user_server_enabled
  ON mcp_tools(user_id, server_id, enabled, public_name);
`;

export const STAGE45_MIGRATIONS: readonly Migration[] = [
  ...STAGE4_MIGRATIONS,
  { version: 5, name: 'mcp-tool-bridge', sql: V5_SQL },
  {
    version: 6,
    name: 'mcp-server-summary',
    sql: `ALTER TABLE mcp_servers ADD COLUMN summary TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 7,
    name: 'model-context-policy',
    sql: `
ALTER TABLE models ADD COLUMN context_window_override INTEGER
  CHECK (context_window_override IS NULL OR context_window_override BETWEEN 1024 AND 4000000);
ALTER TABLE models ADD COLUMN compaction_trigger_ratio REAL NOT NULL DEFAULT 0.8
  CHECK (compaction_trigger_ratio BETWEEN 0.5 AND 0.95);
`,
  },
  {
    version: 8,
    name: 'execution-permissions-and-approvals',
    sql: `
ALTER TABLE sessions ADD COLUMN permission_preset TEXT NOT NULL DEFAULT 'workspace-write'
  CHECK (permission_preset IN ('read-only', 'workspace-write', 'danger-full-access'));
ALTER TABLE mcp_tools ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'first-use'
  CHECK (approval_policy IN ('never', 'first-use', 'always'));
`,
  },
  {
    version: 9,
    name: 'user-session-permission-default',
    sql: `
ALTER TABLE local_users ADD COLUMN session_permission_preset TEXT NOT NULL DEFAULT 'workspace-write'
  CHECK (session_permission_preset IN ('read-only', 'workspace-write', 'danger-full-access'));
`,
  },
  {
    version: 10,
    name: 'automatic-model-output-budget',
    sql: `
UPDATE models
SET request_max_output_tokens = NULL,
    max_output_tokens = MIN(
      COALESCE(max_output_capability, 1000000),
      1000000,
      COALESCE(context_window_override, context_window, 32768)
        - CAST(COALESCE(context_window_override, context_window, 32768) * compaction_trigger_ratio AS INTEGER)
    )
WHERE request_max_output_tokens = 4096
  AND max_output_tokens = 4096;
`,
  },
  {
    version: 11,
    name: 'capability-categories',
    sql: `
CREATE TABLE capability_categories (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, name),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

INSERT INTO capability_categories
  (id, user_id, name, sort_order, is_system, created_at, updated_at)
SELECT 'uncategorized', id, '未分类', 1000000, 1, updated_at, updated_at FROM local_users;

INSERT INTO capability_categories
  (id, user_id, name, sort_order, is_system, created_at, updated_at)
SELECT 'memory', id, '记忆', 10, 0, updated_at, updated_at FROM local_users;

ALTER TABLE skill_installations ADD COLUMN category_id TEXT NOT NULL DEFAULT 'uncategorized';
ALTER TABLE mcp_servers ADD COLUMN category_id TEXT NOT NULL DEFAULT 'uncategorized';

UPDATE mcp_servers SET category_id = 'memory'
WHERE id = 'builtin-memory' AND status <> 'archived';

CREATE INDEX idx_skill_installations_user_category
  ON skill_installations(user_id, category_id, skill_name);
CREATE INDEX idx_mcp_servers_user_category
  ON mcp_servers(user_id, category_id, name);
`,
  },
  {
    version: 12,
    name: 'split-capability-category-types',
    sql: `
CREATE TABLE capability_categories_v12 (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('skill', 'mcp')),
  name        TEXT NOT NULL COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, type, id),
  UNIQUE (user_id, type, name),
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

INSERT INTO capability_categories_v12
  (id, user_id, type, name, sort_order, is_system, created_at, updated_at)
SELECT id, user_id, 'skill', name, sort_order, is_system, created_at, updated_at
FROM capability_categories;

INSERT INTO capability_categories_v12
  (id, user_id, type, name, sort_order, is_system, created_at, updated_at)
SELECT id, user_id, 'mcp', name, sort_order, is_system, created_at, updated_at
FROM capability_categories;

DROP TABLE capability_categories;
ALTER TABLE capability_categories_v12 RENAME TO capability_categories;
`,
  },
  {
    version: 13,
    name: 'prune-capability-category-namespaces',
    sql: `
-- v12 把所有旧分类复制进了 skill 与 mcp 两个命名空间，导致用户在 Skill 页创建的分类
-- 泄漏进 mcp（同名 mcp 副本），mcp 专有的 memory 分类也泄漏进 skill。按命名空间裁剪：
--   mcp   只保留系统分类 + memory（builtin-memory 的归属）
--   skill 只保留系统分类
-- 被裁剪分类下的 server/skill 一律回退到 uncategorized。
UPDATE mcp_servers
   SET category_id = 'uncategorized', updated_at = datetime('now')
 WHERE category_id IN (
     SELECT id FROM capability_categories
      WHERE type = 'mcp' AND is_system = 0 AND id <> 'memory'
 );

UPDATE skill_installations
   SET category_id = 'uncategorized', updated_at = datetime('now')
 WHERE category_id = 'memory';

DELETE FROM capability_categories
 WHERE type = 'mcp' AND is_system = 0 AND id <> 'memory';

DELETE FROM capability_categories
 WHERE type = 'skill' AND is_system = 0 AND id = 'memory';
`,
  },
];

/** 阶段 4.7.0 本机登录凭据。登录会话只驻留服务内存，不进入数据库。 */
const V14_SQL = `
CREATE TABLE local_auth_credentials (
  user_id               TEXT PRIMARY KEY,
  login_name            TEXT NOT NULL,
  normalized_login_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_digest       TEXT NOT NULL,
  password_salt         TEXT NOT NULL,
  password_params_json  TEXT NOT NULL CHECK (json_valid(password_params_json)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES local_users(id)
);

CREATE UNIQUE INDEX idx_local_auth_credentials_login
  ON local_auth_credentials(normalized_login_name);
`;

export const STAGE47_MIGRATIONS: readonly Migration[] = [
  ...STAGE45_MIGRATIONS,
  { version: 14, name: 'local-auth-credentials', sql: V14_SQL },
  {
    version: 15,
    name: 'multi-agent-profiles-and-session-ownership',
    sql: `
ALTER TABLE user_config_revisions
  ADD COLUMN agent_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_profiles (
  id                 TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  avatar_key         TEXT,
  instructions       TEXT NOT NULL DEFAULT '',
  default_model_id   TEXT,
  permission_preset  TEXT NOT NULL DEFAULT 'workspace-write'
    CHECK (permission_preset IN ('read-only', 'workspace-write', 'danger-full-access')),
  status             TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  revision           INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES local_users(id),
  FOREIGN KEY (user_id, default_model_id) REFERENCES models(user_id, id)
);

CREATE UNIQUE INDEX idx_agent_profiles_active_default
  ON agent_profiles(user_id) WHERE status = 'active' AND is_default = 1;
CREATE INDEX idx_agent_profiles_user_status_name
  ON agent_profiles(user_id, status, name, id);

CREATE TABLE agent_home_items (
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  sort_order  INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id),
  UNIQUE (user_id, sort_order),
  FOREIGN KEY (user_id, agent_id) REFERENCES agent_profiles(user_id, id)
);

CREATE TABLE agent_skill_bindings (
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id, skill_id),
  FOREIGN KEY (user_id, agent_id) REFERENCES agent_profiles(user_id, id),
  FOREIGN KEY (user_id, skill_id) REFERENCES skill_installations(user_id, id)
);

CREATE TABLE agent_mcp_bindings (
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  server_id    TEXT NOT NULL,
  access_scope TEXT NOT NULL CHECK (access_scope IN ('user', 'agent')),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id, server_id, access_scope),
  FOREIGN KEY (user_id, agent_id) REFERENCES agent_profiles(user_id, id),
  FOREIGN KEY (user_id, server_id) REFERENCES mcp_servers(user_id, id)
);

CREATE TABLE agent_delegate_bindings (
  user_id         TEXT NOT NULL,
  caller_agent_id TEXT NOT NULL,
  callee_agent_id TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, caller_agent_id, callee_agent_id),
  CHECK (caller_agent_id <> callee_agent_id),
  FOREIGN KEY (user_id, caller_agent_id) REFERENCES agent_profiles(user_id, id),
  FOREIGN KEY (user_id, callee_agent_id) REFERENCES agent_profiles(user_id, id)
);

ALTER TABLE sessions ADD COLUMN agent_id TEXT;
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'direct'
  CHECK (origin IN ('direct', 'delegated'));
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;

INSERT INTO agent_profiles
  (id, user_id, name, description, avatar_key, instructions, default_model_id,
   permission_preset, status, is_default, revision, created_at, updated_at)
SELECT 'dylan', id, 'Dylan', '默认通用智能体', avatar_key, '', NULL,
       session_permission_preset, 'active', 1, 0, created_at, updated_at
FROM local_users;

INSERT INTO agent_home_items (user_id, agent_id, sort_order, created_at)
SELECT id, 'dylan', 0, created_at FROM local_users;

UPDATE sessions SET agent_id = 'dylan', origin = 'direct', parent_session_id = NULL;

CREATE INDEX idx_agent_home_items_user_sort
  ON agent_home_items(user_id, sort_order);
CREATE INDEX idx_sessions_user_agent_origin_status_updated
  ON sessions(user_id, agent_id, origin, status, updated_at DESC);

CREATE TRIGGER trg_agent_home_active_insert
BEFORE INSERT ON agent_home_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agent_profiles
    WHERE user_id = NEW.user_id AND id = NEW.agent_id AND status = 'active'
  ) THEN RAISE(ABORT, 'agent home item requires active agent') END;
END;

CREATE TRIGGER trg_sessions_agent_scope_insert
BEFORE INSERT ON sessions
BEGIN
  SELECT CASE WHEN NEW.agent_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM agent_profiles
    WHERE user_id = NEW.user_id AND id = NEW.agent_id AND status = 'active'
  ) THEN RAISE(ABORT, 'session requires active agent') END;
  SELECT CASE WHEN
    (NEW.origin = 'direct' AND NEW.parent_session_id IS NOT NULL) OR
    (NEW.origin = 'delegated' AND NEW.parent_session_id IS NULL)
  THEN RAISE(ABORT, 'invalid session origin') END;
  SELECT CASE WHEN NEW.origin = 'delegated' AND NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE user_id = NEW.user_id AND id = NEW.parent_session_id
      AND origin = 'direct'
  ) THEN RAISE(ABORT, 'delegated parent must be direct') END;
END;

CREATE TRIGGER trg_sessions_agent_scope_immutable
BEFORE UPDATE OF agent_id, origin, parent_session_id ON sessions
WHEN OLD.agent_id IS NOT NEW.agent_id
  OR OLD.origin IS NOT NEW.origin
  OR OLD.parent_session_id IS NOT NEW.parent_session_id
BEGIN
  SELECT RAISE(ABORT, 'session agent scope is immutable');
END;

CREATE TABLE agent_delegations (
  id                    TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  parent_session_id     TEXT NOT NULL,
  parent_turn_id        TEXT NOT NULL,
  parent_tool_call_id   TEXT NOT NULL,
  delegated_session_id  TEXT NOT NULL,
  target_agent_id       TEXT NOT NULL,
  status                TEXT NOT NULL
    CHECK (status IN ('accepted', 'running', 'awaiting_user', 'completed', 'failed', 'cancelled', 'interrupted')),
  deadline              TEXT NOT NULL,
  result_event_ref      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, parent_tool_call_id),
  UNIQUE (user_id, delegated_session_id),
  FOREIGN KEY (user_id, parent_session_id) REFERENCES sessions(user_id, id),
  FOREIGN KEY (user_id, delegated_session_id) REFERENCES sessions(user_id, id),
  FOREIGN KEY (user_id, target_agent_id) REFERENCES agent_profiles(user_id, id)
);

CREATE INDEX idx_agent_delegations_parent_turn
  ON agent_delegations(user_id, parent_session_id, parent_turn_id, status);
`,
  },
];
