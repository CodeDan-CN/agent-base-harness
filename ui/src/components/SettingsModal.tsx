import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Cable,
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
  Monitor,
  Moon,
  Sun,
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
  McpManagementSnapshot,
  McpServerSaveParams,
} from '@client-contracts';
import { command, query, requireClient, unwrap, userMessage } from '../client';
import type { ThemePreference } from '../theme';
import type { SettingsTab } from '../types';
import { useConfirmDialog } from './Dialogs';
import { SelectMenu } from './SelectMenu';

interface SettingsModalProps {
  initialTab?: SettingsTab;
  themePreference: ThemePreference;
  onThemePreferenceChange(preference: ThemePreference): void;
  onClose(): void;
  onModelChanged(snapshot: ModelManagementSnapshot): void;
  onNotify(message: string, tone?: 'success' | 'error' | 'info'): void;
}

export function SettingsModal(props: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'models');

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.select-popover, .dialog-backdrop')) {
        props.onClose();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [props]);

  return (
    <div className="settings-shell" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-nav">
        <div className="settings-drag-region" aria-hidden="true" />
        <button className="settings-return" onClick={props.onClose} aria-label="返回">
          <ArrowLeft size={15} /> 返回应用
        </button>
        <div className="settings-nav-separator" />
        <button
          className={tab === 'appearance' ? 'active' : ''}
          onClick={() => setTab('appearance')}
        >
          <Sun size={15} /> 外观
        </button>
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
          <Database size={15} /> 模型配置
        </button>
        <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
          <Cable size={15} /> MCP 服务
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
        {tab === 'appearance' ? (
          <AppearanceSettings {...props} />
        ) : tab === 'models' ? (
          <ModelSettings {...props} />
        ) : tab === 'mcp' ? (
          <McpSettings onNotify={props.onNotify} />
        ) : tab === 'skills' ? (
          <SkillSettings onNotify={props.onNotify} />
        ) : (
          <StatisticsSettings onNotify={props.onNotify} />
        )}
      </section>
    </div>
  );
}

const themeOptions: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Monitor;
}> = [
  { value: 'system', label: '自动', description: '跟随 macOS 外观', icon: Monitor },
  { value: 'light', label: '浅色', description: '始终使用浅色主题', icon: Sun },
  { value: 'dark', label: '深色', description: '始终使用深色主题', icon: Moon },
];

function AppearanceSettings(props: SettingsModalProps): JSX.Element {
  return (
    <div className="settings-page appearance-page">
      <header className="settings-page-header">
        <div>
          <h2>外观</h2>
          <p>选择应用的显示主题。</p>
        </div>
        <button className="icon-button" onClick={props.onClose} aria-label="关闭设置">
          <X size={18} />
        </button>
      </header>
      <div className="appearance-body">
        <section aria-labelledby="theme-heading">
          <div className="appearance-section-heading">
            <h3 id="theme-heading">主题</h3>
            <p>自动模式会在系统外观变化时同步切换。</p>
          </div>
          <div className="theme-options" role="radiogroup" aria-label="主题">
            {themeOptions.map((option) => {
              const Icon = option.icon;
              const selected = props.themePreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`theme-option ${selected ? 'selected' : ''}`}
                  onClick={() => props.onThemePreferenceChange(option.value)}
                >
                  <span className={`theme-preview ${option.value}`} aria-hidden="true">
                    <span className="theme-preview-sidebar" />
                    <span className="theme-preview-content">
                      <i />
                      <i />
                      <b />
                    </span>
                  </span>
                  <span className="theme-option-copy">
                    <Icon size={16} />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    <span className="theme-radio" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
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
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
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
    if (!draft.id || !snapshot) return;
    if (
      !(await confirm({
        title: '删除模型服务？',
        description: `“${draft.name}”及其关联配置会从当前用户中移除。`,
        confirmLabel: '删除服务',
        tone: 'danger',
      }))
    )
      return;
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
                  <SelectMenu
                    value={draft.providerPresetId ?? 'custom'}
                    ariaLabel="服务类型"
                    options={[
                      { value: 'custom', label: '自定义 OpenAI 兼容' },
                      { value: 'deepseek-official', label: 'DeepSeek' },
                      { value: 'alibaba-bailian', label: '阿里云百炼' },
                    ]}
                    onChange={(value) => {
                      const providerPresetId =
                        value === 'custom' ? null : (value as ModelDraft['providerPresetId']);
                      const endpoint =
                        providerPresetId === 'deepseek-official'
                          ? 'https://api.deepseek.com/'
                          : providerPresetId === 'alibaba-bailian'
                            ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                            : draft.endpoint;
                      setDraft({ ...draft, providerPresetId, endpoint });
                    }}
                  />
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
        {confirmDialog}
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
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
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
      else {
        const accepted = await confirm({
          title: '删除模型？',
          description: `“${model.displayName}”会从这个服务中移除。`,
          confirmLabel: '删除模型',
          tone: 'danger',
        });
        if (!accepted) return;
        await command('model.archive', { id: model.id, expectedRevision: snapshot.revision });
      }
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
    <>
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
            <SelectMenu
              ariaLabel="思考模式"
              disabled={disabled || savingThinking}
              value={thinkingMode}
              className="compact"
              options={[
                { value: 'auto', label: '默认思考' },
                { value: 'disabled', label: '关闭思考' },
                { value: 'enabled', label: '开启思考' },
              ]}
              onChange={(value) =>
                void saveThinking(value as 'auto' | 'enabled' | 'disabled', reasoningEffort)
              }
            />
            {thinkingMode === 'enabled' ? (
              <SelectMenu
                ariaLabel="思考强度"
                disabled={disabled || savingThinking}
                value={reasoningEffort ?? 'medium'}
                className="compact effort"
                options={model.supportedReasoningEfforts.map((effort) => ({
                  value: effort,
                  label: reasoningEffortLabel(effort),
                }))}
                onChange={(value) =>
                  void saveThinking(
                    'enabled',
                    value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
                  )
                }
              />
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
      {confirmDialog}
    </>
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
            <SelectMenu
              value={filter.sessionId}
              ariaLabel="筛选会话"
              options={[
                { value: '', label: '全部会话' },
                ...(snapshot?.sessions ?? []).map((session) => ({
                  value: session.id,
                  label: session.title,
                })),
              ]}
              onChange={(value) => setFilter({ ...filter, sessionId: value })}
            />
          </label>
          <label>
            <span>模型</span>
            <SelectMenu
              value={filter.modelKeyword}
              ariaLabel="筛选模型"
              options={[
                { value: '', label: '全部模型' },
                ...(snapshot?.models ?? []).map((model) => ({ value: model, label: model })),
              ]}
              onChange={(value) => setFilter({ ...filter, modelKeyword: value })}
            />
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

interface McpDraft {
  id?: string;
  name: string;
  summary: string;
  transport: 'streamable-http' | 'stdio';
  url: string;
  local: boolean;
  command: string;
  args: string;
  cwd: string;
  env: string;
  enabled: boolean;
  token: string;
  clearCredential: boolean;
}

const emptyMcpDraft = (): McpDraft => ({
  name: 'memory',
  summary: '',
  transport: 'streamable-http',
  url: '',
  local: false,
  command: '',
  args: '',
  cwd: '',
  env: '{}',
  enabled: true,
  token: '',
  clearCredential: false,
});

function McpSettings({ onNotify }: Pick<SettingsModalProps, 'onNotify'>): JSX.Element {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<McpManagementSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft>(emptyMcpDraft);
  const [busy, setBusy] = useState<string | null>('load');

  const reload = async (preferred?: string) => {
    setBusy('load');
    try {
      const next = await query<McpManagementSnapshot>('mcp-management.snapshot');
      setSnapshot(next);
      const target = preferred ?? selectedId ?? next.servers[0]?.id ?? null;
      setSelectedId(target);
      const server = next.servers.find((item) => item.id === target);
      setDraft(server ? mcpDraftOf(server) : emptyMcpDraft());
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const selectServer = (id: string) => {
    const server = snapshot?.servers.find((item) => item.id === id);
    if (!server) return;
    setSelectedId(id);
    setDraft(mcpDraftOf(server));
  };

  const credential = () => {
    if (draft.clearCredential) return { action: 'clear' as const };
    if (draft.token.trim()) return { action: 'replace' as const, value: draft.token.trim() };
    return { action: 'unchanged' as const };
  };

  const params = (): McpServerSaveParams => {
    const common = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      summary: draft.summary.trim(),
      enabled: draft.enabled,
      credential: credential(),
      expectedRevision: snapshot?.revision ?? 0,
    };
    if (draft.transport === 'stdio') {
      return {
        ...common,
        transport: 'stdio',
        config: {
          command: draft.command.trim(),
          args: splitArgs(draft.args),
          ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          env: parseEnv(draft.env),
        },
      };
    }
    return {
      ...common,
      transport: 'streamable-http',
      config: { url: draft.url.trim(), local: draft.local },
    };
  };

  const validateDraft = (): string | null => {
    if (!draft.name.trim()) {
      return '请填写 MCP Server 名称。';
    }
    if (!/^[A-Za-z0-9_-]+$/.test(draft.name.trim())) {
      return 'MCP Server 名称仅支持英文字母、数字、下划线和连字符。';
    }
    if (draft.name.trim().length > 80) {
      return 'MCP Server 名称不能超过 80 个字符。';
    }
    if (draft.summary.trim().length > 300) {
      return 'MCP Server 摘要不能超过 300 个字符。';
    }
    if (draft.transport === 'streamable-http') {
      if (!draft.url.trim()) return '请填写 Streamable HTTP 地址。';
      let endpoint: URL;
      try {
        endpoint = new URL(draft.url.trim());
      } catch {
        return '请输入完整有效的 MCP Endpoint。';
      }
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        return 'MCP Endpoint 仅支持 HTTP 或 HTTPS。';
      }
      const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
      if (draft.local && !loopback) {
        return '本地 MCP Endpoint 必须使用 localhost、127.0.0.1 或 ::1。';
      }
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      return '请填写 stdio 启动命令。';
    }
    return null;
  };

  const save = async () => {
    const validationError = validateDraft();
    if (validationError) {
      onNotify(validationError, 'error');
      return;
    }
    setBusy('save');
    try {
      const result = await command<{ id: string }>('mcp-server.save', params());
      onNotify('MCP Server 已保存。新发现工具默认关闭。', 'success');
      await reload(result.id);
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };

  const test = async () => {
    const validationError = validateDraft();
    if (validationError) {
      onNotify(validationError, 'error');
      return;
    }
    setBusy('test');
    try {
      const { expectedRevision, ...testParams } = params();
      void expectedRevision;
      const result = await command<{ status: string; toolCount: number }>(
        'mcp-server.test',
        testParams,
      );
      onNotify(
        result.status === 'success'
          ? `连接成功，发现 ${result.toolCount} 个工具。`
          : '连接失败，请检查地址、命令或凭证。',
        result.status === 'success' ? 'success' : 'error',
      );
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (!draft.id) return;
    setBusy('refresh');
    try {
      const result = await command<{ toolCount: number }>('mcp-server.refresh', { id: draft.id });
      onNotify(`工具目录已刷新，共 ${result.toolCount} 个工具。`, 'success');
      await reload(draft.id);
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };

  const archive = async () => {
    if (!draft.id || !snapshot) return;
    if (
      !(await confirm({
        title: '删除 MCP Server？',
        description: `“${draft.name}”及其工具授权会从当前用户中移除。`,
        confirmLabel: '删除 Server',
        tone: 'danger',
      }))
    )
      return;
    setBusy('archive');
    try {
      await command('mcp-server.archive', {
        id: draft.id,
        expectedRevision: snapshot.revision,
      });
      setSelectedId(null);
      onNotify('MCP Server 已删除。', 'success');
      await reload('');
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };

  const toggleTool = async (rawName: string, enabled: boolean) => {
    if (!snapshot || !draft.id) return;
    setBusy(`tool:${rawName}`);
    try {
      await command('mcp-tool.toggle', {
        serverId: draft.id,
        rawName,
        enabled,
        expectedRevision: snapshot.revision,
      });
      onNotify(`工具 ${rawName} 已${enabled ? '审核启用' : '停用'}。`, 'success');
      await reload(draft.id);
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };

  const serverTools = snapshot?.tools.filter((tool) => tool.serverId === draft.id) ?? [];
  const isBundledMemory = draft.id === 'builtin-memory';

  return (
    <div className="settings-page models-page">
      <header className="settings-page-header">
        <div>
          <h2>MCP Tool Bridge</h2>
          <p>Streamable HTTP 为外部 MCP 主路径；发现的工具需逐项审核后才进入 Agent。</p>
        </div>
      </header>
      <div className="model-layout">
        <aside className="service-list">
          <button
            className="dashed-button"
            onClick={() => {
              setSelectedId(null);
              setDraft(emptyMcpDraft());
            }}
          >
            <Plus size={14} /> 添加 MCP Server
          </button>
          <div className="service-items custom-scrollbar">
            {(snapshot?.servers ?? []).map((server) => (
              <button
                key={server.id}
                className={`service-item ${selectedId === server.id ? 'active' : ''}`}
                onClick={() => selectServer(server.id)}
              >
                <span className="service-icon">
                  <Cable size={14} />
                </span>
                <span className="service-copy">
                  <strong>{server.name}</strong>
                  <small>
                    {server.transport} · {server.toolCount} 个工具
                  </small>
                </span>
                {server.id === 'builtin-memory' && <em>内置</em>}
                {server.connectionStatus === 'connected' && <em>已连接</em>}
              </button>
            ))}
          </div>
        </aside>
        <main className="service-editor custom-scrollbar">
          <div className="editor-column">
            <div className="editor-heading">
              <div>
                <Cable size={18} />
                <h3>{draft.id ? draft.name : '新 MCP Server'}</h3>
              </div>
              <div className="row-actions">
                <button
                  className="secondary-button"
                  disabled={Boolean(busy)}
                  onClick={() => void test()}
                >
                  测试连接
                </button>
                <button
                  className="primary-button"
                  disabled={Boolean(busy)}
                  onClick={() => void save()}
                >
                  保存
                </button>
              </div>
            </div>
            <div className="form-grid two">
              <label>
                <span>Server 名称</span>
                <input
                  value={draft.name}
                  disabled={isBundledMemory}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="memory"
                />
              </label>
              <label>
                <span>Transport</span>
                <SelectMenu
                  value={draft.transport}
                  ariaLabel="Transport"
                  disabled={isBundledMemory}
                  options={[
                    { value: 'streamable-http', label: 'Streamable HTTP（推荐）' },
                    { value: 'stdio', label: 'stdio（本地）' },
                  ]}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      transport: value as McpDraft['transport'],
                    })
                  }
                />
              </label>
            </div>
            <label className="form-field">
              <span>能力摘要</span>
              <textarea
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                placeholder="简要说明这个 MCP 能做什么；留空时保存后自动生成"
                maxLength={300}
              />
              <small>
                用于 mcp_search 的 Server
                摘要。留空时会优先使用默认模型根据工具目录生成；无可用模型时自动使用目录摘要。
              </small>
            </label>
            {draft.transport === 'streamable-http' ? (
              <>
                <label className="form-field">
                  <span>MCP Endpoint</span>
                  <input
                    value={draft.url}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                    placeholder="https://memory.example.com/mcp"
                  />
                  <small>支持 HTTP 或 HTTPS；本地模式仅允许 loopback 地址。</small>
                </label>
                <label className="check-label mcp-check">
                  <input
                    type="checkbox"
                    checked={draft.local}
                    onChange={(event) => setDraft({ ...draft, local: event.target.checked })}
                  />
                  本地 loopback MCP
                </label>
                <label className="form-field">
                  <span>Bearer Token</span>
                  <input
                    type="password"
                    value={draft.token}
                    onChange={(event) =>
                      setDraft({ ...draft, token: event.target.value, clearCredential: false })
                    }
                    placeholder="留空保持现有凭证"
                  />
                </label>
              </>
            ) : isBundledMemory ? (
              <div className="bundled-mcp-note">
                <strong>内置知识图谱记忆</strong>
                <p>
                  使用应用自带的 Node.js 和 Memory
                  MCP，无需安装或联网。记忆文件保存在当前用户的应用数据目录，与其他用户隔离。
                </p>
              </div>
            ) : (
              <>
                <label className="form-field">
                  <span>启动命令</span>
                  <input
                    value={draft.command}
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                    placeholder="node"
                  />
                </label>
                <label className="form-field">
                  <span>参数（每行一个）</span>
                  <textarea
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                    placeholder={'server.js\n--stdio'}
                  />
                </label>
                <div className="form-grid two">
                  <label>
                    <span>托管目录内 cwd</span>
                    <input
                      value={draft.cwd}
                      onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                      placeholder="."
                    />
                  </label>
                  <label>
                    <span>环境变量 JSON</span>
                    <input
                      value={draft.env}
                      onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                      placeholder="{}"
                    />
                  </label>
                </div>
              </>
            )}
            <label className="switch-label mcp-switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <span /> 启用 Server
            </label>

            {draft.id && (
              <>
                <div className="models-heading mcp-tools-heading">
                  <div>
                    <h4>发现工具</h4>
                    <p>Schema 变化后自动关闭并要求重新审核。</p>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={13} /> 刷新目录
                  </button>
                </div>
                <div className="skill-list mcp-tool-list">
                  {serverTools.map((tool) => (
                    <article className="skill-card" key={tool.rawName}>
                      <span className="skill-icon">
                        <Wrench size={18} />
                      </span>
                      <div>
                        <div className="skill-name">
                          <strong>{tool.rawName}</strong>
                          {tool.reviewStatus !== 'approved' && (
                            <em>{tool.reviewStatus === 'pending' ? '待审核' : 'Schema 已变更'}</em>
                          )}
                        </div>
                        <p>{tool.description || tool.publicName}</p>
                        <small>{tool.publicName}</small>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={tool.enabled && tool.reviewStatus === 'approved'}
                          disabled={Boolean(busy)}
                          onChange={(event) => void toggleTool(tool.rawName, event.target.checked)}
                        />
                        <span />
                      </label>
                    </article>
                  ))}
                  {serverTools.length === 0 && (
                    <div className="empty-panel">保存并连接后显示 Server 的 tools/list 结果。</div>
                  )}
                </div>
                <div className="danger-zone">
                  <button disabled={Boolean(busy)} onClick={() => void archive()}>
                    <Trash2 size={13} /> 删除 MCP Server
                  </button>
                </div>
              </>
            )}
          </div>
        </main>
        {confirmDialog}
      </div>
    </div>
  );
}

function mcpDraftOf(server: McpManagementSnapshot['servers'][number]): McpDraft {
  const config = server.config;
  return {
    id: server.id,
    name: server.name,
    summary: server.summary,
    transport: server.transport,
    url: typeof config.url === 'string' ? config.url : '',
    local: config.local === true,
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args)
      ? config.args.filter((value): value is string => typeof value === 'string').join('\n')
      : '',
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    env: typeof config.env === 'object' && config.env !== null ? JSON.stringify(config.env) : '{}',
    enabled: server.status === 'enabled',
    token: '',
    clearCredential: false,
  };
}

function splitArgs(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnv(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('环境变量必须是 JSON 对象');
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') throw new Error('环境变量值必须是字符串');
    output[key] = item;
  }
  return output;
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
