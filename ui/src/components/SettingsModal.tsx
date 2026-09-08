import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Monitor,
  Bot,
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
import { maximumManualOutputBudget, recommendedOutputBudget } from '@client-contracts';
import { command, query, requireClient, unwrap, userMessage } from '../client';
import type { ThemePreference } from '../theme';
import type { SettingsTab } from '../types';
import { TextPromptDialog, useConfirmDialog } from './Dialogs';
import { SelectMenu, CategoryCombo } from './SelectMenu';
import { AgentSettings } from './agents/AgentSettings';

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
      if (
        event.key === 'Escape' &&
        !document.querySelector('.select-popover, .dialog-backdrop, .category-manager-popover')
      ) {
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
        <button className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
          <Bot size={15} /> 智能体
        </button>
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
        {tab === 'agents' ? (
          <div className="settings-page agents-page">
            <AgentSettings onNotify={props.onNotify} />
          </div>
        ) : tab === 'appearance' ? (
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
  const selectedIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(emptyService);
  const [serviceSearch, setServiceSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busyByService, setBusyByService] = useState<Record<string, string>>({});
  const [discoveryByService, setDiscoveryByService] = useState<
    Record<string, ModelDiscoveryResult>
  >({});
  const [manualOpen, setManualOpen] = useState(false);

  const selectId = (id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  };

  const markBusy = (serviceKey: string, action: string | null) => {
    setBusyByService((current) => {
      const next = { ...current };
      if (action) next[serviceKey] = action;
      else delete next[serviceKey];
      return next;
    });
  };

  const reload = async (
    options: {
      preferredId?: string | null;
      originId?: string | null;
      initial?: boolean;
    } = {},
  ) => {
    if (options.initial) setInitialLoading(true);
    try {
      const next = await query<ModelManagementSnapshot>('model-management.snapshot');
      setSnapshot(next);
      props.onModelChanged(next);
      const currentId = selectedIdRef.current;
      if (options.originId !== undefined && currentId !== options.originId) return;
      const target =
        options.preferredId !== undefined
          ? options.preferredId
          : (currentId ?? next.services[0]?.id ?? null);
      selectId(target);
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
      if (options.initial) setInitialLoading(false);
    }
  };

  useEffect(() => {
    void reload({ initial: true });
  }, []);

  const selectService = (id: string) => {
    const service = snapshot?.services.find((item) => item.id === id);
    if (!service) return;
    selectId(id);
    setManualOpen(false);
    setShowKey(false);
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
    const originId = draft.id ?? null;
    const serviceKey = draft.id ?? '__new__';
    const saveParams = serviceParams();
    markBusy(serviceKey, 'save');
    try {
      const result = await command<{ id: string }>('model-service.save', saveParams);
      props.onNotify('模型服务已保存。', 'success');
      await reload({ preferredId: result.id, originId });
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serviceKey, null);
    }
  };

  const testService = async () => {
    if (!draft.name.trim() || !draft.endpoint.trim()) {
      props.onNotify('请先填写完整的服务配置。', 'error');
      return;
    }
    const serviceKey = draft.id ?? '__new__';
    const { expectedRevision, ...params } = serviceParams();
    void expectedRevision;
    markBusy(serviceKey, 'test');
    try {
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
      markBusy(serviceKey, null);
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
    const serviceId = draft.id;
    const expectedRevision = snapshot.revision;
    markBusy(serviceId, 'archive');
    try {
      await command('model-service.archive', { id: serviceId, expectedRevision });
      props.onNotify('模型服务已删除。', 'success');
      await reload({ preferredId: null, originId: serviceId });
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serviceId, null);
    }
  };

  const discover = async () => {
    if (!draft.id) {
      props.onNotify('请先保存模型服务。', 'info');
      return;
    }
    const serviceId = draft.id;
    markBusy(serviceId, 'discover');
    try {
      const result = await command<ModelDiscoveryResult>('model.discover', { serviceId });
      setDiscoveryByService((current) => ({ ...current, [serviceId]: result }));
      props.onNotify(`已获取 ${result.remoteModelIds.length} 个远程模型。`, 'success');
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serviceId, null);
    }
  };

  const saveModel = async (remoteModelId: string, displayName = remoteModelId) => {
    if (!snapshot || !draft.id) return;
    const serviceId = draft.id;
    const expectedRevision = snapshot.revision;
    const discovery = discoveryByService[serviceId];
    markBusy(serviceId, `model:${remoteModelId}`);
    try {
      const discoveredModel = discovery?.models.find((model) => model.id === remoteModelId);
      const contextWindow = discoveredModel?.contextWindow ?? 32768;
      const maxOutputCapability = discoveredModel?.maxOutputCapability ?? null;
      const maxOutputTokens = recommendedOutputBudget({
        contextWindow,
        compactionTriggerRatio: 0.8,
        maxOutputCapability,
      });
      const params: ModelSaveParams = {
        serviceId,
        remoteModelId,
        displayName,
        contextWindow,
        inputCapability: discoveredModel?.inputCapability ?? null,
        maxOutputCapability,
        requestMaxOutputTokens: null,
        maxOutputTokens,
        metadataSource: discoveredModel?.metadataSource ?? 'manual',
        catalogVersion: discoveredModel ? 'bundled' : null,
        capabilityProfileRef: null,
        capabilityMatchKind: discoveredModel?.capabilityMatchKind ?? 'manual',
        thinkingMode: 'auto',
        reasoningEffort: null,
        capabilities: { tools: true, streaming: true, vision: false },
        defaultParams: {},
        enabled: true,
        expectedRevision,
      };
      await command('model.save', params);
      setDiscoveryByService((current) => {
        const currentDiscovery = current[serviceId];
        if (!currentDiscovery) return current;
        return {
          ...current,
          [serviceId]: {
            ...currentDiscovery,
            remoteModelIds: currentDiscovery.remoteModelIds.filter(
              (item) => item !== remoteModelId,
            ),
            models: currentDiscovery.models.filter((item) => item.id !== remoteModelId),
          },
        };
      });
      props.onNotify(`模型 ${displayName} 已添加。`, 'success');
      await reload({ preferredId: serviceId, originId: serviceId });
    } catch (error) {
      props.onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serviceId, null);
    }
  };

  const serviceKey = draft.id ?? '__new__';
  const busy = busyByService[serviceKey] ?? null;
  const discovery = draft.id ? discoveryByService[draft.id] : undefined;
  const discovered = discovery?.remoteModelIds ?? [];
  const discoveredDetails = discovery?.models ?? [];
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
              selectId(null);
              setDraft(emptyService());
              setManualOpen(false);
              setShowKey(false);
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
          {initialLoading && !snapshot ? (
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
                    onChanged={() =>
                      reload({ preferredId: model.serviceId, originId: model.serviceId })
                    }
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
  const [contextOpen, setContextOpen] = useState(false);
  const [savingContext, setSavingContext] = useState(false);

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
        requestMaxOutputTokens: model.requestMaxOutputTokens,
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
  const saveContextSettings = async (
    contextWindowOverride: number | null,
    compactionTriggerRatio: number,
    requestMaxOutputTokens: number | null,
  ) => {
    setSavingContext(true);
    try {
      const effectiveContextWindow =
        contextWindowOverride ?? model.automaticContextWindow ?? model.contextWindow ?? 32768;
      const maxOutputTokens =
        requestMaxOutputTokens ??
        recommendedOutputBudget({
          contextWindow: effectiveContextWindow,
          compactionTriggerRatio,
          maxOutputCapability: model.maxOutputCapability,
        });
      await command('model.save', {
        id: model.id,
        serviceId: model.serviceId,
        remoteModelId: model.remoteModelId,
        displayName: model.displayName,
        contextWindow: model.automaticContextWindow ?? model.contextWindow ?? 32768,
        contextWindowOverride,
        compactionTriggerRatio,
        inputCapability: model.inputCapability,
        maxOutputCapability: model.maxOutputCapability,
        requestMaxOutputTokens,
        maxOutputTokens,
        metadataSource: model.automaticMetadataSource,
        catalogVersion: model.catalogVersion,
        capabilityProfileRef: model.capabilityProfileRef,
        capabilityMatchKind: model.capabilityMatchKind,
        thinkingMode,
        reasoningEffort,
        capabilities: model.capabilities,
        defaultParams: model.defaultParams,
        enabled: model.status === 'enabled',
        expectedRevision: snapshot.revision,
      });
      await onChanged();
      setContextOpen(false);
      onNotify('上下文设置已保存。', 'success');
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setSavingContext(false);
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
        <button
          type="button"
          className="model-cap"
          disabled={disabled}
          onClick={() => setContextOpen(true)}
          aria-label={`设置 ${model.displayName} 的上下文`}
        >
          <Settings2 size={12} /> {formatTokens(model.contextWindow)} ·{' '}
          {modelMetadataSourceLabel(model.metadataSource)}
        </button>
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
      <ModelContextDialog
        open={contextOpen}
        model={model}
        busy={savingContext}
        onCancel={() => !savingContext && setContextOpen(false)}
        onSave={(contextWindowOverride, compactionTriggerRatio, requestMaxOutputTokens) =>
          void saveContextSettings(
            contextWindowOverride,
            compactionTriggerRatio,
            requestMaxOutputTokens,
          )
        }
      />
      {confirmDialog}
    </>
  );
}

function ModelContextDialog({
  open,
  model,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  model: ModelManagementSnapshot['models'][number];
  busy: boolean;
  onCancel(): void;
  onSave(
    contextWindowOverride: number | null,
    compactionTriggerRatio: number,
    requestMaxOutputTokens: number | null,
  ): void;
}): JSX.Element | null {
  const automaticContextWindow = model.automaticContextWindow ?? model.contextWindow ?? 32768;
  const [mode, setMode] = useState<'automatic' | 'manual'>(
    model.contextWindowOverride === null ? 'automatic' : 'manual',
  );
  const [contextWindow, setContextWindow] = useState(
    String(model.contextWindowOverride ?? automaticContextWindow),
  );
  const [triggerRatio, setTriggerRatio] = useState(String(model.compactionTriggerRatio));
  const [outputMode, setOutputMode] = useState<'automatic' | 'manual'>(
    model.requestMaxOutputTokens === null ? 'automatic' : 'manual',
  );
  const [outputTokens, setOutputTokens] = useState(
    String(model.requestMaxOutputTokens ?? model.maxOutputTokens ?? 1),
  );

  useEffect(() => {
    if (!open) return;
    setMode(model.contextWindowOverride === null ? 'automatic' : 'manual');
    setContextWindow(String(model.contextWindowOverride ?? automaticContextWindow));
    setTriggerRatio(String(model.compactionTriggerRatio));
    setOutputMode(model.requestMaxOutputTokens === null ? 'automatic' : 'manual');
    setOutputTokens(String(model.requestMaxOutputTokens ?? model.maxOutputTokens ?? 1));
  }, [
    automaticContextWindow,
    model.compactionTriggerRatio,
    model.contextWindowOverride,
    model.maxOutputTokens,
    model.requestMaxOutputTokens,
    open,
  ]);

  if (!open) return null;
  const parsedContextWindow = Number(contextWindow);
  const parsedRatio = Number(triggerRatio);
  const parsedOutputTokens = Number(outputTokens);
  const effectiveContextWindow =
    mode === 'automatic' ? automaticContextWindow : parsedContextWindow;
  const validContext =
    Number.isInteger(effectiveContextWindow) &&
    effectiveContextWindow >= 1024 &&
    effectiveContextWindow <= 4_000_000 &&
    parsedRatio >= 0.5 &&
    parsedRatio <= 0.95;
  const triggerTokens = validContext ? Math.floor(effectiveContextWindow * parsedRatio) : null;
  const recommendedOutputTokens = validContext
    ? recommendedOutputBudget({
        contextWindow: effectiveContextWindow,
        compactionTriggerRatio: parsedRatio,
        maxOutputCapability: model.maxOutputCapability,
      })
    : null;
  const maximumOutputTokens = validContext
    ? maximumManualOutputBudget({
        contextWindow: effectiveContextWindow,
        maxOutputCapability: model.maxOutputCapability,
      })
    : null;
  const validOutput =
    outputMode === 'automatic' ||
    (Number.isInteger(parsedOutputTokens) &&
      parsedOutputTokens >= 1 &&
      maximumOutputTokens !== null &&
      parsedOutputTokens <= maximumOutputTokens);
  const valid = validContext && validOutput;

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <form
        className="app-dialog context-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${model.displayName} 上下文设置`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy) return;
          onSave(
            mode === 'manual' ? parsedContextWindow : null,
            parsedRatio,
            outputMode === 'manual' ? parsedOutputTokens : null,
          );
        }}
      >
        <div className="app-dialog-copy">
          <h2>上下文设置</h2>
          <p>统一控制新 Turn 与后续 Step 的上下文压缩触发时机。</p>
        </div>
        <button
          type="button"
          className="dialog-close icon-button"
          disabled={busy}
          onClick={onCancel}
          aria-label="关闭"
        >
          <X size={16} />
        </button>

        <div className="context-setting-block">
          <div className="context-setting-heading">
            <span>上下文上限</span>
            <small>自动值来自{modelMetadataSourceLabel(model.automaticMetadataSource)}</small>
          </div>
          <div className="context-mode-switch" role="radiogroup" aria-label="上下文上限来源">
            <button
              type="button"
              className={mode === 'automatic' ? 'selected' : ''}
              role="radio"
              aria-checked={mode === 'automatic'}
              disabled={busy}
              onClick={() => {
                setMode('automatic');
                setContextWindow(String(automaticContextWindow));
              }}
            >
              自动
            </button>
            <button
              type="button"
              className={mode === 'manual' ? 'selected' : ''}
              role="radio"
              aria-checked={mode === 'manual'}
              disabled={busy}
              onClick={() => setMode('manual')}
            >
              手动
            </button>
          </div>
          <label className="context-number-field">
            <input
              type="number"
              min={1024}
              max={4_000_000}
              step={1024}
              disabled={busy || mode === 'automatic'}
              value={mode === 'automatic' ? automaticContextWindow : contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              aria-label="上下文上限 Token"
            />
            <span>Token</span>
          </label>
        </div>

        <div className="context-setting-block">
          <div className="context-setting-heading">
            <span>单次输出上限</span>
            <small>
              {model.maxOutputCapability
                ? `模型能力上限 ${formatTokens(model.maxOutputCapability)}`
                : '未声明模型输出能力'}
            </small>
          </div>
          <div className="context-mode-switch" role="radiogroup" aria-label="单次输出上限来源">
            <button
              type="button"
              className={outputMode === 'automatic' ? 'selected' : ''}
              role="radio"
              aria-checked={outputMode === 'automatic'}
              disabled={busy}
              onClick={() => setOutputMode('automatic')}
            >
              自动推荐
            </button>
            <button
              type="button"
              className={outputMode === 'manual' ? 'selected' : ''}
              role="radio"
              aria-checked={outputMode === 'manual'}
              disabled={busy}
              onClick={() => {
                setOutputMode('manual');
                if (recommendedOutputTokens !== null) {
                  setOutputTokens(String(recommendedOutputTokens));
                }
              }}
            >
              手动
            </button>
          </div>
          <label className="context-number-field">
            <input
              type="number"
              min={1}
              max={maximumOutputTokens ?? undefined}
              step={1024}
              disabled={busy || outputMode === 'automatic'}
              value={
                outputMode === 'automatic' && recommendedOutputTokens !== null
                  ? recommendedOutputTokens
                  : outputTokens
              }
              onChange={(event) => setOutputTokens(event.target.value)}
              aria-label="单次输出上限 Token"
            />
            <span>Token</span>
          </label>
          <p className="context-trigger-preview">
            {recommendedOutputTokens === null
              ? '请先填写有效的上下文设置。'
              : `动态推荐 ${formatTokens(recommendedOutputTokens)} Token，由压缩后余量与模型能力共同限制。`}
          </p>
        </div>

        <div className="context-setting-block">
          <div className="context-setting-heading">
            <span>压缩触发阈值</span>
            <small>达到该比例后采用内置压缩策略</small>
          </div>
          <SelectMenu
            ariaLabel="压缩触发阈值"
            disabled={busy}
            value={triggerRatio}
            options={[
              { value: '0.6', label: '60% · 较早压缩' },
              { value: '0.7', label: '70%' },
              { value: '0.8', label: '80% · 推荐' },
              { value: '0.85', label: '85%' },
              { value: '0.9', label: '90% · 较晚压缩' },
            ]}
            onChange={setTriggerRatio}
          />
          <p className="context-trigger-preview">
            {triggerTokens === null
              ? '请填写有效的上下文上限。'
              : `预计在约 ${formatTokens(triggerTokens)} Token 时开始压缩。`}
          </p>
        </div>

        <div className="app-dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="dark-button" disabled={!valid || busy}>
            {busy ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
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

function modelMetadataSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    manual: '手动设置',
    endpoint: '服务端',
    catalog: '内置模型表',
    fallback: '保守默认值',
    legacy: '旧配置',
  };
  return labels[source] ?? source;
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
  const [busy, setBusy] = useState<'initial' | 'search' | 'reset' | 'refresh' | null>('initial');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = async (
    nextFilter: StatisticsFilter,
    action: Exclude<typeof busy, null> = 'refresh',
  ) => {
    setBusy(action);
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
      setBusy(null);
    }
  };

  useEffect(() => {
    void reload(emptyStatisticsFilter(), 'initial');
  }, []);

  const isBusy = busy !== null;

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
            void reload(filter, 'search');
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
              disabled={isBusy}
              onClick={() => {
                const next = emptyStatisticsFilter();
                setFilter(next);
                void reload(next, 'reset');
              }}
            >
              重置
            </button>
            <button type="submit" className="dark-button" disabled={isBusy}>
              {busy === 'search' ? <RefreshCw className="spin" size={14} /> : <Search size={14} />}{' '}
              搜索
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
              disabled={isBusy}
              onClick={() => void reload(filter, 'refresh')}
            >
              <RefreshCw className={busy === 'refresh' ? 'spin' : ''} size={13} /> 刷新
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
          {busy === 'initial' && !snapshot ? (
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
  category: string;
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
  category: '未分类',
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
  const selectedIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<McpDraft>(emptyMcpDraft);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busyByServer, setBusyByServer] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const selectId = (id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  };

  const markBusy = (serverKey: string, action: string | null) => {
    setBusyByServer((current) => {
      const next = { ...current };
      if (action) next[serverKey] = action;
      else delete next[serverKey];
      return next;
    });
  };

  const reload = async (
    options: {
      preferredId?: string | null;
      originId?: string | null;
      initial?: boolean;
    } = {},
  ) => {
    if (options.initial) setInitialLoading(true);
    try {
      const next = await query<McpManagementSnapshot>('mcp-management.snapshot');
      setSnapshot(next);
      const currentId = selectedIdRef.current;
      if (options.originId !== undefined && currentId !== options.originId) return;
      const target =
        options.preferredId !== undefined
          ? options.preferredId
          : (currentId ?? next.servers[0]?.id ?? null);
      selectId(target);
      const server = next.servers.find((item) => item.id === target);
      setDraft(server ? mcpDraftOf(server, next.categories) : emptyMcpDraft());
      if (server) {
        setCollapsedCategories((current) => {
          if (!current.has(server.categoryId)) return current;
          const nextCollapsed = new Set(current);
          nextCollapsed.delete(server.categoryId);
          return nextCollapsed;
        });
      }
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      if (options.initial) setInitialLoading(false);
    }
  };

  useEffect(() => {
    void reload({ initial: true });
  }, []);

  const selectServer = (id: string) => {
    const server = snapshot?.servers.find((item) => item.id === id);
    if (!server) return;
    selectId(id);
    setDraft(mcpDraftOf(server, snapshot?.categories ?? []));
    setCollapsedCategories((current) => {
      if (!current.has(server.categoryId)) return current;
      const next = new Set(current);
      next.delete(server.categoryId);
      return next;
    });
  };

  const credential = () => {
    if (draft.clearCredential) return { action: 'clear' as const };
    if (draft.token.trim()) return { action: 'replace' as const, value: draft.token.trim() };
    return { action: 'unchanged' as const };
  };

  const params = (categoryId: string): McpServerSaveParams => {
    const common = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      summary: draft.summary.trim(),
      categoryId,
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
    if (draft.category.trim().length > 40) {
      return '分类名称不能超过 40 个字符。';
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
    const categoryName = draft.category.trim() || '未分类';
    const originId = draft.id ?? null;
    const serverKey = draft.id ?? '__new__';
    markBusy(serverKey, 'save');
    try {
      let categoryId = (snapshot?.categories ?? []).find(
        (category) => category.name.toLocaleLowerCase() === categoryName.toLocaleLowerCase(),
      )?.id;
      let expectedRevision = snapshot?.revision ?? 0;
      if (!categoryId) {
        const created = await command<{ id: string }>('capability-category.create', {
          type: 'mcp',
          name: categoryName,
          expectedRevision,
        });
        categoryId = created.id;
        expectedRevision = expectedRevision + 1;
      }
      const result = await command<{ id: string }>('mcp-server.save', {
        ...params(categoryId),
        expectedRevision,
      });
      onNotify('MCP Server 已保存。新发现工具默认关闭。', 'success');
      await reload({ preferredId: result.id, originId });
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serverKey, null);
    }
  };

  const test = async () => {
    const validationError = validateDraft();
    if (validationError) {
      onNotify(validationError, 'error');
      return;
    }
    const serverKey = draft.id ?? '__new__';
    markBusy(serverKey, 'test');
    try {
      const categoryName = draft.category.trim() || '未分类';
      const existing = (snapshot?.categories ?? []).find(
        (category) => category.name.toLocaleLowerCase() === categoryName.toLocaleLowerCase(),
      );
      const { expectedRevision, ...testParams } = params(existing?.id ?? 'uncategorized');
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
      markBusy(serverKey, null);
    }
  };

  const refresh = async () => {
    if (!draft.id) return;
    const serverId = draft.id;
    markBusy(serverId, 'refresh');
    try {
      const result = await command<{ toolCount: number }>('mcp-server.refresh', { id: serverId });
      onNotify(`工具目录已刷新，共 ${result.toolCount} 个工具。`, 'success');
      await reload({ preferredId: serverId, originId: serverId });
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serverId, null);
    }
  };

  const archive = async () => {
    if (!draft.id || !snapshot) return;
    if (
      !(await confirm({
        title: '删除 MCP Server？',
        description: `“${draft.name}”及其已加入工具会从当前用户中移除。`,
        confirmLabel: '删除 Server',
        tone: 'danger',
      }))
    )
      return;
    const serverId = draft.id;
    const expectedRevision = snapshot.revision;
    markBusy(serverId, 'archive');
    try {
      await command('mcp-server.archive', {
        id: serverId,
        expectedRevision,
      });
      onNotify('MCP Server 已删除。', 'success');
      await reload({ preferredId: null, originId: serverId });
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serverId, null);
    }
  };

  const toggleTool = async (rawName: string, enabled: boolean) => {
    if (!snapshot || !draft.id) return;
    const serverId = draft.id;
    const expectedRevision = snapshot.revision;
    markBusy(serverId, `tool:${rawName}`);
    try {
      await command('mcp-tool.toggle', {
        serverId,
        rawName,
        enabled,
        expectedRevision,
      });
      onNotify(`工具 ${rawName} 已${enabled ? '加入' : '移除'}。`, 'success');
      await reload({ preferredId: serverId, originId: serverId });
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      markBusy(serverId, null);
    }
  };
  const serverKey = draft.id ?? '__new__';
  const busy = busyByServer[serverKey] ?? null;
  const serverTools = snapshot?.tools.filter((tool) => tool.serverId === draft.id) ?? [];
  const isBundledMemory = draft.id === 'builtin-memory';
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const groupedServers = useMemo(
    () =>
      (snapshot?.categories ?? [])
        .map((category) => ({
          category,
          servers: (snapshot?.servers ?? []).filter(
            (server) =>
              server.categoryId === category.id &&
              (!normalizedSearch ||
                fuzzyIncludes(`${server.name} ${server.summary}`, normalizedSearch)),
          ),
        }))
        .filter((group) => group.servers.length > 0),
    [snapshot, normalizedSearch],
  );

  return (
    <div className="settings-page models-page mcp-page">
      <header className="settings-page-header">
        <div>
          <h2>MCP Tool Bridge</h2>
          <p>Streamable HTTP 为外部 MCP 主路径；发现工具点击加入后即可供 Agent 使用。</p>
        </div>
      </header>
      <div className="model-layout">
        <aside className="service-list">
          <label className="compact-search mcp-search">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索名称或简介..."
            />
          </label>
          <div className="mcp-add-row">
            <button
              className="dashed-button"
              onClick={() => {
                selectId(null);
                setDraft(emptyMcpDraft());
              }}
            >
              <Plus size={14} /> 添加 MCP Server
            </button>
          </div>
          <div className="service-items custom-scrollbar">
            {groupedServers.map(({ category, servers }) => {
              const collapsed = !normalizedSearch && collapsedCategories.has(category.id);
              return (
                <section className="mcp-category-group" key={category.id}>
                  <button
                    type="button"
                    className="mcp-category-heading"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedCategories((current) => {
                        const next = new Set(current);
                        if (next.has(category.id)) next.delete(category.id);
                        else next.add(category.id);
                        return next;
                      })
                    }
                  >
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{category.name}</span>
                    <small>{servers.length}</small>
                  </button>
                  {!collapsed &&
                    servers.map((server) => (
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
                          <small className="mcp-service-summary">
                            {server.summary || '暂无简介'}
                          </small>
                          <small>
                            {server.transport} · {server.toolCount} 个工具
                          </small>
                        </span>
                        {server.id === 'builtin-memory' && <em>内置</em>}
                        {server.connectionStatus === 'connected' && <em>已连接</em>}
                      </button>
                    ))}
                </section>
              );
            })}
            {!initialLoading && groupedServers.length === 0 && (
              <div className="empty-panel compact">未找到匹配的 MCP Server。</div>
            )}
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
                  disabled={initialLoading || Boolean(busy)}
                  onClick={() => void test()}
                >
                  {busy === 'test' && <RefreshCw className="spin" size={13} />} 测试连接
                </button>
                <button
                  className="primary-button"
                  disabled={initialLoading || Boolean(busy)}
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
            <label className="form-field mcp-category-field">
              <span>分类</span>
              <CategoryCombo
                text={draft.category}
                ariaLabel="MCP Server 分类"
                disabled={initialLoading || Boolean(busy)}
                placeholder="选择或输入分类"
                options={(snapshot?.categories ?? []).map((category) => ({
                  value: category.id,
                  label: category.name,
                }))}
                onTextChange={(category) => setDraft({ ...draft, category })}
              />
              <small>可直接选择已有分类，或输入新名称；保存时若分类不存在会自动新建。</small>
            </label>
            <label className="form-field">
              <span>能力摘要</span>
              <textarea
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                placeholder="简要说明这个 MCP 能做什么；留空时保存后自动生成"
                maxLength={300}
              />
              <small>
                用于 capability_search 的 MCP Server
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
                    <p>Schema 变化后自动关闭，需要重新加入。</p>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={13} className={busy === 'refresh' ? 'spin' : ''} /> 刷新目录
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
                            <em>{tool.reviewStatus === 'pending' ? '未加入' : '需要重新加入'}</em>
                          )}
                        </div>
                        <p>{tool.description || tool.publicName}</p>
                        <small>{tool.publicName}</small>
                      </div>
                      <div className="mcp-tool-controls">
                        <label className="toggle" title="加入或移除这个工具">
                          <input
                            type="checkbox"
                            checked={tool.enabled && tool.reviewStatus === 'approved'}
                            disabled={Boolean(busy)}
                            onChange={(event) =>
                              void toggleTool(tool.rawName, event.target.checked)
                            }
                          />
                          <span />
                        </label>
                      </div>
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

function mcpDraftOf(
  server: McpManagementSnapshot['servers'][number],
  categories: ReadonlyArray<{ id: string; name: string }>,
): McpDraft {
  const config = server.config;
  return {
    id: server.id,
    name: server.name,
    summary: server.summary,
    category: categories.find((item) => item.id === server.categoryId)?.name ?? '未分类',
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
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<SkillManagementSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
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

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of snapshot?.skills ?? []) {
      counts.set(skill.categoryId, (counts.get(skill.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [snapshot]);
  const categoryName = (categoryId: string) =>
    snapshot?.categories.find((category) => category.id === categoryId)?.name ?? '未分类';

  const filtered = useMemo(
    () =>
      (snapshot?.skills ?? []).filter(
        (skill) =>
          (!enabledOnly || skill.enabled) &&
          (categoryFilter === 'all' || skill.categoryId === categoryFilter) &&
          (!search.trim() ||
            `${skill.name} ${skill.description}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase())),
      ),
    [snapshot, enabledOnly, categoryFilter, search],
  );
  const selected = snapshot?.skills.find((skill) => skill.name === selectedName);
  const saveDescription = async () => {
    if (!snapshot || !editing || busy) return;
    setBusy('description');
    try {
      await command('skill.description.update', {
        skillName: editing.name,
        description: editing.description,
        expectedRevision: snapshot.revision,
      });
      setEditing(null);
      onNotify('Skill 描述已保存，能力目录将使用新描述。', 'success');
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
      await reload();
    }
  };
  const removeSkill = async (name: string) => {
    if (!snapshot || busy) return;
    const accepted = await confirm({
      title: '删除 Skill？',
      description: `将永久删除“${name}”的受管目录和安装记录，不保留备份。原始导入目录不受影响，已加载到会话中的内容不会被抹除。`,
      confirmLabel: '删除 Skill',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy('delete');
    try {
      await command('skill.delete', { skillName: name, expectedRevision: snapshot.revision });
      if (selectedName === name) setSelectedName(null);
      onNotify(`Skill ${name} 已删除。`, 'success');
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
      await reload();
    }
  };
  const descriptionDialog = (
    <TextPromptDialog
      className="skill-description-dialog"
      open={editing !== null}
      title={`编辑 ${editing?.name ?? ''} 的描述`}
      description="说明能力和适用场景。模型会根据这段 description 选择 Skill；保存后写回 SKILL.md，不修改正文。"
      label="Description"
      value={editing?.description ?? ''}
      maxLength={4000}
      multiline
      busy={busy === 'description'}
      onChange={(description) =>
        setEditing((current) => (current ? { ...current, description } : null))
      }
      onCancel={() => setEditing(null)}
      onConfirm={() => void saveDescription()}
    />
  );
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
  const setCategory = async (skillName: string, categoryId: string) => {
    if (!snapshot) return;
    setBusy(`skill-category:${skillName}`);
    try {
      await command('skill.category.set', {
        skillName,
        categoryId,
        expectedRevision: snapshot.revision,
      });
      await reload();
      onNotify('Skill 分类已更新。', 'success');
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };
  const createCategory = async (name: string) => {
    if (!snapshot || !name.trim()) return;
    setBusy('category');
    try {
      await command('capability-category.create', {
        type: 'skill',
        name,
        expectedRevision: snapshot.revision,
      });
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };
  const renameCategory = async (id: string, name: string) => {
    if (!snapshot || !id || !name.trim()) return;
    setBusy('category');
    try {
      await command('capability-category.rename', {
        type: 'skill',
        id,
        name,
        expectedRevision: snapshot.revision,
      });
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
      setBusy(null);
    }
  };
  const deleteCategory = async (id: string, name: string) => {
    if (!snapshot) return;
    const accepted = await confirm({
      title: '删除分类？',
      description: `“${name}”中的 Skill 会移动到“未分类”。`,
      confirmLabel: '删除分类',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy('category');
    try {
      await command('capability-category.delete', {
        type: 'skill',
        id,
        expectedRevision: snapshot.revision,
      });
      if (categoryFilter === id) setCategoryFilter('all');
      await reload();
    } catch (error) {
      onNotify(userMessage(error), 'error');
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
            <div className="row-actions skill-detail-actions">
              <button
                className="secondary-button skill-hover-action"
                disabled={
                  Boolean(busy) || selected.sourceType === 'bundled' || selected.status !== 'valid'
                }
                onClick={() =>
                  setEditing({ name: selected.name, description: selected.description })
                }
              >
                <Pencil size={14} /> 编辑描述
              </button>
              <button
                className="danger-button skill-hover-action"
                disabled={Boolean(busy) || selected.sourceType === 'bundled'}
                onClick={() => void removeSkill(selected.name)}
              >
                <Trash2 size={14} /> 删除
              </button>
              <SelectMenu
                value={selected.categoryId}
                ariaLabel="Skill 分类"
                disabled={Boolean(busy)}
                className="compact"
                options={(snapshot?.categories ?? []).map((category) => ({
                  value: category.id,
                  label: category.name,
                }))}
                onChange={(categoryId) => void setCategory(selected.name, categoryId)}
              />
              <button className="secondary-button" onClick={() => setSelectedName(null)}>
                返回列表
              </button>
            </div>
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
              <dt>分类</dt>
              <dd>{categoryName(selected.categoryId)}</dd>
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
        {descriptionDialog}
        {confirmDialog}
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
      <div className="skill-category-bar">
        <div
          className="skill-category-tabs custom-scrollbar"
          role="tablist"
          aria-label="Skill 分类"
        >
          <button
            type="button"
            className={categoryFilter === 'all' ? 'active' : ''}
            onClick={() => setCategoryFilter('all')}
          >
            全部 <small>{snapshot?.skills.length ?? 0}</small>
          </button>
          {(snapshot?.categories ?? []).map((category) => (
            <button
              type="button"
              className={categoryFilter === category.id ? 'active' : ''}
              key={category.id}
              onClick={() => setCategoryFilter(category.id)}
            >
              {category.name} <small>{categoryCounts.get(category.id) ?? 0}</small>
            </button>
          ))}
        </div>
        <CategoryManager
          categories={snapshot?.categories ?? []}
          counts={categoryCounts}
          busy={busy === 'category'}
          label="管理分类"
          onCreate={createCategory}
          onRename={renameCategory}
          onDelete={deleteCategory}
        />
      </div>
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
                  {categoryName(skill.categoryId)} · {skill.sourceType} · {skill.status}
                </small>
              </div>
              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <button
                  className="icon-button skill-hover-action"
                  aria-label={`编辑 ${skill.name} 的描述`}
                  title="编辑描述"
                  disabled={
                    Boolean(busy) || skill.sourceType === 'bundled' || skill.status !== 'valid'
                  }
                  onClick={() => setEditing({ name: skill.name, description: skill.description })}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button danger-text skill-hover-action"
                  aria-label={`删除 ${skill.name}`}
                  title="删除 Skill"
                  disabled={Boolean(busy) || skill.sourceType === 'bundled'}
                  onClick={() => void removeSkill(skill.name)}
                >
                  <Trash2 size={15} />
                </button>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={Boolean(busy)}
                    onChange={(event) => void toggle(skill.name, event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            </article>
          ))
        )}
        {busy !== 'load' && filtered.length === 0 && (
          <div className="empty-panel">未找到匹配的 Skill。</div>
        )}
      </div>
      {descriptionDialog}
      {confirmDialog}
    </div>
  );
}

function fuzzyIncludes(value: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const normalizedValue = value.toLocaleLowerCase();
  if (normalizedValue.includes(normalizedQuery)) return true;
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      if (normalizedValue.includes(term)) return true;
      let cursor = 0;
      for (const character of normalizedValue) {
        if (character === term[cursor]) cursor += 1;
        if (cursor === term.length) return true;
      }
      return false;
    });
}

function formatTokens(value: number | null): string {
  if (!value) return '—';
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

interface CategoryManagerProps {
  categories: ReadonlyArray<{ id: string; name: string; system: boolean }>;
  counts: Map<string, number>;
  busy: boolean;
  label: string;
  onCreate(name: string): void | Promise<void>;
  onRename(id: string, name: string): void | Promise<void>;
  onDelete(id: string, name: string): void | Promise<void>;
}

/** 分类管理浮层：删除确认由父级各自闭环，避免双重确认弹窗。 */
function CategoryManager({
  categories,
  counts,
  busy,
  label,
  onCreate,
  onRename,
  onDelete,
}: CategoryManagerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', keydown);
    };
  }, [open]);

  return (
    <div className="category-manager" ref={containerRef}>
      <button
        type="button"
        className="icon-button category-manager-trigger"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <div className="category-manager-popover">
          <strong>{label}</strong>
          <form
            className="category-create-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newName.trim() || busy) return;
              void onCreate(newName.trim());
              setNewName('');
            }}
          >
            <input
              value={newName}
              maxLength={40}
              disabled={busy}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="新增分类"
              aria-label="新增分类名称"
            />
            <button
              type="submit"
              className="icon-button"
              disabled={busy || !newName.trim()}
              aria-label="新增分类"
            >
              <Plus size={15} />
            </button>
          </form>
          <div className="category-manager-list custom-scrollbar">
            {categories.map((category) =>
              editingId === category.id ? (
                <form
                  className="category-edit-row"
                  key={category.id}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!editingId || !editingName.trim() || busy) return;
                    void onRename(editingId, editingName.trim());
                    setEditingId(null);
                  }}
                >
                  <input
                    autoFocus
                    value={editingName}
                    maxLength={40}
                    disabled={busy}
                    onChange={(event) => setEditingName(event.target.value)}
                    aria-label={`重命名 ${category.name}`}
                  />
                  <button
                    type="submit"
                    className="icon-button"
                    disabled={busy || !editingName.trim()}
                    aria-label="保存分类名称"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setEditingId(null)}
                    aria-label="取消重命名"
                  >
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <div className="category-manager-row" key={category.id}>
                  <span>{category.name}</span>
                  <small>{counts.get(category.id) ?? 0}</small>
                  {category.system ? (
                    <em>固定</em>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(category.id);
                          setEditingName(category.name);
                        }}
                        aria-label={`重命名 ${category.name}`}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        disabled={busy}
                        onClick={() => void onDelete(category.id, category.name)}
                        aria-label={`删除 ${category.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
