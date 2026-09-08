import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Settings,
  LogOut,
  UserRoundPlus,
} from 'lucide-react';
import type { AgentNavigationSnapshot, BootstrapLocalUser, Session } from '@client-contracts';

interface SidebarProps {
  navigation: AgentNavigationSnapshot | null;
  activeAgentId: string | null;
  activeSessionId: string | null;
  activeUser: BootstrapLocalUser;
  onSelectAgent(id: string): void;
  onSelectSession(id: string): void;
  onNewSession(): void;
  onNewAgentSession(agentId: string): void;
  onAddAgent(agentId: string): Promise<void>;
  onCreateAgent(): void;
  onRename(session: Session): void;
  onArchive(session: Session): void;
  onToggle(): void;
  onOpenSettings(): void;
  onLogout(): void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const profileAreaRef = useRef<HTMLDivElement>(null);
  const initials = props.activeUser.displayName.slice(0, 2).toUpperCase();

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuId(null);
        setProfileOpen(false);
        setPickerOpen(false);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (!target.closest('.session-menu, .session-menu-button')) {
        setMenuId(null);
      }
      if (!target.closest('.profile-menu, .profile-button')) {
        setProfileOpen(false);
      }
      if (!target.closest('.agent-picker-popover, .agent-navigation-heading > .icon-button')) {
        setPickerOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);

  const toggleAgent = (agentId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  return (
    <aside className="sidebar" aria-label="智能体与会话导航">
      <div className="sidebar-top">
        <div className="brand-row">
          <button className="icon-button" onClick={props.onToggle} aria-label="关闭侧边栏">
            <PanelLeftClose size={19} />
          </button>
        </div>
        <button
          className="new-chat-button"
          onClick={props.onNewSession}
          disabled={!props.activeAgentId}
        >
          <Plus size={16} /> 新对话
        </button>
        <button className="create-agent-button" onClick={props.onCreateAgent}>
          <UserRoundPlus size={15} /> 创建智能体
        </button>
      </div>

      <div className="agent-navigation custom-scrollbar">
        <div className="agent-navigation-heading">
          <strong>智能体</strong>
          <button
            className="icon-button compact"
            aria-label="把已有智能体加入首页"
            onClick={() => setPickerOpen((current) => !current)}
          >
            <Plus size={15} />
          </button>
          {pickerOpen && (
            <div className="agent-picker-popover">
              <strong>加入已有智能体</strong>
              {(props.navigation?.availableToAdd.length ?? 0) === 0 ? (
                <p>没有可加入的智能体</p>
              ) : (
                props.navigation?.availableToAdd.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setPickerOpen(false);
                      void props.onAddAgent(agent.id);
                    }}
                  >
                    <AgentAvatar name={agent.name} />
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.description || '未填写简介'}</small>
                    </span>
                  </button>
                ))
              )}
              <button className="manage-agents-link" onClick={props.onCreateAgent}>
                管理智能体
              </button>
            </div>
          )}
        </div>

        {props.navigation?.items.map((item) => {
          const isCollapsed = collapsed.has(item.agent.id);
          const active = props.activeAgentId === item.agent.id;
          return (
            <section key={item.agent.id} className={`agent-group ${active ? 'active' : ''}`}>
              <div className="agent-row">
                <button
                  className="agent-collapse"
                  onClick={() => toggleAgent(item.agent.id)}
                  aria-label={isCollapsed ? '展开会话' : '折叠会话'}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button
                  className="agent-select"
                  onClick={() => {
                    setMenuId(null);
                    setPickerOpen(false);
                    props.onSelectAgent(item.agent.id);
                  }}
                >
                  <AgentAvatar name={item.agent.name} />
                  <span>{item.agent.name}</span>
                </button>
                <button
                  className="agent-new-session"
                  aria-label={`在 ${item.agent.name} 下新建对话`}
                  onClick={() => props.onNewAgentSession(item.agent.id)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {!isCollapsed && (
                <div className="agent-sessions">
                  {item.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`session-item ${
                        props.activeSessionId === session.id ? 'active' : ''
                      }`}
                    >
                      <button
                        className="session-select"
                        onClick={() => {
                          setMenuId(null);
                          props.onSelectSession(session.id);
                        }}
                      >
                        <span>{session.title}</span>
                      </button>
                      <button
                        className="session-menu-button"
                        aria-label={`${session.title} 操作`}
                        onClick={() =>
                          setMenuId((current) => (current === session.id ? null : session.id))
                        }
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {menuId === session.id && (
                        <div className="session-menu" role="menu">
                          <button
                            onClick={() => {
                              setMenuId(null);
                              props.onRename(session);
                            }}
                          >
                            <Pencil size={14} /> 重命名
                          </button>
                          <button
                            className="danger"
                            onClick={() => {
                              setMenuId(null);
                              props.onArchive(session);
                            }}
                          >
                            <Archive size={14} /> 归档
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {item.sessions.length === 0 && (
                    <div className="agent-session-empty">暂无对话</div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {props.navigation?.items.length === 0 && (
          <div className="sidebar-empty">
            <Bot size={22} />
            <span>首页还没有智能体</span>
            <button onClick={() => setPickerOpen(true)}>添加智能体</button>
          </div>
        )}
      </div>

      <div ref={profileAreaRef} className="profile-area">
        {profileOpen && (
          <div className="profile-menu" role="menu">
            <button
              onClick={() => {
                setProfileOpen(false);
                props.onOpenSettings();
              }}
            >
              <Settings size={15} /> 设置
            </button>
            <button
              onClick={() => {
                setProfileOpen(false);
                props.onLogout();
              }}
            >
              <LogOut size={15} /> 退出登录
            </button>
          </div>
        )}
        <button
          className="profile-button"
          aria-expanded={profileOpen}
          onClick={() => setProfileOpen((current) => !current)}
        >
          <span className="avatar">{initials}</span>
          <span className="profile-copy">
            <strong>{props.activeUser.displayName}</strong>
            <small>本地用户</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </div>
    </aside>
  );
}

function AgentAvatar({ name }: { name: string }): JSX.Element {
  return <span className="agent-avatar">{name.slice(0, 2).toUpperCase()}</span>;
}
