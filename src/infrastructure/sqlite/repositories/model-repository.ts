import type { SqliteDatabase } from '../connection';
import { mapSqliteError } from '../connection';
import type {
  Model,
  ModelService,
  ModelSource,
  UserModelSettings,
} from '../../../shared/domain/model';
import type { LocalUserId } from '../../../shared/domain/user';
import { BridgeError } from '../../../shared/contracts/errors';

interface ServiceRow {
  id: string;
  user_id: string;
  name: string;
  provider_type: string;
  endpoint: string;
  credential_ref: string | null;
  provider_preset_id?: string | null;
  provider_preset_version?: number | null;
  status: 'enabled' | 'disabled' | 'archived';
  config_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ModelRow {
  id: string;
  user_id: string;
  service_id: string;
  remote_model_id: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  input_capability?: number | null;
  max_output_capability?: number | null;
  request_max_output_tokens?: number | null;
  metadata_source?: Model['metadataSource'];
  catalog_version?: string | null;
  capability_profile_ref?: string | null;
  capability_match_kind?: Model['capabilityMatchKind'];
  thinking_mode?: Model['thinkingMode'];
  reasoning_effort?: Model['reasoningEffort'];
  capabilities_json: string;
  default_params_json: string;
  source: ModelSource;
  status: 'enabled' | 'disabled' | 'archived';
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface SettingsRow {
  user_id: string;
  default_model_id: string | null;
  updated_at: string;
}

export class ModelRepository {
  private readonly stage4: boolean;

  constructor(private readonly db: SqliteDatabase) {
    this.stage4 =
      (this.db
        .prepare("SELECT 1 FROM pragma_table_info('models') WHERE name = 'thinking_mode'")
        .get() as { 1: number } | undefined) !== undefined;
  }

  createService(input: {
    id: string;
    userId: LocalUserId;
    name: string;
    providerType: string;
    endpoint: string;
    credentialRef: string | null;
    providerPresetId?: string | null;
    providerPresetVersion?: number | null;
    config: Record<string, unknown>;
    now: string;
  }): ModelService {
    const service: ModelService = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      providerType: input.providerType,
      endpoint: input.endpoint,
      credentialRef: input.credentialRef,
      providerPresetId: input.providerPresetId ?? null,
      providerPresetVersion: input.providerPresetVersion ?? null,
      status: 'enabled',
      config: input.config,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
    };
    try {
      const txn = this.db.transaction(() => {
        const statement = this.stage4
          ? this.db.prepare(
              `INSERT INTO model_services
               (id, user_id, name, provider_type, endpoint, credential_ref, provider_preset_id,
                provider_preset_version, status, config_json, created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, NULL)`,
            )
          : this.db.prepare(
              `INSERT INTO model_services
                 (id, user_id, name, provider_type, endpoint, credential_ref, status, config_json, created_at, updated_at, archived_at)
               VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, NULL)`,
            );
        statement.run(
          service.id,
          service.userId,
          service.name,
          service.providerType,
          service.endpoint,
          service.credentialRef,
          ...(this.stage4 ? [service.providerPresetId, service.providerPresetVersion] : []),
          JSON.stringify(service.config),
          service.createdAt,
          service.updatedAt,
        );
        this.bumpModelRevision(service.userId, service.updatedAt);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
    return service;
  }

  getService(userId: LocalUserId, id: string): ModelService | undefined {
    const row = this.db
      .prepare('SELECT * FROM model_services WHERE user_id = ? AND id = ?')
      .get(userId, id) as ServiceRow | undefined;
    return row ? this.mapService(row) : undefined;
  }

  listServices(userId: LocalUserId): ModelService[] {
    const rows = this.db
      .prepare('SELECT * FROM model_services WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as ServiceRow[];
    return rows.map((r) => this.mapService(r));
  }

  archiveService(userId: LocalUserId, id: string, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT id FROM model_services WHERE user_id = ? AND id = ?')
          .get(userId, id) as { id: string } | undefined;
        if (!existing) {
          throw new BridgeError('INVALID_REQUEST', 'Service not found');
        }
        const usedAsDefault = this.db
          .prepare(
            `SELECT ums.default_model_id AS id
             FROM user_model_settings ums
             JOIN models m ON m.user_id = ums.user_id AND m.id = ums.default_model_id
             WHERE ums.user_id = ? AND m.service_id = ?`,
          )
          .get(userId, id) as { id: string } | undefined;
        if (usedAsDefault) {
          throw new BridgeError('INVALID_REQUEST', 'Cannot archive service with default model');
        }
        this.db
          .prepare(
            `UPDATE model_services SET status = 'archived', archived_at = ?, updated_at = ?
             WHERE user_id = ? AND id = ?`,
          )
          .run(now, now, userId, id);
        this.db
          .prepare(
            `UPDATE models SET status = 'archived', archived_at = ?, updated_at = ?
             WHERE user_id = ? AND service_id = ? AND status <> 'archived'`,
          )
          .run(now, now, userId, id);
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  updateService(
    userId: LocalUserId,
    id: string,
    patch: {
      name?: string;
      endpoint?: string;
      config?: Record<string, unknown>;
      credentialRef?: string | null;
      providerPresetId?: string | null;
      providerPresetVersion?: number | null;
      status?: 'enabled' | 'disabled';
    },
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT * FROM model_services WHERE user_id = ? AND id = ?')
          .get(userId, id) as ServiceRow | undefined;
        if (!existing) {
          throw new BridgeError('INVALID_REQUEST', 'Service not found');
        }
        const name = patch.name ?? existing.name;
        const endpoint = patch.endpoint ?? existing.endpoint;
        const config =
          patch.config ?? (JSON.parse(existing.config_json) as Record<string, unknown>);
        const credentialRef =
          patch.credentialRef !== undefined ? patch.credentialRef : existing.credential_ref;
        const providerPresetId =
          patch.providerPresetId !== undefined
            ? patch.providerPresetId
            : existing.provider_preset_id;
        const providerPresetVersion =
          patch.providerPresetVersion !== undefined
            ? patch.providerPresetVersion
            : existing.provider_preset_version;
        const status = patch.status ?? existing.status;
        const statement = this.stage4
          ? this.db.prepare(
              `UPDATE model_services SET name = ?, endpoint = ?, config_json = ?, credential_ref = ?,
               provider_preset_id = ?, provider_preset_version = ?, status = ?,
               archived_at = CASE WHEN ? = 'archived' THEN archived_at ELSE NULL END, updated_at = ?
             WHERE user_id = ? AND id = ?`,
            )
          : this.db.prepare(
              `UPDATE model_services SET name = ?, endpoint = ?, config_json = ?, credential_ref = ?, status = ?,
                 archived_at = CASE WHEN ? = 'archived' THEN archived_at ELSE NULL END, updated_at = ?
               WHERE user_id = ? AND id = ?`,
            );
        statement.run(
          name,
          endpoint,
          JSON.stringify(config),
          credentialRef,
          ...(this.stage4 ? [providerPresetId, providerPresetVersion] : []),
          status,
          status,
          now,
          userId,
          id,
        );
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  setModelStatus(
    userId: LocalUserId,
    id: string,
    status: 'enabled' | 'disabled' | 'archived',
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT id FROM models WHERE user_id = ? AND id = ?')
          .get(userId, id) as { id: string } | undefined;
        if (!existing) {
          throw new BridgeError('INVALID_REQUEST', 'Model not found');
        }
        if (status === 'archived') {
          const isDefault =
            (
              this.db
                .prepare('SELECT default_model_id FROM user_model_settings WHERE user_id = ?')
                .get(userId) as SettingsRow | undefined
            )?.default_model_id === id;
          if (isDefault) {
            throw new BridgeError('INVALID_REQUEST', 'Cannot archive the default model');
          }
        }
        this.db
          .prepare(
            `UPDATE models SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END, updated_at = ?
             WHERE user_id = ? AND id = ?`,
          )
          .run(status, status, now, now, userId, id);
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  clearDefaultModel(userId: LocalUserId, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            'UPDATE user_model_settings SET default_model_id = NULL, updated_at = ? WHERE user_id = ?',
          )
          .run(now, userId);
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  createModel(input: {
    id: string;
    userId: LocalUserId;
    serviceId: string;
    remoteModelId: string;
    displayName: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputCapability?: number | null;
    maxOutputCapability?: number | null;
    requestMaxOutputTokens?: number | null;
    metadataSource?: Model['metadataSource'];
    catalogVersion?: string | null;
    capabilityProfileRef?: string | null;
    capabilityMatchKind?: Model['capabilityMatchKind'];
    thinkingMode?: Model['thinkingMode'];
    reasoningEffort?: Model['reasoningEffort'];
    capabilities: Record<string, unknown>;
    defaultParams: Record<string, unknown>;
    source: ModelSource;
    now: string;
  }): Model {
    const model: Model = {
      id: input.id,
      userId: input.userId,
      serviceId: input.serviceId,
      remoteModelId: input.remoteModelId,
      displayName: input.displayName,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      inputCapability: input.inputCapability ?? null,
      maxOutputCapability: input.maxOutputCapability ?? input.maxOutputTokens,
      requestMaxOutputTokens: input.requestMaxOutputTokens ?? input.maxOutputTokens,
      metadataSource: input.metadataSource ?? 'manual',
      catalogVersion: input.catalogVersion ?? null,
      capabilityProfileRef: input.capabilityProfileRef ?? null,
      capabilityMatchKind: input.capabilityMatchKind ?? 'manual',
      thinkingMode: input.thinkingMode ?? 'auto',
      reasoningEffort: input.reasoningEffort ?? null,
      capabilities: input.capabilities,
      defaultParams: input.defaultParams,
      source: input.source,
      status: 'enabled',
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
    };
    try {
      const txn = this.db.transaction(() => {
        const statement = this.stage4
          ? this.db.prepare(
              `INSERT INTO models
               (id, user_id, service_id, remote_model_id, display_name, context_window, max_output_tokens,
                input_capability, max_output_capability, request_max_output_tokens, metadata_source,
                catalog_version, capability_profile_ref, capability_match_kind, thinking_mode, reasoning_effort,
                capabilities_json, default_params_json, source, status, created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, NULL)`,
            )
          : this.db.prepare(
              `INSERT INTO models
                 (id, user_id, service_id, remote_model_id, display_name, context_window, max_output_tokens,
                  capabilities_json, default_params_json, source, status, created_at, updated_at, archived_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, NULL)`,
            );
        statement.run(
          model.id,
          model.userId,
          model.serviceId,
          model.remoteModelId,
          model.displayName,
          model.contextWindow,
          model.maxOutputTokens,
          ...(this.stage4
            ? [
                model.inputCapability,
                model.maxOutputCapability,
                model.requestMaxOutputTokens,
                model.metadataSource,
                model.catalogVersion,
                model.capabilityProfileRef,
                model.capabilityMatchKind,
                model.thinkingMode,
                model.reasoningEffort,
              ]
            : []),
          JSON.stringify(model.capabilities),
          JSON.stringify(model.defaultParams),
          model.source,
          model.createdAt,
          model.updatedAt,
        );
        this.bumpModelRevision(model.userId, model.updatedAt);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
    return model;
  }

  getModel(userId: LocalUserId, id: string): Model | undefined {
    const row = this.db
      .prepare('SELECT * FROM models WHERE user_id = ? AND id = ?')
      .get(userId, id) as ModelRow | undefined;
    return row ? this.mapModel(row) : undefined;
  }

  getModelByRemoteId(
    userId: LocalUserId,
    serviceId: string,
    remoteModelId: string,
  ): Model | undefined {
    const row = this.db
      .prepare('SELECT * FROM models WHERE user_id = ? AND service_id = ? AND remote_model_id = ?')
      .get(userId, serviceId, remoteModelId) as ModelRow | undefined;
    return row ? this.mapModel(row) : undefined;
  }

  updateModel(
    userId: LocalUserId,
    id: string,
    patch: {
      remoteModelId: string;
      displayName: string;
      contextWindow: number;
      maxOutputTokens: number;
      inputCapability?: number | null;
      maxOutputCapability?: number | null;
      requestMaxOutputTokens?: number | null;
      metadataSource?: Model['metadataSource'];
      catalogVersion?: string | null;
      capabilityProfileRef?: string | null;
      capabilityMatchKind?: Model['capabilityMatchKind'];
      thinkingMode?: Model['thinkingMode'];
      reasoningEffort?: Model['reasoningEffort'];
      capabilities: Record<string, unknown>;
      defaultParams: Record<string, unknown>;
      status: 'enabled' | 'disabled';
    },
    now: string,
  ): void {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db
          .prepare('SELECT id FROM models WHERE user_id = ? AND id = ?')
          .get(userId, id) as { id: string } | undefined;
        if (!existing) throw new BridgeError('INVALID_REQUEST', 'Model not found');
        const statement = this.stage4
          ? this.db.prepare(
              `UPDATE models
             SET remote_model_id = ?, display_name = ?, context_window = ?, max_output_tokens = ?,
                 input_capability = ?, max_output_capability = ?, request_max_output_tokens = ?,
                 metadata_source = ?, catalog_version = ?, capability_profile_ref = ?,
                 capability_match_kind = ?, thinking_mode = ?, reasoning_effort = ?,
                 capabilities_json = ?, default_params_json = ?, status = ?, archived_at = NULL,
                 config_version = config_version + 1, updated_at = ?
             WHERE user_id = ? AND id = ?`,
            )
          : this.db.prepare(
              `UPDATE models
               SET remote_model_id = ?, display_name = ?, context_window = ?, max_output_tokens = ?,
                   capabilities_json = ?, default_params_json = ?, status = ?, archived_at = NULL,
                   config_version = config_version + 1, updated_at = ?
               WHERE user_id = ? AND id = ?`,
            );
        statement.run(
          patch.remoteModelId,
          patch.displayName,
          patch.contextWindow,
          patch.maxOutputTokens,
          ...(this.stage4
            ? [
                patch.inputCapability ?? null,
                patch.maxOutputCapability ?? patch.maxOutputTokens,
                patch.requestMaxOutputTokens ?? patch.maxOutputTokens,
                patch.metadataSource ?? 'manual',
                patch.catalogVersion ?? null,
                patch.capabilityProfileRef ?? null,
                patch.capabilityMatchKind ?? 'manual',
                patch.thinkingMode ?? 'auto',
                patch.reasoningEffort ?? null,
              ]
            : []),
          JSON.stringify(patch.capabilities),
          JSON.stringify(patch.defaultParams),
          patch.status,
          now,
          userId,
          id,
        );
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  listModels(userId: LocalUserId): Model[] {
    const rows = this.db
      .prepare('SELECT * FROM models WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as ModelRow[];
    return rows.map((r) => this.mapModel(r));
  }

  getDefaultModelId(userId: LocalUserId): string | null {
    const row = this.db
      .prepare('SELECT * FROM user_model_settings WHERE user_id = ?')
      .get(userId) as SettingsRow | undefined;
    return row?.default_model_id ?? null;
  }

  setDefaultModel(userId: LocalUserId, modelId: string, now: string): void {
    try {
      const txn = this.db.transaction(() => {
        const model = this.db
          .prepare(
            `SELECT m.id, m.status AS model_status, s.status AS service_status
             FROM models m JOIN model_services s ON m.user_id = s.user_id AND m.service_id = s.id
             WHERE m.user_id = ? AND m.id = ?`,
          )
          .get(userId, modelId) as
          { id: string; model_status: string; service_status: string } | undefined;
        if (!model) {
          throw new BridgeError('INVALID_REQUEST', 'Model not found');
        }
        if (model.model_status !== 'enabled' || model.service_status !== 'enabled') {
          throw new BridgeError('INVALID_REQUEST', 'Model is not enabled');
        }
        this.db
          .prepare(
            'UPDATE user_model_settings SET default_model_id = ?, updated_at = ? WHERE user_id = ?',
          )
          .run(modelId, now, userId);
        this.bumpModelRevision(userId, now);
      });
      txn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  private bumpModelRevision(userId: LocalUserId, now: string): void {
    this.db
      .prepare(
        'UPDATE user_config_revisions SET model_revision = model_revision + 1, updated_at = ? WHERE user_id = ?',
      )
      .run(now, userId);
  }

  private mapService(row: ServiceRow): ModelService {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      providerType: row.provider_type,
      endpoint: row.endpoint,
      credentialRef: row.credential_ref,
      providerPresetId: row.provider_preset_id ?? null,
      providerPresetVersion: row.provider_preset_version ?? null,
      status: row.status,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  private mapModel(row: ModelRow): Model {
    return {
      id: row.id,
      userId: row.user_id,
      serviceId: row.service_id,
      remoteModelId: row.remote_model_id,
      displayName: row.display_name,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      inputCapability: row.input_capability ?? null,
      maxOutputCapability: row.max_output_capability ?? row.max_output_tokens,
      requestMaxOutputTokens: row.request_max_output_tokens ?? row.max_output_tokens,
      metadataSource: row.metadata_source ?? 'legacy',
      catalogVersion: row.catalog_version ?? null,
      capabilityProfileRef: row.capability_profile_ref ?? null,
      capabilityMatchKind: row.capability_match_kind ?? 'unresolved',
      thinkingMode: row.thinking_mode ?? 'auto',
      reasoningEffort: row.reasoning_effort ?? null,
      capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown>,
      defaultParams: JSON.parse(row.default_params_json) as Record<string, unknown>,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }
}

export type { UserModelSettings };
