import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Archive,
  Check,
  ChevronRight,
  Loader2,
  Plus,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AgentManagementSnapshot,
  AgentProfile,
  McpManagementSnapshot,
  ModelManagementSnapshot,
  PermissionPreset,
  SkillManagementSnapshot,
} from '@client-contracts';
import { command, query, userMessage } from '../../client';
import { permissionLabel, permissionOptions } from '../../permission-presets';
import { SelectMenu } from '../SelectMenu';

interface Props {
  startCreating?: boolean;
  onNotify(message: string, tone?: 'success' | 'error' | 'info'): void;
  onChanged?(): void;
}

interface Draft {
  name: string;
  description: string;
  instructions: string;
  defaultModelId: string | null;
  permissionPreset: PermissionPreset;
}

interface AdvancedDraft {
  instructions: string;
  defaultModelId: string | null;
  permissionPreset: PermissionPreset;
}

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  instructions: '',
  defaultModelId: null,
  permissionPreset: 'guarded',
});

export function AgentSettings({ startCreating = false, onNotify, onChanged }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentManagementSnapshot | null>(null);
  const [skills, setSkills] = useState<SkillManagementSnapshot | null>(null);
  const [mcp, setMcp] = useState<McpManagementSnapshot | null>(null);
  const [models, setModels] = useState<ModelManagementSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(startCreating);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [openBindingPicker, setOpenBindingPicker] = useState<BindingKind | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const reload = async (preferredId?: string | null) => {
    try {
      const [next, nextSkills, nextMcp, nextModels] = await Promise.all([
        query<AgentManagementSnapshot>('agent-management.snapshot'),
        query<SkillManagementSnapshot>('skill-management.snapshot'),
        query<McpManagementSnapshot>('mcp-management.snapshot'),
        query<ModelManagementSnapshot>('model-management.snapshot'),
      ]);
      setSnapshot(next);
      setSkills(nextSkills);
      setMcp(nextMcp);
      setModels(nextModels);
      const target = preferredId ?? selectedId ?? next.defaultAgentId;
      const profile = next.agents.find((item) => item.profile.id === target)?.profile;
      setSelectedId(profile?.id ?? next.agents[0]?.profile.id ?? null);
      if (profile) setDraft(fromProfile(profile));
      onChanged?.();
    } catch (error) {
      onNotify(userMessage(error), 'error');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const selected = snapshot?.agents.find((item) => item.profile.id === selectedId) ?? null;
  const activeAgents = useMemo(
    () => snapshot?.agents.filter((item) => item.profile.status === 'active') ?? [],
    [snapshot],
  );

  const select = (profile: AgentProfile) => {
    setCreating(false);
    setSelectedId(profile.id);
    setDraft(fromProfile(profile));
    setOpenBindingPicker(null);
    setAdvancedOpen(false);
  };

  const mutate = async (work: () => Promise<unknown>, success: string, preferred = selectedId) => {
    setBusy(true);
    try {
      const result = await work();
      const returnedId =
        result && typeof result === 'object' && 'id' in result
          ? String((result as { id: unknown }).id)
          : null;
      await reload(returnedId ?? preferred);
      onNotify(success, 'success');
    } catch (error) {
      onNotify(userMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!snapshot || !draft.name.trim()) return;
    if (creating) {
      void mutate(
        async () => {
          const profile = await command<AgentProfile>('agent.create', {
            ...draft,
            avatarKey: null,
            expectedRevision: snapshot.revision,
          });
          setCreating(false);
          setSelectedId(profile.id);
          return profile;
        },
        '智能体档案已创建；可在首页“智能体＋”中加入。',
        null,
      );
      return;
    }
    if (!selected) return;
    void mutate(
      () =>
        command('agent.update', {
          agentId: selected.profile.id,
          ...draft,
          avatarKey: selected.profile.avatarKey,
          expectedProfileRevision: selected.profile.revision,
          expectedRevision: snapshot.revision,
        }),
      '智能体配置已保存。',
    );
  };

  const saveAdvanced = async (advanced: AdvancedDraft): Promise<boolean> => {
    const nextDraft = { ...draft, ...advanced };
    setDraft(nextDraft);
    if (creating) return true;
    if (!selected || !snapshot) return false;
    setBusy(true);
    try {
      await command('agent.update', {
        agentId: selected.profile.id,
        ...nextDraft,
        avatarKey: selected.profile.avatarKey,
        expectedProfileRevision: selected.profile.revision,
        expectedRevision: snapshot.revision,
      });
      await reload(selected.profile.id);
      onNotify('更多设置已保存。', 'success');
      return true;
    } catch (error) {
      onNotify(userMessage(error), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pickerOptions = useMemo<BindingOption[]>(() => {
    if (!selected || !snapshot || !openBindingPicker) return [];
    if (openBindingPicker === 'skills') {
      return (
        skills?.skills
          .filter((skill) => !selected.bindings.skillIds.includes(skill.id))
          .map((skill) => ({
            id: skill.id,
            label: skill.name,
            description: skill.description,
            tagId: skill.categoryId,
            tagLabel: categoryLabel(skills.categories, skill.categoryId),
            onAdd: () =>
              void mutate(
                () =>
                  command('agent.skill.toggle', {
                    agentId: selected.profile.id,
                    skillId: skill.id,
                    enabled: true,
                    expectedRevision: snapshot.revision,
                  }),
                'Skill 已加入。',
              ),
          })) ?? []
      );
    }
    if (openBindingPicker === 'mcp') {
      return mcpOptions(mcp, selected.bindings.mcp).map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        tagId: option.categoryId,
        tagLabel: categoryLabel(mcp?.categories ?? [], option.categoryId),
        onAdd: () =>
          void mutate(
            () =>
              command('agent.mcp.toggle', {
                agentId: selected.profile.id,
                serverId: option.serverId,
                accessScope: option.accessScope,
                enabled: true,
                expectedRevision: snapshot.revision,
              }),
            'MCP 已加入。',
          ),
      }));
    }
    return activeAgents
      .filter(
        (item) =>
          item.profile.id !== selected.profile.id &&
          !selected.bindings.delegateAgentIds.includes(item.profile.id),
      )
      .map((item) => ({
        id: item.profile.id,
        label: item.profile.name,
        description: item.profile.description,
        tagId: item.profile.isDefault ? 'default-agent' : 'custom-agent',
        tagLabel: item.profile.isDefault ? '默认智能体' : '自建智能体',
        onAdd: () =>
          void mutate(
            () =>
              command('agent.delegate.toggle', {
                callerAgentId: selected.profile.id,
                calleeAgentId: item.profile.id,
                enabled: true,
                expectedRevision: snapshot.revision,
              }),
            'Sub Agent 已加入。',
          ),
      }));
  }, [activeAgents, mcp, openBindingPicker, selected, skills, snapshot]);

  if (!snapshot) {
    return (
      <div className="settings-loading">
        <Loader2 className="spin" /> 正在加载智能体...
      </div>
    );
  }

  return (
    <>
      <div className="agent-settings-layout">
        <aside className="agent-settings-list">
          <button
            className="secondary-button agent-create-entry"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
              setDraft(emptyDraft());
              setOpenBindingPicker(null);
              setAdvancedOpen(false);
            }}
          >
            <Plus size={14} /> 创建智能体
          </button>
          {snapshot.agents.map(({ profile }) => (
            <button
              key={profile.id}
              className={selectedId === profile.id && !creating ? 'active' : ''}
              onClick={() => select(profile)}
            >
              <span className="agent-avatar">{profile.name.slice(0, 2).toUpperCase()}</span>
              <span>
                <strong>{profile.name}</strong>
                <small>
                  {profile.status === 'archived' ? '已归档' : profile.description || '通用智能体'}
                </small>
              </span>
              {profile.isDefault && <Star size={13} />}
            </button>
          ))}
        </aside>

        <div className="agent-settings-form">
          <header>
            <div>
              <h2>{creating ? '创建智能体' : (selected?.profile.name ?? '智能体')}</h2>
              <p>管理身份与能力；默认模型、权限和核心指令收纳在更多设置中。</p>
            </div>
            {(creating || selected?.profile.status === 'active') && (
              <div className="agent-form-actions compact-actions">
                {!creating && selected && !selected.profile.isDefault && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          command('agent.default.set', {
                            agentId: selected.profile.id,
                            expectedRevision: snapshot.revision,
                          }),
                        '默认智能体已更新。',
                      )
                    }
                  >
                    <Star size={14} /> 设为默认
                  </button>
                )}
                {!creating && selected && !selected.profile.isDefault && (
                  <button
                    className="secondary-button danger"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          command('agent.archive', {
                            agentId: selected.profile.id,
                            expectedRevision: snapshot.revision,
                          }),
                        '智能体已归档。',
                        snapshot.defaultAgentId,
                      )
                    }
                  >
                    <Archive size={14} /> 归档
                  </button>
                )}
                <button
                  className="dark-button"
                  disabled={busy || !draft.name.trim()}
                  onClick={save}
                >
                  {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
                  {creating ? '创建档案' : '保存配置'}
                </button>
              </div>
            )}
          </header>

          {(creating || selected?.profile.status === 'active') && (
            <>
              <div className="agent-form-grid">
                <label>
                  <span>名称</span>
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label className="wide">
                  <span>简介</span>
                  <input
                    value={draft.description}
                    maxLength={2000}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </label>
              </div>
              <button
                type="button"
                className="advanced-settings-entry"
                onClick={() => setAdvancedOpen(true)}
              >
                <span className="advanced-settings-entry-icon">
                  <Settings2 size={16} />
                </span>
                <span className="advanced-settings-entry-copy">
                  <strong>更多设置</strong>
                  <small>
                    {advancedModelLabel(draft.defaultModelId, models)} ·{' '}
                    {permissionLabel(draft.permissionPreset)} ·{' '}
                    {draft.instructions.trim() ? '已配置核心指令' : '未配置核心指令'}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            </>
          )}

          {!creating && selected?.profile.status === 'active' && (
            <div className="agent-bindings">
              <BindingSection title="Skills" onAdd={() => setOpenBindingPicker('skills')}>
                {skills?.skills
                  .filter((skill) => selected.bindings.skillIds.includes(skill.id))
                  .map((skill) => (
                    <BindingToggle
                      key={skill.id}
                      label={skill.name}
                      description={skill.description}
                      disabled={busy}
                      onRemove={() =>
                        void mutate(
                          () =>
                            command('agent.skill.toggle', {
                              agentId: selected.profile.id,
                              skillId: skill.id,
                              enabled: false,
                              expectedRevision: snapshot.revision,
                            }),
                          'Skill 已移除。',
                        )
                      }
                    />
                  ))}
              </BindingSection>
              <BindingSection title="MCP 与记忆" onAdd={() => setOpenBindingPicker('mcp')}>
                {selected.bindings.mcp.map((binding) => {
                  const server = mcp?.servers.find((item) => item.id === binding.serverId);
                  const privateMemory =
                    binding.serverId === 'builtin-memory' && binding.accessScope === 'agent';
                  return (
                    <BindingToggle
                      key={`${binding.serverId}:${binding.accessScope}`}
                      label={mcpBindingLabel(server?.name, binding.serverId, binding.accessScope)}
                      description={server?.summary ?? 'MCP 服务'}
                      disabled={busy || privateMemory}
                      onRemove={() =>
                        void mutate(
                          () =>
                            command('agent.mcp.toggle', {
                              agentId: selected.profile.id,
                              serverId: binding.serverId,
                              accessScope: binding.accessScope,
                              enabled: false,
                              expectedRevision: snapshot.revision,
                            }),
                          'MCP 已移除。',
                        )
                      }
                    />
                  );
                })}
              </BindingSection>
              <BindingSection title="Sub Agents" onAdd={() => setOpenBindingPicker('agents')}>
                {activeAgents
                  .filter((item) => selected.bindings.delegateAgentIds.includes(item.profile.id))
                  .map((item) => (
                    <BindingToggle
                      key={item.profile.id}
                      label={item.profile.name}
                      description={item.profile.description}
                      disabled={busy}
                      onRemove={() =>
                        void mutate(
                          () =>
                            command('agent.delegate.toggle', {
                              callerAgentId: selected.profile.id,
                              calleeAgentId: item.profile.id,
                              enabled: false,
                              expectedRevision: snapshot.revision,
                            }),
                          'Sub Agent 已移除。',
                        )
                      }
                    />
                  ))}
              </BindingSection>
            </div>
          )}
        </div>
      </div>

      {openBindingPicker && (
        <BindingPickerDialog
          kind={openBindingPicker}
          options={pickerOptions}
          busy={busy}
          onClose={() => setOpenBindingPicker(null)}
        />
      )}
      {advancedOpen && (
        <AdvancedSettingsDialog
          agentName={draft.name.trim() || (creating ? '新智能体' : '当前智能体')}
          initialValue={advancedFromDraft(draft)}
          models={models}
          creating={creating}
          busy={busy}
          onClose={() => setAdvancedOpen(false)}
          onSave={saveAdvanced}
        />
      )}
    </>
  );
}

type BindingKind = 'skills' | 'mcp' | 'agents';

interface BindingOption {
  id: string;
  label: string;
  description: string;
  tagId: string;
  tagLabel: string;
  onAdd(): void;
}

function BindingSection(props: {
  title: string;
  onAdd(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <div className="binding-section-heading">
        <h3>{props.title}</h3>
        <button
          className="icon-button compact binding-add-button"
          type="button"
          aria-label={`添加${props.title}`}
          onClick={props.onAdd}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="binding-list">{props.children}</div>
    </section>
  );
}

function BindingToggle(props: {
  label: string;
  description: string;
  disabled?: boolean;
  onRemove(): void;
}): JSX.Element {
  return (
    <div className="binding-toggle">
      <span>
        <strong>{props.label}</strong>
        <small>{props.description || '无简介'}</small>
      </span>
      <button
        className="binding-remove-button"
        type="button"
        aria-label={`移除${props.label}`}
        title={props.disabled ? '内置私有记忆不可移除' : '从当前智能体移除'}
        disabled={props.disabled}
        onClick={props.onRemove}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function AdvancedSettingsDialog(props: {
  agentName: string;
  initialValue: AdvancedDraft;
  models: ModelManagementSnapshot | null;
  creating: boolean;
  busy: boolean;
  onClose(): void;
  onSave(value: AdvancedDraft): Promise<boolean>;
}): JSX.Element {
  const [value, setValue] = useState(props.initialValue);
  const [submitting, setSubmitting] = useState(false);
  const enabledModels = props.models?.models.filter((model) => model.status === 'enabled') ?? [];
  const configuredModel = props.initialValue.defaultModelId
    ? props.models?.models.find((model) => model.id === props.initialValue.defaultModelId)
    : null;
  const modelAvailable = enabledModels.some((model) => model.id === value.defaultModelId);
  const modelOptions = [
    { value: '', label: '继承用户默认模型' },
    ...(!modelAvailable && value.defaultModelId
      ? [
          {
            value: value.defaultModelId,
            label: `${configuredModel?.displayName ?? value.defaultModelId}（当前不可用）`,
            disabled: true,
          },
        ]
      : []),
    ...enabledModels.map((model) => ({
      value: model.id,
      label: `${model.displayName} · ${model.remoteModelId}`,
    })),
  ];
  const locked = props.busy || submitting;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !locked) props.onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [locked, props.onClose]);

  const save = async () => {
    if (locked) return;
    setSubmitting(true);
    const saved = await props.onSave(value);
    if (saved) props.onClose();
    else setSubmitting(false);
  };

  return (
    <div
      className="dialog-backdrop advanced-settings-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !locked && props.onClose()}
    >
      <section
        className="app-dialog advanced-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-settings-title"
      >
        <header className="advanced-settings-heading">
          <div>
            <h2 id="advanced-settings-title">{props.agentName} · 更多设置</h2>
            <p>这些设置会持续影响该智能体后续的会话与受派执行。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭更多设置"
            disabled={locked}
            onClick={props.onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="advanced-settings-body">
          <div className="advanced-settings-field">
            <span>默认模型</span>
            <SelectMenu
              ariaLabel="默认模型"
              value={value.defaultModelId ?? ''}
              disabled={locked}
              options={modelOptions}
              className="advanced-model-select"
              popoverClassName="advanced-model-popover"
              onChange={(modelId) => setValue({ ...value, defaultModelId: modelId || null })}
            />
            <small>{inheritedModelDescription(props.models)}</small>
          </div>

          <fieldset className="advanced-permission-field" disabled={locked}>
            <legend>权限模式</legend>
            <div className="advanced-permission-options">
              {permissionOptions.map((option) => (
                <label
                  className={value.permissionPreset === option.value ? 'selected' : ''}
                  key={option.value}
                >
                  <input
                    type="radio"
                    name="advanced-permission-preset"
                    value={option.value}
                    checked={value.permissionPreset === option.value}
                    onChange={() => setValue({ ...value, permissionPreset: option.value })}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="advanced-settings-field core-instructions-field">
            <span>核心指令</span>
            <textarea
              aria-label="核心指令"
              rows={9}
              maxLength={32_000}
              value={value.instructions}
              disabled={locked}
              placeholder="用于规定智能体长期角色、工作方式、输出格式和行为边界；通用智能体可以留空。"
              onChange={(event) => setValue({ ...value, instructions: event.target.value })}
            />
            <small>
              每个执行步骤都会携带这段内容，建议只写长期稳定规则，不要填写密码或密钥。
              <span>{value.instructions.length.toLocaleString()} / 32,000</span>
            </small>
          </label>
        </div>

        <footer className="advanced-settings-footer">
          {props.creating && <p>这些设置将在创建档案时一并保存。</p>}
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={props.onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="dark-button"
              disabled={locked}
              onClick={() => void save()}
            >
              {(submitting || props.busy) && <Loader2 className="spin" size={14} />}
              {props.creating ? '应用设置' : '保存设置'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function BindingPickerDialog(props: {
  kind: BindingKind;
  options: BindingOption[];
  busy: boolean;
  onClose(): void;
}): JSX.Element {
  const [queryText, setQueryText] = useState('');
  const [activeTag, setActiveTag] = useState('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const copy = pickerCopy(props.kind);
  const tags = useMemo(() => {
    const unique = new Map<string, string>();
    props.options.forEach((option) => unique.set(option.tagId, option.tagLabel));
    return [...unique].map(([id, label]) => ({ id, label }));
  }, [props.options]);
  const results = useMemo(() => {
    const queryValue = queryText.trim().toLocaleLowerCase();
    return props.options.filter((option) => {
      if (activeTag !== 'all' && option.tagId !== activeTag) return false;
      if (!queryValue) return true;
      return `${option.label} ${option.description}`.toLocaleLowerCase().includes(queryValue);
    });
  }, [activeTag, props.options, queryText]);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [props.busy, props.onClose]);

  useEffect(() => {
    if (activeTag !== 'all' && !tags.some((tag) => tag.id === activeTag)) setActiveTag('all');
  }, [activeTag, tags]);

  return (
    <div
      className="dialog-backdrop binding-picker-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !props.busy && props.onClose()
      }
    >
      <section
        className="app-dialog binding-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="binding-picker-title"
      >
        <header className="binding-picker-dialog-heading">
          <div>
            <h2 id="binding-picker-title">{copy.title}</h2>
            <p>{copy.description}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭选择窗口"
            disabled={props.busy}
            onClick={props.onClose}
          >
            <X size={16} />
          </button>
        </header>

        <label className="binding-picker-search">
          <Search size={15} />
          <input
            ref={searchRef}
            type="search"
            aria-label={`搜索${copy.shortName}`}
            value={queryText}
            placeholder={`搜索${copy.shortName}名称或简介`}
            onChange={(event) => setQueryText(event.target.value)}
          />
        </label>

        <div className="binding-picker-tags" aria-label={`${copy.shortName}分类`}>
          <button
            type="button"
            className={activeTag === 'all' ? 'active' : ''}
            onClick={() => setActiveTag('all')}
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={activeTag === tag.id ? 'active' : ''}
              onClick={() => setActiveTag(tag.id)}
            >
              {tag.label}
            </button>
          ))}
        </div>

        <div className="binding-picker-results-heading">
          <strong>结果列表</strong>
          <span>{results.length} 项</span>
        </div>
        <div className="binding-picker-results">
          {results.length === 0 ? (
            <div className="binding-picker-empty">
              <Search size={20} />
              <strong>{props.options.length === 0 ? '没有可添加的项目' : '没有匹配结果'}</strong>
              <span>
                {props.options.length === 0
                  ? `当前可用的${copy.shortName}都已添加。`
                  : '换个关键词或分类再试试。'}
              </span>
            </div>
          ) : (
            results.map((option) => (
              <article className="binding-picker-result" key={option.id}>
                <div>
                  <span className="binding-picker-result-title">
                    <strong>{option.label}</strong>
                    <small>{option.tagLabel}</small>
                  </span>
                  <p>{option.description || '无简介'}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={props.busy}
                  onClick={option.onAdd}
                >
                  {props.busy ? <Loader2 className="spin" size={13} /> : <Plus size={13} />}
                  添加
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function pickerCopy(kind: BindingKind): { title: string; shortName: string; description: string } {
  if (kind === 'skills') {
    return {
      title: '添加 Skills',
      shortName: 'Skill',
      description: '为当前智能体选择可按需加载的专业能力。',
    };
  }
  if (kind === 'mcp') {
    return {
      title: '添加 MCP 与记忆',
      shortName: 'MCP',
      description: '为当前智能体连接工具服务或可用的记忆范围。',
    };
  }
  return {
    title: '添加 Sub Agent',
    shortName: 'Sub Agent',
    description: '选择当前智能体在任务中可以调用的其他智能体。',
  };
}

function categoryLabel(categories: Array<{ id: string; name: string }>, id: string): string {
  return categories.find((category) => category.id === id)?.name ?? '未分类';
}

function mcpOptions(
  snapshot: McpManagementSnapshot | null,
  bindings: AgentManagementSnapshot['agents'][number]['bindings']['mcp'],
): Array<{
  id: string;
  serverId: string;
  accessScope: 'user' | 'agent';
  label: string;
  description: string;
  categoryId: string;
}> {
  const enabled = new Set(bindings.map((binding) => `${binding.serverId}:${binding.accessScope}`));
  return (snapshot?.servers ?? [])
    .filter((server) => server.status === 'enabled')
    .flatMap((server) => {
      const scopes =
        server.id === 'builtin-memory' ? (['agent', 'user'] as const) : (['user'] as const);
      return scopes
        .filter((scope) => !enabled.has(`${server.id}:${scope}`))
        .map((scope) => ({
          id: `${server.id}:${scope}`,
          serverId: server.id,
          accessScope: scope,
          label: mcpBindingLabel(server.name, server.id, scope),
          description: server.summary,
          categoryId: server.categoryId,
        }));
    });
}

function mcpBindingLabel(
  serverName: string | undefined,
  serverId: string,
  scope: 'user' | 'agent',
): string {
  if (serverId === 'builtin-memory') {
    return scope === 'agent' ? '本智能体私有记忆' : '用户共享记忆';
  }
  return serverName ?? serverId;
}

function fromProfile(profile: AgentProfile): Draft {
  return {
    name: profile.name,
    description: profile.description,
    instructions: profile.instructions,
    defaultModelId: profile.defaultModelId,
    permissionPreset: profile.permissionPreset,
  };
}

function advancedFromDraft(draft: Draft): AdvancedDraft {
  return {
    instructions: draft.instructions,
    defaultModelId: draft.defaultModelId,
    permissionPreset: draft.permissionPreset,
  };
}

function advancedModelLabel(
  modelId: string | null,
  snapshot: ModelManagementSnapshot | null,
): string {
  if (!modelId) {
    const inherited = snapshot?.models.find((model) => model.id === snapshot.defaultModelId);
    return inherited ? `继承 ${inherited.displayName}` : '继承用户默认模型';
  }
  return snapshot?.models.find((model) => model.id === modelId)?.displayName ?? '已指定模型';
}

function inheritedModelDescription(snapshot: ModelManagementSnapshot | null): string {
  const inherited = snapshot?.models.find((model) => model.id === snapshot.defaultModelId);
  return inherited
    ? `选择继承时使用用户默认模型：${inherited.displayName}。`
    : '选择继承时使用用户默认模型；当前尚未设置用户默认模型。';
}
