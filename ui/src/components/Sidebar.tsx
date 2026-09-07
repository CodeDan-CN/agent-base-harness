import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  LogOut,
} from 'lucide-react';
import type { BootstrapLocalUser, Session } from '@client-contracts';

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  activeUser: BootstrapLocalUser;
  onSelectSession(id: string): void;
  onNewSession(): void;
  onRename(session: Session): void;
  onArchive(session: Session): void;
  onToggle(): void;
  onOpenSettings(): void;
  onLogout(): void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileAreaRef = useRef<HTMLDivElement>(null);
  const sessionMenuButtonRef = useRef<HTMLButtonElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupSessions(props.sessions, search), [props.sessions, search]);
  const initials = props.activeUser.displayName.slice(0, 2).toUpperCase();

  useEffect(() => {
    if (!profileOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !profileAreaRef.current?.contains(target)) {
        setProfileOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };

    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  useEffect(() => {
    if (!menuId) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !sessionMenuButtonRef.current?.contains(target) &&
        !sessionMenuRef.current?.contains(target)
      ) {
        setMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuId(null);
    };

    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuId]);

  return (
    <aside className="sidebar" aria-label="会话导航">
      <div className="sidebar-top">
        <div className="brand-row">
          <button className="icon-button" onClick={props.onToggle} aria-label="关闭侧边栏">
            <PanelLeftClose size={19} />
          </button>
        </div>
        <button className="new-chat-button" onClick={props.onNewSession}>
          <Plus size={16} /> 新对话
        </button>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索对话..."
            aria-label="搜索对话"
          />
        </label>
      </div>

      <div className="session-groups custom-scrollbar">
        {groups.map((group) => (
          <section key={group.label} className="session-group">
            <h3>{group.label}</h3>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${props.activeSessionId === session.id ? 'active' : ''}`}
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
                  ref={menuId === session.id ? sessionMenuButtonRef : undefined}
                  className="session-menu-button"
                  aria-label={`${session.title} 操作`}
                  aria-expanded={menuId === session.id}
                  aria-haspopup="menu"
                  onClick={() => {
                    setProfileOpen(false);
                    setMenuId((current) => (current === session.id ? null : session.id));
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
                {menuId === session.id && (
                  <div ref={sessionMenuRef} className="session-menu" role="menu">
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
          </section>
        ))}
        {groups.length === 0 && <div className="sidebar-empty">暂无匹配的对话</div>}
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
          aria-haspopup="menu"
          onClick={() => {
            setMenuId(null);
            setProfileOpen((current) => !current);
          }}
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

function groupSessions(sessions: Session[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  const buckets = new Map<string, Session[]>();
  for (const session of sessions) {
    if (
      session.status !== 'active' ||
      (query && !session.title.toLocaleLowerCase().includes(query))
    ) {
      continue;
    }
    const label = dateGroup(session.updatedAt);
    const list = buckets.get(label) ?? [];
    list.push(session);
    buckets.set(label, list);
  }
  return ['今天', '昨天', '前 7 天', '更早']
    .map((label) => ({ label, sessions: buckets.get(label) ?? [] }))
    .filter((group) => group.sessions.length > 0);
}

function dateGroup(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.floor((today - target) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days <= 7) return '前 7 天';
  return '更早';
}
