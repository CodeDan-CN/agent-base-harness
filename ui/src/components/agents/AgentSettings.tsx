import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Archive, Check, Loader2, Plus, Star, Trash2 } from 'lucide-react';
import type {
  AgentManagementSnapshot,
  AgentProfile,
  McpManagementSnapshot,
  PermissionPreset,
  SkillManagementSnapshot,
} from '@client-contracts';
import { command, query, userMessage } from '../../client';

interface Props {
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

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  instructions: '',
  defaultModelId: null,
  permissionPreset: 'guarded',
});

export function AgentSettings({ onNotify, onChanged }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentManagementSnapshot | null>(null);
  const [skills, setSkills] = useState<SkillManagementSnapshot | null>(null);
  const [mcp, setMcp] = useState<McpManagementSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [openBindingPicker, setOpenBindingPicker] = useState<BindingKind | null>(null);

  const reload = async (preferredId?: string | null) => {
    try {
      const [next, nextSkills, nextMcp] = await Promise.all([
        query<AgentManagementSnapshot>('agent-management.snapshot'),
        query<SkillManagementSnapshot>('skill-management.snapshot'),
        query<McpManagementSnapshot>('mcp-management.snapshot'),
      ]);
      setSnapshot(next);
      setSkills(nextSkills);
      setMcp(nextMcp);
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

  useEffect(() => {
    if (!openBindingPicker) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.binding-picker-popover, .binding-add-button')) {
        setOpenBindingPicker(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [openBindingPicker]);

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

  if (!snapshot) {
    return (
      <div className="settings-loading">
        <Loader2 className="spin" /> 正在加载智能体...
      </div>
    );
  }

  return (
    <div className="agent-settings-layout">
      <aside className="agent-settings-list">
        <button
          className="secondary-button agent-create-entry"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
            setDraft(emptyDraft());
            setOpenBindingPicker(null);
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
            <p>档案保存后不会自动出现在首页，也不会自动创建会话或启动 MCP。</p>
          </div>
          {!creating && selected?.profile.status === 'active' && (
            <div className="agent-form-actions compact-actions">
              {!selected.profile.isDefault && (
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
              {!selected.profile.isDefault && (
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
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="wide">
                <span>简介</span>
                <input
                  value={draft.description}
                  maxLength={2000}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label className="wide">
                <span>核心指令</span>
                <textarea
                  rows={8}
                  value={draft.instructions}
                  onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                />
              </label>
            </div>
            <div className="agent-form-actions">
              <button className="dark-button" disabled={busy || !draft.name.trim()} onClick={save}>
                {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
                {creating ? '创建档案' : '保存配置'}
              </button>
            </div>
          </>
        )}

        {!creating && selected?.profile.status === 'active' && (
          <div className="agent-bindings">
            <BindingSection
              title="Skills"
              pickerOpen={openBindingPicker === 'skills'}
              onTogglePicker={() =>
                setOpenBindingPicker((current) => (current === 'skills' ? null : 'skills'))
              }
              picker={
                <BindingPicker
                  options={
                    skills?.skills
                      .filter((skill) => !selected.bindings.skillIds.includes(skill.id))
                      .map((skill) => ({
                        id: skill.id,
                        label: skill.name,
                        description: skill.description,
                        checked: false,
                        onChange: (enabled) =>
                          void mutate(
                            () =>
                              command('agent.skill.toggle', {
                                agentId: selected.profile.id,
                                skillId: skill.id,
                                enabled,
                                expectedRevision: snapshot.revision,
                              }),
                            'Skill 已加入。',
                          ),
                      })) ?? []
                  }
                />
              }
            >
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
            <BindingSection
              title="MCP 与记忆"
              pickerOpen={openBindingPicker === 'mcp'}
              onTogglePicker={() =>
                setOpenBindingPicker((current) => (current === 'mcp' ? null : 'mcp'))
              }
              picker={
                <BindingPicker
                  options={mcpOptions(mcp, selected.bindings.mcp).map((option) => ({
                    ...option,
                    checked: false,
                    onChange: (enabled) =>
                      void mutate(
                        () =>
                          command('agent.mcp.toggle', {
                            agentId: selected.profile.id,
                            serverId: option.serverId,
                            accessScope: option.accessScope,
                            enabled,
                            expectedRevision: snapshot.revision,
                          }),
                        'MCP 已加入。',
                      ),
                  }))}
                />
              }
            >
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
            <BindingSection
              title="可调用智能体"
              pickerOpen={openBindingPicker === 'agents'}
              onTogglePicker={() =>
                setOpenBindingPicker((current) => (current === 'agents' ? null : 'agents'))
              }
              picker={
                <BindingPicker
                  options={activeAgents
                    .filter(
                      (item) =>
                        item.profile.id !== selected.profile.id &&
                        !selected.bindings.delegateAgentIds.includes(item.profile.id),
                    )
                    .map((item) => ({
                      id: item.profile.id,
                      label: item.profile.name,
                      description: item.profile.description,
                      checked: false,
                      onChange: (enabled) =>
                        void mutate(
                          () =>
                            command('agent.delegate.toggle', {
                              callerAgentId: selected.profile.id,
                              calleeAgentId: item.profile.id,
                              enabled,
                              expectedRevision: snapshot.revision,
                            }),
                          '可调用智能体已加入。',
                        ),
                    }))}
                />
              }
            >
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
                        '可调用智能体已移除。',
                      )
                    }
                  />
                ))}
            </BindingSection>
          </div>
        )}
      </div>
    </div>
  );
}

type BindingKind = 'skills' | 'mcp' | 'agents';

interface BindingOption {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange(enabled: boolean): void;
}

function BindingSection(props: {
  title: string;
  pickerOpen: boolean;
  onTogglePicker(): void;
  picker: React.ReactNode;
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
          aria-expanded={props.pickerOpen}
          onClick={props.onTogglePicker}
        >
          <Plus size={14} />
        </button>
        {props.pickerOpen && <div className="binding-picker-popover">{props.picker}</div>}
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

function BindingPicker(props: { options: BindingOption[] }): JSX.Element {
  return (
    <div className="binding-picker">
      {props.options.length === 0 ? (
        <p className="binding-picker-empty">没有可添加的项目</p>
      ) : (
        props.options.map((option) => (
          <label className="binding-picker-option" key={option.id}>
            <input
              type="checkbox"
              checked={option.checked}
              onChange={(event) => option.onChange(event.target.checked)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description || '无简介'}</small>
            </span>
          </label>
        ))
      )}
    </div>
  );
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
