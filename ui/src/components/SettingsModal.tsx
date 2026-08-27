import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type {
  ModelDiscoveryResult,
  ModelManagementSnapshot,
  ModelCallStatisticsParams,
  ModelCallStatisticsSnapshot,
  ModelSaveParams,
  ModelServiceSaveParams,
  SkillManagementSnapshot,
} from '@client-contracts';
import { command, query, requireClient, unwrap, userMessage } from '../client';
import type { SettingsTab } from '../types';

interface SettingsModalProps {
  initialTab?: SettingsTab;
  onClose(): void;
  onModelChanged(snapshot: ModelManagementSnapshot): void;
  onNotify(message: string, tone?: 'success' | 'error' | 'info'): void;
}

export function SettingsModal(props: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'models');

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [props]);

  return (
    <div className="settings-shell" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-nav">
        <div className="settings-title">
          <button className="icon-button" onClick={props.onClose} aria-label="返回">
            <ArrowLeft size={17} />
          </button>
          <strong>设置</strong>
        </div>
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
          <Database size={15} /> 模型配置
        </button>
        <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
          <Zap size={15} /> 技能与插件
        </button>
        <button
          className={tab === 'statistics' ? 'active' : ''}
          onClick={() => setTab('statistics')}
        >
          <BarChart3 size={15} /> 调用统计
        </button>
      </aside>
      <section className="settings-content">
        {tab === 'models' ? (
          <ModelSettings {...props} />
        ) : tab === 'skills' ? (
          <SkillSettings onNotify={props.onNotify} />
        ) : (
          <StatisticsSettings onNotify={props.onNotify} />
        )}
      </section>
    </div>
  );
}

interface ModelDraft {
  id?: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  apiKey: string;
  clearCredential: boolean;
  providerPresetId: 'deepseek-official' | 'alibaba-bailian' | null;
}

const emptyService = (): ModelDraft => ({
  name: '新模型服务',
  endpoint: '',
  enabled: true,
  apiKey: '',
  clearCredential: false,
  providerPresetId: null,
});

function ModelSettings(props: SettingsModalProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelManagementSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(emptyService);
  const [serviceSearch, setServiceSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>('load');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discoveredDetails, setDiscoveredDetails] = useState<ModelDiscoveryResult['models']>([]);
  const [manualOpen, setManualOpen] = useState(false);

  const reload = async (preferred?: string) => {
    setBusy('load');
    try {
      const next = await query<ModelManagementSnapshot>('model-management.snapshot');
      setSnapshot(next);
      props.onModelChanged(next);
      const target = preferred ?? selectedId ?? next.services[0]?.id ?? null;
      setSelectedId(target);
      const service = next.services.find((item) => item.id === target);
      setDraft(
        service
          ? {
              id: service.id,
              name: service.name,
              endpoint: service.endpoint,
              enabled: service.status === 'enabled',
              apiKey: '',
              clearCredential: false,
              providerPresetId:
                service.providerPresetId === 'deepseek-official' ||
                service.providerPresetId === 'alibaba-bailian'
                  ? service.providerPresetId
                  : null,
            }
          : emptyService(),
      );
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const selectService = (id: string) => {
    const service = snapshot?.services.find((item) => item.id === id);
    if (!service) return;
    setSelectedId(id);
    setDiscovered([]);
    setDraft({
      id: service.id,
      name: service.name,
      endpoint: service.endpoint,
      enabled: service.status === 'enabled',
      apiKey: '',
      clearCredential: false,
      providerPresetId:
        service.providerPresetId === 'deepseek-official' ||
        service.providerPresetId === 'alibaba-bailian'
          ? service.providerPresetId
          : null,
    });
  };

  const mutation = () => {
    if (draft.clearCredential) return { action: 'clear' as const };
    if (draft.apiKey.trim()) return { action: 'replace' as const, value: draft.apiKey.trim() };
    return { action: 'unchanged' as const };
  };

  const serviceParams = (expectedRevision?: number): ModelServiceSaveParams => ({
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    providerType: 'openai-compatible',
    providerPresetId: draft.providerPresetId,
    endpoint: draft.endpoint.trim(),
    enabled: draft.enabled,
    config: {},
    credential: mutation(),
    expectedRevision: expectedRevision ?? snapshot?.revision ?? 0,
  });

  const saveService = async () => {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      props.onNotify('请填写服务名称和 API 地址。', 'error');
      return;
    }
    setBusy('save');
    try {
      const result = await command<{ id: string }>('model-service.save', serviceParams());
      props.onNotify('模型服务已保存。', 'success');
      await reload(result.id);
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const testService = async () => {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      props.onNotify('请先填写完整的服务配置。', 'error');
      return;
    }
    setBusy('test');
    try {
      const { expectedRevision, ...params } = serviceParams();
      void expectedRevision;
      const result = await command<{ status: string }>('model-service.test', params);
      const labels: Record<string, string> = {
        success: '连接成功。',
        auth: '认证失败，请检查 API Key。',
        network: '无法连接模型服务。',
        timeout: '连接超时。',
        protocol: '服务响应不符合 OpenAI 兼容协议。',
      };
      props.onNotify(
        labels[result.status] ?? '连接测试完成。',
        result.status === 'success' ? 'success' : 'error',
      );
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const archiveService = async () => {
    if (!draft.id || !snapshot || !window.confirm(`删除模型服务“${draft.name}”？`)) return;
    setBusy('archive');
    try {
      await command('model-service.archive', { id: draft.id, expectedRevision: snapshot.revision });
      setSelectedId(null);
      props.onNotify('模型服务已删除。', 'success');
      await reload('');
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    if (!draft.id) {
      props.onNotify('请先保存模型服务。', 'info');
      return;
    }
    setBusy('discover');
    try {
      const result = await command<ModelDiscoveryResult>('model.discover', { serviceId: draft.id });
      setDiscovered(result.remoteModelIds);
      setDiscoveredDetails(result.models);
      props.onNotify(`已获取 ${result.remoteModelIds.length} 个远程模型。`, 'success');
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveModel = async (remoteModelId: string, displayName = remoteModelId) => {
    if (!snapshot || !draft.id) return;
    setBusy(`model:${remoteModelId}`);
    try {
      const discoveredModel = discoveredDetails.find((model) => model.id === remoteModelId);
      const contextWindow = discoveredModel?.contextWindow ?? 32768;
      const maxOutputCapability = discoveredModel?.maxOutputCapability ?? 4096;
      const params: ModelSaveParams = {
        serviceId: draft.id,
        remoteModelId,
        displayName,
        contextWindow,
        inputCapability: discoveredModel?.inputCapability ?? null,
        maxOutputCapability,
        requestMaxOutputTokens: Math.min(4096, maxOutputCapability),
        maxOutputTokens: Math.min(4096, maxOutputCapability),
        metadataSource: discoveredModel?.metadataSource ?? 'manual',
        catalogVersion: discoveredModel ? 'bundled' : null,
        capabilityProfileRef: null,
        capabilityMatchKind: discoveredModel?.capabilityMatchKind ?? 'manual',
        thinkingMode: 'auto',
        reasoningEffort: null,
        capabilities: { tools: true, streaming: true, vision: false },
        defaultParams: {},
        enabled: true,
        expectedRevision: snapshot.revision,
      };
      await command('model.save', params);
      setDiscovered((items) => items.filter((item) => item !== remoteModelId));
      props.onNotify(`模型 ${displayName} 已添加。`, 'success');
      await reload(draft.id);
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const serviceModels = snapshot?.models.filter((model) => model.serviceId === draft.id) ?? [];
  const filteredServices =
    snapshot?.services.filter((service) =>
      service.name.toLocaleLowerCase().includes(serviceSearch.trim().toLocaleLowerCase()),
    ) ?? [];

  return (
    <div className="settings-page models-page">
      <header className="settings-page-header">
        <div>
          <h2>Agent 模型管理</h2>
          <p>配置仅供当前本地用户的智能体使用，模型与凭证均按用户隔离。</p>
        </div>
        <button className="icon-button" onClick={props.onClose} aria-label="关闭设置">
          <X size={18} />
        </button>
      </header>
      <div className="model-layout">
        <aside className="service-list">
          <label className="compact-search">
            <Search size={14} />
            <input
              value={serviceSearch}
              onChange={(event) => setServiceSearch(event.target.value)}
              placeholder="搜索模型服务"
            />
          </label>
          <button
            className="dashed-button"
            onClick={() => {
              setSelectedId(null);
              setDraft(emptyService());
              setDiscovered([]);
            }}
          >
            <Plus size={14} /> 添加模型服务
          </button>
          <div className="service-items custom-scrollbar">
            {filteredServices.map((service) => (
              <button
                key={service.id}
                className={`service-item ${selectedId === service.id ? 'active' : ''}`}
                onClick={() => selectService(service.id)}
              >
                <span className="service-icon">
                  <Database size={14} />
                </span>
                <span className="service-copy">
                  <strong>{service.name}</strong>
                  <small>{service.modelCount} 个模型</small>
                </span>
                {service.agentReady && <em>Agent 可用</em>}
              </button>
            ))}
          </div>
        </aside>
        <div className="service-editor custom-scrollbar">
          {busy === 'load' && !snapshot ? (
            <div className="center-state">
              <RefreshCw className="spin" /> 加载模型配置...
            </div>
          ) : (
            <div className="editor-column">
              <div className="editor-heading">
                <div>
                  <h3>{draft.name || '新模型服务'}</h3>
                  <span className="security-note">
                    <KeyRound size={12} /> 密钥不会回显
                  </span>
                </div>
                <div className="row-actions">
                  <label className="switch-label">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    <span />
                    启用
                  </label>
                  <button
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void testService()}
                  >
                    {busy === 'test' ? (
                      <RefreshCw className="spin" size={13} />
                    ) : (
                      <CheckCircle2 size={13} />
                    )}{' '}
                    测试
                  </button>
                  <button
                    className="primary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void saveService()}
                  >
                    保存
                  </button>
                </div>
              </div>
              <div className="form-grid two">
                <label>
                  <span>服务名称</span>
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  <span>服务类型</span>
                  <select
                    value={draft.providerPresetId ?? 'custom'}
                    onChange={(event) => {
                      const providerPresetId =
                        event.target.value === 'custom'
                          ? null
                          : (event.target.value as ModelDraft['providerPresetId']);
                      const endpoint =
                        providerPresetId === 'deepseek-official'
                          ? 'https://api.deepseek.com/'
                          : providerPresetId === 'alibaba-bailian'
                            ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                            : draft.endpoint;
                      setDraft({ ...draft, providerPresetId, endpoint });
                    }}
                  >
                    <option value="custom">自定义 OpenAI 兼容</option>
                    <option value="deepseek-official">DeepSeek</option>
                    <option value="alibaba-bailian">阿里云百炼</option>
                  </select>
                </label>
              </div>
              <label className="form-field">
                <span>模型服务 API 地址</span>
                <input
                  value={draft.endpoint}
                  onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                  placeholder="https://example.com/v1"
                />
                <small>用于流式请求与获取模型列表；系统会自动补全 models 路径。</small>
              </label>
              <label className="form-field">
                <span>API 密钥</span>
                <div className="password-field">
                  <input
                    type={showKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={draft.apiKey}
                    disabled={draft.clearCredential}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                    placeholder={draft.id ? '留空表示保持现有密钥' : '输入 API Key（可选）'}
                  />
                  <button onClick={() => setShowKey(!showKey)}>
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>
              {draft.id && (
                <label className="clear-key">
                  <input
                    type="checkbox"
                    checked={draft.clearCredential}
                    onChange={(event) =>
                      setDraft({ ...draft, clearCredential: event.target.checked, apiKey: '' })
                    }
                  />
                  清除已保存的 API 密钥
                </label>
              )}
              <hr />
              <div className="models-heading">
                <div>
                  <h4>模型</h4>
                  <p>添加后可设置为当前用户的默认运行模型。</p>
                </div>
                <div className="row-actions">
                  <button
                    className="secondary-button"
                    disabled={!draft.id || Boolean(busy)}
                    onClick={() => void discover()}
                  >
                    <RefreshCw size={13} className={busy === 'discover' ? 'spin' : ''} /> 获取模型
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!draft.id}
                    onClick={() => setManualOpen(!manualOpen)}
                  >
                    <Plus size={13} /> 手动添加
                  </button>
                </div>
              </div>
              {manualOpen && (
                <ManualModelForm
                  disabled={Boolean(busy)}
                  onCancel={() => setManualOpen(false)}
                  onSave={(id, name) => {
                    setManualOpen(false);
                    void saveModel(id, name);
                  }}
                />
              )}
              {discovered.length > 0 && (
                <section className="discovered-list">
                  <strong>远程模型</strong>
                  {discovered.map((id) => (
                    <div key={id}>
                      <span>
                        {id}
                        {discoveredDetails.find((model) => model.id === id)?.contextWindow
                          ? ` · ${formatTokens(discoveredDetails.find((model) => model.id === id)?.contextWindow ?? null)}`
                          : ' · 容量待确认'}
                      </span>
                      <button disabled={Boolean(busy)} onClick={() => void saveModel(id)}>
                        <Plus size={13} /> 添加
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <div className="model-items">
                {serviceModels.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    snapshot={snapshot!}
                    disabled={Boolean(busy)}
                    onChanged={() => reload(draft.id)}
                    onNotify={props.onNotify}
                  />
                ))}
                {serviceModels.length === 0 && (
                  <div className="empty-panel">暂无模型，请从服务获取或手动添加。</div>
                )}
              </div>
              {draft.id && (
                <div className="danger-zone">
                  <button disabled={Boolean(busy)} onClick={() => void archiveService()}>
                    <Trash2 size={14} /> 删除模型服务
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ManualModelForm({
  disabled,
  onCancel,
  onSave,
}: {
  disabled: boolean;
  onCancel(): void;
  onSave(id: string, name: string): void;
}): JSX.Element {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="manual-model">
      <label>
        <span>远程模型 ID</span>
        <input
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="例如 deepseek-chat"
        />
      </label>
      <label>
        <span>显示名称</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="默认使用模型 ID"
        />
      </label>
      <button className="secondary-button" onClick={onCancel}>
        取消
      </button>
      <button
        className="primary-button"
        disabled={disabled || !id.trim()}
        onClick={() => onSave(id.trim(), name.trim() || id.trim())}
      >
        添加
      </button>
    </div>
  );
}

function ModelRow({
  model,
  snapshot,
  disabled,
  onChanged,
  onNotify,
}: {
  model: ModelManagementSnapshot['models'][number];
  snapshot: ModelManagementSnapshot;
  disabled: boolean;
  onChanged(): Promise<void>;
  onNotify(message: string, tone?: 'success' | 'error' | 'info'): void;
}): JSX.Element {
  const [thinkingMode, setThinkingMode] = useState(model.thinkingMode);
  const [reasoningEffort, setReasoningEffort] = useState(model.reasoningEffort);
  const [savingThinking, setSavingThinking] = useState(false);

  useEffect(() => {
    setThinkingMode(model.thinkingMode);
    setReasoningEffort(model.reasoningEffort);
  }, [model.thinkingMode, model.reasoningEffort]);

  const run = async (kind: 'default' | 'archive') => {
    try {
      if (kind === 'default')
        await command('model.default.set', {
          modelId: model.id,
          expectedRevision: snapshot.revision,
        });
      else if (window.confirm(`删除模型“${model.displayName}”？`))
        await command('model.archive', { id: model.id, expectedRevision: snapshot.revision });
      else return;
      onNotify(kind === 'default' ? '默认模型已切换。' : '模型已删除。', 'success');
      await onChanged();
    } catch (error) {
      onNotify(userMessage(error), 'error');
    }
  };
  const providerPresetId = snapshot.services.find(
    (service) => service.id === model.serviceId,
  )?.providerPresetId;
  const saveThinking = async (
    nextMode: 'auto' | 'enabled' | 'disabled',
    nextEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
  ) => {
    const normalizedEffort = nextMode === 'enabled' ? (nextEffort ?? 'medium') : null;
    const previousMode = thinkingMode;
    const previousEffort = reasoningEffort;
    setThinkingMode(nextMode);
    setReasoningEffort(normalizedEffort);
    setSavingThinking(true);
    try {
      await command('model.save', {
        id: model.id,
        serviceId: model.serviceId,
        remoteModelId: model.remoteModelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow ?? 32768,
        inputCapability: model.inputCapability,
        maxOutputCapability: model.maxOutputCapability,
        requestMaxOutputTokens: model.requestMaxOutputTokens ?? model.maxOutputTokens ?? 4096,
        maxOutputTokens: model.maxOutputTokens ?? 4096,
        metadataSource: model.metadataSource,
        catalogVersion: model.catalogVersion,
        capabilityProfileRef: model.capabilityProfileRef,
        capabilityMatchKind: model.capabilityMatchKind,
        thinkingMode: nextMode,
        reasoningEffort: normalizedEffort,
        capabilities: model.capabilities,
        defaultParams: model.defaultParams,
        enabled: model.status === 'enabled',
        expectedRevision: snapshot.revision,
      });
      await onChanged();
      onNotify('思考设置已保存。', 'success');
    } catch (error) {
      setThinkingMode(previousMode);
      setReasoningEffort(previousEffort);
      onNotify(userMessage(error), 'error');
    } finally {
      setSavingThinking(false);
    }
  };
  return (
    <div className="model-row">
      <button
        className={`default-radio ${snapshot.defaultModelId === model.id ? 'selected' : ''}`}
        disabled={disabled}
        onClick={() => void run('default')}
        aria-label="设为默认模型"
      />
      <Database size={15} />
      <span className="model-copy">
        <strong>{model.displayName}</strong>
        <small>{model.remoteModelId}</small>
      </span>
      <span className="model-cap">
        <Settings2 size={12} /> {formatTokens(model.contextWindow)} · {model.metadataSource}
      </span>
      {providerPresetId ? (
        <>
          <select
            aria-label="思考模式"
            disabled={disabled || savingThinking}
            value={thinkingMode}
            onChange={(event) =>
              void saveThinking(
                event.target.value as 'auto' | 'enabled' | 'disabled',
                reasoningEffort,
              )
            }
          >
            <option value="auto">默认思考</option>
            <option value="disabled">关闭思考</option>
            <option value="enabled">开启思考</option>
          </select>
          {thinkingMode === 'enabled' ? (
            <select
              aria-label="思考强度"
              disabled={disabled || savingThinking}
              value={reasoningEffort ?? 'medium'}
              onChange={(event) =>
                void saveThinking(
                  'enabled',
                  event.target.value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
                )
              }
            >
              {model.supportedReasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {reasoningEffortLabel(effort)}
                </option>
              ))}
            </select>
          ) : null}
        </>
      ) : null}
      <button
        className="row-delete"
        disabled={disabled}
        onClick={() => void run('archive')}
        aria-label="删除模型"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function reasoningEffortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '很高',
    max: '最高',
  };
  return labels[effort] ?? effort;
}

interface StatisticsFilter {
  sessionId: string;
  modelKeyword: string;
  from: string;
  to: string;
}

const emptyStatisticsFilter = (): StatisticsFilter => ({
  sessionId: '',
  modelKeyword: '',
  from: '',
  to: '',
});

function StatisticsSettings({ onNotify }: Pick<SettingsModalProps, 'onNotify'>): JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelCallStatisticsSnapshot | null>(null);
  const [filter, setFilter] = useState<StatisticsFilter>(emptyStatisticsFilter);
  const [busy, setBusy] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = async (nextFilter: StatisticsFilter) => {
    setBusy(true);
    try {
      const params: ModelCallStatisticsParams = {
        ...(nextFilter.sessionId ? { sessionId: nextFilter.sessionId } : {}),
        ...(nextFilter.modelKeyword ? { modelKeyword: nextFilter.modelKeyword } : {}),
        ...(nextFilter.from ? { from: new Date(`${nextFilter.from}T00:00:00`).toISOString() } : {}),
        ...(nextFilter.to ? { to: new Date(`${nextFilter.to}T23:59:59.999`).toISOString() } : {}),
        limit: 100,
      };
      setSnapshot(await query<ModelCallStatisticsSnapshot>('model-call-statistics.query', params));
      setExpandedId(null);
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload(emptyStatisticsFilter());
  }, []);

  return (
    <div className="settings-page statistics-page">
      <header className="settings-page-header">
        <div>
          <h2>模型调用统计</h2>
          <p>按当前本地用户查询每次会话中的模型调用性能与 Token 用量。</p>
        </div>
      </header>

      <div className="statistics-body custom-scrollbar">
        <form
          className="statistics-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void reload(filter);
          }}
        >
          <label>
            <span>会话</span>
            <select
              value={filter.sessionId}
              onChange={(event) => setFilter({ ...filter, sessionId: event.target.value })}
            >
              <option value="">全部会话</option>
              {(snapshot?.sessions ?? []).map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>模型</span>
            <input
              value={filter.modelKeyword}
              list="statistics-model-options"
              placeholder="输入模型名称"
              onChange={(event) => setFilter({ ...filter, modelKeyword: event.target.value })}
            />
            <datalist id="statistics-model-options">
              {(snapshot?.models ?? []).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label>
            <span>开始日期</span>
            <input
              type="date"
              value={filter.from}
              onChange={(event) => setFilter({ ...filter, from: event.target.value })}
            />
          </label>
          <label>
            <span>结束日期</span>
            <input
              type="date"
              value={filter.to}
              onChange={(event) => setFilter({ ...filter, to: event.target.value })}
            />
          </label>
          <div className="statistics-filter-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                const next = emptyStatisticsFilter();
                setFilter(next);
                void reload(next);
              }}
            >
              重置
            </button>
            <button type="submit" className="dark-button" disabled={busy}>
              {busy ? <RefreshCw className="spin" size={14} /> : <Search size={14} />} 搜索
            </button>
          </div>
        </form>

        <section className="statistics-summary" aria-label="调用汇总">
          <MetricCard label="模型调用" value={formatInteger(snapshot?.summary.callCount ?? 0)} />
          <MetricCard label="平均 TTFT" value={formatLatency(snapshot?.summary.averageTtftMs)} />
          <MetricCard label="平均 TPS" value={formatTps(snapshot?.summary.averageTps)} />
          <MetricCard
            label="Token 总数"
            value={formatInteger(snapshot?.summary.totalTokens ?? 0)}
          />
        </section>

        <section className="statistics-log">
          <div className="statistics-log-heading">
            <div>
              <strong>调用日志</strong>
              <span>共 {snapshot?.total ?? 0} 条，最多显示 100 条</span>
            </div>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void reload(filter)}
            >
              <RefreshCw className={busy ? 'spin' : ''} size={13} /> 刷新
            </button>
          </div>
          <div className="statistics-table-head" aria-hidden="true">
            <span>时间 / 会话</span>
            <span>模型</span>
            <span>TTFT</span>
            <span>TPS</span>
            <span>Token</span>
            <span>状态</span>
            <span />
          </div>
          {busy && !snapshot ? (
            <div className="center-state statistics-loading">
              <RefreshCw className="spin" /> 正在读取调用日志...
            </div>
          ) : snapshot?.items.length ? (
            snapshot.items.map((item) => {
              const expanded = expandedId === item.requestId;
              return (
                <article
                  className={`statistics-row ${expanded ? 'expanded' : ''}`}
                  key={item.requestId}
                >
                  <button
                    className="statistics-row-main"
                    onClick={() => setExpandedId(expanded ? null : item.requestId)}
                    aria-expanded={expanded}
                  >
                    <span className="statistics-session-cell">
                      <strong>{formatDateTime(item.startedAt)}</strong>
                      <small title={item.sessionTitle}>{item.sessionTitle}</small>
                    </span>
                    <span className="statistics-model-cell" title={item.modelId}>
                      {item.modelId}
                    </span>
                    <span>{formatLatency(item.ttftMs)}</span>
                    <span>{formatTps(item.tps)}</span>
                    <span>{formatInteger(item.totalTokens)}</span>
                    <span className={`statistics-status ${item.status}`}>
                      {statisticsStatusLabel(item.status)}
                    </span>
                    <span className="statistics-expand-icon">
                      {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </span>
                  </button>
                  {expanded && (
                    <div className="statistics-detail">
                      <DetailItem label="请求 ID" value={item.requestId} wide />
                      <DetailItem
                        label="Step"
                        value={item.stepIndex ? `步骤 ${item.stepIndex}` : item.stepId}
                      />
                      <DetailItem label="总耗时" value={formatLatency(item.durationMs)} />
                      <DetailItem label="输入 Token" value={formatInteger(item.inputTokens)} />
                      <DetailItem label="输出 Token" value={formatInteger(item.outputTokens)} />
                      <DetailItem
                        label="上下文估算"
                        value={formatInteger(item.estimatedInputTokens)}
                      />
                      <DetailItem label="上下文容量" value={formatInteger(item.contextWindow)} />
                      <DetailItem label="停止原因" value={item.stopReason ?? '—'} />
                      <DetailItem label="工具调用" value={formatInteger(item.toolCallCount)} />
                      <DetailItem
                        label="思考设置"
                        value={
                          [item.thinkingMode, item.reasoningEffort].filter(Boolean).join(' · ') ||
                          '—'
                        }
                      />
                      <DetailItem
                        label="TTFT 来源"
                        value={item.firstTokenObserved ? '首个流式分片' : '完整响应估算'}
                      />
                    </div>
                  )}
                </article>
              );
            })
          ) : (
            <div className="empty-panel statistics-empty">没有符合条件的模型调用。</div>
          )}
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailItem({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'wide' : ''}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

function formatTps(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)} tok/s`;
}

function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : Math.round(value).toLocaleString('zh-CN');
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function statisticsStatusLabel(status: 'completed' | 'failed' | 'running'): string {
  return status === 'completed' ? '完成' : status === 'failed' ? '失败' : '运行中';
}

function SkillSettings({ onNotify }: Pick<SettingsModalProps, 'onNotify'>): JSX.Element {
  const [snapshot, setSnapshot] = useState<SkillManagementSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const reload = async () => {
    try {
      setSnapshot(await query<SkillManagementSnapshot>('skill-management.snapshot'));
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const filtered = useMemo(
    () =>
      (snapshot?.skills ?? []).filter(
        (skill) =>
          (!enabledOnly || skill.enabled) &&
          (!search.trim() ||
            `${skill.name} ${skill.description}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase())),
      ),
    [snapshot, enabledOnly, search],
  );
  const selected = snapshot?.skills.find((skill) => skill.name === selectedName);
  const toggle = async (name: string, enabled: boolean) => {
    if (!snapshot) return;
    setBusy(name);
    try {
      await command(enabled ? 'skill.enable' : 'skill.disable', {
        skillName: name,
        expectedRevision: snapshot.revision,
      });
      onNotify(`Skill ${name} 已${enabled ? '启用' : '停用'}。`, 'success');
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };
  const install = async () => {
    setBusy('install');
    try {
      const result = unwrap<{ cancelled?: boolean; skillName?: string }>(
        await requireClient().selectAndInstallSkill(),
      );
      if (!result.cancelled) {
        onNotify(`Skill ${result.skillName ?? ''} 已安装。`, 'success');
        await reload();
      }
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (selected)
    return (
      <div className="skill-detail">
        <aside>
          <button onClick={() => setSelectedName(null)}>
            <ArrowLeft size={15} /> {selected.name}
          </button>
          <div className="skill-file active">
            <FileText size={15} /> SKILL.md
          </div>
        </aside>
        <main>
          <header>
            <div>
              <h2>SKILL.md</h2>
              <p>托管 Skill 摘要</p>
            </div>
            <button className="secondary-button" onClick={() => setSelectedName(null)}>
              返回列表
            </button>
          </header>
          <div className="skill-document">
            <pre>{`name: ${selected.name}\ndescription: ${selected.description}\nsource: ${selected.sourceType}\nstatus: ${selected.status}\ncompatibility: ${selected.compatibilityStatus}`}</pre>
            <h3>{selected.name}</h3>
            <p>{selected.description || '该 Skill 未提供描述。'}</p>
            <dl>
              <dt>内容指纹</dt>
              <dd>{selected.contentDigest}</dd>
              <dt>运行状态</dt>
              <dd>{selected.enabled ? '已启用' : '已停用'}</dd>
              <dt>元数据</dt>
              <dd>
                {Object.keys(selected.metadata).length
                  ? JSON.stringify(selected.metadata, null, 2)
                  : '无'}
              </dd>
            </dl>
            <p className="privacy-copy">
              出于安全边界，Renderer 仅显示 Worker 输出的摘要，不读取宿主机 Skill 路径和文件内容。
            </p>
          </div>
        </main>
      </div>
    );

  return (
    <div className="settings-page skills-page">
      <header className="settings-page-header">
        <div>
          <h2>技能与插件</h2>
          <p>可导入标准 SKILL.md 目录或 ZIP，校验后复制到当前用户的托管区域。</p>
        </div>
      </header>
      <div className="skills-toolbar">
        <label className="compact-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索技能..."
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={enabledOnly}
            onChange={(event) => setEnabledOnly(event.target.checked)}
          />
          仅显示已启用
        </label>
        <button className="dark-button" disabled={Boolean(busy)} onClick={() => void install()}>
          {busy === 'install' ? <RefreshCw className="spin" size={14} /> : <FolderOpen size={14} />}{' '}
          导入技能
        </button>
      </div>
      <div className="skill-list custom-scrollbar">
        {busy === 'load' ? (
          <div className="center-state">
            <RefreshCw className="spin" /> 正在扫描 Skill...
          </div>
        ) : (
          filtered.map((skill) => (
            <article
              className="skill-card"
              key={skill.id}
              onClick={() => setSelectedName(skill.name)}
            >
              <span className="skill-icon">
                <Wrench size={20} />
              </span>
              <div>
                <div className="skill-name">
                  <strong>{skill.name}</strong>
                  {skill.compatibilityStatus !== 'compatible' && (
                    <em>{skill.compatibilityStatus}</em>
                  )}
                </div>
                <p>{skill.description || '暂无描述'}</p>
                <small>
                  {skill.sourceType} · {skill.status}
                </small>
              </div>
              <label className="toggle" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={Boolean(busy)}
                  onChange={(event) => void toggle(skill.name, event.target.checked)}
                />
                <span />
              </label>
            </article>
          ))
        )}
        {busy !== 'load' && filtered.length === 0 && (
          <div className="empty-panel">未找到匹配的 Skill。</div>
        )}
      </div>
    </div>
  );
}

function formatTokens(value: number | null): string {
  if (!value) return '—';
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}
